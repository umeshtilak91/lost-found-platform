const express = require("express");
const cors = require("cors");
const session = require("express-session");
const passport = require("passport");
require("dotenv").config();

const pool = require("./db");
const upload = require("./upload");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

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
        console.error("User authentication/database error:", error);
        return done(error, null);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

const app = express();






app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  })
);

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
  })
);

app.use(express.json());

app.use(passport.initialize());
app.use(passport.session());



function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }

  return res.status(401).json({
    message: "Please login with Google first",
  });
}

const path = require("path");

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const PORT = 5000;




app.get("/", (req, res) => {
  res.send("🚀 Lost & Found Backend is Running!");
});

app.get("/api/lost-items", async (req, res) => {
  try {
        const result = await pool.query(`
      SELECT
        items.*,
        users.name AS user_name,
        users.email AS user_email,
        users.profile_image AS user_profile_image
      FROM items
      LEFT JOIN users
        ON items.user_id = users.id
      WHERE items.type = 'found'
      ORDER BY items.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Database Error",
    });
  }
});
app.get("/api/found-items", async (req, res) => {
  try {
        const result = await pool.query(`
        SELECT
        items.*,
        users.name AS user_name,
        users.email AS user_email,
        users.profile_image AS user_profile_image
      FROM items
      LEFT JOIN users
        ON items.user_id = users.id
      ORDER BY items.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Database Error",
    });
  }
});

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
    console.error("Stats Error:", error);

    res.status(500).json({
      message: "Failed to fetch statistics",
    });
  }
});

app.post(
  "/api/report",
  ensureAuthenticated,
  upload.single("image"),
  async (req, res) => {
    try {
      const { name, location, date, description, type } = req.body;

      const image = req.file ? req.file.filename : null;

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
        message: "Lost/Found item reported successfully!",
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
app.get(
  "/api/auth/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
  })
);

app.get(
  "/api/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "http://localhost:3000/",
  }),
  (req, res) => {
    res.redirect("http://localhost:3000/");
  }
);

app.get("/api/auth/me", (req, res) => {
  if (req.isAuthenticated()) {
    res.json({
      loggedIn: true,
      user: req.user,
    });
  } else {
    res.json({
      loggedIn: false,
    });
  }
});

app.get("/api/auth/logout", (req, res) => {
  req.logout((err) => {
    if (err) {
      return res.status(500).json({
        message: "Logout failed",
      });
    }

    res.json({
      message: "Logged out successfully",
    });
  });
});
pool.query("SELECT NOW()", (err, result) => {
  if (err) {
    console.error("Database connection failed:", err);
  } else {
    console.log("✅ Database Connected");
    console.log(result.rows[0]);
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});