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

        return done(null, profile);
      } catch (error) {
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

app.use(cors());

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
  })
);

app.use(passport.initialize());
app.use(passport.session());

app.use(express.json());


const path = require("path");

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const PORT = 5000;




app.get("/", (req, res) => {
  res.send("🚀 Lost & Found Backend is Running!");
});

app.get("/api/lost-items", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM items ORDER BY created_at DESC"
    );

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
    const result = await pool.query(
      "SELECT * FROM items WHERE type = 'found' ORDER BY created_at DESC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Database Error",
    });
  }
});

app.post("/api/report", upload.single("image"), async (req, res) => {
  try {
    const { name, location, date, description, type } = req.body;
    const image = req.file ? req.file.filename : null;
    console.log("================================");
console.log("BODY:", req.body);
console.log("FILE:", req.file);
console.log("IMAGE:", image);
console.log("================================");
    console.log("Request Body:", req.body);
    console.log("Uploaded File:", req.file);

const result = await pool.query(
  `INSERT INTO items (name, location, date, description, image, type)
   VALUES ($1, $2, $3, $4, $5, $6)
   RETURNING *`,
  [name, location, date, description, image, type]
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
});
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