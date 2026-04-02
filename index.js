const { onCall, onRequest } = require('firebase-functions/v2/https');
const { defineString, defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');

admin.initializeApp();

// ==============================================
// PARAMETERS (from .env files)
// ==============================================
const BILLPLZ_COLLECTION_ID = defineString('BILLPLZ_COLLECTION_ID');
const BILLPLZ_SANDBOX = defineString('BILLPLZ_SANDBOX', { default: 'false' });
const APP_URL = defineString('APP_URL', { default: 'https://chaletkurungtengar.com' });

// ==============================================
// SECRETS (from Secret Manager)
// ==============================================
const BILLPLZ_API_KEY = defineSecret('BILLPLZ_API_KEY');
const BILLPLZ_X_SIGNATURE = defineSecret('BILLPLZ_X_SIGNATURE');

function getBillplzBaseUrl(sandbox) {
    return sandbox === 'true' 
        ? 'https://www.billplz-sandbox.com/api/v3' 
        : 'https://www.billplz.com/api/v3';
}

// Helper to get config values at runtime
async function getConfig() {
    return {
        appUrl: APP_URL.value(),
        billplzCollectionId: BILLPLZ_COLLECTION_ID.value(),
        billplzSandbox: BILLPLZ_SANDBOX.value(),
        billplzApiKey: await BILLPLZ_API_KEY.value(),
        billplzXSignature: await BILLPLZ_X_SIGNATURE.value()
    };
}

// ==============================================
// CREATE BILLPLZ BILL - Callable Function
// ==============================================
exports.createBillplzBill = onCall(
    { secrets: [BILLPLZ_API_KEY] },
    async (request) => {
        const { bookingId, totalAmount, name, email, roomType, nights } = request.data;
        
        try {
            const config = await getConfig();
            
            console.log('Creating bill for:', { bookingId, totalAmount, email, roomType, nights });
            console.log('Using collection ID:', config.billplzCollectionId);
            console.log('Sandbox mode:', config.billplzSandbox);
            
            const amountInCents = Math.round(totalAmount * 100);
            
            const billData = {
                collection_id: config.billplzCollectionId,
                email: email,
                name: name,
                amount: amountInCents,
                description: `Chalet Kurung Tengar - ${roomType} for ${nights} nights (${bookingId})`,
                reference_1: bookingId,
                reference_2: roomType,
                callback_url: `https://us-central1-chalet-kurung-tengar.cloudfunctions.net/billplzCallback`,
                redirect_url: `${config.appUrl}/payment-successful.html?bookingId=${bookingId}`,
                deliver: false,
                // Production payment methods - FPX for Malaysian banks
                payment_methods: ['fpx']
            };
            
            const response = await axios.post(
                `${getBillplzBaseUrl(config.billplzSandbox)}/bills`,
                billData,
                {
                    auth: {
                        username: config.billplzApiKey,
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
            
            // Update booking if exists
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
            }
            
            return {
                success: true,
                billUrl: response.data.url,
                billId: response.data.id
            };
            
        } catch (error) {
            console.error('Billplz creation error:', {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status
            });
            
            return {
                success: false,
                error: error.response?.data?.message || error.message
            };
        }
    }
);

// ==============================================
// BILLPLZ WEBHOOK/CALLBACK HANDLER
// ==============================================
exports.billplzCallback = onRequest(
    { secrets: [BILLPLZ_X_SIGNATURE] },
    async (req, res) => {
        console.log('Billplz callback received:', req.method);
        
        try {
            const config = await getConfig();
            
            // Handle GET callback (redirect after payment)
            if (req.method === 'GET') {
                const { billplz_id, billplz_paid, id, paid, reference_1, transaction_id } = req.query;
                
                console.log('GET callback params:', { billplz_id, billplz_paid, id, paid, reference_1 });
                
                if (billplz_paid === 'true' || paid === 'true') {
                    const billId = billplz_id || id;
                    const result = await updatePaymentAndBlockDates(reference_1, billId, transaction_id);
                    
                    if (result.success) {
                        return res.redirect(`${config.appUrl}/payment-successful.html?bookingId=${reference_1}&status=success`);
                    } else {
                        return res.redirect(`${config.appUrl}/payment-successful.html?bookingId=${reference_1}&status=processing`);
                    }
                }
                return res.redirect(`${config.appUrl}/booking-pending.html?bookingId=${reference_1}&status=pending`);
            }
            
            // Handle POST webhook
            let rawBody = '';
            req.on('data', chunk => { rawBody += chunk; });
            
            req.on('end', async () => {
                try {
                    const signature = req.headers['x-billplz-signature'];
                    const generatedSignature = crypto
                        .createHmac('sha256', config.billplzXSignature)
                        .update(rawBody)
                        .digest('hex');
                    
                    if (generatedSignature !== signature) {
                        console.error('Invalid signature');
                        return res.status(403).send('Invalid signature');
                    }
                    
                    const data = JSON.parse(rawBody);
                    console.log('Webhook data:', data);
                    
                    if (data.paid_at || data.state === 'paid') {
                        await updatePaymentAndBlockDates(data.reference_1, data.id, data.transaction_id);
                    }
                    
                    res.status(200).send('OK');
                } catch (error) {
                    console.error('Webhook error:', error);
                    res.status(500).send('Error');
                }
            });
            
        } catch (error) {
            console.error('Callback error:', error);
            res.status(500).send('Error');
        }
    }
);

// ==============================================
// UPDATE PAYMENT AND BLOCK DATES
// ==============================================
async function updatePaymentAndBlockDates(bookingId, billId, transactionId = null) {
    try {
        console.log(`Updating booking ${bookingId} - CONFIRMING AND BLOCKING DATES`);
        
        // First, get the booking details
        const bookingQuery = await admin.firestore()
            .collection('bookings')
            .where('bookingId', '==', bookingId)
            .get();
        
        if (bookingQuery.empty) {
            console.error(`Booking ${bookingId} not found`);
            return { success: false, error: 'Booking not found' };
        }
        
        const bookingDoc = bookingQuery.docs[0];
        const bookingData = bookingDoc.data();
        
        // Update payments collection
        await admin.firestore().collection('payments').doc(bookingId).set({
            status: 'paid',
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            transactionId: transactionId,
            billplzBillId: billId
        }, { merge: true });
        
        // Update booking to CONFIRMED
        await bookingDoc.ref.update({
            status: 'confirmed',
            paymentStatus: 'completed',
            paymentDate: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            transactionId: transactionId,
            confirmedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // Create blocked dates entries
        const blockedDatesRef = admin.firestore().collection('blocked_dates');
        
        const checkIn = new Date(bookingData.checkIn);
        const checkOut = new Date(bookingData.checkOut);
        const dates = [];
        
        for (let d = new Date(checkIn); d < checkOut; d.setDate(d.getDate() + 1)) {
            const dateStr = d.toISOString().split('T')[0];
            dates.push(dateStr);
        }
        
        // Create blocked date entries for each night
        for (const date of dates) {
            const blockedDocRef = blockedDatesRef.doc(`${bookingData.roomType}_${date}`);
            await blockedDocRef.set({
                roomType: bookingData.roomType,
                date: date,
                bookingId: bookingId,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                status: 'blocked'
            }, { merge: true });
        }
        
        console.log(`✅ Booking ${bookingId} CONFIRMED - ${dates.length} dates blocked for ${bookingData.roomType}`);
        
        // Create audit record
        await admin.firestore().collection('confirmed_bookings').doc(bookingId).set({
            bookingId: bookingId,
            confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
            checkIn: bookingData.checkIn,
            checkOut: bookingData.checkOut,
            roomType: bookingData.roomType,
            guests: bookingData.guests,
            totalPaid: bookingData.totalPrice,
            nights: bookingData.nights,
            transactionId: transactionId
        });
        
        return { success: true, blockedDates: dates.length };
        
    } catch (error) {
        console.error('Error updating payment/booking:', error);
        throw error;
    }
}

// ==============================================
// CHECK BILL STATUS - Callable Function
// ==============================================
exports.checkBillStatus = onCall(
    { secrets: [BILLPLZ_API_KEY] },
    async (request) => {
        const { bookingId } = request.data;
        
        try {
            const config = await getConfig();
            
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
                        `${getBillplzBaseUrl(config.billplzSandbox)}/bills/${paymentData.billplzBillId}`,
                        {
                            auth: {
                                username: config.billplzApiKey,
                                password: ''
                            }
                        }
                    );
                    
                    const billData = response.data;
                    
                    if (billData.paid_at || billData.state === 'paid') {
                        await updatePaymentAndBlockDates(bookingId, paymentData.billplzBillId, billData.transaction_id);
                        
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

// ==============================================
// TEST BILLPLZ CONNECTION - HTTP Function
// ==============================================
exports.testBillplz = onRequest(
    { secrets: [BILLPLZ_API_KEY] },
    async (req, res) => {
        try {
            const config = await getConfig();
            
            console.log('Testing Billplz connection...');
            console.log('Collection ID:', config.billplzCollectionId);
            console.log('Sandbox mode:', config.billplzSandbox);
            console.log('API URL:', getBillplzBaseUrl(config.billplzSandbox));
            
            // Test collection access
            const response = await axios.get(
                `${getBillplzBaseUrl(config.billplzSandbox)}/collections/${config.billplzCollectionId}`,
                {
                    auth: {
                        username: config.billplzApiKey,
                        password: ''
                    }
                }
            );
            
            res.json({ 
                success: true, 
                message: 'Billplz connection successful!',
                collection: response.data,
                config: {
                    sandbox: config.billplzSandbox,
                    collectionId: config.billplzCollectionId,
                    appUrl: config.appUrl,
                    apiUrl: getBillplzBaseUrl(config.billplzSandbox)
                }
            });
        } catch (error) {
            console.error('Test error:', error.response?.data || error.message);
            res.status(500).json({ 
                success: false, 
                error: error.response?.data || error.message,
                config: {
                    sandbox: BILLPLZ_SANDBOX.value(),
                    collectionId: BILLPLZ_COLLECTION_ID.value(),
                    appUrl: APP_URL.value()
                }
            });
        }
    }
);;
