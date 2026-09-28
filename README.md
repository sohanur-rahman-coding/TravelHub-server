# 🚍 TravelHub - Backend API Server

This is the backend server repository for **TravelHub**, a full-featured Online Ticket Booking Platform. Built with Node.js, Express, and MongoDB Atlas, this server handles authentication verification, ticket inventory, transactional seat holds, Stripe payment intents, and role-based permissions.

## 🔗 Links
- **Live Server API:** [https://travel-hub-server-three.vercel.app/](https://travel-hub-server-three.vercel.app/)
- **Live Website:** [TravelHub | Your Ultimate Ticket Booking Platform](https://travell-hub-client.vercel.app)
- **Client Repository:** [sohanur-rahman-coding/TravelHub-Client](https://github.com/sohanur-rahman-coding/TravelHub-Client)
- **Server Repository:** [sohanur-rahman-coding/TravelHub-server](https://github.com/sohanur-rahman-coding/TravelHub-server)

---

## 🚀 Key Backend Capabilities

- **Transactional Seat Hold & Auto-Release:** Prevents concurrent double-booking of seats with a background cleaner that automatically releases expired locks.
- **Payment Processing & Idempotency:** Secure Stripe PaymentIntent creation with idempotency guards on confirmation endpoints.
- **Role-Based Access Control (RBAC):** Middleware for validating `admin`, `vendor`, and `user` privileges with Bearer Token authentication.
- **Ticket Moderation & Fraud Isolation:** Instant isolation of fraudulent vendor tickets and route advertisement management.
- **Reviews & Ratings Engine:** Aggregates user feedback and updates route ratings dynamically.
- **Vendor Analytics:** Real-time revenue aggregation and booking statistics pipelines.

---

## 🛠️ Tech Stack & Dependencies

- **Runtime:** Node.js (v18+)
- **Framework:** Express.js
- **Database:** MongoDB Atlas (Native MongoDB Driver)
- **Payments:** Stripe SDK
- **Security & Utilities:** CORS, Dotenv, JWT

---

## ⚙️ Installation & Setup

### 1. Clone & Navigate
```bash
git clone https://github.com/sohanur-rahman-coding/TravelHub-server.git
cd TravelHub-server
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Variables Configuration
Create a `.env` file in the root directory:
```env
PORT=5000
MONGODB_URI=your_mongodb_connection_uri
DB_USER=your_db_user
DB_PASS=your_db_password
JWT_SECRET=your_jwt_secret
STRIPE_SECRET_KEY=your_stripe_secret_key
```

### 4. Start Server
```bash
# Development mode
npm run dev

# Production mode
node index.js
```
The server will listen at `http://localhost:5000`.

---

## 📚 API Endpoints Summary

### 🎫 Tickets
- `GET /api/tickets` - Fetch paginated, filtered tickets (`type`, `from`, `to`, `sortPrice`, `status`)
- `GET /api/tickets/advertised` - Fetch advertised tickets for the hero carousel
- `GET /api/tickets/:id` - Fetch ticket details by ID
- `POST /api/tickets` - Create new ticket (Vendor only)
- `PATCH /api/tickets/:id` - Update ticket details (Vendor ownership enforced)
- `DELETE /api/tickets/:id` - Delete ticket (Vendor/Admin)
- `PATCH /api/tickets/:id/status` - Moderate ticket status (`approved`/`rejected`/`isAdvertised`)

### 📋 Bookings & Holds
- `POST /api/bookings` - Create booking request with seat lock
- `GET /api/bookings/user/:email` - Get passenger bookings
- `GET /api/bookings/vendor/:email` - Get vendor booking requests
- `PATCH /api/bookings/:id/status` - Accept/reject booking
- `PATCH /api/bookings/:id/pay` - Confirm payment & update seat stock (Idempotent)
- `PATCH /api/bookings/:id/cancel` - Cancel booking & release locked seats

### 💳 Payments
- `POST /api/create-payment-intent` - Generate Stripe client secret

### 👥 Users & Auth
- `PATCH /api/user/:email` - Update user role / fraud status (Admin protected)
- `GET /api/users` - List all users (Admin protected)
- `GET /api/vendor/:email/stats` - Vendor revenue and sales metrics
