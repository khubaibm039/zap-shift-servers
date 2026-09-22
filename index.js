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
// const serviceAccount = require("./firebase-admin-key.json");

// const decoded = Buffer.from(process.env.FB_PRIVATE_KEY, "base64").toString(
//     "utf8",
// );
const serviceAccount = JSON.parse(decoded);
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
        const trackingsCollection = database.collection("trackings");
        //? ---------------------------------------------------------------
        //k middleware with database access
        //k must be used after verifyFBToken middleware
        //? ---------------------------------------------------------------
        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded_email;
            const query = { email };
            const user = await userCollection.findOne(query);
            if (!user || user.role !== "admin") {
                return res.status(403).send({ message: "forbidden access" });
            }
            next();
        };
        //k verify rider
        const verifyRider = async (req, res, next) => {
            const email = req.decoded_email;
            const query = { email };
            const user = await userCollection.findOne(query);
            if (!user || user.role !== "rider") {
                return res.status(403).send({ message: "forbidden access" });
            }
            next();
        };
        //k tracking related function
        const logTracking = async (trackingId, status) => {
            const log = {
                trackingId,
                status,
                details: status.split("_").join(" "),
                createAt: new Date(),
            };
            const result = await trackingsCollection.insertOne(log);
            return result;
        };
        //? ---------------------------------------------------------------
        //k user related apis
        //? ---------------------------------------------------------------
        app.get("/users", verifyFBToken, async (req, res) => {
            const searchText = req.query.searchText;
            const query = {};
            if (searchText) {
                // query.displayName ={$regex: searchText, $options: 'i'}
                query.$or = [
                    { displayName: { $regex: searchText, $options: "i" } },
                    { email: { $regex: searchText, $options: "i" } },
                ];
            }

            const cursor = userCollection
                .find(query)
                .sort({ createAt: -1 })
                .limit(5);
            const result = await cursor.toArray();
            res.send(result);
        });
        app.get("/users/:email/role", async (req, res) => {
            const email = req.params.email;
            const query = { email };
            const user = await userCollection.findOne(query);
            res.send({ role: user?.role || "user" });
        });
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
        app.patch(
            "/users/:id/role",
            verifyFBToken,
            verifyAdmin,
            async (req, res) => {
                const id = req.params.id;
                const roleInfo = req.body;
                const query = { _id: new ObjectId(id) };
                const updateRole = {
                    $set: {
                        role: roleInfo.role,
                    },
                };
                const result = await userCollection.updateOne(
                    query,
                    updateRole,
                );
                res.send(result);
            },
        );
        //? ---------------------------------------------------------------
        //k parcel api
        //? ---------------------------------------------------------------
        app.get("/parcels", async (req, res) => {
            try {
                const query = {};
                const { email, deliveryStatus } = req.query;
                if (deliveryStatus) {
                    query.deliveryStatus = deliveryStatus;
                }
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
        app.get("/parcels/rider", async (req, res) => {
            const { riderEmail, deliveryStatus } = req.query;
            const query = {};
            if (riderEmail) {
                query.riderEmail = riderEmail;
            }
            if (deliveryStatus !== "parcel_delivered") {
                // query.deliveryStatus = {$in: ["driver_assigned", "rider_arriving" ]};
                query.deliveryStatus = { $nin: ["parcel_delivered"] };
            } else {
                query.deliveryStatus = deliveryStatus;
            }
            const cursor = parcelsCollection.find(query);
            const result = await cursor.toArray();
            res.send(result);
        });

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
        app.get("/parcels/delivery-status/stats", async (req, res) => {
            const pipeline = [
                {
                    $group: {
                        _id: "$deliveryStatus",
                        count: { $sum: 1 },
                    },
                },
            ];
            const result = await parcelsCollection
                .aggregate(pipeline)
                .toArray();
            res.send(result);
        });
        app.post("/parcels", async (req, res) => {
            try {
                const parcel = req.body;
                const trackingId = generateTrackingId();
                // ? parcel created time
                parcel.createAt = new Date();
                parcel.trackingId = trackingId;
                logTracking(trackingId, "parcel_created");
                const result = await parcelsCollection.insertOne(parcel);
                res.send(result);
            } catch (err) {
                console.error("POST /parcels error:", err);
                res.status(500).send({ message: "Failed to create parcel" });
            }
        });
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
        app.patch("/parcels/:id", async (req, res) => {
            const { riderId, riderName, riderEmail, trackingId } = req.body;
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };

            const parcelUpdateDoc = {
                $set: {
                    deliveryStatus: "driver_assigned",
                    riderId: riderId,
                    riderName: riderName,
                    riderEmail: riderEmail,
                },
            };
            const parcelsResult = await parcelsCollection.updateOne(
                query,
                parcelUpdateDoc,
            );

            const riderQuery = { _id: new ObjectId(riderId) };
            const riderUpdateDoc = {
                $set: {
                    workStatus: "in_delivery",
                },
            };
            const riderResult = await riderCollection.updateOne(
                riderQuery,
                riderUpdateDoc,
            );
            //K log tracking
            logTracking(trackingId, "driver_assigned");

            res.send(riderResult, parcelsResult);
        });
        app.patch("/parcels/:id/status", async (req, res) => {
            const { deliveryStatus, riderId, trackingId } = req.body;
            const query = { _id: new ObjectId(req.params.id) };
            const updateDoc = {
                $set: {
                    deliveryStatus: deliveryStatus,
                },
            };
            if (deliveryStatus === "parcel_delivered") {
                const riderQuery = { _id: new ObjectId(riderId) };
                const riderUpdateDoc = {
                    $set: {
                        workStatus: "available",
                    },
                };
                const riderResult = await riderCollection.updateOne(
                    riderQuery,
                    riderUpdateDoc,
                );
            }
            const result = await parcelsCollection.updateOne(query, updateDoc);
            //k log tracking
            logTracking(trackingId, deliveryStatus);
            res.send(result);
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
                        trackingId: paymentInfo.trackingId,
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
                const trackingId = session.metadata.trackingId;
                const parcelId = session.metadata.parcelId;

                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEmail: session.customer_email,
                    parcelId,
                    parcelName: session.metadata.parcelName,
                    transactionId,
                    paymentStatus: session.payment_status,
                    paidAt: new Date(),
                    trackingId,
                };

                // Atomic: inserts only if transactionId doesn't already exist.
                // If it does, this just leaves the existing doc alone — no race window.
                const upsertResult = await paymentCollection.updateOne(
                    { transactionId },
                    { $setOnInsert: payment },
                    { upsert: true },
                );

                const isNewPayment = upsertResult.upsertedCount > 0;

                // Only update the parcel + log tracking the first time this payment is recorded
                if (isNewPayment) {
                    await parcelsCollection.updateOne(
                        { _id: new ObjectId(parcelId) },
                        {
                            $set: {
                                paymentStatus: "paid",
                                deliveryStatus: "parcel_paid",
                            },
                        },
                    );
                    logTracking(trackingId, "pending-pickup");
                }

                return res.send({
                    success: true,
                    message: isNewPayment
                        ? "Payment recorded"
                        : "Payment already recorded",
                    transactionId,
                    trackingId,
                });
            } catch (err) {
                console.error("payment-success error:", err);
                return res.status(500).send({
                    success: false,
                    message: "Server error verifying payment",
                });
            }
        });
        // app.patch("/payment-success", async (req, res) => {
        //     try {
        //         const sessionId = req.query.session_id;

        //         if (!sessionId) {
        //             return res.status(400).send({
        //                 success: false,
        //                 message: "Missing session_id",
        //             });
        //         }

        //         const session =
        //             await stripe.checkout.sessions.retrieve(sessionId);

        //         if (session.payment_status !== "paid") {
        //             return res.send({
        //                 success: false,
        //                 message: "Payment not completed",
        //             });
        //         }

        //         const transactionId = session.payment_intent;

        //         const paymentExist = await paymentCollection.findOne({
        //             transactionId,
        //         });
        //         if (paymentExist) {
        //             return res.send({
        //                 success: true,
        //                 message: "Payment already recorded",
        //                 transactionId,
        //                 trackingId: paymentExist.trackingId,
        //             });
        //         }

        //         const trackingId = session.metadata.trackingId;

        //         const parcelId = session.metadata.parcelId;

        //         const result = await parcelsCollection.updateOne(
        //              { _id: new ObjectId(parcelId) },
        //             {
        //                 $set: {
        //                     paymentStatus: "paid",
        //                     deliveryStatus: "parcel_paid",
        //                 },
        //             },
        //         );

        //         const payment = {
        //             amount: session.amount_total / 100,
        //             currency: session.currency,
        //             customerEmail: session.customer_email,
        //             parcelId: session.metadata.parcelId,
        //             parcelName: session.metadata.parcelName,
        //             transactionId,
        //             paymentStatus: session.payment_status,
        //             paidAt: new Date(),
        //             trackingId: trackingId,
        //         };
        //         if (session.payment_status === "paid") {
        //             const resultPayment =
        //                 await paymentCollection.insertOne(payment);
        //             logTracking(trackingId, "pending-pickup");

        //             return res.send({
        //                 success: true,
        //                 modifyParcel: result,
        //                 trackingId,
        //                 transactionId,
        //                 paymentInfo: resultPayment,
        //             });
        //         }
        //     } catch (err) {
        //         console.error("payment-success error:", err);
        //         return res.status(500).send({
        //             success: false,
        //             message: "Server error verifying payment",
        //         });
        //     }
        // });
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
        //k  ride related apis
        //? ---------------------------------------------------------------
        app.get("/riders", async (req, res) => {
            const { status, district, workStatus } = req.query;
            const query = {};
            if (status) {
                query.status = status;
            }
            if (district) {
                query.district = district;
            }
            if (workStatus) {
                query.workStatus = workStatus;
            }
            const cursor = riderCollection.find(query);
            const result = await cursor.toArray(cursor);
            res.send(result);
        });
        app.get("/riders/delivery-per-day", async (req, res) => {
            const email = req.query.email;

            const pipeline = [
                {
                    $match: {
                        riderEmail: email,
                        deliveryStatus: "parcel_delivered",
                    },
                },
            ];
            const result = await parcelsCollection
                .aggregate(pipeline)
                .toArray();
            res.send(result);
        });
        app.post("/riders", async (req, res) => {
            const rider = req.body;
            rider.status = "pending";
            rider.createAt = new Date();

            const result = await riderCollection.insertOne(rider);
            res.send(result);
        });

        app.patch(
            "/riders/:id",
            verifyFBToken,
            verifyRider,
            async (req, res) => {
                const status = req.body.status;
                const id = req.params.id;
                const query = { _id: new ObjectId(id) };
                const updatedDoc = {
                    $set: {
                        status: status,
                        workStatus: "available",
                    },
                };
                const result = await riderCollection.updateOne(
                    query,
                    updatedDoc,
                );

                if (status === "approved") {
                    const email = req.body.email;
                    const userQuery = { email };
                    const updateUser = {
                        $set: {
                            role: "rider",
                        },
                    };
                    const userResult = await userCollection.updateOne(
                        userQuery,
                        updateUser,
                    );
                }

                res.send(result);
            },
        );
        app.delete("/riders/:id", async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await riderCollection.deleteOne(query);
            res.send(result);
        });
        //? ---------------------------------------------------------------
        //k tracking related Apis
        //? ---------------------------------------------------------------
        app.get("/trackings/:trackingId/logs", async (req, res) => {
            const trackingId = req.params.trackingId;
            const query = { trackingId };
            const result = await trackingsCollection.find(query).toArray();
            res.send(result);
        });

        //? ---------------------------------------------------------------
        //? Send a ping to confirm a successful connection
        //? ---------------------------------------------------------------

        // await client.db("admin").command({ ping: 1 });
        // console.log(
        //     "Pinged your deployment. You successfully connected to MongoDB!",
        // );

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
