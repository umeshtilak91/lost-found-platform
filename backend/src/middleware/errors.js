"use strict";

const { ZodError } = require("zod");

class HttpError extends Error {
  constructor(status, message, code = undefined, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function notFound(req, res) {
  res.status(404).json({ error: { code: "not_found", message: "Not found" } });
}

// Final error handler: known errors return their status; anything else is
// logged with the request ID and returned as a generic 500.
function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: "validation_failed",
        message: "Some fields are invalid",
        fields: err.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
      requestId: req.id,
    });
  }
  if (err instanceof HttpError) {
    if (err.status >= 500) req.log?.error({ err }, err.message);
    return res.status(err.status).json({
      error: { code: err.code || "error", message: err.message, ...(err.details ? { details: err.details } : {}) },
      requestId: req.id,
    });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: { code: "payload_too_large", message: "Request is too large" } });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "invalid_json", message: "Malformed JSON body" } });
  }
  req.log?.error({ err }, "Unhandled error");
  return res.status(500).json({
    error: { code: "internal_error", message: "Something went wrong. Please try again." },
    requestId: req.id,
  });
}

module.exports = { HttpError, notFound, errorHandler };
