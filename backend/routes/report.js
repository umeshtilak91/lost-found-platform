const express = require("express");
const router = express.Router();

const pool = require("../db");
const upload = require("../upload");
const ensureAuthenticated = require("../middleware/auth");

// ======================================================
// REPORT LOST / FOUND ITEM
// ======================================================

router.post(
  "/report",
  ensureAuthenticated,
  upload.single("image"),

  async (req, res) => {
    try {
      let {
        name,
        location,
        date,
        description,
        type,
      } = req.body;

      // ======================================================
      // VALIDATION
      // ======================================================

      name = name?.trim();
      location = location?.trim();
      type = type?.trim().toLowerCase();

      if (!name || !location || !date || !type) {
        return res.status(400).json({
          message: "Name, location, date and type are required",
        });
      }

      if (!["lost", "found"].includes(type)) {
        return res.status(400).json({
          message: "Type must be either lost or found",
        });
      }

      // Validate date format: YYYY-MM-DD
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({
          message: "Date must be in YYYY-MM-DD format",
        });
      }

      const parsedDate = new Date(`${date}T00:00:00Z`);

      // Check whether the date actually exists
      if (
        Number.isNaN(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !== date
      ) {
        return res.status(400).json({
          message: "Please provide a valid date",
        });
      }

      // Prevent future dates
      const today = new Date().toISOString().slice(0, 10);

      if (date > today) {
        return res.status(400).json({
          message: "Date cannot be in the future",
        });
      }

      // ======================================================
      // IMAGE
      // ======================================================

      const image = req.file
        ? req.file.filename
        : null;

      const userId = req.user.id;

      // ======================================================
      // DATABASE INSERT
      // ======================================================

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
          description?.trim() || null,
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

module.exports = router;