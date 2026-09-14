const express = require("express");
const passport = require("passport");

const pool = require("../db");
const ensureAuthenticated = require("../middleware/auth");

const router = express.Router();


// ======================================================
// GOOGLE LOGIN
// ======================================================

router.get(
  "/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
  })
);


// ======================================================
// GOOGLE CALLBACK
// ======================================================

router.get(
  "/google/callback",
  passport.authenticate("google", {
    failureRedirect: "http://localhost:3000/",
  }),
  (req, res) => {
    res.redirect("http://localhost:3000/");
  }
);


// ======================================================
// CHECK CURRENT USER
// ======================================================

router.get("/me", (req, res) => {
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


// ======================================================
// UPDATE PHONE CONTACT SETTINGS
// ======================================================

router.put(
  "/profile",
  ensureAuthenticated,
  async (req, res) => {
    try {
      const {
        mobile_number,
        allow_phone_contact,
      } = req.body;

      // Clean mobile number
      const cleanedMobile = mobile_number
        ? mobile_number.replace(/[\s-]/g, "")
        : "";

      // Validate Indian mobile number
      if (
        cleanedMobile &&
        !/^(\+91)?[6-9]\d{9}$/.test(cleanedMobile)
      ) {
        return res.status(400).json({
          message:
            "Please enter a valid Indian mobile number",
        });
      }

      const result = await pool.query(
        `
        UPDATE users
        SET
          mobile_number = $1,
          allow_phone_contact = $2
        WHERE id = $3
        RETURNING
          id,
          name,
          email,
          profile_image,
          mobile_number,
          allow_phone_contact
        `,
        [
          cleanedMobile || null,
          allow_phone_contact === true,
          req.user.id,
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          message: "User not found",
        });
      }

      res.json({
        message: "Profile updated successfully",
        user: result.rows[0],
      });
    } catch (error) {
      console.error(
        "Profile update error:",
        error
      );

      res.status(500).json({
        message: "Database Error",
      });
    }
  }
);


// ======================================================
// GET MY POSTED ITEMS
// ======================================================

router.get(
  "/my-items",
  ensureAuthenticated,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT
          id,
          name,
          location,
          date,
          description,
          image,
          type,
          created_at
        FROM items
        WHERE user_id = $1
        ORDER BY created_at DESC
        `,
        [req.user.id]
      );

      res.json(result.rows);
    } catch (error) {
      console.error(
        "My items error:",
        error
      );

      res.status(500).json({
        message: "Database Error",
      });
    }
  }
);


// ======================================================
// LOGOUT
// ======================================================

router.get("/logout", (req, res) => {
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


module.exports = router;