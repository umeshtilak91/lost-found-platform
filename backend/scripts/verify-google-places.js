"use strict";

// Live check of the Google Maps Platform configuration used by the location
// features. Makes exactly three billable-class calls (one autocomplete, one
// place details that closes the same session, one reverse geocode) and
// prints the outcome of each. The key is read from the environment and never
// printed.
//
//   node scripts/verify-google-places.js            (reads GOOGLE_MAPS_API_KEY)

require("dotenv").config({ quiet: true });
const crypto = require("crypto");
const { createGoogleProvider } = require("../src/integrations/places");

const ADVICE = {
  api_disabled: "Enable the API for the key's project (APIs & Services > Library), then wait a few minutes.",
  billing: "Link an active billing account to the project.",
  key_invalid: "The key is wrong, deleted or expired; create or copy a valid key.",
  restricted: "The key's restrictions block this request: allow this API in API restrictions and this server's IP in Application restrictions.",
  quota: "Quota or rate limit reached; check Quotas in the Cloud Console.",
  timeout: "No answer in time; check outbound network access.",
  unavailable: "Network or Google-side error; retry later.",
};

async function step(name, api, fn) {
  try {
    const detail = await fn();
    console.log(`PASS  ${name} [${api}] ${detail}`);
    return true;
  } catch (error) {
    const reason = error.reason || "error";
    console.log(`FAIL  ${name} [${api}] reason=${reason} http=${error.providerStatus ?? "-"} :: ${ADVICE[reason] || error.message}`);
    return false;
  }
}

async function main() {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.log("BLOCKED  GOOGLE_MAPS_API_KEY is not set");
    process.exit(2);
  }
  console.log(`Key present (length ${apiKey.length}, value not shown)`);
  const google = createGoogleProvider({ apiKey, timeoutMs: 8000 });
  const sessionToken = crypto.randomUUID();
  let placeId = null;
  const results = [];
  results.push(
    await step("Autocomplete 'Koramangala' (IN)", "Places API (New) places:autocomplete", async () => {
      const s = await google.autocomplete({ input: "Koramangala", sessionToken, country: "IN", language: "en" });
      if (!s.length) throw Object.assign(new Error("no suggestions"), { reason: "empty" });
      placeId = s[0].placeId;
      return `${s.length} suggestions, first: "${s[0].label}"`;
    })
  );
  results.push(
    await step("Place Details for first suggestion (same session)", "Places API (New) places/{id}", async () => {
      if (!placeId) throw Object.assign(new Error("skipped: no place id from autocomplete"), { reason: "skipped" });
      const p = await google.details({ placeId, sessionToken, language: "en" });
      return `lat/lng returned (${p.lat.toFixed(2)}, ${p.lng.toFixed(2)}), country ${p.country}, precision ${p.precision}`;
    })
  );
  results.push(
    await step("Reverse geocode 12.9352,77.6245", "Geocoding API", async () => {
      const r = await google.reverse({ lat: 12.9352, lng: 77.6245, language: "en" });
      return r ? `"${r.label}"` : "no area name (ZERO_RESULTS)";
    })
  );
  process.exit(results.every(Boolean) ? 0 : 1);
}

main();
