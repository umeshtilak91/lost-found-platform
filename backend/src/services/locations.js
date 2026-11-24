"use strict";

// One definition of a location for the whole backend: input validation for
// listings and searches, the public distance query, and provider-coordinate
// retention.

const { z, ZodError } = require("zod");
const { HttpError } = require("../middleware/errors");

const SOURCES = ["provider", "device", "manual"];
// Radius options offered by the UI plus two wider legacy values.
const RADII_KM = [2, 5, 10, 25, 50, 100];
const PLACE_ID = /^[A-Za-z0-9_-]{4,512}$/;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{8,36}$/;
const COUNTRY = /^[A-Za-z]{2}$/;
const EARTH_KM = 6371;

// Strict decimal: rejects "", "1e3", "0x10", " 12 ", NaN and Infinity.
const coordinate = (min, max, label) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === "") return undefined;
      if (typeof value === "number") return value;
      return /^-?\d{1,3}(\.\d{1,10})?$/.test(String(value)) ? Number(value) : NaN;
    },
    z.number({ error: `${label} must be a number` }).finite(`${label} must be a number`).min(min, `${label} is out of range`).max(max, `${label} is out of range`).optional()
  );

const latitude = coordinate(-90, 90, "Latitude");
const longitude = coordinate(-180, 180, "Longitude");
const country = z
  .string()
  .trim()
  .regex(COUNTRY, "Use a two-letter country code")
  .transform((v) => v.toUpperCase());
const placeId = z.string().trim().regex(PLACE_ID, "Invalid place identifier");
const sessionToken = z.string().trim().regex(SESSION_TOKEN, "Invalid session token");
const radiusKm = z.preprocess(
  (value) => (value === undefined || value === null || value === "" ? undefined : /^\d{1,4}(\.\d+)?$/.test(String(value)) ? Number(value) : NaN),
  z
    .number({ error: "radiusKm must be a number" })
    .refine((v) => RADII_KM.includes(v), { message: `radiusKm must be one of ${RADII_KM.join(", ")}` })
    .optional()
);

// Reported like any other field validation error (400 validation_failed).
function fieldError(path, message) {
  return new ZodError([{ code: "custom", path: [path], message, input: undefined }]);
}

// Listing location fields as sent by the report/edit form.
const itemLocationShape = {
  latitude,
  longitude,
  locationSource: z.enum(SOURCES).optional(),
  locationPlaceId: placeId.optional(),
  locationCountry: country.optional(),
  locationAccuracyM: z.preprocess((v) => (v === "" || v === undefined ? undefined : Number(v)), z.number().int().min(0).max(1_000_000).optional()),
};

// Turns validated form input into item columns. Returns undefined when the
// request does not touch the location metadata (partial edits).
async function resolveItemLocation(input, { places, existing } = {}) {
  const hasCoords = input.latitude !== undefined;
  if (hasCoords !== (input.longitude !== undefined)) {
    throw fieldError("latitude", "Latitude and longitude must be provided together");
  }
  let source = input.locationSource;
  if (!source) {
    if (!hasCoords && !input.locationPlaceId) return undefined;
    source = input.locationPlaceId ? "provider" : "device"; // older clients sent bare coordinates from the device
  }
  const base = { location_country: input.locationCountry ?? null, location_admin_area: null };

  if (source === "manual") {
    if (hasCoords || input.locationPlaceId) {
      throw fieldError("location", "A typed location can't include coordinates. Choose a suggestion or use your location instead.");
    }
    return { ...base, location_source: "manual", location_provider: null, location_place_id: null, latitude: null, longitude: null, location_accuracy_m: null, location_coords_at: null };
  }

  if (source === "device") {
    if (!hasCoords) throw fieldError("location", "Your device position is missing. Try again or choose a suggestion.");
    if (input.locationPlaceId) throw fieldError("location", "A device position can't carry a place identifier");
    return {
      ...base,
      location_source: "device",
      location_provider: null,
      location_place_id: null,
      // ~11 m: enough for matching, never shown publicly.
      latitude: Math.round(input.latitude * 1e4) / 1e4,
      longitude: Math.round(input.longitude * 1e4) / 1e4,
      location_accuracy_m: input.locationAccuracyM ?? null,
      location_coords_at: new Date(),
    };
  }

  // provider: coordinates are looked up server-side from the place ID, never
  // trusted from the client.
  if (!input.locationPlaceId) throw fieldError("location", "Choose a location from the suggestions");
  if (existing && existing.location_place_id === input.locationPlaceId && existing.latitude !== null) {
    return {
      location_source: "provider",
      location_provider: existing.location_provider,
      location_place_id: existing.location_place_id,
      location_country: existing.location_country,
      location_admin_area: existing.location_admin_area,
      latitude: existing.latitude,
      longitude: existing.longitude,
      location_accuracy_m: null,
      location_coords_at: existing.location_coords_at,
    };
  }
  if (!places) throw new HttpError(503, "Location suggestions are unavailable. Type the area name instead.", "location_service_unavailable");
  const place = await lookupPlace(places, { placeId: input.locationPlaceId });
  return {
    location_source: "provider",
    location_provider: places.name,
    location_place_id: place.placeId,
    location_country: place.country || input.locationCountry || null,
    // Google address components are not stored (Places content may not be
    // cached). Fixture data is ours to keep.
    location_admin_area: places.name === "google" ? null : place.adminArea || null,
    latitude: place.lat,
    longitude: place.lng,
    location_accuracy_m: null,
    location_coords_at: new Date(),
  };
}

// Calls the provider and converts its errors into API errors.
async function lookupPlace(places, args) {
  try {
    return await places.details(args);
  } catch (error) {
    throw toHttpError(error);
  }
}

function toHttpError(error) {
  if (!error || !error.reason) return error;
  if (error.reason === "not_found") return new HttpError(400, "That place could not be found. Choose another suggestion.", "place_not_found");
  if (error.reason === "bad_request") return new HttpError(400, "That location request was invalid.", "invalid_location");
  const retryable = Boolean(error.retryable);
  const status = error.reason === "timeout" ? 504 : 503;
  const message = retryable ? "Location search is busy right now. Try again in a moment, or type the area name." : "Location suggestions are unavailable right now. Type the area name instead.";
  return new HttpError(status, message, "location_service_unavailable", { reason: error.reason, retryable });
}

// ---------------------------------------------------------------------------
// Distance search on the public grid
// ---------------------------------------------------------------------------
function haversineSql(latParam, lngParam) {
  return `(2 * ${EARTH_KM} * asin(LEAST(1, sqrt(
      power(sin(radians(i.grid_lat - ${latParam}) / 2), 2)
      + cos(radians(${latParam})) * cos(radians(i.grid_lat)) * power(sin(radians(i.grid_lng - ${lngParam}) / 2), 2)))))`;
}

// Index-friendly bounding box around the search circle (handles the poles
// and the antimeridian). The exact distance check runs afterwards.
function boundingBox(lat, lng, radius) {
  const dLat = radius / 111.0;
  const minLat = lat - dLat;
  const maxLat = lat + dLat;
  if (minLat <= -90 || maxLat >= 90) return { minLat: Math.max(-90, minLat), maxLat: Math.min(90, maxLat), lng: null };
  const dLng = radius / (111.0 * Math.cos((lat * Math.PI) / 180));
  if (dLng >= 180) return { minLat, maxLat, lng: null };
  let minLng = lng - dLng;
  let maxLng = lng + dLng;
  if (minLng < -180) return { minLat, maxLat, lng: { wrap: true, a: minLng + 360, b: maxLng } };
  if (maxLng > 180) return { minLat, maxLat, lng: { wrap: true, a: minLng, b: maxLng - 360 } };
  return { minLat, maxLat, lng: { wrap: false, a: minLng, b: maxLng } };
}

function distanceClauses(add, { lat, lng, radiusKm: radius }) {
  const latP = add(lat);
  const lngP = add(lng);
  const distance = haversineSql(latP, lngP);
  const where = [];
  if (radius !== undefined) {
    // A small epsilon keeps a listing that is exactly on the boundary inside.
    const box = boundingBox(lat, lng, radius + 0.001);
    where.push("i.grid_lat IS NOT NULL", `i.grid_lat BETWEEN ${add(box.minLat)} AND ${add(box.maxLat)}`);
    if (box.lng) {
      const a = add(box.lng.a);
      const b = add(box.lng.b);
      where.push(box.lng.wrap ? `(i.grid_lng >= ${a} OR i.grid_lng <= ${b})` : `i.grid_lng BETWEEN ${a} AND ${b}`);
    }
    where.push(`${distance} <= ${add(radius + 1e-6)}`);
  }
  return { select: `CASE WHEN i.grid_lat IS NULL THEN NULL ELSE ${distance} END AS distance_km`, where };
}

// Public distance, approximate by design.
function approximateDistance(km) {
  if (km === null || km === undefined) return undefined;
  if (km < 1) return 1; // shown as "under 1 km"
  if (km < 10) return Math.round(km * 2) / 2;
  return Math.round(km);
}

// ---------------------------------------------------------------------------
// Provider coordinate retention
// ---------------------------------------------------------------------------
// Google may be cached for up to 30 days (place IDs are exempt). Refresh
// older coordinates by place ID; if that is impossible, clear them so the
// listing falls back to text-only (it stays visible, just not in radius search).
async function refreshProviderCoordinates({ pool, places, config, logger, batch = 100 }) {
  const { rows } = await pool.query(
    `SELECT id, location_place_id FROM items
     WHERE location_provider = 'google' AND latitude IS NOT NULL
       AND location_coords_at < now() - ($1 || ' days')::interval
     ORDER BY location_coords_at LIMIT $2`,
    [String(config.places.coordinateMaxAgeDays), batch]
  );
  let refreshed = 0;
  let cleared = 0;
  for (const row of rows) {
    let place = null;
    if (places && places.name === "google") {
      try {
        place = await places.details({ placeId: row.location_place_id });
      } catch (error) {
        if (error.retryable) continue; // try again next run, before clearing
      }
    }
    if (place) {
      await pool.query("UPDATE items SET latitude = $2, longitude = $3, location_coords_at = now() WHERE id = $1", [row.id, place.lat, place.lng]);
      refreshed += 1;
    } else {
      await pool.query("UPDATE items SET latitude = NULL, longitude = NULL, location_coords_at = NULL WHERE id = $1", [row.id]);
      cleared += 1;
    }
  }
  if (rows.length) logger.info({ refreshed, cleared }, "Provider coordinates refreshed");
  return { refreshed, cleared };
}

module.exports = {
  RADII_KM,
  SOURCES,
  latitude,
  longitude,
  country,
  placeId,
  sessionToken,
  radiusKm,
  itemLocationShape,
  resolveItemLocation,
  lookupPlace,
  toHttpError,
  distanceClauses,
  boundingBox,
  approximateDistance,
  refreshProviderCoordinates,
};
