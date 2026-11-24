"use strict";

const express = require("express");
const { z } = require("zod");
const { HttpError } = require("../middleware/errors");
const { issueCsrfToken } = require("../middleware/security");
const { selfUser } = require("../services/serializers");
const { resolveIdentity } = require("../auth/accounts");

const emailSchema = z.string().trim().toLowerCase().email().max(254);

// Only same-site relative paths are allowed as post-login destinations.
function safeRedirect(next) {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f]/.test(next) || /^\/[^/]*:/.test(next)) return "/";
  return next;
}

function loginAndRespond(req, res, next, user) {
  // passport >= 0.6 regenerates the session ID on login (session fixation).
  req.login(user, (error) => {
    if (error) return next(error);
    return res.json({ user: selfUser(user), csrfToken: issueCsrfToken(req) });
  });
}

function authRoutes({ pool, config, passport, otp, limits, logger }) {
  const router = express.Router();
  const failure = `${config.appUrl}/login?error=oauth_failed`;

  router.get("/providers", (req, res) => {
    res.json({ google: Boolean(config.google), apple: Boolean(config.apple), email: config.emailLogin });
  });

  router.get("/me", (req, res) => {
    const csrfToken = issueCsrfToken(req);
    if (req.user) return res.json({ loggedIn: true, user: selfUser(req.user), csrfToken });
    return res.json({ loggedIn: false, csrfToken });
  });

  // --- Google -------------------------------------------------------------
  router.get("/google", limits.auth, (req, res, next) => {
    if (!config.google) return res.redirect(`${config.appUrl}/login?error=google_unconfigured`);
    return passport.authenticate("google")(req, res, next);
  });
  router.get("/google/callback", limits.auth, (req, res, next) => {
    if (!config.google) return res.redirect(`${config.appUrl}/login?error=google_unconfigured`);
    return passport.authenticate("google", { failureRedirect: failure })(req, res, (error) => {
      if (error) {
        logger.warn({ err: { message: error.message } }, "Google callback rejected");
        return res.redirect(failure);
      }
      return res.redirect(`${config.appUrl}/`);
    });
  });

  // --- Apple (form_post callback) ------------------------------------------
  router.get("/apple", limits.auth, (req, res, next) => {
    if (!config.apple) return res.redirect(`${config.appUrl}/login?error=apple_unconfigured`);
    return passport.authenticate("apple")(req, res, next);
  });
  router.post("/apple/callback", limits.auth, express.urlencoded({ extended: false, limit: "16kb" }), (req, res, next) => {
    if (!config.apple) return res.redirect(`${config.appUrl}/login?error=apple_unconfigured`);
    return passport.authenticate("apple", { failureRedirect: failure })(req, res, (error) => {
      if (error) return res.redirect(failure);
      return res.redirect(`${config.appUrl}/`);
    });
  });

  // --- Email one-time code -------------------------------------------------
  router.post("/email/request", limits.otpRequest, async (req, res) => {
    if (!config.emailLogin) throw new HttpError(503, "Email sign-in is not configured", "email_unconfigured");
    const email = emailSchema.parse(req.body?.email);
    const challenge = await otp.request(email);
    // Same shape whether or not the address has an account. The provider
    // message id is recorded server-side only.
    res.status(202).json({
      challengeId: challenge.challengeId,
      email: challenge.email,
      expiresAt: challenge.expiresAt,
      resendAvailableAt: challenge.resendAvailableAt,
      delivery: challenge.delivery,
    });
  });

  router.post("/email/verify", limits.otpVerify, async (req, res, next) => {
    if (!config.emailLogin) throw new HttpError(503, "Email sign-in is not configured", "email_unconfigured");
    const input = z
      .object({
        challengeId: z.string().uuid("Request a new code"),
        code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"),
        email: emailSchema.optional(),
        next: z.string().max(500).optional(),
      })
      .strict()
      .parse(req.body || {});
    const email = await otp.verify(input.challengeId, input.code, input.email);
    const user = await resolveIdentity(pool, { provider: "email", subject: email, email, emailVerified: true });
    // Proving control of the inbox verifies this address on the account.
    await pool.query("UPDATE users SET email_verified = TRUE, updated_at = now() WHERE id = $1 AND lower(email) = $2", [user.id, email]);
    user.email_verified = user.email_verified || (user.email || "").toLowerCase() === email;
    req.login(user, (error) => {
      if (error) return next(error);
      return res.json({ user: selfUser(user), csrfToken: issueCsrfToken(req), redirectTo: safeRedirect(input.next) });
    });
  });

  // --- Logout (POST + CSRF) ------------------------------------------------
  router.post("/logout", (req, res, next) => {
    req.logout((error) => {
      if (error) return next(error);
      req.session.destroy((destroyError) => {
        if (destroyError) return next(destroyError);
        res.clearCookie(config.session.cookieName, { path: "/" });
        return res.json({ ok: true });
      });
    });
  });

  // --- Test-only fixture login --------------------------------------------
  // Registered only when NODE_ENV=test and ENABLE_TEST_AUTH=true; config.js
  // refuses to start with ENABLE_TEST_AUTH in any other environment.
  if (config.enableTestAuth) {
    router.post("/test-login", async (req, res, next) => {
      const { email, name, role } = z
        .object({
          email: emailSchema,
          name: z.string().trim().min(1).max(100),
          role: z.enum(["user", "moderator", "admin"]).default("user"),
        })
        .parse(req.body || {});
      const user = await resolveIdentity(pool, { provider: "test", subject: email, email, emailVerified: true, name });
      if (user.role !== role) {
        await pool.query("UPDATE users SET role = $1 WHERE id = $2", [role, user.id]);
        user.role = role;
      }
      loginAndRespond(req, res, next, user);
    });
  }

  return router;
}

module.exports = { authRoutes, safeRedirect };
