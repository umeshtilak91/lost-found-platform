"use strict";

// Email one-time-code challenges.
//
// request(email):
//   - per-email advisory lock serializes concurrent requests for the same address
//   - 60s resend cooldown (429 with retryAfter) and a per-email request window
//   - a new challenge supersedes any unconsumed earlier one
//   - 6-digit code from a CSPRNG; only HMAC(secret, challengeId:email:code) is stored
//   - delivery: provider accepted -> "sent"; provider rejected -> challenge is
//     consumed ("delivery_failed") so it can never be used and no cooldown applies;
//     provider timeout -> "unconfirmed", the code stays valid because the email
//     may still arrive (the UI says so and offers a resend after the cooldown)
// verify(challengeId, code, email?):
//   - expiry, 5 wrong attempts, single use, all enforced with conditional UPDATEs
//     so concurrent verifications can succeed at most once

const crypto = require("crypto");
const { HttpError } = require("../middleware/errors");

function hashCode(secret, challengeId, email, code) {
  return crypto.createHmac("sha256", secret).update(`${challengeId}:${email}:${code}`).digest("hex");
}

function renderOtpEmail(code, ttlMinutes) {
  const text = `Your sign-in code is ${code}. It expires in ${ttlMinutes} minutes. If you did not request this code, you can ignore this email.`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f7f8fa;font-family:Arial,Helvetica,sans-serif;color:#15191e">
  <table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #dfe3e8;border-radius:12px">
    <tr><td style="padding:24px">
      <p style="margin:0 0 8px;font-size:18px;font-weight:bold">Lost &amp; Found</p>
      <p style="margin:0 0 16px">Your sign-in code is:</p>
      <p style="margin:0 0 16px;font-size:32px;letter-spacing:8px;font-weight:bold;font-family:Menlo,Consolas,monospace">${code}</p>
      <p style="margin:0 0 8px;color:#5b6573">It expires in ${ttlMinutes} minutes.</p>
      <p style="margin:0;color:#5b6573;font-size:13px">If you did not request this code, you can ignore this email. We will never ask you for this code by phone or chat.</p>
    </td></tr>
  </table></body></html>`;
  return { text, html };
}

function createOtpService({ pool, mailer, config }) {
  const { ttlMinutes, resendCooldownSeconds, maxAttempts, maxRequestsPerEmail, requestWindowMinutes } = config.otp;

  async function request(email) {
    const client = await pool.connect();
    let challenge;
    let code;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["otp:" + email]);

      const recent = await client.query(
        `SELECT created_at FROM otp_codes
         WHERE email = $1 AND consumed_at IS NULL AND delivery_status <> 'failed'
           AND created_at > now() - ($2 || ' seconds')::interval
         ORDER BY created_at DESC LIMIT 1`,
        [email, String(resendCooldownSeconds)]
      );
      if (recent.rows[0]) {
        const retryAfter = Math.max(1, Math.ceil(resendCooldownSeconds - (Date.now() - new Date(recent.rows[0].created_at).getTime()) / 1000));
        throw new HttpError(429, `Please wait ${retryAfter} seconds before requesting another code`, "otp_cooldown", { retryAfter });
      }
      const windowCount = await client.query(
        "SELECT count(*)::int AS n FROM otp_codes WHERE email = $1 AND created_at > now() - ($2 || ' minutes')::interval",
        [email, String(requestWindowMinutes)]
      );
      if (windowCount.rows[0].n >= maxRequestsPerEmail) {
        throw new HttpError(429, `Too many codes requested. Please try again in ${requestWindowMinutes} minutes.`, "otp_limit");
      }

      await client.query(
        "UPDATE otp_codes SET consumed_at = now(), consumed_reason = 'superseded' WHERE email = $1 AND consumed_at IS NULL",
        [email]
      );
      const challengeId = crypto.randomUUID();
      code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
      const inserted = await client.query(
        `INSERT INTO otp_codes (challenge_id, email, code_hash, expires_at, delivery_status, provider)
         VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval, 'sending', $5)
         RETURNING challenge_id, expires_at, created_at`,
        [challengeId, email, hashCode(config.session.secret, challengeId, email, code), String(ttlMinutes), mailer.provider || null]
      );
      challenge = inserted.rows[0];
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    // Provider call happens outside the transaction (never hold a lock across network I/O).
    const { text, html } = renderOtpEmail(code, ttlMinutes);
    const result = await mailer.send({ to: email, subject: "Your Lost & Found sign-in code", text, html, template: "otp" });
    code = null;

    if (result.status === "sent") {
      await pool.query("UPDATE otp_codes SET delivery_status = 'sent', provider_message_id = $2 WHERE challenge_id = $1", [challenge.challenge_id, result.messageId || null]);
    } else if (result.status === "unconfirmed") {
      await pool.query("UPDATE otp_codes SET delivery_status = 'unconfirmed', provider_error = 'timeout' WHERE challenge_id = $1", [challenge.challenge_id]);
    } else {
      await pool.query(
        "UPDATE otp_codes SET delivery_status = 'failed', provider_error = $2, consumed_at = now(), consumed_reason = 'delivery_failed' WHERE challenge_id = $1",
        [challenge.challenge_id, result.error || result.status]
      );
      throw new HttpError(502, "We couldn't send the email right now. Please try again in a moment or use another sign-in option.", "email_delivery_failed");
    }

    return {
      challengeId: challenge.challenge_id,
      email,
      expiresAt: new Date(challenge.expires_at).toISOString(),
      resendAvailableAt: new Date(new Date(challenge.created_at).getTime() + resendCooldownSeconds * 1000).toISOString(),
      delivery: result.status === "sent" ? "sent" : "unconfirmed",
      messageId: result.messageId || null,
    };
  }

  // Returns the verified email or throws a precise, user-safe error.
  async function verify(challengeId, code, expectedEmail) {
    const { rows } = await pool.query(
      "SELECT id, email, code_hash, attempts, expires_at, consumed_at, consumed_reason, delivery_status FROM otp_codes WHERE challenge_id = $1",
      [challengeId]
    );
    const record = rows[0];
    if (!record || (expectedEmail && record.email !== expectedEmail)) {
      throw new HttpError(400, "That code doesn't match this sign-in request. Request a new code.", "invalid_challenge");
    }
    if (record.consumed_at) {
      const reason = record.consumed_reason;
      if (reason === "attempts") throw new HttpError(400, "Too many incorrect attempts. Request a new code.", "otp_locked");
      if (reason === "superseded") throw new HttpError(400, "A newer code was sent. Use the latest email.", "otp_superseded");
      throw new HttpError(400, "This code was already used or is no longer valid. Request a new code.", "otp_used");
    }
    if (new Date(record.expires_at).getTime() <= Date.now()) {
      throw new HttpError(400, "This code has expired. Request a new code.", "otp_expired");
    }

    const expected = Buffer.from(record.code_hash, "hex");
    const actual = Buffer.from(hashCode(config.session.secret, challengeId, record.email, code), "hex");
    if (!crypto.timingSafeEqual(expected, actual)) {
      const updated = await pool.query(
        `UPDATE otp_codes SET attempts = attempts + 1,
           consumed_at = CASE WHEN attempts + 1 >= $2 THEN now() ELSE consumed_at END,
           consumed_reason = CASE WHEN attempts + 1 >= $2 THEN 'attempts' ELSE consumed_reason END
         WHERE id = $1 AND consumed_at IS NULL RETURNING attempts`,
        [record.id, maxAttempts]
      );
      const attempts = updated.rows[0]?.attempts ?? maxAttempts;
      const remaining = Math.max(0, maxAttempts - attempts);
      if (remaining === 0) throw new HttpError(400, "Too many incorrect attempts. Request a new code.", "otp_locked");
      throw new HttpError(400, `That code is incorrect. ${remaining} attempt${remaining === 1 ? "" : "s"} left.`, "invalid_code", { remaining });
    }

    const consumed = await pool.query(
      `UPDATE otp_codes SET consumed_at = now(), consumed_reason = 'verified'
       WHERE id = $1 AND consumed_at IS NULL AND expires_at > now() AND attempts < $2 RETURNING email`,
      [record.id, maxAttempts]
    );
    if (consumed.rowCount !== 1) throw new HttpError(400, "This code was already used or is no longer valid. Request a new code.", "otp_used");
    return consumed.rows[0].email;
  }

  return { request, verify };
}

module.exports = { createOtpService, hashCode, renderOtpEmail };
