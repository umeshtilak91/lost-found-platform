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

module.exports = router;