"use strict";

// Location provider behind one small interface:
//   autocomplete({ input, sessionToken, country, bias, language }) -> suggestions[]
//   details({ placeId, sessionToken, language })                    -> place
//   reverse({ lat, lng, language })                                 -> place | null
//
// "google"  Places API (New) Autocomplete + Place Details (New), Geocoding API
//           reverse geocoding. Called only from the server; the key never
//           reaches the browser.
// "fixture" Deterministic offline data for tests and local development.
// "none"    Location suggestions disabled; the UI falls back to typed text.
//
// Provider failures are normalised to PlacesError with a stable `reason` so
// the API, logs and UI never depend on Google's error wording.

const PLACES_BASE = "https://places.googleapis.com/v1";
const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

class PlacesError extends Error {
  constructor(reason, message, { retryable = false, status } = {}) {
    super(message);
    this.reason = reason; // key_invalid | api_disabled | billing | restricted | quota | timeout | unavailable | not_found | unconfigured | bad_request
    this.retryable = retryable;
    this.providerStatus = status;
  }
}

// ---------------------------------------------------------------------------
// Google error mapping (Places API (New) JSON errors and legacy web-service
// statuses returned by the Geocoding API).
// ---------------------------------------------------------------------------
function classifyGoogleError(httpStatus, body) {
  const err = body && body.error;
  if (err && typeof err === "object") {
    const details = Array.isArray(err.details) ? err.details : [];
    const reasons = details.map((d) => d && d.reason).filter(Boolean);
    const text = `${err.message || ""} ${reasons.join(" ")}`;
    if (reasons.includes("API_KEY_INVALID") || /API key not valid|API key expired/i.test(text)) return "key_invalid";
    if (reasons.some((r) => /HTTP_REFERRER_BLOCKED|IP_ADDRESS_BLOCKED|ANDROID_APP_BLOCKED|IOS_APP_BLOCKED|API_KEY_SERVICE_BLOCKED/.test(r))) return "restricted";
    if (reasons.includes("BILLING_DISABLED") || /billing/i.test(text)) return "billing";
    if (reasons.includes("SERVICE_DISABLED") || reasons.includes("ACCESS_DENIED") || /has not been used|is disabled|Permission denied on the service/i.test(text)) return "api_disabled";
    if (httpStatus === 429 || err.status === "RESOURCE_EXHAUSTED" || reasons.includes("RATE_LIMIT_EXCEEDED")) return "quota";
    if (httpStatus === 404 || err.status === "NOT_FOUND") return "not_found";
    if (httpStatus === 400 || err.status === "INVALID_ARGUMENT") return "bad_request";
    if (httpStatus === 403) return "restricted";
    return "unavailable";
  }
  const status = body && body.status;
  const message = String((body && body.error_message) || "");
  if (status === "OVER_QUERY_LIMIT" || status === "OVER_DAILY_LIMIT") return /billing/i.test(message) ? "billing" : "quota";
  if (status === "REQUEST_DENIED") {
    if (/invalid/i.test(message) && /key/i.test(message)) return "key_invalid";
    if (/billing/i.test(message)) return "billing";
    if (/not authorized|referer|referrer|IP address/i.test(message)) return "restricted";
    if (/not activated|not enabled|legacy API/i.test(message)) return "api_disabled";
    return "restricted";
  }
  if (status === "INVALID_REQUEST") return "bad_request";
  if (status === "NOT_FOUND") return "not_found";
  if (httpStatus === 429) return "quota";
  return "unavailable";
}

const RETRYABLE = new Set(["quota", "timeout", "unavailable"]);

function componentsOf(list = [], pick) {
  const byType = (type) => list.find((c) => (c.types || []).includes(type));
  const name = (c) => (c ? c[pick.long] : undefined);
  const short = (c) => (c ? c[pick.short] : undefined);
  return {
    country: short(byType("country"))?.toUpperCase() || null,
    adminArea: name(byType("administrative_area_level_1")) || null,
    locality: name(byType("locality")) || name(byType("postal_town")) || name(byType("administrative_area_level_2")) || null,
    sublocality: name(byType("sublocality_level_1")) || name(byType("sublocality")) || name(byType("neighborhood")) || null,
  };
}

// Precision from the place types: a named area is shown as an area, a street
// address or point of interest is exact.
function precisionOf(types = []) {
  if (types.some((t) => ["street_address", "premise", "subpremise", "point_of_interest", "establishment", "route", "transit_station", "airport"].includes(t))) return "exact";
  if (types.some((t) => ["country", "administrative_area_level_1", "administrative_area_level_2"].includes(t))) return "region";
  return "area";
}

function createGoogleProvider({ apiKey, timeoutMs = 4000, fetchImpl = globalThis.fetch }) {
  async function call(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error && error.name === "AbortError") throw new PlacesError("timeout", "Location provider timed out", { retryable: true });
      throw new PlacesError("unavailable", "Location provider unreachable", { retryable: true });
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const legacyFailure = body && typeof body.status === "string" && !["OK", "ZERO_RESULTS"].includes(body.status);
    if (!res.ok || legacyFailure || (body && body.error)) {
      const reason = classifyGoogleError(res.status, body);
      throw new PlacesError(reason, `Location provider error (${reason})`, { retryable: RETRYABLE.has(reason), status: res.status });
    }
    return body || {};
  }

  return {
    name: "google",
    async autocomplete({ input, sessionToken, country, bias, language }) {
      const body = { input, sessionToken, languageCode: language, includeQueryPredictions: false };
      if (country) body.includedRegionCodes = [country.toLowerCase()];
      if (country) body.regionCode = country.toLowerCase();
      if (bias) body.locationBias = { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: 50000 } };
      const data = await call(`${PLACES_BASE}/places:autocomplete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types",
        },
        body: JSON.stringify(body),
      });
      return (data.suggestions || [])
        .map((s) => s.placePrediction)
        .filter((p) => p && p.placeId)
        .map((p) => ({
          placeId: p.placeId,
          primary: p.structuredFormat?.mainText?.text || p.text?.text || "",
          secondary: p.structuredFormat?.secondaryText?.text || "",
          label: p.text?.text || p.structuredFormat?.mainText?.text || "",
        }));
    },
    async details({ placeId, sessionToken, language }) {
      const params = new URLSearchParams();
      if (sessionToken) params.set("sessionToken", sessionToken);
      if (language) params.set("languageCode", language);
      // Essentials fields only: id, location, address components, types.
      const data = await call(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}?${params}`, {
        headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "id,location,addressComponents,types,shortFormattedAddress" },
      });
      if (!data.location) throw new PlacesError("not_found", "Place has no location");
      return {
        placeId: data.id || placeId,
        lat: data.location.latitude,
        lng: data.location.longitude,
        label: data.shortFormattedAddress || null,
        precision: precisionOf(data.types),
        ...componentsOf(data.addressComponents, { long: "longText", short: "shortText" }),
      };
    },
    async reverse({ lat, lng, language }) {
      const params = new URLSearchParams({
        latlng: `${lat},${lng}`,
        key: apiKey,
        result_type: "sublocality|neighborhood|locality|administrative_area_level_2",
      });
      if (language) params.set("language", language);
      const data = await call(`${GEOCODE_URL}?${params}`);
      const result = (data.results || [])[0];
      if (!result) return null;
      const parts = componentsOf(result.address_components, { long: "long_name", short: "short_name" });
      const label = [parts.sublocality, parts.locality, parts.adminArea].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", ");
      return { placeId: result.place_id || null, label: label || result.formatted_address || null, ...parts };
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture provider: known places with exact coordinates (on the 0.01° public
// grid, so distance tests are exact) and deterministic failure triggers.
// ---------------------------------------------------------------------------
const FIXTURE_PLACES = [
  { placeId: "fx_koramangala_blr", primary: "Koramangala", secondary: "Bengaluru, Karnataka, India", country: "IN", adminArea: "Karnataka", locality: "Bengaluru", lat: 12.93, lng: 77.62, precision: "area" },
  { placeId: "fx_indiranagar_blr", primary: "Indiranagar", secondary: "Bengaluru, Karnataka, India", country: "IN", adminArea: "Karnataka", locality: "Bengaluru", lat: 12.97, lng: 77.64, precision: "area" },
  { placeId: "fx_mgroad_blr", primary: "MG Road", secondary: "Bengaluru, Karnataka, India", country: "IN", adminArea: "Karnataka", locality: "Bengaluru", lat: 12.97, lng: 77.61, precision: "area" },
  { placeId: "fx_mgroad_pune", primary: "MG Road", secondary: "Camp, Pune, Maharashtra, India", country: "IN", adminArea: "Maharashtra", locality: "Pune", lat: 18.51, lng: 73.88, precision: "area" },
  { placeId: "fx_mgroad_ggn", primary: "MG Road", secondary: "Gurugram, Haryana, India", country: "IN", adminArea: "Haryana", locality: "Gurugram", lat: 28.48, lng: 77.08, precision: "area" },
  { placeId: "fx_shivajinagar_pune", primary: "Shivajinagar", secondary: "Pune, Maharashtra, India", country: "IN", adminArea: "Maharashtra", locality: "Pune", lat: 18.53, lng: 73.85, precision: "area" },
  { placeId: "fx_shivajinagar_blr", primary: "Shivajinagar", secondary: "Bengaluru, Karnataka, India", country: "IN", adminArea: "Karnataka", locality: "Bengaluru", lat: 12.99, lng: 77.6, precision: "area" },
  { placeId: "fx_pune_station", primary: "Pune Railway Station", secondary: "Agarkar Nagar, Pune, Maharashtra, India", country: "IN", adminArea: "Maharashtra", locality: "Pune", lat: 18.53, lng: 73.87, precision: "exact" },
  { placeId: "fx_pune", primary: "Pune", secondary: "Maharashtra, India", aliases: ["पुणे"], country: "IN", adminArea: "Maharashtra", locality: "Pune", lat: 18.52, lng: 73.86, precision: "area" },
  { placeId: "fx_connaught_del", primary: "Connaught Place", secondary: "New Delhi, Delhi, India", aliases: ["कनॉट प्लेस"], country: "IN", adminArea: "Delhi", locality: "New Delhi", lat: 28.63, lng: 77.22, precision: "area" },
  { placeId: "fx_bandra_mum", primary: "Bandra West", secondary: "Mumbai, Maharashtra, India", country: "IN", adminArea: "Maharashtra", locality: "Mumbai", lat: 19.06, lng: 72.83, precision: "area" },
  { placeId: "fx_camden_lon", primary: "Camden Town", secondary: "London, UK", country: "GB", adminArea: "England", locality: "London", lat: 51.54, lng: -0.14, precision: "area" },
  { placeId: "fx_springfield_il", primary: "Springfield", secondary: "IL, USA", country: "US", adminArea: "Illinois", locality: "Springfield", lat: 39.78, lng: -89.65, precision: "area" },
  { placeId: "fx_springfield_ma", primary: "Springfield", secondary: "MA, USA", country: "US", adminArea: "Massachusetts", locality: "Springfield", lat: 42.1, lng: -72.59, precision: "area" },
  { placeId: "fx_suva_fj", primary: "Suva", secondary: "Fiji", country: "FJ", adminArea: "Central", locality: "Suva", lat: -18.14, lng: 178.44, precision: "area" },
];

// Fixture reverse geocoding: nearest fixture area within 30 km.
function haversineKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const FIXTURE_FAILURES = {
  zzerrkey: ["key_invalid", false],
  zzerrdisabled: ["api_disabled", false],
  zzerrbilling: ["billing", false],
  zzerrreferrer: ["restricted", false],
  zzerrquota: ["quota", true],
  zzerrtimeout: ["timeout", true],
  zzerrdown: ["unavailable", true],
};

function createFixtureProvider({ delay = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const normalize = (s) => s.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
  const failFor = (input) => {
    const hit = Object.entries(FIXTURE_FAILURES).find(([trigger]) => normalize(input).startsWith(trigger));
    if (hit) throw new PlacesError(hit[1][0], `Simulated provider error (${hit[1][0]})`, { retryable: hit[1][1] });
  };
  return {
    name: "fixture",
    async autocomplete({ input, country, bias }) {
      failFor(input);
      // "zzslowNNN" delays the answer by NNN ms (stale-response tests).
      const slow = /^zzslow(\d{1,4})\s*(.*)$/i.exec(input.trim());
      if (slow) await delay(Number(slow[1]));
      const term = normalize(slow ? slow[2] : input);
      const matches = FIXTURE_PLACES.filter((p) => !country || p.country === country)
        .filter((p) => [p.primary, `${p.primary}, ${p.secondary}`, ...(p.aliases || [])].some((name) => normalize(name).includes(term)))
        .sort((a, b) => (bias ? haversineKm(bias, a) - haversineKm(bias, b) : 0));
      return matches.slice(0, 5).map((p) => ({ placeId: p.placeId, primary: p.primary, secondary: p.secondary, label: `${p.primary}, ${p.secondary}` }));
    },
    async details({ placeId }) {
      const place = FIXTURE_PLACES.find((p) => p.placeId === placeId);
      if (!place) throw new PlacesError("not_found", "Unknown place");
      return { placeId, lat: place.lat, lng: place.lng, label: `${place.primary}, ${place.locality}`, precision: place.precision, country: place.country, adminArea: place.adminArea, locality: place.locality, sublocality: null };
    },
    async reverse({ lat, lng }) {
      // Latitude 0 / longitude 0 ("Null Island") simulates a reverse-geocoding outage.
      if (lat === 0 && lng === 0) throw new PlacesError("unavailable", "Simulated reverse-geocoding failure", { retryable: true });
      const nearest = FIXTURE_PLACES.map((p) => ({ p, d: haversineKm({ lat, lng }, p) })).sort((a, b) => a.d - b.d)[0];
      if (!nearest || nearest.d > 30) return null;
      const { p } = nearest;
      return { placeId: p.placeId, label: `${p.primary}, ${p.locality}`, country: p.country, adminArea: p.adminArea, locality: p.locality };
    },
  };
}

function createPlacesProvider(config, overrides = {}) {
  const { provider, apiKey, timeoutMs } = config.places;
  if (provider === "google") return createGoogleProvider({ apiKey, timeoutMs, ...overrides });
  if (provider === "fixture") return createFixtureProvider(overrides);
  return null;
}

module.exports = { PlacesError, classifyGoogleError, createGoogleProvider, createFixtureProvider, createPlacesProvider, haversineKm, FIXTURE_PLACES };
