require('dotenv').config();
const express = require('express')
const cors = require('cors')
const app = express()
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const crypto = require("crypto");
const port = process.env.PORT || 3000


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

        // payment apis

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
        app.post('/create-checkout-session', async (req, res) => {
            const paymentInfo = req.body
            const amount = parseInt(paymentInfo.cost)
            const session = await stripe.checkout.sessions.create(
                {
                    line_items: [
                        {
                            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
                            price_data: {
                                currency: 'USD',
                                unit_amount: amount,
                                product_data: {
                                    name: paymentInfo.parcelName
                                }
                            },
                            quantity: 1,
                        },
                    ],
                    customer_email: paymentInfo.senderEmail,
                    mode: 'payment',
                    metadata: {
                        parcelId: paymentInfo.parcelId
                    },
                    success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
                    cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
                }
            )
            // console.log(session)
            res.send({ url: session.url })
        })

        app.patch('/verify-payment-success', async (req, res) => {
            const sessionId = req.query.session_id
            const session = await stripe.checkout.sessions.retrieve(sessionId);
            const trackingId = generateTrackingId()
            console.log("session retrieve", session)
            if (session.payment_status === 'paid') {
                const id = session.metadata.parcelId
                const query = { _id: new ObjectId(id) }
                const update = {
                    $set: {
                        paymentStatus: 'paid',
                        trackingId: trackingId
                    }
                }
                const result = await parcelCollection.updateOne(query, update)

                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEemail: session.customer_email,
                    parcelId: session.metadata.parcelId,
                    parcelName: session.metadata.parcelName,
                    transactionId: session.payment_intent,
                    paymentStatus: session.payment_status,
                    paidAt: new Date(),
                }

                if (session.payment_status === 'paid') {
                    const paymentResult = await parcelCollection.insertOne(payment)
                    res.send({ success: true, trackingId: trackingId, transactionId: session.payment_intent, modifyParcel: result, paymentInfo: paymentResult })
                }

                res.send(result)
            }
            res.send({ success: false })
        })

        // parcel apis
        app.get('/parcels', async (req, res) => {
            const query = {}
            const { email } = req.query
            if (email) {
                query.senderEmail = email
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
        app.get('/users', async (req, res) => {
            const query = {}
            const cursor = userCollection.find(query)
            const result = await cursor.toArray()
            res.send(result)
        })

        // rider apis
        app.get('/riders', async (req, res) => {
            const qurey = {}
            const cursor = riderCollection.find(qurey)
            const result = await cursor.toArray()
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