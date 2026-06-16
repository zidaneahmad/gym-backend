require("dotenv").config();
const express = require("express");
const midtransClient = require("midtrans-client");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const app = express();
app.use(express.json());

let serviceAccount;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error("FIREBASE_SERVICE_ACCOUNT kosong atau tidak ada!");
    process.exit(1);
  }
  serviceAccount = JSON.parse(raw);
  console.log("Service account berhasil diparsing, project_id:", serviceAccount.project_id);
} catch (e) {
  console.error("Gagal parse FIREBASE_SERVICE_ACCOUNT:", e.message);
  process.exit(1);
}

initializeApp({
  credential: cert({
    projectId: serviceAccount.project_id,
    clientEmail: serviceAccount.client_email,
    privateKey: serviceAccount.private_key.replace(/\\n/g, '\n'),
  }),
});
const db = getFirestore();

// ── Create Snap Token ──────────────────────────────────────
app.post("/create-token", async (req, res) => {
  const {packageId, packageName, price, memberName, email, uid} = req.body;

  if (!uid || !packageId || !price) {
    return res.status(400).json({error: "Data tidak lengkap"});
  }

  const snap = new midtransClient.Snap({
    isProduction: false,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
  });

  const orderId = `ORDER-${uid}-${Date.now()}`;

  try {
    const transaction = await snap.createTransaction({
      transaction_details: {
        order_id: orderId,
        gross_amount: price,
      },
      customer_details: {
        first_name: memberName,
        email: email,
      },
      item_details: [{
        id: packageId,
        price: price,
        quantity: 1,
        name: packageName,
      }],
    });

    await db.collection("orders").add({
      uid,
      packageId,
      packageName,
      orderId,
      amount: price,
      status: "pending",
      createdAt: new Date(),
    });

    return res.json({token: transaction.token, orderId});
  } catch (err) {
    console.error("create-token error:", err.message);
    return res.status(500).json({error: err.message});
  }
});

// ── Webhook Midtrans ───────────────────────────────────────
app.post("/webhook", async (req, res) => {
  console.log("=== WEBHOOK MASUK ===");
  console.log(req.body);

  const {order_id, transaction_status, fraud_status} = req.body;

  const isSuccess =
    (transaction_status === "capture" && fraud_status === "accept") ||
    transaction_status === "settlement";

  if (isSuccess) {
    try {
      const orderSnap = await db.collection("orders")
        .where("orderId", "==", order_id)
        .get();

      if (!orderSnap.empty) {
        const orderDoc = orderSnap.docs[0];
        const orderData = orderDoc.data();

        await orderDoc.ref.update({status: "paid"});

        const pkgSnap = await db
          .collection("membership_packages")
          .doc(orderData.packageId)
          .get();

        if (pkgSnap.exists) {
          const pkg = pkgSnap.data();
          const startDate = Date.now();
          const endDate = startDate + (pkg.durationInDays * 24 * 60 * 60 * 1000);

          await db.collection("members").doc(orderData.uid).update({
            activePackageId: orderData.packageId,
            startDate,
            endDate,
            isActive: true,
            pricePaid: orderData.amount,
});
        }
      }
    } catch (err) {
      console.error("Webhook error:", err.message);
    }
  }

  res.sendStatus(200);
});

// ── Health check ───────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("Gym backend is running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));