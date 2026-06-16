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
  const { packageId, packageName, price, memberName, email, uid } = req.body;

  if (!uid || !packageId || !price) {
    return res.status(400).json({ error: "Data tidak lengkap" });
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

    console.log("=== CREATE TOKEN DIPANGGIL ===");
    console.log(req.body);

    const orderRef = await db.collection("orders").add({
      uid,
      packageId,
      packageName,
      orderId,
      amount: price,
      status: "pending",
      createdAt: new Date(),
    });

    console.log("=== ORDER TERSIMPAN ===");
    console.log("Firestore Doc ID:", orderRef.id);
    console.log("Midtrans Order ID:", orderId);

    return res.json({ token: transaction.token, orderId });
  } catch (err) {
    console.error("create-token error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Webhook Midtrans ───────────────────────────────────────
app.post("/webhook", async (req, res) => {
  console.log("=== WEBHOOK MASUK ===");
  console.log(req.body);

  const { order_id, transaction_status, fraud_status } = req.body;

  const isSuccess =
    (transaction_status === "capture" && fraud_status === "accept") ||
    transaction_status === "settlement";

  if (isSuccess) {
    try {
      const orderSnap = await db.collection("orders")
        .where("orderId", "==", order_id)
        .get();

      console.log("Order ditemukan:", orderSnap.size);

      if (!orderSnap.empty) {
        const orderDoc = orderSnap.docs[0];
        const orderData = orderDoc.data();

        if (orderData.status === "paid") {
          console.log("Order sudah paid, skip");
          return res.sendStatus(200);
        }

        await orderDoc.ref.update({ status: "paid" });
        console.log("Status order berhasil diupdate menjadi paid");

        const pkgSnap = await db
          .collection("membership_packages")
          .doc(orderData.packageId)
          .get();

        console.log("Package exists:", pkgSnap.exists);

        if (pkgSnap.exists) {
          const pkg = pkgSnap.data();
          const duration = Number(pkg.duration || 0);
          const durationMs = duration * 24 * 60 * 60 * 1000;

          const memberSnap = await db.collection("members")
            .doc(orderData.uid)
            .get();
          const memberData = memberSnap.data();

          const now = Date.now();

          
          const currentEndDate = memberData?.endDate || 0;
          const baseDate = currentEndDate > now ? currentEndDate : now;
          const newEndDate = baseDate + durationMs;

          const newStartDate = currentEndDate > now
            ? memberData.startDate  
            : now;                  

          const currentPricePaid = memberData?.pricePaid || 0;
          const newPricePaid = currentPricePaid + orderData.amount;

          console.log("currentEndDate:", new Date(currentEndDate));
          console.log("newEndDate:", new Date(newEndDate));
          console.log("newPricePaid:", newPricePaid);

          await db.collection("members").doc(orderData.uid).update({
            activePackageId: orderData.packageId,
            startDate: newStartDate,       
            endDate: newEndDate,           
            isActive: true,
            pricePaid: newPricePaid,       
          });

          console.log("Member berhasil diupdate");
        }
      }
    } catch (err) {
      console.error("Webhook error lengkap:", err);
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