const express = require("express");
const pool = require("../db");

const router = express.Router();


// ======================================================
// GET ALL LOST ITEMS
// ======================================================

router.get("/lost-items", async (req, res) => {
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


module.exports = router;


// ======================================================
// GET ALL FOUND ITEMS
// ======================================================

router.get("/found-items", async (req, res) => {
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

router.get("/items/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!/^\d+$/.test(id)) {
      return res.status(400).json({
        message: "Item ID must be a valid number",
      });
    }

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
// GET ITEM STATISTICS
// ======================================================

router.get("/stats", async (req, res) => {
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
// EXPORT ROUTER
// ======================================================

module.exports = router;