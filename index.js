const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
//k payment get way
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const crypto = require("crypto");

//? firebase admin
const admin = require("firebase-admin");
admin.initializeApp({
    credential: cert({
        projectId: process.env.FB_PROJECT_ID,
        clientEmail: process.env.FB_CLIENT_EMAIL,
        privateKey: process.env.FB_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
});

function generateTrackingId() {
    const date = new Date();

    const datePart =
        date.getFullYear().toString() +
        String(date.getMonth() + 1).padStart(2, "0") +
        String(date.getDate()).padStart(2, "0");

    //? 5 random bytes = 10 hex characters
    const randomPart = crypto.randomBytes(5).toString("hex").toUpperCase();

    return `PKG-${datePart}-${randomPart}`;
}

//? middleware
app.use(express.json());
app.use(cors());

//? Custom middleware
const verifyFBToken = async (req, res, next) => {
    const token = req.headers.authorization;

    if (!token) {
        return res.status(401).send({ message: "Unauthorized access" });
    }

    try {
        const idToken = token.split(" ")[1];
        const decoded = await getAuth().verifyIdToken(idToken);
        req.decoded_email = decoded.email;
        next();
    } catch (err) {
        console.error("Token verification failed:", err.message);
        return res.status(403).send({ message: "Forbidden access" });
    }
};

//? mongobd user and password

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.ag6bkre.mongodb.net/?appName=Cluster0`;

//k Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

async function run() {
    try {
        //? Connect the client to the server	(optional starting in v4.7)
        await client.connect();
        const database = client.db("zap_shift_db");
        const userCollection = database.collection("users");
        const parcelsCollection = database.collection("parcels");
        const paymentCollection = database.collection("payments");
        const riderCollection = database.collection("riders");

        //? ---------------------------------------------------------------
        //k user related apis
        //? ---------------------------------------------------------------
        app.post("/users", async (req, res) => {
            const user = req.body;
            user.role = "user";
            user.createAt = new Date();
            const email = user.email;
            const userExits = await userCollection.findOne({ email });
            if (userExits) {
                return res.send({ message: "user already exist" });
            }
            const result = await userCollection.insertOne(user);
            res.send(result);
        });
        //? ---------------------------------------------------------------
        //k parcel api
        //? ---------------------------------------------------------------
        app.get("/parcels", async (req, res) => {
            try {
                const query = {};
                const { email } = req.query;
                //? ---------------------------------------------------------------
                //? parcels?email=''&
                if (email) {
                    query.senderEmail = email;
                }
                //? ---------------------------------------------------------------
                //?  sorted by date
                const options = { sort: { createAt: -1 } };

                const cursor = parcelsCollection.find(query, options);
                const result = await cursor.toArray();
                res.send(result);
            } catch (err) {
                console.error("GET /parcels error:", err);
                res.status(500).send({ message: "Failed to fetch parcels" });
            }
        });
        //? ---------------------------------------------------------------
        //k get parcel by id
        //? ---------------------------------------------------------------
        app.get("/parcels/:id", async (req, res) => {
            try {
                const id = req.params.id;
                const query = { _id: new ObjectId(id) };
                const result = await parcelsCollection.findOne(query);
                res.send(result);
            } catch (err) {
                console.error("GET /parcels/:id error:", err);
                res.status(500).send({ message: "Failed to fetch parcel" });
            }
        });
        //? ---------------------------------------------------------------
        app.post("/parcels", async (req, res) => {
            try {
                const parcel = req.body;

                // ? parcel created time
                parcel.createAt = new Date();

                const result = await parcelsCollection.insertOne(parcel);
                res.send(result);
            } catch (err) {
                console.error("POST /parcels error:", err);
                res.status(500).send({ message: "Failed to create parcel" });
            }
        });
        //? ---------------------------------------------------------------
        //k Delete parcel data by id
        //? ---------------------------------------------------------------
        app.delete("/parcels/:id", async (req, res) => {
            try {
                const id = req.params.id;
                const query = { _id: new ObjectId(id) };
                const result = await parcelsCollection.deleteOne(query);
                res.send(result);
            } catch (err) {
                console.error("DELETE /parcels/:id error:", err);
                res.status(500).send({ message: "Failed to delete parcel" });
            }
        });
        //? ---------------------------------------------------------------
        //k payment related apis new
        //? ---------------------------------------------------------------
        app.post("/create-checkout-session", async (req, res) => {
            try {
                const paymentInfo = req.body;
                const amount = parseInt(paymentInfo.price) * 100;
                const session = await stripe.checkout.sessions.create({
                    line_items: [
                        {
                            price_data: {
                                currency: "usd",
                                product_data: {
                                    name: `Please pay for: ${paymentInfo.parcelName}`,
                                },
                                unit_amount: amount,
                            },

                            quantity: 1,
                        },
                    ],
                    customer_email: paymentInfo.senderEmail,
                    mode: "payment",
                    metadata: {
                        parcelId: paymentInfo.parcelId,
                        parcelName: paymentInfo.parcelName,
                    },
                    success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
                });
                res.send({ url: session.url });
            } catch (err) {
                console.error("POST /create-checkout-session error:", err);
                res.status(500).send({
                    message: "Failed to create checkout session",
                });
            }
        });
        //? ---------------------------------------------------------------
        //k session id check and update
        //? ---------------------------------------------------------------
        app.patch("/payment-success", async (req, res) => {
            try {
                const sessionId = req.query.session_id;

                if (!sessionId) {
                    return res.status(400).send({
                        success: false,
                        message: "Missing session_id",
                    });
                }

                const session =
                    await stripe.checkout.sessions.retrieve(sessionId);

                if (session.payment_status !== "paid") {
                    return res.send({
                        success: false,
                        message: "Payment not completed",
                    });
                }

                const transactionId = session.payment_intent;

                const paymentExist = await paymentCollection.findOne({
                    transactionId,
                });
                if (paymentExist) {
                    return res.send({
                        success: true,
                        message: "Payment already recorded",
                        transactionId,
                        trackingId: paymentExist.trackingId,
                    });
                }

                const trackingId = generateTrackingId();
                const parcelId = session.metadata.parcelId;

                const result = await parcelsCollection.updateOne(
                    { _id: new ObjectId(parcelId) },
                    {
                        $set: {
                            paymentStatus: "paid",
                            trackingId,
                        },
                    },
                );

                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEmail: session.customer_email,
                    parcelId: session.metadata.parcelId,
                    parcelName: session.metadata.parcelName,
                    transactionId,
                    paymentStatus: session.payment_status,
                    paidAt: new Date(),
                    trackingId: trackingId,
                };
                const resultPayment =
                    await paymentCollection.insertOne(payment);

                return res.send({
                    success: true,
                    modifyParcel: result,
                    trackingId,
                    transactionId,
                    paymentInfo: resultPayment,
                });
            } catch (err) {
                console.error("payment-success error:", err);
                return res.status(500).send({
                    success: false,
                    message: "Server error verifying payment",
                });
            }
        });

        app.get("/payments", verifyFBToken, async (req, res) => {
            try {
                const { email } = req.query;
                const query = {};
                // console.log(req.headers.authorization)

                if (email) {
                    query.customerEmail = email;
                    if (email !== req.decoded_email) {
                        return res
                            .status(403)
                            .send({ message: "forbidden access " });
                    }
                }
                const cursor = paymentCollection
                    .find(query)
                    .sort({ paidAt: -1 });
                const result = await cursor.toArray();
                res.send(result);
            } catch (err) {
                console.error("GET /payments error:", err);
                res.status(500).send({ message: "Failed to fetch payments" });
            }
        });
        //? ---------------------------------------------------------------
        // k  ride related apis
        //? ---------------------------------------------------------------
        app.get('riders', async(req, res)=>{
            const query = {}
            if (req.query.status){
                query.status = req.query.status
            }
            const cursor = riderCollection.find(query)
            const result = await cursor.toArray(cursor)
            res.send(result)
        })

        app.post("/riders", async(req, res)=>{
            const rider = req.body;
            rider.status = "pending"
            rider.createAt = new Date()

            const result = await riderCollection.insertOne(rider)
            res.send(result)
        })

        //? ---------------------------------------------------------------
        //? Send a ping to confirm a successful connection
        //? ---------------------------------------------------------------

        await client.db("admin").command({ ping: 1 });
        console.log(
            "Pinged your deployment. You successfully connected to MongoDB!",
        );

        //? ---------------------------------------------------------------
        //? Start the server ONLY after routes are registered and DB is connected.
        //? This avoids the race condition where requests hit the server before
        //? MongoDB has connected and before the routes exist (which caused 404s).
        //? ---------------------------------------------------------------
        app.listen(port, () => {
            console.log(`Example app listening on port ${port}`);
        });

        //? this route doesn't depend on the DB, so it's safe to register anytime
        app.get("/", (req, res) => {
            res.send(" this is my server");
        });
    } catch (err) {
        console.error("Failed to start server:", err);
        process.exit(1);
    }
    //? Note: we intentionally do NOT close the client here.
    //? The connection needs to stay open for the lifetime of the server.
}
run();
