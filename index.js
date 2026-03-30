const { onCall, onRequest } = require('firebase-functions/v2/https');
const { defineString, defineSecret, defineBoolean } = require('firebase-functions/params');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');

admin.initializeApp();

// Define parameters
const BILLPLZ_API_KEY = defineSecret('BILLPLZ_API_KEY');
const BILLPLZ_X_SIGNATURE = defineSecret('BILLPLZ_X_SIGNATURE');
const BILLPLZ_COLLECTION_ID = defineString('BILLPLZ_COLLECTION_ID');
const BILLPLZ_SANDBOX = defineBoolean('BILLPLZ_SANDBOX', { default: true });
const APP_URL = defineString('APP_URL', { default: 'https://chalet-kurung-tengar.web.app' });

function getBillplzBaseUrl() {
    return BILLPLZ_SANDBOX.value() 
        ? 'https://www.billplz-sandbox.com/api/v3' 
        : 'https://www.billplz.com/api/v3';
}

// Create Billplz Bill - Callable Function
exports.createBillplzBill = onCall(
    { secrets: [BILLPLZ_API_KEY] },
    async (request) => {
        const { bookingId, totalAmount, name, email, roomType, nights } = request.data;
        
        try {
            console.log('Creating bill for:', { bookingId, totalAmount, email, roomType });
            
            const amountInCents = Math.round(totalAmount * 100);
            
            const billData = {
                collection_id: BILLPLZ_COLLECTION_ID.value(),
                email: email,
                name: name,
                amount: amountInCents,
                description: `Chalet Kurung Tengar - ${roomType} for ${nights} nights (${bookingId})`,
                reference_1: bookingId,
                reference_2: roomType,
                callback_url: `${APP_URL.value()}/api/billplz-callback`,
                redirect_url: `${APP_URL.value()}/payment-successful.html?bookingId=${bookingId}`,
            };
            
            const response = await axios.post(
                `${getBillplzBaseUrl()}/bills`,
                billData,
                {
                    auth: {
                        username: BILLPLZ_API_KEY.value(),
                        password: ''
                    },
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            console.log('Billplz response:', response.data);
            
            // Save payment record
            await admin.firestore().collection('payments').doc(bookingId).set({
                bookingId: bookingId,
                billplzBillId: response.data.id,
                amount: totalAmount,
                amountInCents: amountInCents,
                status: 'pending',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                billUrl: response.data.url,
                roomType: roomType,
                nights: nights,
                guestEmail: email,
                guestName: name
            });
            
            // Update booking
            const bookingSnapshot = await admin.firestore()
                .collection('bookings')
                .where('bookingId', '==', bookingId)
                .get();
            
            if (!bookingSnapshot.empty) {
                const bookingDoc = bookingSnapshot.docs[0];
                await bookingDoc.ref.update({
                    paymentStatus: 'pending',
                    paymentMethod: 'Billplz',
                    billplzBillId: response.data.id,
                    billplzBillUrl: response.data.url,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
            
            return {
                success: true,
                billUrl: response.data.url,
                billId: response.data.id
            };
            
        } catch (error) {
            console.error('Billplz creation error:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.message || error.message
            };
        }
    }
);

// Billplz Webhook/Callback Handler
exports.billplzCallback = onRequest(
    { secrets: [BILLPLZ_X_SIGNATURE] },
    async (req, res) => {
        console.log('Received billplz callback:', req.method);
        
        try {
            if (req.method === 'GET') {
                const { billplz_id, billplz_paid, id, paid, reference_1 } = req.query;
                
                if (billplz_paid === 'true' || paid === 'true') {
                    console.log('GET callback - Payment confirmed for:', reference_1);
                    await updatePaymentAndBooking(reference_1, billplz_id || id);
                    return res.redirect(`${APP_URL.value()}/payment-successful.html?bookingId=${reference_1}&status=success`);
                }
                return res.redirect(`${APP_URL.value()}/payment-successful.html?bookingId=${reference_1}&status=pending`);
            }
            
            const billplzSignature = req.headers['x-billplz-signature'];
            
            if (!billplzSignature) {
                console.error('No signature found');
                return res.status(400).send('No signature');
            }
            
            let rawBody = '';
            req.on('data', chunk => { rawBody += chunk; });
            
            req.on('end', async () => {
                try {
                    const generatedSignature = crypto
                        .createHmac('sha256', BILLPLZ_X_SIGNATURE.value())
                        .update(rawBody)
                        .digest('hex');
                    
                    if (generatedSignature !== billplzSignature) {
                        console.error('Invalid signature');
                        return res.status(403).send('Invalid signature');
                    }
                    
                    const data = JSON.parse(rawBody);
                    const { id, paid_at, reference_1, state } = data;
                    
                    if (paid_at || state === 'paid') {
                        console.log(`Payment confirmed for booking: ${reference_1}`);
                        await updatePaymentAndBooking(reference_1, id);
                    }
                    
                    res.status(200).send('OK');
                    
                } catch (parseError) {
                    console.error('Parse error:', parseError);
                    res.status(500).send('Error');
                }
            });
            
        } catch (error) {
            console.error('Callback error:', error);
            res.status(500).send('Error');
        }
    }
);

// Helper function to update payment and booking
async function updatePaymentAndBooking(bookingId, billplzBillId) {
    try {
        await admin.firestore().collection('payments').doc(bookingId).update({
            status: 'paid',
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        const bookingSnapshot = await admin.firestore()
            .collection('bookings')
            .where('bookingId', '==', bookingId)
            .get();
        
        if (!bookingSnapshot.empty) {
            const bookingDoc = bookingSnapshot.docs[0];
            await bookingDoc.ref.update({
                status: 'confirmed',
                paymentStatus: 'completed',
                paymentDate: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`Booking ${bookingId} updated to confirmed`);
        }
    } catch (error) {
        console.error('Error updating payment/booking:', error);
    }
}

// Check Bill Status
exports.checkBillStatus = onCall(
    { secrets: [BILLPLZ_API_KEY] },
    async (request) => {
        const { bookingId } = request.data;
        
        try {
            const paymentDoc = await admin.firestore()
                .collection('payments')
                .doc(bookingId)
                .get();
                
            if (!paymentDoc.exists) {
                return { success: false, error: 'Payment not found' };
            }
            
            const paymentData = paymentDoc.data();
            
            if (paymentData.status === 'paid') {
                return {
                    success: true,
                    status: 'paid',
                    paidAt: paymentData.paidAt
                };
            }
            
            if (paymentData.billplzBillId) {
                try {
                    const response = await axios.get(
                        `${getBillplzBaseUrl()}/bills/${paymentData.billplzBillId}`,
                        {
                            auth: {
                                username: BILLPLZ_API_KEY.value(),
                                password: ''
                            }
                        }
                    );
                    
                    const billData = response.data;
                    
                    if (billData.paid_at || billData.state === 'paid') {
                        await admin.firestore().collection('payments').doc(bookingId).update({
                            status: 'paid',
                            paidAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                        
                        const bookingSnapshot = await admin.firestore()
                            .collection('bookings')
                            .where('bookingId', '==', bookingId)
                            .get();
                        
                        if (!bookingSnapshot.empty) {
                            const bookingDoc = bookingSnapshot.docs[0];
                            await bookingDoc.ref.update({
                                status: 'confirmed',
                                paymentStatus: 'completed'
                            });
                        }
                        
                        return {
                            success: true,
                            status: 'paid',
                            paidAt: billData.paid_at
                        };
                    }
                    
                    return {
                        success: true,
                        status: 'pending',
                        billUrl: paymentData.billUrl
                    };
                    
                } catch (apiError) {
                    console.error('API check error:', apiError.message);
                    return {
                        success: true,
                        status: 'pending',
                        billUrl: paymentData.billUrl
                    };
                }
            }
            
            return {
                success: true,
                status: 'pending',
                billUrl: paymentData.billUrl
            };
            
        } catch (error) {
            console.error('Status check error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
);