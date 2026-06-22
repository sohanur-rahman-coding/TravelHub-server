const dns = require("node:dns");
dns.setServers(["1.1.1.1", "1.0.0.1"]);

const express = require("express");
const dontenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
dontenv.config();

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

async function run() {
  try {
    await client.connect();
    const db = client.db("TravelHub");
    const ticketsCollection = db.collection("tickets");
    const usersCollection = db.collection("user");
    const BookedTicketsCollection = db.collection("booked_tickets");

    // 1. Get all tickets (Dynamic filter via query params)
    app.get("/api/tickets", async (req, res) => {
      try {
        const { email, status } = req.query;
        let query = {};
        if (email) query.vendorEmail = email;
        if (status) query.verificationStatus = status;

        const tickets = await ticketsCollection
          .find(query)
          .sort({ _id: -1 })
          .toArray();

        res.status(200).json(tickets);
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // 2. Advertisment data get route (MUST BE ABOVE /:id ROUTE)
    app.get("/api/tickets/advertised", async (req, res) => {
      try {
        const advertisedTickets = await ticketsCollection
          .find({ isAdvertised: true })
          .toArray();
        res.status(200).json(advertisedTickets);
      } catch (error) {
        console.error("Error fetching advertised tickets:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // 3. Get a single ticket by ID (MUST BE BELOW SPECIFIC ROUTES)
    app.get("/api/tickets/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: "Invalid ticket ID format" });
        }

        const query = { _id: new ObjectId(id) };
        const ticket = await ticketsCollection.findOne(query);

        if (!ticket) {
          return res.status(404).json({ message: "Ticket not found" });
        }

        res.status(200).json(ticket);
      } catch (error) {
        console.error("Error fetching single ticket:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // upload ticket data to database
    app.post("/api/tickets", async (req, res) => {
      try {
        const ticket = req.body;

        if (ticket.vendorEmail) {
          const vendor = await usersCollection.findOne({
            email: ticket.vendorEmail,
          });

          if (vendor && vendor.isFraud) {
            return res
              .status(403)
              .json({ message: "Fraudulent vendors cannot add new tickets." });
          }
        }

        const result = await ticketsCollection.insertOne(ticket);
        res
          .status(201)
          .json({ message: "Ticket created", id: result.insertedId });
      } catch (error) {
        console.error("Error creating ticket:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Update ticket data
    app.patch("/api/tickets/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const updatedData = req.body;
        const result = await ticketsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updatedData },
        );
        if (result.matchedCount === 0) {
          return res.status(404).json({ message: "Ticket not found" });
        }
        res.status(200).json({ message: "Ticket updated" });
      } catch (error) {
        console.error("Error updating ticket:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // delete a ticket
    app.delete("/api/tickets/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const result = await ticketsCollection.deleteOne({
          _id: new ObjectId(id),
        });
        if (result.deletedCount === 0) {
          return res.status(404).json({ message: "Ticket not found" });
        }
        res.status(200).json({ message: "Ticket deleted" });
      } catch (error) {
        console.error("Error deleting ticket:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // advertisement route
    app.patch("/api/tickets/:id/advertise", async (req, res) => {
      try {
        const { id } = req.params;
        const { advertise } = req.body;

        if (advertise) {
          const advertisedCount = await ticketsCollection.countDocuments({
            isAdvertised: true,
          });
          if (advertisedCount >= 6) {
            return res.status(400).json({
              message: "You cannot advertise more than 6 tickets at a time.",
            });
          }
        }

        const result = await ticketsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { isAdvertised: advertise } },
        );

        res
          .status(200)
          .json({ message: "Advertisement status updated successfully" });
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // booking modal
    app.post("/api/bookings", async (req, res) => {
      try {
        const bookingData = req.body;

        const existingBooking = await BookedTicketsCollection.findOne({
          ticketId: bookingData.ticketId,
          userEmail: bookingData.userEmail,
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

        const filter = { _id: new ObjectId(bookingData.ticketId) };
        const updateDoc = {
          $inc: { quantity: -bookingData.quantity },
        };
        await ticketsCollection.updateOne(filter, updateDoc);

        res.status(201).json({
          success: true,
          message: "Booking successful!",
        });
      } catch (error) {
        res
          .status(500)
          .json({ success: false, message: "Internal Server Error" });
      }
    });

    // get all users
    app.get("/api/users", async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.status(200).json(users);
      } catch (error) {
        console.error("Error fetching users:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // update user role
    app.patch("/api/users/:id/role", async (req, res) => {
      try {
        const { id } = req.params;
        const { role } = req.body;

        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role: role } },
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ message: "User not found" });
        }
        res.status(200).json({ message: `Role updated to ${role}` });
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // set user as fraud
    app.patch("/api/users/:id/fraud", async (req, res) => {
      try {
        const { id } = req.params;

        const user = await usersCollection.findOne({ _id: new ObjectId(id) });
        if (!user) {
          return res.status(404).json({ message: "User not found" });
        }

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

        res
          .status(200)
          .json({ message: "Vendor marked as fraud and all tickets hidden" });
      } catch (error) {
        console.error("Error marking fraud:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
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
