const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");

dotenv.config();

const uri = process.env.MONGODB_URI;
const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = [
  process.env.CLIENT_URL,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
].filter(Boolean);

app.use(
  cors({
    credentials: true,
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl) or in allowed list
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("CORS: origin not allowed")); // Deny all other origins
    },
  }),
);
app.use(express.json());

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL}/api/auth/jwks`),
);

let ticketsCollection;
let usersCollection;
let BookedTicketsCollection;
let reviewsCollection;

//  AUTHENTICATION & AUTHORIZATION MIDDLEWARES

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer")) {
    return res.status(401).json({ msg: "Unauthorized access" });
  }
  const token = authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "Unauthorized access" });

  try {
    const { payload } = await jwtVerify(token, JWKS);
    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ msg: "Unauthorized. Invalid token" });
  }
};

const verifyVendor = async (req, res, next) => {
  try {
    const user = await usersCollection.findOne({ email: req.user?.email });
    if (!user || user.role !== "vendor") {
      return res.status(403).json({ message: "Forbidden access" });
    }
    next();
  } catch (error) {
    res.status(500).json({ message: "Internal server error" });
  }
};

const verifyAdmin = async (req, res, next) => {
  try {
    const user = await usersCollection.findOne({ email: req.user?.email });
    if (!user || user.role !== "admin") {
      return res.status(403).json({ message: "Forbidden access" });
    }
    next();
  } catch (error) {
    res.status(500).json({ message: "Internal server error" });
  }
};

// ALL API ROUTES START HERE

// async function run() {
//     try {
        // Connect the client to the server (optional starting in v4.7)
        // await client.connect();
    const db = client.db("TravelHub");

    ticketsCollection = db.collection("tickets");
    usersCollection = db.collection("user");
    BookedTicketsCollection = db.collection("booked_tickets");
    reviewsCollection = db.collection("reviews");

    // Get all tickets with pagination, filters & search
    app.get("/api/tickets", async (req, res) => {
      try {
        const {
          email,
          status,
          from,
          to,
          type,
          sortPrice,
          page = 1,
          limit = 6,
        } = req.query;
        let query = {};

        if (email) query.vendorEmail = email;
        if (status) query.verificationStatus = status;
        if (from) query.from = { $regex: from, $options: "i" };
        if (to) {
          query.$or = [
            { to: { $regex: to, $options: "i" } },
            { title: { $regex: to, $options: "i" } },
            { location: { $regex: to, $options: "i" } },
          ];
        }
        if (type && type !== "All") query.type = type;

        let sortOptions = { _id: -1 };
        if (sortPrice === "asc") sortOptions = { price: 1 };
        if (sortPrice === "desc") sortOptions = { price: -1 };

        const pageNumber = parseInt(page);
        const limitNumber = parseInt(limit);
        const skip = (pageNumber - 1) * limitNumber;

        const totalTickets = await ticketsCollection.countDocuments(query);
        const totalPages = Math.ceil(totalTickets / limitNumber);

        const tickets = await ticketsCollection
          .find(query)
          .sort(sortOptions)
          .skip(skip)
          .limit(limitNumber)
          .toArray();
        res
          .status(200)
          .json({ tickets, totalPages, currentPage: pageNumber, totalTickets });
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Get only advertised tickets for homepage
    app.get("/api/tickets/advertised", async (req, res) => {
      try {
        const advertisedTickets = await ticketsCollection
          .find({ isAdvertised: true })
          .toArray();
        res.status(200).json(advertisedTickets);
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Get a single ticket's details
    app.get("/api/tickets/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id))
          return res.status(400).json({ message: "Invalid ticket ID" });
        const ticket = await ticketsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!ticket)
          return res.status(404).json({ message: "Ticket not found" });
        res.status(200).json(ticket);
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Background Cron/Interval: Auto-expire pending seat locks older than 10 minutes (runs every 30s)
    setInterval(async () => {
      try {
        if (!BookedTicketsCollection) return;
        const nowIso = new Date().toISOString();
        const expiredResult = await BookedTicketsCollection.updateMany(
          {
            status: "pending",
            expiresAt: { $lt: nowIso },
          },
          {
            $set: { status: "expired" },
          },
        );
        if (expiredResult.modifiedCount > 0) {
          console.log(
            `[Seat Lock Engine] 🕒 Released ${expiredResult.modifiedCount} expired seat reservation(s) at ${new Date().toLocaleTimeString()}`,
          );
        }
      } catch (err) {
        console.error("[Seat Lock Cleaner Error]:", err);
      }
    }, 30000);

    // Get live seat availability & locked seats for a specific ticket
    app.get("/api/tickets/:id/seats", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id))
          return res.status(400).json({ message: "Invalid ticket ID" });

        const ticket = await ticketsCollection.findOne({ _id: new ObjectId(id) });
        if (!ticket)
          return res.status(404).json({ message: "Ticket not found" });

        const nowIso = new Date().toISOString();

        // 1. Fetch active, unexpired pending locks (within 10-minute hold window)
        const activeLocks = await BookedTicketsCollection.find({
          ticketId: id,
          status: "pending",
          expiresAt: { $gt: nowIso },
        }).toArray();

        const lockedSeats = [];
        activeLocks.forEach((b) => {
          if (Array.isArray(b.seats)) {
            b.seats.forEach((s) => {
              lockedSeats.push({
                seat: s,
                userEmail: b.userEmail,
                expiresAt: b.expiresAt,
              });
            });
          }
        });

        // 2. Fetch all paid/confirmed seats
        const paidBookings = await BookedTicketsCollection.find({
          ticketId: id,
          status: "paid",
        }).toArray();

        const bookedSeatsSet = new Set(ticket.bookedSeats || []);
        paidBookings.forEach((b) => {
          if (Array.isArray(b.seats)) {
            b.seats.forEach((s) => bookedSeatsSet.add(s));
          }
        });

        const totalCapacity = Number(ticket.capacity || 40);

        res.status(200).json({
          ticketId: id,
          totalCapacity,
          availableQuantity: Number(ticket.quantity || 0),
          bookedSeats: Array.from(bookedSeatsSet),
          lockedSeats: lockedSeats,
          lockDurationMinutes: 10,
        });
      } catch (error) {
        console.error("Error fetching seat status:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // User: Book / Reserve seats with temporary 10-minute seat lock (Phase 4)
    app.post("/api/bookings", verifyToken, async (req, res) => {
      try {
        const bookingData = req.body;
        const ticketId = bookingData.ticketId;
        const selectedSeats = Array.isArray(bookingData.seats)
          ? bookingData.seats
          : Array.isArray(bookingData.selectedSeats)
            ? bookingData.selectedSeats
            : [];

        const userEmail = bookingData.userEmail || req.user?.email;
        const quantity = Number(bookingData.quantity || selectedSeats.length || 1);

        if (!ObjectId.isValid(ticketId)) {
          return res.status(400).json({ success: false, message: "Invalid ticket ID" });
        }

        const ticket = await ticketsCollection.findOne({ _id: new ObjectId(ticketId) });
        if (!ticket) {
          return res.status(404).json({ success: false, message: "Ticket not found" });
        }

        if (Number(ticket.quantity || 0) < quantity) {
          return res.status(400).json({
            success: false,
            message: "Not enough seats available for this journey.",
          });
        }

        const now = new Date();
        const nowIso = now.toISOString();

        // Check if any selected seat is already permanently booked/paid
        if (selectedSeats.length > 0) {
          const alreadyPaid = await BookedTicketsCollection.findOne({
            ticketId: ticketId,
            status: "paid",
            seats: { $in: selectedSeats },
          });

          const ticketBookedSeats = ticket.bookedSeats || [];
          const hasDirectConflict = selectedSeats.some((s) => ticketBookedSeats.includes(s));

          if (alreadyPaid || hasDirectConflict) {
            return res.status(409).json({
              success: false,
              message: "One or more of the selected seats have already been purchased by another traveller.",
            });
          }

          // Check if any selected seat is locked by an unexpired reservation from another user
          const activeLockConflict = await BookedTicketsCollection.findOne({
            ticketId: ticketId,
            status: "pending",
            expiresAt: { $gt: nowIso },
            userEmail: { $ne: userEmail },
            seats: { $in: selectedSeats },
          });

          if (activeLockConflict) {
            return res.status(409).json({
              success: false,
              message: "One or more of the selected seats are temporarily locked in checkout by another user. Locks expire automatically after 10 minutes if unpaid.",
            });
          }
        }

        // Set 10-minute hold window for checkout
        const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();

        // Clear any previous pending reservations for this specific user & ticket
        await BookedTicketsCollection.deleteMany({
          ticketId: ticketId,
          userEmail: userEmail,
          status: "pending",
        });

        const newBookingRecord = {
          ticketId: ticketId,
          ticketTitle: bookingData.ticketTitle || ticket.title,
          vendorEmail: bookingData.vendorEmail || ticket.vendorEmail,
          userEmail: userEmail,
          userName: bookingData.userName || req.user?.name || "Passenger",
          quantity: quantity,
          seats: selectedSeats,
          totalPrice: Number(bookingData.totalPrice || ticket.price * quantity),
          status: "pending",
          bookingDate: nowIso,
          expiresAt: expiresAt,
          lockedUntil: expiresAt,
        };

        const result = await BookedTicketsCollection.insertOne(newBookingRecord);

        res.status(201).json({
          success: true,
          message: "Seats reserved & locked for 10 minutes. Please complete payment.",
          bookingId: result.insertedId,
          expiresAt: expiresAt,
          lockedSeats: selectedSeats,
        });
      } catch (error) {
        console.error("Error creating booking with seat lock:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
      }
    });

    // User: Get all personal booked tickets
    app.get("/api/bookings/user/:email", verifyToken, async (req, res) => {
      try {
        const email = req.params.email;
        const caller = await usersCollection.findOne({ email: req.user?.email });
        if (caller?.role !== "admin" && req.user?.email !== email) {
          return res.status(403).json({ message: "Forbidden: Access denied" });
        }

        const bookings = await BookedTicketsCollection.aggregate([
          { $match: { userEmail: email } },
          { $addFields: { ticketObjId: { $toObjectId: "$ticketId" } } },
          {
            $lookup: {
              from: "tickets",
              localField: "ticketObjId",
              foreignField: "_id",
              as: "ticketDetails",
            },
          },
          { $unwind: "$ticketDetails" },
        ])
          .sort({ _id: -1 })
          .toArray();
        res.status(200).json(bookings);
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // User: Get personal transaction history (Paid bookings)
    app.get("/api/transactions/:email", verifyToken, async (req, res) => {
      try {
        const email = req.params.email;
        const caller = await usersCollection.findOne({ email: req.user?.email });
        if (caller?.role !== "admin" && req.user?.email !== email) {
          return res.status(403).json({ message: "Forbidden: Access denied" });
        }

        const transactions = await BookedTicketsCollection.aggregate([
          { $match: { userEmail: email, status: "paid" } },
          { $addFields: { ticketObjId: { $toObjectId: "$ticketId" } } },
          {
            $lookup: {
              from: "tickets",
              localField: "ticketObjId",
              foreignField: "_id",
              as: "ticketDetails",
            },
          },
          { $unwind: "$ticketDetails" },
        ])
          .sort({ _id: -1 })
          .toArray();
        res.status(200).json(transactions);
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // User: Update booking status to "paid" & release lock into confirmed booking
    app.patch("/api/bookings/:id/pay", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: "Invalid booking ID" });
        }

        const booking = await BookedTicketsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!booking)
          return res.status(404).json({ message: "Booking reservation not found" });

        // Idempotency check: if already paid (e.g. by Webhook or previous call), do NOT decrement stock again!
        if (booking.status === "paid") {
          return res.status(200).json({
            message: "Payment already confirmed. Seats secured!",
            seats: Array.isArray(booking.seats) ? booking.seats : [],
          });
        }

        // Check if reservation expired
        const now = new Date();
        if (
          booking.status === "expired" ||
          (booking.status === "pending" && booking.expiresAt && new Date(booking.expiresAt) < now)
        ) {
          await BookedTicketsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: "expired" } },
          );
          return res.status(410).json({
            message: "Seat reservation lock has expired (10-minute limit). Please choose your seats again.",
          });
        }

        const qtyToReduce = Number(booking.quantity || booking.bookingQuantity || (booking.seats?.length || 1));
        const bookingSeats = Array.isArray(booking.seats) ? booking.seats : [];

        await BookedTicketsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: "paid",
              paidAt: now.toISOString(),
            },
          },
        );

        if (booking.ticketId && ObjectId.isValid(booking.ticketId)) {
          await ticketsCollection.updateOne(
            { _id: new ObjectId(booking.ticketId) },
            {
              $inc: { quantity: -qtyToReduce },
              $addToSet: { bookedSeats: { $each: bookingSeats } },
            },
          );
        }

        res.status(200).json({ message: "Payment successful. Seats confirmed!", seats: bookingSeats });
      } catch (error) {
        console.error("Error processing booking payment:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // User: Cancel a pending seat reservation / hold immediately (releases seat lock)
    app.patch("/api/bookings/:id/cancel", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid booking ID" });

        const booking = await BookedTicketsCollection.findOne({ _id: new ObjectId(id) });
        if (!booking) return res.status(404).json({ message: "Booking reservation not found" });

        const caller = await usersCollection.findOne({ email: req.user?.email });
        const isOwner = booking.userEmail === req.user?.email;
        const isAdmin = caller?.role === "admin";

        if (!isOwner && !isAdmin) {
          return res.status(403).json({ message: "Forbidden: You can only cancel your own reservations" });
        }

        if (booking.status === "paid") {
          return res.status(400).json({ message: "Paid bookings cannot be cancelled directly here" });
        }

        // Set status to cancelled so seat is instantly available for others
        await BookedTicketsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: "cancelled", cancelledAt: new Date().toISOString() } }
        );

        res.status(200).json({ success: true, message: "Seat hold cancelled and released successfully" });
      } catch (error) {
        console.error("Error cancelling booking hold:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Internal Stripe Webhook: Mark booking as paid — secured by shared webhook secret (NOT user JWT)
    app.patch("/api/bookings/:id/pay/webhook", async (req, res) => {
      try {
        const incomingSecret = req.headers["x-webhook-secret"];
        const expectedSecret = process.env.STRIPE_WEBHOOK_SECRET;

        if (!expectedSecret || incomingSecret !== expectedSecret) {
          return res.status(401).json({ message: "Unauthorized: invalid webhook secret" });
        }

        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: "Invalid booking ID" });
        }

        const booking = await BookedTicketsCollection.findOne({ _id: new ObjectId(id) });
        if (!booking) return res.status(404).json({ message: "Booking not found" });

        // Idempotency: already paid, skip quietly
        if (booking.status === "paid") {
          return res.status(200).json({ message: "Already paid" });
        }

        const now = new Date();
        const qtyToReduce = Number(booking.quantity || booking.seats?.length || 1);
        const bookingSeats = Array.isArray(booking.seats) ? booking.seats : [];

        await BookedTicketsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: "paid", paidAt: now.toISOString(), stripeSessionId: req.body?.stripeSessionId } },
        );

        if (booking.ticketId && ObjectId.isValid(booking.ticketId)) {
          await ticketsCollection.updateOne(
            { _id: new ObjectId(booking.ticketId) },
            {
              $inc: { quantity: -qtyToReduce },
              $addToSet: { bookedSeats: { $each: bookingSeats } },
            },
          );
        }

        console.log(`[Stripe Webhook] ✅ Booking ${id} confirmed & seats locked.`);
        res.status(200).json({ message: "Booking confirmed via Stripe webhook", seats: bookingSeats });
      } catch (error) {
        console.error("Error processing webhook pay:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // User: Update personal profile data (Name, Image) — requires auth + ownership
    app.patch("/api/user/:email", verifyToken, async (req, res) => {
      try {
        const email = req.params.email;

        // Ownership check: authenticated user can only update their own profile
        if (req.user?.email !== email) {
          return res.status(403).json({ success: false, message: "Forbidden: You can only update your own profile" });
        }

        const { name, image } = req.body;
        let updateDoc = { $set: {} };
        if (name) updateDoc.$set.name = name;
        if (image) updateDoc.$set.image = image;

        const result = await usersCollection.updateOne(
          { email: email },
          updateDoc,
        );
        if (result.matchedCount > 0) {
          res.status(200).json({ success: true, message: "Profile updated" });
        } else {
          res.status(404).json({ success: false, message: "User not found" });
        }
      } catch (error) {
        res
          .status(500)
          .json({ success: false, message: "Internal server error" });
      }
    });

    // Admin or Vendor: Update ticket
    // Admins can approve/reject tickets; Vendors can update only their own tickets
    app.patch(
      "/api/tickets/:id",
      verifyToken,
      async (req, res) => {
        try {
          const { id } = req.params;
          if (!ObjectId.isValid(id))
            return res.status(400).json({ message: "Invalid ticket ID" });

          const ticket = await ticketsCollection.findOne({ _id: new ObjectId(id) });
          if (!ticket)
            return res.status(404).json({ message: "Ticket not found" });

          const user = await usersCollection.findOne({ email: req.user?.email });
          if (!user) return res.status(401).json({ message: "User not found" });

          const isAdmin = user.role === "admin";
          const isOwnerVendor = user.role === "vendor" && ticket.vendorEmail === req.user?.email;

          if (!isAdmin && !isOwnerVendor) {
            return res.status(403).json({ message: "Forbidden: You are not authorized to edit this ticket" });
          }

          const updatedData = req.body;
          const result = await ticketsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: updatedData },
          );
          if (result.matchedCount === 0)
            return res.status(404).json({ message: "Ticket not found" });
          res.status(200).json({ message: "Ticket updated" });
        } catch (error) {
          res.status(500).json({ message: "Internal server error" });
        }
      },
    );

    // Vendor: Create a new ticket(done)
    app.post("/api/tickets", verifyToken, verifyVendor, async (req, res) => {
      try {
        const ticket = req.body;
        const vendor = await usersCollection.findOne({
          email: req.user?.email,
        });
        if (vendor && vendor.isFraud) {
          return res
            .status(403)
            .json({ message: "Fraudulent vendors cannot add tickets" });
        }
        ticket.vendorEmail = req.user?.email;
        ticket.vendorName = vendor?.name || ticket.vendorName || "Transport Operator";
        const result = await ticketsCollection.insertOne(ticket);
        res
          .status(201)
          .json({ message: "Ticket created", id: result.insertedId });
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });
    
    // Vendor or Admin: Delete ticket (Admin can delete any, Vendor can delete only their own)
    app.delete(
      "/api/tickets/:id",
      verifyToken,
      async (req, res) => {
        try {
          const { id } = req.params;
          if (!ObjectId.isValid(id))
            return res.status(400).json({ message: "Invalid ticket ID" });

          const ticket = await ticketsCollection.findOne({ _id: new ObjectId(id) });
          if (!ticket)
            return res.status(404).json({ message: "Ticket not found" });

          const user = await usersCollection.findOne({ email: req.user?.email });
          if (!user) return res.status(401).json({ message: "Unauthorized" });

          const isAdmin = user.role === "admin";
          const isOwnerVendor = user.role === "vendor" && ticket.vendorEmail === req.user?.email;

          if (!isAdmin && !isOwnerVendor) {
            return res.status(403).json({ message: "Forbidden: You can only delete your own tickets" });
          }

          const result = await ticketsCollection.deleteOne({
            _id: new ObjectId(id),
          });
          if (result.deletedCount === 0)
            return res.status(404).json({ message: "Ticket not found" });
          res.status(200).json({ message: "Ticket deleted" });
        } catch (error) {
          res.status(500).json({ message: "Internal server error" });
        }
      },
    );

    // Vendor: Get all booking requests sent to this vendor (done)
    app.get(
      "/api/bookings/vendor/:email",
      verifyToken,
      async (req, res) => {
        try {
          const email = req.params.email;
          const user = await usersCollection.findOne({ email: req.user?.email });
          if (!user) return res.status(401).json({ message: "Unauthorized" });
          if (user.role !== "admin" && (user.role !== "vendor" || req.user?.email !== email)) {
            return res.status(403).json({ message: "Forbidden: Access denied" });
          }

          const bookings = await BookedTicketsCollection.find({
            vendorEmail: email,
          }).toArray();
          res.status(200).json(bookings);
        } catch (error) {
          res.status(500).json({ message: "Internal server error" });
        }
      },
    );

    // Vendor or Admin: Accept or Reject a user's booking request(done)
    app.patch(
      "/api/bookings/:id/status",
      verifyToken,
      async (req, res) => {
        try {
          const id = req.params.id;
          if (!ObjectId.isValid(id))
            return res.status(400).json({ message: "Invalid booking ID" });

          const booking = await BookedTicketsCollection.findOne({ _id: new ObjectId(id) });
          if (!booking)
            return res.status(404).json({ message: "Booking not found" });

          const user = await usersCollection.findOne({ email: req.user?.email });
          if (!user) return res.status(401).json({ message: "Unauthorized" });

          const isAdmin = user.role === "admin";
          const isOwnerVendor = user.role === "vendor" && booking.vendorEmail === req.user?.email;

          if (!isAdmin && !isOwnerVendor) {
            return res.status(403).json({ message: "Forbidden: You can only moderate bookings for your own tickets" });
          }

          const { status } = req.body;
          const result = await BookedTicketsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: status } },
          );
          if (result.matchedCount === 0)
            return res.status(404).json({ message: "Booking not found" });
          res.status(200).json({ message: `Booking ${status} successfully` });
        } catch (error) {
          res.status(500).json({ message: "Internal server error" });
        }
      },
    );

    // Vendor: Get total revenue, sales, and stats for dashboard — requires auth
    app.get(
      "/api/vendor/:email/stats",
      verifyToken,
      verifyVendor,
      async (req, res) => {
        try {
          const email = req.params.email;
          const allTickets = await ticketsCollection
            .find({ vendorEmail: email })
            .toArray();
          const totalTicketsAdded = allTickets.length;

          let availableStock = 0;
          allTickets.forEach((ticket) => {
            availableStock += Number(ticket.quantity || 0);
          });

          const paidBookings = await BookedTicketsCollection.find({
            vendorEmail: email,
            status: "paid",
          }).toArray();

          let totalTicketsSold = 0;
          let totalRevenue = 0;
          const monthlyMap = {};

          paidBookings.forEach((booking) => {
            totalTicketsSold += Number(booking.quantity);
            totalRevenue += Number(booking.totalPrice);
            const timestamp =
              parseInt(booking._id.toString().substring(0, 8), 16) * 1000;
            const monthYear = new Date(timestamp).toLocaleString("default", {
              month: "short",
            });

            if (!monthlyMap[monthYear]) {
              monthlyMap[monthYear] = {
                month: monthYear,
                revenue: 0,
                bookings: 0,
              };
            }
            monthlyMap[monthYear].revenue += Number(booking.totalPrice);
            monthlyMap[monthYear].bookings += Number(booking.quantity);
          });

          const revenueData = Object.values(monthlyMap);
          const pieData = [
            { name: "Sold Tickets", value: totalTicketsSold, fill: "#10b981" },
            {
              name: "Available Tickets",
              value: availableStock,
              fill: "#3b82f6",
            },
          ];

          res.status(200).json({
            totalTicketsAdded,
            totalTicketsSold,
            totalRevenue,
            revenueData:
              revenueData.length > 0
                ? revenueData
                : [{ month: "No Data", revenue: 0, bookings: 0 }],
            pieData,
          });
        } catch (error) {
          res.status(500).json({ message: "Internal server error" });
        }
      },
    );

    // Admin: Get a list of all users (done)
    app.get("/api/users", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.status(200).json(users);
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Admin: Toggle featured status for a ticket (max 6)
    // FIX: added verifyAdmin — previously any authenticated user could feature tickets.
    app.patch("/api/tickets/:id/advertise", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const { advertise } = req.body;

        if (advertise) {
          const advertisedCount = await ticketsCollection.countDocuments({
            isAdvertised: true,
          });
          if (advertisedCount >= 6) {
            return res
              .status(400)
              .json({ message: "Cannot advertise more than 6 tickets" });
          }
        }

        await ticketsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { isAdvertised: advertise } },
        );
        res.status(200).json({ message: "Advertisement status updated" });
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Admin: Change a user's role (Make Admin/Vendor) (done)
    app.patch(
      "/api/users/:id/role",
      verifyToken,
      verifyAdmin,

      async (req, res) => {
        try {
          const { id } = req.params;
          const { role } = req.body;
          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role: role } },
          );
          if (result.matchedCount === 0)
            return res.status(404).json({ message: "User not found" });
          res.status(200).json({ message: `Role updated to ${role}` });
        } catch (error) {
          res.status(500).json({ message: "Internal server error" });
        }
      },
    );

    // Admin: Mark a vendor as fraud and hide all their tickets (done)
    app.patch(
      "/api/users/:id/fraud",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;
          const user = await usersCollection.findOne({ _id: new ObjectId(id) });
          if (!user) return res.status(404).json({ message: "User not found" });

          await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { isFraud: true } },
          );
          if (user.email) {
            await ticketsCollection.updateMany(
              { vendorEmail: user.email },
              { $set: { verificationStatus: "rejected", isFraud: true } },
            );
          }
          res.status(200).json({ message: "Vendor marked as fraud" });
        } catch (error) {
          res.status(500).json({ message: "Internal server error" });
        }
      },
    );

    // Admin: Get platform-wide overview statistics + monthly revenue chart data
    app.get("/api/admin/stats", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const totalUsers = await usersCollection.countDocuments();
        const totalVendors = await usersCollection.countDocuments({ role: "vendor" });
        const totalAdmins = await usersCollection.countDocuments({ role: "admin" });
        const totalTickets = await ticketsCollection.countDocuments();
        const pendingTickets = await ticketsCollection.countDocuments({ verificationStatus: "pending" });
        const approvedTickets = await ticketsCollection.countDocuments({ verificationStatus: "approved" });
        const featuredTickets = await ticketsCollection.countDocuments({ isAdvertised: true });

        const paidBookings = await BookedTicketsCollection.find({ status: "paid" }).toArray();
        let totalPlatformRevenue = 0;
        let totalTicketsSold = 0;

        // Build monthly revenue map for the last 6 months
        const monthlyMap = {};
        const now = new Date();
        for (let i = 5; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          const label = d.toLocaleString("default", { month: "short", year: "2-digit" });
          monthlyMap[key] = { month: label, revenue: 0, bookings: 0 };
        }

        paidBookings.forEach((b) => {
          const price = Number(b.totalPrice || 0);
          const qty = Number(b.quantity || 1);
          totalPlatformRevenue += price;
          totalTicketsSold += qty;

          // Parse paidAt or createdAt for chart bucketing
          const dateStr = b.paidAt || b.createdAt;
          if (dateStr) {
            const d = new Date(dateStr);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            if (monthlyMap[key]) {
              monthlyMap[key].revenue += price;
              monthlyMap[key].bookings += 1;
            }
          }
        });

        const monthlyRevenue = Object.values(monthlyMap);

        res.status(200).json({
          totalUsers,
          totalVendors,
          totalAdmins,
          totalTickets,
          pendingTickets,
          approvedTickets,
          featuredTickets,
          totalPlatformRevenue,
          totalTicketsSold,
          totalBookingsCount: await BookedTicketsCollection.countDocuments(),
          monthlyRevenue,
        });
      } catch (error) {
        console.error("Error fetching admin stats:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

//  await client.db("admin").command({ ping: 1 });
//         console.log("Pinged your deployment. You successfully connected to MongoDB!");
//     } finally {
//         // Ensures that the client will close when you finish/error
//         // await client.close();
//     }
// }j
// run().catch(console.dir);

    // ==========================================
    // Phase 3: Dynamic Reviews & Ratings System
    // ==========================================

    // Get public reviews with pagination for homepage
    app.get("/api/reviews/public", async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 6;
        const skip = (page - 1) * limit;

        const totalReviews = await reviewsCollection.countDocuments();
        const totalPages = Math.ceil(totalReviews / limit) || 1;

        const reviews = await reviewsCollection
          .find({})
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        // Calculate overall average rating and counts
        const allReviews = await reviewsCollection.find({}).toArray();
        const totalSum = allReviews.reduce((s, r) => s + (Number(r.rating) || 0), 0);
        const averageRating = allReviews.length > 0 ? (totalSum / allReviews.length).toFixed(1) : "4.9";

        // Populate ticket info if ticketId exists
        const populatedReviews = await Promise.all(
          reviews.map(async (review) => {
            let ticketInfo = review.ticketInfo || null;
            if (!ticketInfo && review.ticketId) {
              try {
                const query = ObjectId.isValid(review.ticketId)
                  ? { _id: new ObjectId(review.ticketId) }
                  : { _id: review.ticketId };
                const t = await ticketsCollection.findOne(query);
                if (t) {
                  ticketInfo = {
                    title: t.title,
                    from: t.from,
                    to: t.to,
                    type: t.type,
                  };
                }
              } catch (e) {}
            }
            return {
              ...review,
              ticketInfo,
            };
          })
        );

        res.status(200).json({
          reviews: populatedReviews,
          totalReviews,
          totalPages,
          currentPage: page,
          averageRating: Number(averageRating),
        });
      } catch (error) {
        console.error("Error fetching public reviews:", error);
        res.status(500).json({ message: "Failed to fetch public reviews" });
      }
    });

    // Submit a public review from homepage (Works for logged in users & guest reviewers)
    app.post("/api/reviews/public", async (req, res) => {
      try {
        const { userName, userEmail, userImage, rating, comment, journeyTitle, transportType } = req.body;

        if (!userName || !comment || !rating) {
          return res.status(400).json({ message: "Name, rating, and comment are required" });
        }

        const numRating = Number(rating);
        if (numRating < 1 || numRating > 5) {
          return res.status(400).json({ message: "Rating must be between 1 and 5" });
        }

        const newReview = {
          userName: String(userName).trim(),
          userEmail: userEmail ? String(userEmail).trim() : "guest@travelhub.com",
          userImage: userImage || null,
          rating: numRating,
          comment: String(comment).trim(),
          isVerifiedBuyer: true,
          ticketInfo: journeyTitle ? {
            title: journeyTitle,
            type: transportType || "Bus",
          } : {
            title: "TravelHub Express Journey",
            type: transportType || "Bus"
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await reviewsCollection.insertOne(newReview);
        res.status(201).json({ message: "Review posted successfully!", reviewId: result.insertedId });
      } catch (error) {
        console.error("Error posting public review:", error);
        res.status(500).json({ message: "Failed to submit review" });
      }
    });

    // Get featured/recent top reviews for homepage
    app.get("/api/reviews/featured", async (req, res) => {
      try {
        const reviews = await reviewsCollection
          .find({ rating: { $gte: 4 } })
          .sort({ createdAt: -1 })
          .limit(6)
          .toArray();

        // Populate basic ticket info for each review
        const populatedReviews = await Promise.all(
          reviews.map(async (review) => {
            let ticketInfo = null;
            if (review.ticketId) {
              try {
                const query = ObjectId.isValid(review.ticketId)
                  ? { _id: new ObjectId(review.ticketId) }
                  : { _id: review.ticketId };
                const t = await ticketsCollection.findOne(query);
                if (t) {
                  ticketInfo = {
                    title: t.title,
                    from: t.from,
                    to: t.to,
                    type: t.type,
                    image: t.image,
                  };
                }
              } catch (e) {
                // ignore invalid objectid
              }
            }
            return {
              ...review,
              ticketInfo,
            };
          })
        );

        res.status(200).json({ reviews: populatedReviews });
      } catch (error) {
        console.error("Error fetching featured reviews:", error);
        res.status(500).json({ message: "Failed to fetch featured reviews" });
      }
    });

    // Get all reviews and statistics for a specific ticket
    app.get("/api/reviews/ticket/:ticketId", async (req, res) => {
      try {
        const { ticketId } = req.params;
        if (!ticketId) {
          return res.status(400).json({ message: "Ticket ID is required" });
        }

        const reviews = await reviewsCollection
          .find({ ticketId })
          .sort({ createdAt: -1 })
          .toArray();

        const totalReviews = reviews.length;
        const totalRatingSum = reviews.reduce((sum, r) => sum + (Number(r.rating) || 0), 0);
        const averageRating = totalReviews > 0 ? (totalRatingSum / totalReviews).toFixed(1) : 0;

        const ratingCounts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
        reviews.forEach((r) => {
          const stars = Math.round(Number(r.rating));
          if (ratingCounts[stars] !== undefined) {
            ratingCounts[stars] += 1;
          }
        });

        res.status(200).json({
          totalReviews,
          averageRating: Number(averageRating),
          ratingCounts,
          reviews,
        });
      } catch (error) {
        console.error("Error fetching reviews:", error);
        res.status(500).json({ message: "Failed to fetch reviews" });
      }
    });

    // Check review eligibility for logged-in user
    app.get("/api/reviews/eligibility/:ticketId", verifyToken, async (req, res) => {
      try {
        const { ticketId } = req.params;
        const userEmail = req.user?.email;

        if (!userEmail) {
          return res.status(401).json({ message: "User not authenticated" });
        }

        // Check if user has a booking for this ticket
        const booking = await BookedTicketsCollection.findOne({
          ticketId,
          userEmail,
          status: { $in: ["paid", "accepted"] },
        });

        const existingReview = await reviewsCollection.findOne({
          ticketId,
          userEmail,
        });

        res.status(200).json({
          isEligible: Boolean(booking),
          hasReviewed: Boolean(existingReview),
          existingReview,
        });
      } catch (error) {
        console.error("Error checking review eligibility:", error);
        res.status(500).json({ message: "Failed to check eligibility" });
      }
    });

    // Create or update a review (Verified buyers only)
    app.post("/api/reviews", verifyToken, async (req, res) => {
      try {
        const { ticketId, rating, comment } = req.body;
        const userEmail = req.user?.email;

        if (!ticketId || !rating || !comment?.trim()) {
          return res.status(400).json({ message: "Ticket ID, rating (1-5), and comment are required." });
        }

        const numRating = Number(rating);
        if (isNaN(numRating) || numRating < 1 || numRating > 5) {
          return res.status(400).json({ message: "Rating must be a number between 1 and 5." });
        }

        // Verify that the user has a confirmed/paid booking
        const booking = await BookedTicketsCollection.findOne({
          ticketId,
          userEmail,
          status: { $in: ["paid", "accepted"] },
        });

        if (!booking) {
          return res.status(403).json({
            message: "Only passengers who booked and paid for this ticket can leave a verified review.",
          });
        }

        // Fetch user profile info
        const userProfile = await usersCollection.findOne({ email: userEmail });
        const userName = userProfile?.name || req.user?.name || "Traveler";
        const userImage = userProfile?.image || req.user?.image || null;

        const filter = { ticketId, userEmail };
        const updateDoc = {
          $set: {
            ticketId,
            userEmail,
            userName,
            userImage,
            rating: numRating,
            comment: comment.trim(),
            isVerifiedBuyer: true,
            updatedAt: new Date(),
          },
          $setOnInsert: {
            createdAt: new Date(),
          },
        };

        const result = await reviewsCollection.updateOne(filter, updateDoc, { upsert: true });

        // Update aggregated rating on ticket document for quick card badge display
        const allReviews = await reviewsCollection.find({ ticketId }).toArray();
        const totalRatingSum = allReviews.reduce((sum, r) => sum + (Number(r.rating) || 0), 0);
        const avg = allReviews.length > 0 ? Number((totalRatingSum / allReviews.length).toFixed(1)) : 0;

        await ticketsCollection.updateOne(
          { _id: new ObjectId(ticketId) },
          {
            $set: {
              averageRating: avg,
              reviewCount: allReviews.length,
            },
          }
        );

        res.status(201).json({
          success: true,
          message: "Review submitted successfully!",
          review: {
            ticketId,
            userEmail,
            userName,
            userImage,
            rating: numRating,
            comment: comment.trim(),
            isVerifiedBuyer: true,
          },
        });
      } catch (error) {
        console.error("Error submitting review:", error);
        res.status(500).json({ message: "Failed to submit review" });
      }
    });

// ==========================================
// Phase 2: AI Support Chatbot Route
// ==========================================
const { GoogleGenerativeAI } = require("@google/generative-ai");

app.post("/api/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY is not configured on the server." });
    }

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required." });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const systemInstruction = "You are TravelBot, a friendly and helpful AI customer support assistant for TravelHub (a modern ticket booking platform for flights, trains, and buses). Help users find tickets, check route availability, understand pricing, and provide concise, polite travel recommendations. Keep answers direct and well-structured.";

    const formattedHistory = Array.isArray(history)
      ? history
          .filter((msg) => msg && msg.text && typeof msg.text === "string")
          .map((msg) => ({
            role: msg.role === "user" ? "user" : "model",
            parts: [{ text: msg.text }],
          }))
      : [];

    const candidateModels = [
      "gemini-flash-latest",
      "gemini-3.5-flash",
      "gemini-3.6-flash",
      "gemini-3.7-flash",
    ];
    let lastError = null;
    let replyText = null;

    for (const modelName of candidateModels) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction,
        });

        const chat = model.startChat({
          history: formattedHistory,
        });

        const result = await chat.sendMessage(message);
        const response = await result.response;
        replyText = response.text();
        if (replyText) break;
      } catch (err) {
        console.warn(`Model ${modelName} encountered issue: ${err.message}. Trying next fallback...`);
        lastError = err;
      }
    }

    if (!replyText) {
      throw lastError || new Error("Unable to get response from Gemini API.");
    }

    return res.status(200).json({ reply: replyText });
  } catch (error) {
    console.error("Chat API Final Error:", error);
    return res.status(500).json({ error: error.message || "Failed to process chat request." });
  }
});

async function startServer() {
  try {
    await client.connect();
    console.log(" Connected to MongoDB Atlas Cloud Cluster!");
    app.listen(PORT, () => {
      console.log(`PromptForge Server listening on port ${PORT}`);
    });
  } catch (error) {
    console.error("MongoDB Atlas connection error:", error);
    process.exit(1);
  }
}

startServer();