const express = require("express");
const cors = require("cors");
const session = require("express-session");
const passport = require("passport");
require("dotenv").config();

const pool = require("./db");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const authRoutes = require("./routes/auth");
const itemsRoutes = require("./routes/items");
const reportRoutes = require("./routes/report");
const path = require("path");
const configurePassport = require("./config/passport");






// ======================================================
// EXPRESS APP
// ======================================================

const app = express();
configurePassport(passport);


app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"))
);


// ======================================================
// CORS
// ======================================================

app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  })
);


// ======================================================
// SESSION
// ======================================================

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
  })
);


// ======================================================
// BODY PARSER
// ======================================================

app.use(express.json());


// ======================================================
// PASSPORT
// ======================================================

app.use(passport.initialize());
app.use(passport.session());

app.use("/api/auth", authRoutes);
app.use("/api", itemsRoutes);
app.use("/api", reportRoutes);







// ======================================================
// PORT
// ======================================================

const PORT = 5000;


// ======================================================
// HOME
// ======================================================

app.get("/", (req, res) => {
  res.send("🚀 Lost & Found Backend is Running!");
});






















// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, () => {
  console.log(
    `Server is running on http://localhost:${PORT}`
  );
});