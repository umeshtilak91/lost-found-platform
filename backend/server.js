const express = require("express");
const cors = require("cors");
const session = require("express-session");
const passport = require("passport");
require("dotenv").config();

const pool = require("./db");
const upload = require("./upload");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const ensureAuthenticated = require("./middleware/auth");
const authRoutes = require("./routes/auth");


// ======================================================
// GOOGLE PASSPORT STRATEGY
// ======================================================

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "http://localhost:5000/api/auth/google/callback",
    },

    async (accessToken, refreshToken, profile, done) => {
      try {
        console.log("Google profile:", profile);

        const googleId = profile.id;
        const name = profile.displayName;
        const email = profile.emails?.[0]?.value;
        const profileImage = profile.photos?.[0]?.value || null;

        // Check if user already exists
        const existingUser = await pool.query(
          "SELECT * FROM users WHERE google_id = $1",
          [googleId]
        );

        if (existingUser.rows.length > 0) {
          console.log("✅ Existing user found");

          return done(null, existingUser.rows[0]);
        }

        // Create new user
        const result = await pool.query(
          `INSERT INTO users
            (google_id, name, email, profile_image)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [googleId, name, email, profileImage]
        );

        console.log("✅ New user created");

        return done(null, result.rows[0]);
      } catch (error) {
        console.error(
          "User authentication/database error:",
          error
        );

        return done(error, null);
      }
    }
  )
);


// ======================================================
// PASSPORT SESSION
// ======================================================

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const result = await pool.query(
      `SELECT
        id,
        google_id,
        name,
        email,
        profile_image,
        mobile_number,
        allow_phone_contact
       FROM users
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return done(null, false);
    }

    done(null, result.rows[0]);
  } catch (error) {
    console.error("Session user lookup error:", error);
    done(error, null);
  }
});


// ======================================================
// EXPRESS APP
// ======================================================

const app = express();


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

// ======================================================
// AUTHENTICATION MIDDLEWARE
// ======================================================




// ======================================================
// FILE UPLOADS
// ======================================================

const path = require("path");

app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"))
);


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
// GET ALL LOST ITEMS
// ======================================================

app.get("/api/lost-items", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        items.*,
        users.name AS user_name,
        users.email AS user_email,
        users.profile_image AS user_profile_image,
        CASE
          WHEN users.allow_phone_contact = TRUE
          THEN users.mobile_number
          ELSE NULL
        END AS user_mobile_number,
        COALESCE(users.allow_phone_contact, FALSE) AS allow_phone_contact
      FROM items
      LEFT JOIN users
        ON items.user_id = users.id
      WHERE items.type = 'lost'
      ORDER BY items.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Lost items error:", error);

    res.status(500).json({
      message: "Database Error",
    });
  }
});


// ======================================================
// GET ALL FOUND ITEMS
// ======================================================

app.get("/api/found-items", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        items.*,
        users.name AS user_name,
        users.email AS user_email,
        users.profile_image AS user_profile_image,
        CASE
          WHEN users.allow_phone_contact = TRUE
          THEN users.mobile_number
          ELSE NULL
        END AS user_mobile_number,
        COALESCE(users.allow_phone_contact, FALSE) AS allow_phone_contact
      FROM items
      LEFT JOIN users
        ON items.user_id = users.id
      WHERE items.type = 'found'
      ORDER BY items.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Found items error:", error);

    res.status(500).json({
      message: "Database Error",
    });
  }
});


// ======================================================
// GET SINGLE ITEM
// ======================================================

app.get("/api/items/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        items.*,
        users.name AS user_name,
        users.email AS user_email,
        users.profile_image AS user_profile_image,
        CASE
          WHEN users.allow_phone_contact = TRUE
          THEN users.mobile_number
          ELSE NULL
        END AS user_mobile_number,
        COALESCE(users.allow_phone_contact, FALSE) AS allow_phone_contact
      FROM items
      LEFT JOIN users
        ON items.user_id = users.id
      WHERE items.id = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Item not found",
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Single item error:", error);

    res.status(500).json({
      message: "Database Error",
    });
  }
});

// ======================================================
// REPORT LOST / FOUND ITEM
// ======================================================

app.post(
  "/api/report",
  ensureAuthenticated,
  upload.single("image"),

  async (req, res) => {
    try {
      const {
        name,
        location,
        date,
        description,
        type,
      } = req.body;

      const image = req.file
        ? req.file.filename
        : null;

      const userId = req.user.id;

      console.log("================================");
      console.log("USER:", req.user);
      console.log("USER ID:", userId);
      console.log("BODY:", req.body);
      console.log("FILE:", req.file);
      console.log("IMAGE:", image);
      console.log("================================");

      const result = await pool.query(
        `INSERT INTO items (
          name,
          location,
          date,
          description,
          image,
          type,
          user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *`,

        [
          name,
          location,
          date,
          description,
          image,
          type,
          userId,
        ]
      );

      res.status(201).json({
        message:
          "Lost/Found item reported successfully!",
        item: result.rows[0],
      });
    } catch (error) {
      console.error("Database Error:", error);

      res.status(500).json({
        message: "Database Error",
      });
    }
  }
);


// ======================================================
// GOOGLE LOGIN
// ======================================================




// ======================================================
// GOOGLE CALLBACK
// ======================================================




// ======================================================
// CHECK CURRENT USER
// ======================================================


// ======================================================
// UPDATE PHONE CONTACT SETTINGS
// ======================================================


      // ======================================================
// GET MY POSTED ITEMS
// ======================================================



// ======================================================
// LOGOUT
// ======================================================


// ======================================================
// HOMEPAGE STATISTICS
// ======================================================

app.get("/api/stats", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE type = 'lost') AS lost,
        COUNT(*) FILTER (WHERE type = 'found') AS found
      FROM items
    `);

    res.json({
      total: Number(result.rows[0].total),
      lost: Number(result.rows[0].lost),
      found: Number(result.rows[0].found),
    });
  } catch (error) {
    console.error("Stats error:", error);

    res.status(500).json({
      message: "Database Error",
    });
  }
});


// ======================================================
// DATABASE CONNECTION TEST
// ======================================================

pool.query("SELECT NOW()", (err, result) => {
  if (err) {
    console.error(
      "Database connection failed:",
      err
    );
  } else {
    console.log("✅ Database Connected");
    console.log(result.rows[0]);
  }
});


// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, () => {
  console.log(
    `Server is running on http://localhost:${PORT}`
  );
});