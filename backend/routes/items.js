const express = require("express");
const pool = require("../db");

const router = express.Router();


// ======================================================
// GET ALL LOST ITEMS
// ======================================================

router.get("/lost-items", async (req, res, next) => {
  try {
    const page = Number.parseInt(req.query.page, 10) || 1;
    const limit = Number.parseInt(req.query.limit, 10) || 10;

    if (page < 1 || limit < 1 || limit > 100) {
      return res.status(400).json({
        message: "Page must be >= 1 and limit must be between 1 and 100",
      });
    }

    const offset = (page - 1) * limit;

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
      WHERE items.type = 'lost'
      ORDER BY items.created_at DESC
      LIMIT $1 OFFSET $2
     `,
      [limit, offset]
    );

    res.json(result.rows);
  } catch (error) {
  next(error);
}
});





// ======================================================
// GET ALL FOUND ITEMS
// ======================================================

router.get("/found-items", async (req, res, next) => {
  try {
    const page = Number.parseInt(req.query.page, 10) || 1;
    const limit = Number.parseInt(req.query.limit, 10) || 10;

    if (page < 1 || limit < 1 || limit > 100) {
      return res.status(400).json({
        message: "Page must be >= 1 and limit must be between 1 and 100",
      });
    }

    const offset = (page - 1) * limit;

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
      WHERE items.type = 'found'
      ORDER BY items.created_at DESC
  LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );

    res.json(result.rows);
  } catch (error) {
  next(error);
}
});




// ======================================================
// GET SINGLE ITEM
// ======================================================

router.get("/items/:id", async (req, res, next) => {
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
  next(error);
}
});


// ======================================================
// GET ITEM STATISTICS
// ======================================================

router.get("/stats", async (req, res, next) => {
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
    next(error);
  }
});


// ======================================================
// EXPORT ROUTER
// ======================================================

module.exports = router;