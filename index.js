const dns = require("node:dns");
dns.setServers(["1.1.1.1", "1.0.0.1"]);

const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");

dotenv.config();

const uri = process.env.MONGODB_URI;
const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    credentials: true,
    origin: [process.env.CLIENT_URL],
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

async function run() {
  try {
    await client.connect();
    const db = client.db("TravelHub");

    ticketsCollection = db.collection("tickets");
    usersCollection = db.collection("user");
    BookedTicketsCollection = db.collection("booked_tickets");

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
        if (to) query.to = { $regex: to, $options: "i" };
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

    // User: Book a new ticket (Send request to vendor)(done)
    app.post("/api/bookings", verifyToken, async (req, res) => {
      try {
        const bookingData = req.body;
        const existingBooking = await BookedTicketsCollection.findOne({
          ticketId: bookingData.ticketId,
          userEmail: bookingData.userEmail,
          status: "pending",
        });

        if (existingBooking) {
          await BookedTicketsCollection.updateOne(
            { _id: existingBooking._id },
            {
              $inc: {
                quantity: bookingData.quantity,
                totalPrice: bookingData.totalPrice,
              },
            },
          );
        } else {
          await BookedTicketsCollection.insertOne(bookingData);
        }
        res
          .status(201)
          .json({ success: true, message: "Booking request sent!" });
      } catch (error) {
        res
          .status(500)
          .json({ success: false, message: "Internal Server Error" });
      }
    });

    // User: Get all personal booked tickets (done)
    app.get("/api/bookings/user/:email", verifyToken, async (req, res) => {
      try {
        const email = req.params.email;
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
        ]).toArray();
        res.status(200).json(bookings);
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // User: Get personal transaction history (Paid bookings)(done)
    app.get("/api/transactions/:email", verifyToken, async (req, res) => {
      try {
        const email = req.params.email;
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

    // User: Update booking status to "paid" & reduce ticket quantity after payment(done)
    app.patch("/api/bookings/:id/pay", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const booking = await BookedTicketsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!booking)
          return res.status(404).json({ message: "Booking not found" });

        const qtyToReduce = Number(booking.quantity || booking.bookingQuantity);
        await BookedTicketsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: "paid" } },
        );

        if (!booking.ticketId)
          return res.status(400).json({ message: "Ticket ID missing" });

        await ticketsCollection.updateOne(
          { _id: new ObjectId(booking.ticketId) },
          { $inc: { quantity: -qtyToReduce } },
        );
        res.status(200).json({ message: "Payment successful" });
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // User: Update personal profile data (Name, Image)
    app.patch("/api/user/:email", async (req, res) => {
      try {
        const email = req.params.email;
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

    //  Admin  reject or approved details(done)
    app.patch("/api/tickets/:id", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
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
    });

    

    // Vendor: Create a new ticket(done)
    app.post("/api/tickets", verifyToken,verifyVendor, async (req, res) => {
      try {
        const ticket = req.body;
        if (ticket.vendorEmail) {
          const vendor = await usersCollection.findOne({
            email: ticket.vendorEmail,
          });
          if (vendor && vendor.isFraud) {
            return res
              .status(403)
              .json({ message: "Fraudulent vendors cannot add tickets" });
          }
        }
        const result = await ticketsCollection.insertOne(ticket);
        res
          .status(201)
          .json({ message: "Ticket created", id: result.insertedId });
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Vendor: Delete their own ticket (done)
    app.delete("/api/tickets/:id", verifyToken, verifyVendor, async (req, res) => {
      try {
        const { id } = req.params;
        const result = await ticketsCollection.deleteOne({
          _id: new ObjectId(id),
        });
        if (result.deletedCount === 0)
          return res.status(404).json({ message: "Ticket not found" });
        res.status(200).json({ message: "Ticket deleted" });
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Vendor: Get all booking requests sent to this vendor (done)
    app.get("/api/bookings/vendor/:email", verifyToken, verifyVendor, async (req, res) => {
      try {
        const email = req.params.email;
        const bookings = await BookedTicketsCollection.find({
          vendorEmail: email,
        }).toArray();
        res.status(200).json(bookings);
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Vendor: Accept or Reject a user's booking request(done)
    app.patch("/api/bookings/:id/status", verifyToken,verifyVendor, async (req, res) => {
      try {
        const id = req.params.id;
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
    });

    // Vendor: Get total revenue, sales, and stats for dashboard
    app.get(
      "/api/vendor/:email/stats",

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

    // Admin: Toggle advertisement status for a ticket (max 6)(done)
    app.patch("/api/tickets/:id/advertise", verifyToken, async (req, res) => {
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
      verifyToken,verifyAdmin,
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

    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB!");
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Server is running fine!");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
