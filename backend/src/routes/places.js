"use strict";

// Location lookup proxy. The browser never sees the provider key; these
// endpoints validate input, call the provider, and return only the fields the
// UI needs. Nothing here is stored and coordinates are never logged.

const express = require("express");
const { z } = require("zod");
const { HttpError } = require("../middleware/errors");
const { latitude, longitude, country, placeId, sessionToken, toHttpError } = require("../services/locations");

const MIN_INPUT = 3;
const LANGUAGE = z.enum(["en", "hi"]).optional();

function placesRoutes({ places, limits, logger }) {
  const router = express.Router();
  const enabled = Boolean(places);

  function requireProvider() {
    if (!enabled) throw new HttpError(503, "Location suggestions are not configured. Type the area name instead.", "location_service_unavailable", { reason: "unconfigured", retryable: false });
  }

  async function guarded(label, fn) {
    try {
      return await fn();
    } catch (error) {
      if (error && error.reason) {
        // Reason only; never the key, the query text or coordinates.
        logger.warn({ provider: places && places.name, op: label, reason: error.reason, providerStatus: error.providerStatus }, "Location provider error");
      }
      throw toHttpError(error);
    }
  }

  router.get("/places/config", (req, res) => {
    res.set("Cache-Control", "public, max-age=300").json({
      enabled,
      provider: enabled ? places.name : null,
      // Google requires attribution when predictions are shown without a Google map.
      attribution: enabled && places.name === "google" ? "Google Maps" : null,
      minChars: MIN_INPUT,
    });
  });

  router.get("/places/autocomplete", limits.places, async (req, res) => {
    requireProvider();
    const q = z
      .object({
        input: z.string().max(120, "Search text is too long"),
        sessionToken,
        country: country.optional(),
        lat: latitude,
        lng: longitude,
        lang: LANGUAGE,
      })
      .strict()
      .refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: "lat and lng must be provided together", path: ["lat"] })
      .parse(req.query);
    const input = q.input.normalize("NFC").replace(/\s+/g, " ").trim();
    res.set("Cache-Control", "private, no-store");
    // Short input: no provider call (cost and noise); the UI shows a hint.
    if ([...input].length < MIN_INPUT) return res.json({ suggestions: [], tooShort: true });
    const suggestions = await guarded("autocomplete", () =>
      places.autocomplete({ input, sessionToken: q.sessionToken, country: q.country, bias: q.lat !== undefined ? { lat: q.lat, lng: q.lng } : undefined, language: q.lang })
    );
    res.json({ suggestions: suggestions.slice(0, 5) });
  });

  router.get("/places/details", limits.places, async (req, res) => {
    requireProvider();
    const q = z.object({ placeId, sessionToken: sessionToken.optional(), lang: LANGUAGE }).strict().parse(req.query);
    const place = await guarded("details", () => places.details({ placeId: q.placeId, sessionToken: q.sessionToken, language: q.lang }));
    res.set("Cache-Control", "private, no-store").json({
      place: { placeId: place.placeId, lat: place.lat, lng: place.lng, country: place.country, precision: place.precision, label: place.label || null },
    });
  });

  router.get("/places/reverse", limits.places, async (req, res) => {
    requireProvider();
    const q = z
      .object({ lat: latitude, lng: longitude, lang: LANGUAGE })
      .strict()
      .refine((v) => v.lat !== undefined && v.lng !== undefined, { message: "lat and lng are required", path: ["lat"] })
      .parse(req.query);
    const place = await guarded("reverse", () => places.reverse({ lat: q.lat, lng: q.lng, language: q.lang }));
    res.set("Cache-Control", "private, no-store").json({
      place: place ? { label: place.label, country: place.country || null } : null,
    });
  });

  return router;
}

module.exports = { placesRoutes };
