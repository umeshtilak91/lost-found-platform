"use strict";

const { withTransaction } = require("../db");

const USER_COLUMNS = `id, name, email, email_verified, profile_image, mobile_number, locale, role, created_at`;

// Resolves a provider identity to a user:
//   1. existing (provider, subject) identity -> that user
//   2. otherwise, if the provider asserts a *verified* email that matches an
//      existing user whose email is also verified -> link to that user
//   3. otherwise create a new user
// Linking never happens on an unverified email, which prevents account
// takeover by registering someone else's address with another provider.
async function resolveIdentity(pool, { provider, subject, email, emailVerified, name, profileImage }) {
  const normalizedEmail = email ? String(email).trim().toLowerCase() : null;

  return withTransaction(pool, async (db) => {
    const existing = await db.query(
      `SELECT u.${USER_COLUMNS.split(", ").join(", u.")}
       FROM auth_identities i JOIN users u ON u.id = i.user_id
       WHERE i.provider = $1 AND i.subject = $2`,
      [provider, subject]
    );
    if (existing.rows[0]) {
      const user = existing.rows[0];
      if (profileImage && provider === "google") {
        await db.query("UPDATE users SET profile_image = $1, updated_at = now() WHERE id = $2", [profileImage, user.id]);
        user.profile_image = profileImage;
      }
      return user;
    }

    let user = null;
    if (normalizedEmail && emailVerified) {
      const match = await db.query(
        `SELECT ${USER_COLUMNS} FROM users
         WHERE lower(email) = $1 AND email_verified = TRUE
         ORDER BY id LIMIT 1 FOR UPDATE`,
        [normalizedEmail]
      );
      user = match.rows[0] || null;
    }

    if (!user) {
      const created = await db.query(
        `INSERT INTO users (name, email, email_verified, profile_image, google_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${USER_COLUMNS}`,
        [
          name || (normalizedEmail ? normalizedEmail.split("@")[0] : null),
          normalizedEmail,
          Boolean(normalizedEmail && emailVerified),
          profileImage || null,
          provider === "google" ? subject : null,
        ]
      );
      user = created.rows[0];
    } else if (provider === "google") {
      await db.query("UPDATE users SET google_id = COALESCE(google_id, $1), updated_at = now() WHERE id = $2", [
        subject,
        user.id,
      ]);
    }

    await db.query(
      `INSERT INTO auth_identities (user_id, provider, subject) VALUES ($1, $2, $3)
       ON CONFLICT (provider, subject) DO NOTHING`,
      [user.id, provider, subject]
    );
    return user;
  });
}

async function loadUser(pool, id) {
  const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

module.exports = { resolveIdentity, loadUser, USER_COLUMNS };
