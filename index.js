const { onCall, onRequest } = require('firebase-functions/v2/https');
const { defineString, defineSecret, defineBoolean } = require('firebase-functions/params');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');

admin.initializeApp();

// Define parameters - ADD X_SIGNATURE SECRET
const BILLPLZ_API_KEY = defineSecret('BILLPLZ_API_KEY');
const BILLPLZ_X_SIGNATURE = defineSecret('BILLPLZ_X_SIGNATURE');  // ← MUST BE SET
const BILLPLZ_COLLECTION_ID = defineString('BILLPLZ_COLLECTION_ID');
const BILLPLZ_SANDBOX = defineBoolean('BILLPLZ_SANDBOX', { default: true });
const APP_URL = defineString('APP_URL', { default: 'https://chaletkurungtengar.com' });

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
                callback_url: `${APP_URL.value()}/billplz-callback`,  // ← FIXED: removed /api/
                redirect_url: `${APP_URL.value()}/payment-successful.html?bookingId=${bookingId}`,
            };
            
            console.log('Billplz request:', { url: `${getBillplzBaseUrl()}/bills`, billData });
            
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
            
            // Update booking - FIX: Use bookingId field directly
            const bookingQuery = await admin.firestore()
                .collection('bookings')
                .where('bookingId', '==', bookingId)
                .get();
            
            if (!bookingQuery.empty) {
                const bookingDoc = bookingQuery.docs[0];
                await bookingDoc.ref.update({
                    paymentStatus: 'pending',
                    paymentMethod: 'Billplz',
                    billplzBillId: response.data.id,
                    billplzBillUrl: response.data.url,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            } else {
                console.warn(`Booking ${bookingId} not found in bookings collection`);
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

// Billplz Webhook/Callback Handler - FIXED Webhook Handler
exports.billplzCallback = onRequest(
    { secrets: [BILLPLZ_X_SIGNATURE] },
    async (req, res) => {
        console.log('Received billplz callback:', req.method);
        console.log('Headers:', req.headers);
        console.log('Query:', req.query);
        
        try {
            // Handle GET callback (Billplz sends GET to redirect_url)
            if (req.method === 'GET') {
                const { billplz_id, billplz_paid, id, paid, reference_1, transaction_id } = req.query;
                
                console.log('GET callback params:', { billplz_id, billplz_paid, id, paid, reference_1 });
                
                if (billplz_paid === 'true' || paid === 'true') {
                    console.log('GET callback - Payment confirmed for:', reference_1);
                    const billId = billplz_id || id;
                    await updatePaymentAndBooking(reference_1, billId, transaction_id);
                    return res.redirect(`${APP_URL.value()}/payment-successful.html?bookingId=${reference_1}&status=success`);
                }
                return res.redirect(`${APP_URL.value()}/booking-pending.html?bookingId=${reference_1}&status=pending`);
            }
            
            // Handle POST webhook (Billplz sends POST to callback_url)
            // Get signature from header - Billplz uses X-Billplz-Signature
            const billplzSignature = req.headers['x-billplz-signature'] || req.headers['X-Billplz-Signature'];
            
            if (!billplzSignature) {
                console.error('No signature found in headers');
                return res.status(400).send('No signature');
            }
            
            // Get raw body for signature verification
            let rawBody = '';
            req.on('data', chunk => { rawBody += chunk; });
            
            req.on('end', async () => {
                try {
                    // Verify signature
                    const generatedSignature = crypto
                        .createHmac('sha256', BILLPLZ_X_SIGNATURE.value())
                        .update(rawBody)
                        .digest('hex');
                    
                    console.log('Signature verification:', { 
                        received: billplzSignature.substring(0, 20), 
                        generated: generatedSignature.substring(0, 20),
                        match: generatedSignature === billplzSignature 
                    });
                    
                    if (generatedSignature !== billplzSignature) {
                        console.error('Invalid signature');
                        return res.status(403).send('Invalid signature');
                    }
                    
                    // Parse the data - Billplz sends as JSON when content-type is JSON
                    let data;
                    if (req.headers['content-type'] === 'application/json') {
                        data = JSON.parse(rawBody);
                    } else {
                        // Handle x-www-form-urlencoded
                        const urlParams = new URLSearchParams(rawBody);
                        data = Object.fromEntries(urlParams);
                    }
                    
                    console.log('Webhook data:', data);
                    
                    const { id, paid_at, reference_1, state, transaction_id } = data;
                    
                    if (paid_at || state === 'paid' || data.paid === 'true') {
                        console.log(`Payment confirmed for booking: ${reference_1}`);
                        await updatePaymentAndBooking(reference_1, id, transaction_id);
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
async function updatePaymentAndBooking(bookingId, billplzBillId, transactionId = null) {
    try {
        console.log(`Updating booking ${bookingId} with bill ID ${billplzBillId}`);
        
        // Update payments collection
        await admin.firestore().collection('payments').doc(bookingId).update({
            status: 'paid',
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            transactionId: transactionId
        });
        
        // Update bookings collection
        const bookingQuery = await admin.firestore()
            .collection('bookings')
            .where('bookingId', '==', bookingId)
            .get();
        
        if (!bookingQuery.empty) {
            const bookingDoc = bookingQuery.docs[0];
            await bookingDoc.ref.update({
                status: 'confirmed',
                paymentStatus: 'completed',
                paymentDate: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                transactionId: transactionId
            });
            console.log(`Booking ${bookingId} updated to confirmed`);
        } else {
            console.error(`Booking ${bookingId} not found in bookings collection`);
        }
    } catch (error) {
        console.error('Error updating payment/booking:', error);
        throw error;
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
                        
                        const bookingQuery = await admin.firestore()
                            .collection('bookings')
                            .where('bookingId', '==', bookingId)
                            .get();
                        
                        if (!bookingQuery.empty) {
                            const bookingDoc = bookingQuery.docs[0];
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
