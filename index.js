require('dotenv').config();
const express = require('express')
const cors = require('cors')
const app = express()
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const crypto = require("crypto");
const port = process.env.PORT || 3000

const admin = require("firebase-admin");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

function generateTrackingId() {
    const prefix = "TE";
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const random = crypto.randomBytes(4).toString("hex").toUpperCase();
    return `${prefix}-${date}-${random}`;
}

module.exports = generateTrackingId;

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
        req.decoded_email = decoded.email
        next()
    }
    catch (error) {
        res.status(401).send({ message: "Unauthorizes access" })
    }
}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.9hcy35q.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        const db = client.db("zap_shift_db")
        const parcelCollection = db.collection("parcels")
        const paymentCollection = db.collection('payments')
        const userCollection = db.collection("users")
        const riderCollection = db.collection("riders")
        const trackingsCollection = db.collection("trackings")
        const reviewsCollection = db.collection('reviews')

        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded_email
            const query = { email }
            const user = await userCollection.findOne(query)

            if (!user || user.role !== 'admin') {
                return res.status(403).send({ message: 'Forbidden access' })
            }
            next()
        }

        const verifyRider = async (req, res, next) => {
            const email = req.decoded_email
            const query = { email }
            const user = await userCollection.findOne(query)

            if (!user || user.role !== 'admin') {
                return res.status(403).send({ message: 'Forbidden access' })
            }
            next()
        }

        const logTracking = async (trackingId, status) => {
            const log = {
                trackingId,
                status,
                details: status.split('_').map(status => status.charAt(0).toUpperCase() + status.slice(1)).join(' '),
                createdAt: new Date()
            }
            const result = await trackingsCollection.insertOne(log)
            return result
        }

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
                    parcelName: paymentInfo.parcelName,
                    trackingId: paymentInfo.trackingId
                },
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`
            })
            res.send({ url: session.url })
        })

        app.patch('/verify-payment-success', async (req, res) => {
            try {
                const sessionId = req.query.session_id;
                const session = await stripe.checkout.sessions.retrieve(sessionId);

                const transactionId = session.payment_intent;
                const existingPayment = await paymentCollection.findOne({ transactionId });

                if (existingPayment) {
                    return res.send({
                        success: true,
                        message: 'Payment already exists',
                        trackingId: existingPayment.trackingId,
                    });
                }

                if (session.payment_status !== 'paid') {
                    return res.send({ success: false, message: "Payment not completed" });
                }

                const trackingId = session.metadata.trackingId;
                const parcelId = session.metadata.parcelId;

                await parcelCollection.updateOne(
                    { _id: new ObjectId(parcelId) },
                    {
                        $set: {
                            paymentStatus: "paid",
                            deliveryStatus: 'pending_pickup',
                            transactionId: transactionId
                        }
                    }
                );

                logTracking(trackingId, 'parcel_paid')

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
                res.status(500).send({ success: false, error: err.message });
            }
        })


        app.get('/parcels', verifyFireBaseToken, async (req, res) => {
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

        app.get('/parcels/riders', async (req, res) => {
            const { riderEmail, deliveryStatus } = req.query
            const query = {}

            if (riderEmail) {
                query.riderEmail = riderEmail
            }
            if (deliveryStatus !== "parcel_delivered") {
                query.deliveryStatus = { $nin: ["parcel_delivered"] }
            }
            else {
                query.deliveryStatus = deliveryStatus
            }

            const cursor = parcelCollection.find(query)
            const result = await cursor.toArray()
            res.send(result)
        })

        app.get('/parcels/:id', async (req, res) => {
            const id = req.params.id
            const query = { _id: new ObjectId(id) }
            const result = await parcelCollection.findOne(query)
            res.send(result)
        })

        app.get('/parcels/delivery-status/stats', verifyFireBaseToken, verifyAdmin, async (req, res) => {
            const pipeline = [
                {
                    $group: {
                        _id: '$deliveryStatus',
                        count: { $sum: 1 }
                    }
                },
                {
                    $project: {
                        status: '$_id',
                        count: 1,
                    }
                }
            ]
            const result = await parcelCollection.aggregate(pipeline).toArray()
            res.send(result)
        })

        app.post('/parcels', async (req, res) => {
            const parcel = req.body
            const trackingId = generateTrackingId()
            parcel.createdAt = new Date()
            parcel.trackingId = trackingId
            logTracking(trackingId, 'parcel_created')
            const result = await parcelCollection.insertOne(parcel)
            res.send(result)
        })

        app.patch('/parcels/:id/assign', async (req, res) => {
            const { riderId, riderName, riderEmail, trackingId } = req.body
            const id = req.params.id
            const query = { _id: new ObjectId(id) }

            const updatedDoc = {
                $set: {
                    deliveryStatus: 'driver_assigned',
                    riderId: riderId,
                    riderName: riderName,
                    riderEmail: riderEmail
                }
            }
            const result = await parcelCollection.updateOne(query, updatedDoc)

            const riderQuery = { _id: new ObjectId(riderId) }
            const riderUpdatedDoc = {
                $set: {
                    workStatus: 'in_delivery'
                }
            }

            logTracking(trackingId, 'driver_assigned')

            const riderResult = await riderCollection.updateOne(riderQuery, riderUpdatedDoc)
            res.send(riderResult)
        })

        app.patch('/parcels/:id/status', async (req, res) => {
            const { deliveryStatus, riderId, trackingId } = req.body
            const id = req.params.id
            const query = { _id: new ObjectId(id) }
            const updatedDoc = {
                $set: {
                    deliveryStatus: deliveryStatus
                }
            }

            if (deliveryStatus === 'parcel_delivered') {
                const riderQuery = { _id: new ObjectId(riderId) }
                const riderUpdatedDoc = {
                    $set: {
                        workStatus: 'available'
                    }
                }

                const riderResult = await riderCollection.updateOne(riderQuery, riderUpdatedDoc);
            }

            const result = await parcelCollection.updateOne(query, updatedDoc)
            logTracking(trackingId, deliveryStatus)
            res.send(result)
        })

        app.patch('/parcels/:id/reject', async (req, res) => {
            const { deliveryStatus } = req.body;
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };

            const parcel = await parcelCollection.findOne(query);

            if (parcel?.riderId) {
                await riderCollection.updateOne(
                    { _id: new ObjectId(parcel.riderId) },
                    { $set: { workStatus: "available" } }
                );
            }

            const updatedDoc = {
                $set: {
                    deliveryStatus: deliveryStatus,
                },
                $unset: {
                    riderId: "",
                    riderName: "",
                    riderEmail: ""
                }
            };

            const result = await parcelCollection.updateOne(query, updatedDoc);
            res.send(result);
        });


        app.delete('/parcels/:id', async (req, res) => {
            const id = req.params.id
            const query = { _id: new ObjectId(id) }
            const result = await parcelCollection.deleteOne(query)
            res.send(result)
        })

        app.get('/users', verifyFireBaseToken, async (req, res) => {
            const searchText = req.query.searchText
            const query = {}

            if (searchText) {
                query.$or = [
                    { displayName: { $regex: searchText, $options: 'i' } },
                    { email: { $regex: searchText, $options: 'i' } },
                ]
            }

            const cursor = userCollection.find(query).sort({ createdAt: -1 })
            const result = await cursor.toArray()
            res.send(result)
        })

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

        app.get('/riders', async (req, res) => {
            const { status, district, workStatus } = req.query
            const qurey = {}

            if (status) {
                qurey.status = status
            }

            if (district) {
                qurey.district = district
            }

            if (workStatus) {
                qurey.workStatus = workStatus
            }

            const cursor = riderCollection.find(qurey)
            const result = await cursor.toArray()
            res.send(result)
        })

        app.get('/riders/delivery-per-day', async (req, res) => {
            const email = req.query.email

            const pipeline = [
                {
                    $match: {
                        riderEmail: email,
                        deliveryStatus: "parcel_delivered"
                    }
                },
                {
                    $lookup: {
                        from: "trackings",
                        localField: "trackingId",
                        foreignField: "trackingId",
                        as: "parcel_trackings"
                    }
                },
                {
                    $unwind: "$parcel_trackings"
                },
                {
                    $match: {
                        "parcel_trackings.status": "parcel_delivered"
                    }
                },
                {
                    $addFields: {
                        deliveryDay: {
                            $dateToString: {
                                format: "%Y-%m-%d",
                                date: "$parcel_trackings.createdAt"
                            }
                        }
                    }
                },
                {
                    $group: {
                        _id: "$deliveryDay",
                        deliveredCount: { $sum: 1 }
                    }
                }
            ];

            const result = await parcelCollection.aggregate(pipeline).toArray()
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
            } else {
                const email = req.body.email
                const userQuery = { email }
                const updateUser = {

                    $set: {
                        role: 'user'
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

        app.get('/trackings/:trackingId/logs', async (req, res) => {
            const trackingId = req.params.trackingId
            const query = { trackingId }
            const result = await trackingsCollection.find(query).toArray()
            res.send(result)
        })

        app.get('/reviews', async (req, res) => {
            const cursor = reviewsCollection.find()
            const result = await cursor.toArray()
            res.send(result)
        })

    } finally {
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('Zap Shift is running!')
})

if (require.main === module) {
    app.listen(port, () => {
        console.log(`Example app listening on port ${port}`);
    });
} else {
    module.exports = app;
}
