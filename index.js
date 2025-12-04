require('dotenv').config();
const express = require('express')
const cors = require('cors')
const app = express()
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const crypto = require("crypto");
const port = process.env.PORT || 3000

const admin = require("firebase-admin");

const serviceAccount = require("./zap-shift-firebase-adminsdk.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


function generateTrackingId() {
    const prefix = "TE"; // your project code (TravelEase)
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");

    // Generate a secure 4-byte random hex (8 characters)
    const random = crypto.randomBytes(4).toString("hex").toUpperCase();

    return `${prefix}-${date}-${random}`;
}

module.exports = generateTrackingId;


// middle wares
app.use(cors())
app.use(express.json())

const verifyFireBaseToken = async (req, res, next) => {
    const token = req.headers.authorization

    if (!token) {
        return res.status(401).send({ message: 'Unauthorized access' })
    }

    try {
        const idToken = token.split(' ')[1]
        const decoded = await admin.auth().verifyIdToken(idToken)
        console.log('decoded in the token', decoded)
        req.decoded_email = decoded.email
        next()
    }
    catch (error) {
        res.status(401).send({ message: "Unauthorizes access" })
    }
}

// mongodb connection string
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.9hcy35q.mongodb.net/?appName=Cluster0`;

// MongoClient with a MongoClientOptions 
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const db = client.db("zap_shift_db")
        const parcelCollection = db.collection("parcels")
        const paymentCollection = db.collection('payments')
        const userCollection = db.collection("users")
        const riderCollection = db.collection("riders")

        // verify admin middleware with database access
        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded_email
            const query = { email }
            const user = await userCollection.findOne(query)

            if (!user || user.role !== 'admin') {
                return res.status(403).send({ message: 'Forbidden access' })
            }
            next()
        }

        // payment apis
        app.get('/payments', verifyFireBaseToken, async (req, res) => {
            const email = req.query.email;
            const query = {}
            if (email) {
                query.customerEmail = email;
                if (email !== req.decoded_email) {
                    return res.status(403).send({ message: 'Forbidden access' })
                }
            }
            const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
            const result = await cursor.toArray();
            res.send(result);
        })

        // new
        app.post('/checkuot-sesion', async (req, res) => {
            const paymentInfo = req.body
            const amount = parseInt(paymentInfo.cost) * 100
            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        price_data: {
                            currency: 'USD',
                            unit_amount: amount,
                            product_data: {
                                name: paymentInfo.parcelName
                            }
                        },
                        quantity: 1,
                    }
                ],
                customer_email: paymentInfo.senderEmail,
                mode: 'payment',
                metadata: {
                    parcelId: paymentInfo.parcelId,
                    parcelName: paymentInfo.parcelName
                },
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`
            })
            res.send({ url: session.url })
        })

        // old
        // app.post('/create-checkout-session', async (req, res) => {
        //     const paymentInfo = req.body
        //     const amount = parseInt(paymentInfo.cost)
        //     const session = await stripe.checkout.sessions.create(
        //         {
        //             line_items: [
        //                 {
        //                     // Provide the exact Price ID (for example, price_1234) of the product you want to sell
        //                     price_data: {
        //                         currency: 'USD',
        //                         unit_amount: amount,
        //                         product_data: {
        //                             name: paymentInfo.parcelName
        //                         }
        //                     },
        //                     quantity: 1,
        //                 },
        //             ],
        //             customer_email: paymentInfo.senderEmail,
        //             mode: 'payment',
        //             metadata: {
        //                 parcelId: paymentInfo.parcelId
        //             },
        //             success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
        //             cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
        //         }
        //     )
        //     // console.log(session)
        //     res.send({ url: session.url })
        // })

        // app.patch('/verify-payment-success', async (req, res) => {
        //     const sessionId = req.query.session_id
        //     const session = await stripe.checkout.sessions.retrieve(sessionId);
        //     console.log("session retrieve", session)

        //     const transactionId = session.payment_intent
        //     const query = { transactionId: transactionId }
        //     const paymentExist = await paymentCollection.findOne(query)
        //     console.log(paymentExist)
        //     if (paymentExist) {
        //         return res.send({
        //             message: 'Payment already exist, no need to add again'
        //         })
        //     }

        //     const trackingId = generateTrackingId()
        //     if (session.payment_status === 'paid') {
        //         const id = session.metadata.parcelId
        //         const query = { _id: new ObjectId(id) }
        //         const update = {
        //             $set: {
        //                 paymentStatus: 'paid',
        //                 trackingId: trackingId
        //             }
        //         }
        //         const result = await parcelCollection.updateOne(query, update)

        //         const payment = {
        //             amount: session.amount_total / 100,
        //             currency: session.currency,
        //             customerEmail: session.customer_email,
        //             parcelId: session.metadata.parcelId,
        //             parcelName: session.metadata.parcelName,
        //             transactionId: session.payment_intent,
        //             paymentStatus: session.payment_status,
        //             paidAt: new Date(),
        //             trackingId: trackingId
        //         }

        //         if (session.payment_status === 'paid') {
        //             const paymentResult = await paymentCollection.insertOne(payment)
        //             res.send({ success: true, trackingId: trackingId, transactionId: session.payment_intent, modifyParcel: result, paymentInfo: paymentResult })
        //         }

        //         res.send(result)
        //     }
        //     res.send({ success: false })
        // })
        app.patch('/verify-payment-success', async (req, res) => {
            try {
                const sessionId = req.query.session_id;
                const session = await stripe.checkout.sessions.retrieve(sessionId);

                const transactionId = session.payment_intent;
                const existingPayment = await paymentCollection.findOne({ transactionId });

                // Already paid → avoid duplicate insert
                if (existingPayment) {
                    return res.send({
                        success: true,
                        message: 'Payment already exists',
                        trackingId: existingPayment.trackingId,
                    });
                }

                // Only continue if paid
                if (session.payment_status !== 'paid') {
                    return res.send({ success: false, message: "Payment not completed" });
                }

                // Update parcel with tracking & paid status
                const trackingId = generateTrackingId();
                const parcelId = session.metadata.parcelId;

                await parcelCollection.updateOne(
                    { _id: new ObjectId(parcelId) },
                    { $set: { paymentStatus: "paid", deliveryStatus: 'pending-pickup', trackingId: trackingId, transactionId: transactionId } }
                );

                // Create payment record
                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEmail: session.customer_email,
                    parcelId: parcelId,
                    parcelName: session.metadata.parcelName,
                    transactionId: transactionId,
                    paymentStatus: session.payment_status,
                    paidAt: new Date(),
                    trackingId: trackingId
                };

                const result = await paymentCollection.insertOne(payment);

                return res.send({
                    success: true,
                    trackingId,
                    transactionId,
                    paymentInfo: result,
                });

            } catch (err) {
                console.error(err);
                res.status(500).send({ success: false, error: err.message });
            }
        });


        // parcel apis
        app.get('/parcels', async (req, res) => {
            const query = {}
            const { email, deliveryStatus } = req.query

            if (email) {
                query.senderEmail = email
            }

            if (deliveryStatus) {
                query.deliveryStatus = deliveryStatus
            }

            const options = { sort: { createdAt: -1 } }
            const cursor = parcelCollection.find(query, options)
            const result = await cursor.toArray()
            res.send(result)
        })

        app.get('/parcels/:id', async (req, res) => {
            const id = req.params.id
            const query = { _id: new ObjectId(id) }
            const result = await parcelCollection.findOne(query)
            res.send(result)
        })

        app.post('/parcels', async (req, res) => {
            const parcel = req.body
            parcel.createdAt = new Date()
            const result = await parcelCollection.insertOne(parcel)
            res.send(result)
        })

        app.delete('/parcels/:id', async (req, res) => {
            const id = req.params.id
            const query = { _id: new ObjectId(id) }
            const result = await parcelCollection.deleteOne(query)
            res.send(result)
        })

        // user apis
        app.get('/users', verifyFireBaseToken, async (req, res) => {
            const searchText = req.query.searchText
            const query = {}

            if (searchText) {
                // query.displayName = { $regex: searchText, $options: 'i' }
                query.$or = [
                    { displayName: { $regex: searchText, $options: 'i' } },
                    { email: { $regex: searchText, $options: 'i' } },
                ]
            }

            const cursor = userCollection.find(query).sort({ createdAt: -1 })
            const result = await cursor.toArray()
            res.send(result)
        })

        // app.get('/users/:id', async (req, res) => {

        // })

        app.get('/users/:email/role', verifyFireBaseToken, async (req, res) => {
            const email = req.params.email
            const query = { email }
            const user = await userCollection.findOne(query)
            res.send({ role: user?.role || 'user' })
        })

        app.post('/users', async (req, res) => {
            const user = req.body
            user.role = 'user'
            user.createdAt = new Date()
            const email = user.email
            const existingUser = await userCollection.findOne({ email })
            if (existingUser) {
                return res.send({ message: 'user already exist' })
            }
            const result = await userCollection.insertOne(user)
            res.send(result)
        })

        app.patch('/users/:id/role', verifyFireBaseToken, verifyAdmin, async (req, res) => {
            const id = req.params.id
            const roleInfo = req.body
            const query = { _id: new ObjectId(id) }
            const updatedDoc = {
                $set: {
                    role: roleInfo.role
                }
            }
            const result = await userCollection.updateOne(query, updatedDoc)
            res.send(result)
        })

        // rider apis
        app.get('/riders', async (req, res) => {
            const qurey = {}
            const cursor = riderCollection.find(qurey)
            const result = await cursor.toArray()
            res.send(result)
        })

        app.post('/riders', async (req, res) => {
            const rider = req.body
            rider.status = 'pending'
            rider.appliedAt = new Date()
            const result = await riderCollection.insertOne(rider)
            res.send(result)
        })

        app.patch('/riders/:id', verifyFireBaseToken, async (req, res) => {
            const status = req.body.status
            const id = req.params.id
            const query = { _id: new ObjectId(id) }
            const updatedDoc = {
                $set: {
                    status: status,
                    workStatus: 'available'
                }
            }

            if (status === 'approved') {
                const email = req.body.email
                const userQuery = { email }
                const updateUser = {
                    $set: {
                        role: 'rider'
                    }
                }
                const userResult = await userCollection.updateOne(userQuery, updateUser)
            }

            const result = await riderCollection.updateOne(query, updatedDoc)
            res.send(result)
        })

        app.delete('/riders/:id', verifyFireBaseToken, async (req, res) => {
            const id = req.params.id
            const query = { _id: new ObjectId(id) }
            const result = await riderCollection.deleteOne(query)
            res.send(result)
        })

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);


app.get('/', (req, res) => {
    res.send('Zap Shift is runnign!')
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})