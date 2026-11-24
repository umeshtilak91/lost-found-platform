"use strict";

// Outbound email adapters. All return { status, provider, messageId?, error? }:
//   status "sent"        provider accepted the message (messageId set)
//   status "failed"      provider rejected it (error is a sanitized summary)
//   status "unconfirmed" provider did not answer in time (it may still deliver)
//   status "skipped"     no provider configured
// Message bodies, codes and API keys are never logged.

const nodemailer = require("nodemailer");

function sanitize(message) {
  return String(message || "unknown error")
    .replace(/re_[A-Za-z0-9_]{8,}/g, "re_***") // Resend keys
    .replace(/\b\d{6}\b/g, "******") // anything that looks like a code
    .slice(0, 300);
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("Email provider timed out"), { code: "ETIMEOUT" })), ms);
    }),
  ]);
}

function createResendMailer(config, logger) {
  const { Resend } = require("resend");
  const resend = new Resend(config.mail.resendApiKey);
  return {
    configured: true,
    provider: "resend",
    async send({ to, subject, text, html, template }) {
      try {
        const { data, error } = await withTimeout(resend.emails.send({ from: config.mail.from, to, subject, text, html }), config.mail.timeoutMs);
        if (error) {
          const summary = sanitize(`${error.name || "error"}: ${error.message || ""}`);
          logger.warn({ template, provider: "resend", providerError: summary }, "Email rejected by provider");
          return { status: "failed", provider: "resend", error: summary };
        }
        logger.info({ template, provider: "resend", messageId: data?.id }, "Email accepted by provider");
        return { status: "sent", provider: "resend", messageId: data?.id || null };
      } catch (err) {
        if (err.code === "ETIMEOUT") {
          logger.warn({ template, provider: "resend" }, "Email provider timed out; delivery unconfirmed");
          return { status: "unconfirmed", provider: "resend", error: "timeout" };
        }
        const summary = sanitize(err.message);
        logger.error({ template, provider: "resend", providerError: summary }, "Email send threw");
        return { status: "failed", provider: "resend", error: summary };
      }
    },
  };
}

function createSmtpMailer(config, logger) {
  const transport = nodemailer.createTransport(config.mail.smtpUrl);
  return {
    configured: true,
    provider: "smtp",
    async send({ to, subject, text, html, template }) {
      try {
        const info = await withTimeout(transport.sendMail({ from: config.mail.from, to, subject, text, html }), config.mail.timeoutMs);
        return { status: "sent", provider: "smtp", messageId: info.messageId };
      } catch (err) {
        if (err.code === "ETIMEOUT") return { status: "unconfirmed", provider: "smtp", error: "timeout" };
        logger.error({ template, provider: "smtp", providerError: sanitize(err.message) }, "Email delivery failed");
        return { status: "failed", provider: "smtp", error: sanitize(err.code || err.message) };
      }
    },
  };
}

function createMailer(config, logger) {
  if (config.mail.resendApiKey) return createResendMailer(config, logger);
  if (config.mail.smtpUrl) return createSmtpMailer(config, logger);
  return {
    configured: false,
    provider: "none",
    async send({ template }) {
      logger.info({ template }, "Email not sent: no email provider configured");
      return { status: "skipped", provider: "none", error: "not_configured" };
    },
  };
}

module.exports = { createMailer, sanitize, withTimeout };
