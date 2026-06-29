# 🚍 TravelHub - Backend Server

This is the server-side repository for **TravelHub**, a comprehensive Online Ticket Booking Platform. Built with Node.js, Express, and MongoDB, this robust backend provides RESTful APIs, secure authentication, role-based access control, and payment gateway integration to support the TravelHub client application.

## 🔗 Links
- **Live Server API:** [https://travel-hub-server-three.vercel.app/]
- **Live Website:** [TravelHub | Your Ultimate Ticket Booking Platform](https://travell-hub-client.vercel.app/)
- **Client-side Repository:** [sohanur-rahman-coding/TravelHub-Client](https://github.com/sohanur-rahman-coding/TravelHub-Client)
- **Server-side Repository:** [sohanur-rahman-coding/TravelHub-server](https://github.com/sohanur-rahman-coding/TravelHub-server)


---

## 🚀 Key Backend Features

- **RESTful API Architecture:** Well-structured and scalable endpoints for users, tickets, and bookings.
- **Secure Authentication:** Implemented JSON Web Tokens (JWT) for secure login sessions and API route protection.
- **Role-Based Access Control (RBAC):** Custom middlewares to verify Admin, Vendor, and User roles, ensuring secure data access.
- **Payment Gateway Integration:** Integrated Stripe API for processing secure online ticket payments.
- **Database Management:** Efficient MongoDB queries using Mongoose for handling complex ticket inventory and booking statuses.
- **Error Handling:** Centralized error handling for smooth API responses and debugging.

---

## 🛠️ Technologies & Tools Used

- **Runtime Environment:** Node.js
- **Framework:** Express.js
- **Database:** MongoDB & Mongoose
- **Authentication:** JSON Web Token (JWT)
- **Payment Processing:** Stripe
- **Environment Management:** dotenv
- **Cross-Origin Resource Sharing:** CORS

---

## ⚙️ Installation & Setup

To run this backend server locally on your machine, follow these steps:

### 1. Clone the repository
```bash
git clone [https://github.com/sohanur-rahman-coding/TravelHub-server.git](https://github.com/sohanur-rahman-coding/TravelHub-server.git)
cd TravelHub-server
```

### 2. Install dependencies
```bash
npm install
```

### 3. Setup Environment Variables
Create a `.env` file in the root directory and add the following variables:

```env
PORT=5000
DB_USER=your_mongodb_username
DB_PASS=your_mongodb_password
JWT_SECRET=your_jwt_secret_token
STRIPE_SECRET_KEY=your_stripe_secret_key
```
*(Note: Replace the placeholder values with your actual database and API credentials.)*

### 4. Start the server
For development (using nodemon, if installed):
```bash
npm run dev
```
Or for standard start:
```bash
npm start
```
The server should now be running on `http://localhost:5000`.

---

## 📚 API Endpoints Overview (Brief)

- **Auth:** Generate and verify JWT tokens.
- **Users:** CRUD operations for user profiles, managing roles, and handling fraud detection.
- **Tickets:** Endpoints for vendors to add/update tickets, and for users to fetch approved/advertised tickets.
- **Bookings:** Handle ticket booking requests, status updates (pending, accepted, rejected, paid), and Stripe payment intents.

---
*Designed & Developed by Sohanur Rahman for Assignment Category A10_CAT-005*
