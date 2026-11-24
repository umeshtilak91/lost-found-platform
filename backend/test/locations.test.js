"use strict";

// Location features: provider proxy, Google error mapping (stubbed fetch, no
// network), listing location storage, server-side radius search on the public
// grid, privacy, pagination, legacy data and provider-coordinate retention.
//
// Geography fixtures are on the 0.01° grid so distances are exact:
//   1° of latitude = 2π·6371/360 = 111.19493 km.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { setup, createItem, createDatabase } = require("./helpers");
const { createGoogleProvider, classifyGoogleError, haversineKm } = require("../src/integrations/places");
const { refreshProviderCoordinates, boundingBox, approximateDistance } = require("../src/services/locations");

const KM_PER_DEG = (2 * Math.PI * 6371) / 360;
const TOKEN = "3f0e4a52-6d1b-4c7e-9a43-2b8f1e7c9d10";

let ctx;
before(async () => {
  ctx = await setup();
});
after(async () => ctx && ctx.teardown());

// ---------------------------------------------------------------------------
describe("Google provider (stubbed HTTP, no network)", () => {
  function stub(status, body, record = []) {
    return async (url, init) => {
      record.push({ url: String(url), init });
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    };
  }
  const googleError = (code, status, reason, message) => ({ error: { code, status, message, details: reason ? [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason }] : [] } });

  test("maps real-world Google error shapes to stable reasons", () => {
    const cases = [
      // Observed live from the supplied key's project on 2026-11-23:
      [403, googleError(403, "PERMISSION_DENIED", "ACCESS_DENIED", "Permission denied on the service."), "api_disabled"],
      [403, googleError(403, "PERMISSION_DENIED", "SERVICE_DISABLED", "Places API (New) has not been used in project 1 before or it is disabled."), "api_disabled"],
      [400, googleError(400, "INVALID_ARGUMENT", "API_KEY_INVALID", "API key not valid. Please pass a valid API key."), "key_invalid"],
      [403, googleError(403, "PERMISSION_DENIED", "BILLING_DISABLED", "This API method requires billing to be enabled."), "billing"],
      [403, googleError(403, "PERMISSION_DENIED", "API_KEY_HTTP_REFERRER_BLOCKED", "Requests from referer <empty> are blocked."), "restricted"],
      [403, googleError(403, "PERMISSION_DENIED", "API_KEY_IP_ADDRESS_BLOCKED", "Requests from this IP are blocked."), "restricted"],
      [403, googleError(403, "PERMISSION_DENIED", "API_KEY_SERVICE_BLOCKED", "Requests to this API are blocked."), "restricted"],
      [429, googleError(429, "RESOURCE_EXHAUSTED", "RATE_LIMIT_EXCEEDED", "Quota exceeded."), "quota"],
      [404, googleError(404, "NOT_FOUND", null, "Not found"), "not_found"],
      [500, googleError(500, "INTERNAL", null, "Internal error"), "unavailable"],
      // Geocoding API (legacy web-service status format), as observed live:
      [200, { status: "REQUEST_DENIED", error_message: "This API is not activated on your API project." }, "api_disabled"],
      [200, { status: "REQUEST_DENIED", error_message: "The provided API key is invalid." }, "key_invalid"],
      [200, { status: "REQUEST_DENIED", error_message: "You must enable Billing on the Google Cloud Project" }, "billing"],
      [200, { status: "REQUEST_DENIED", error_message: "This IP, site or mobile application is not authorized to use this API key." }, "restricted"],
      [200, { status: "OVER_QUERY_LIMIT", error_message: "You have exceeded your rate-limit for this API." }, "quota"],
    ];
    for (const [status, body, reason] of cases) assert.equal(classifyGoogleError(status, body), reason, JSON.stringify(body));
  });

  test("autocomplete: key in header (never URL), session token, country and bias forwarded, fields mapped", async () => {
    const calls = [];
    const google = createGoogleProvider({
      apiKey: "TEST-KEY-123",
      fetchImpl: stub(200, {
        suggestions: [
          { placePrediction: { placeId: "ChIJ1", text: { text: "MG Road, Bengaluru, Karnataka, India" }, structuredFormat: { mainText: { text: "MG Road" }, secondaryText: { text: "Bengaluru, Karnataka, India" } } } },
          { queryPrediction: { text: { text: "mg road shops" } } },
        ],
      }, calls),
    });
    const out = await google.autocomplete({ input: "MG Ro", sessionToken: TOKEN, country: "IN", bias: { lat: 12.97, lng: 77.6 }, language: "en" });
    assert.deepEqual(out, [{ placeId: "ChIJ1", primary: "MG Road", secondary: "Bengaluru, Karnataka, India", label: "MG Road, Bengaluru, Karnataka, India" }]);
    assert.equal(calls[0].url, "https://places.googleapis.com/v1/places:autocomplete");
    assert.ok(!calls[0].url.includes("TEST-KEY"));
    assert.equal(calls[0].init.headers["X-Goog-Api-Key"], "TEST-KEY-123");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.sessionToken, TOKEN);
    assert.deepEqual(body.includedRegionCodes, ["in"]);
    assert.deepEqual(body.locationBias.circle.center, { latitude: 12.97, longitude: 77.6 });
  });

  test("details requests only essentials fields and ends the session token; reverse picks the area", async () => {
    const calls = [];
    const google = createGoogleProvider({
      apiKey: "K",
      fetchImpl: stub(200, {
        id: "ChIJ1",
        location: { latitude: 12.9716, longitude: 77.5946 },
        types: ["sublocality", "political"],
        addressComponents: [
          { longText: "India", shortText: "IN", types: ["country"] },
          { longText: "Karnataka", shortText: "KA", types: ["administrative_area_level_1"] },
          { longText: "Bengaluru", shortText: "Bengaluru", types: ["locality"] },
        ],
      }, calls),
    });
    const place = await google.details({ placeId: "ChIJ1", sessionToken: TOKEN });
    assert.equal(place.lat, 12.9716);
    assert.equal(place.country, "IN");
    assert.equal(place.precision, "area");
    assert.match(calls[0].url, /\/places\/ChIJ1\?sessionToken=3f0e4a52/);
    assert.equal(calls[0].init.headers["X-Goog-FieldMask"], "id,location,addressComponents,types,shortFormattedAddress");

    const geo = createGoogleProvider({
      apiKey: "K",
      fetchImpl: stub(200, {
        status: "OK",
        results: [{ place_id: "ChIJk", formatted_address: "Koramangala, Bengaluru", address_components: [
          { long_name: "Koramangala", short_name: "Koramangala", types: ["sublocality_level_1", "sublocality"] },
          { long_name: "Bengaluru", short_name: "Bengaluru", types: ["locality"] },
          { long_name: "Karnataka", short_name: "KA", types: ["administrative_area_level_1"] },
          { long_name: "India", short_name: "IN", types: ["country"] },
        ] }],
      }),
    });
    assert.deepEqual(await geo.reverse({ lat: 12.93, lng: 77.62 }), { placeId: "ChIJk", label: "Koramangala, Bengaluru, Karnataka", country: "IN", adminArea: "Karnataka", locality: "Bengaluru", sublocality: "Koramangala" });
    const none = createGoogleProvider({ apiKey: "K", fetchImpl: stub(200, { status: "ZERO_RESULTS", results: [] }) });
    assert.equal(await none.reverse({ lat: 0.5, lng: -160 }), null);
  });

  test("timeout and network failures are retryable; errors never contain the key", async () => {
    const hang = createGoogleProvider({
      apiKey: "SECRET-KEY",
      timeoutMs: 50,
      fetchImpl: (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    });
    await assert.rejects(hang.autocomplete({ input: "abc", sessionToken: TOKEN }), (e) => e.reason === "timeout" && e.retryable && !e.message.includes("SECRET"));
    const offline = createGoogleProvider({ apiKey: "SECRET-KEY", fetchImpl: async () => { throw new TypeError("fetch failed"); } });
    await assert.rejects(offline.reverse({ lat: 1, lng: 1 }), (e) => e.reason === "unavailable" && e.retryable);
    const denied = createGoogleProvider({ apiKey: "SECRET-KEY", fetchImpl: stub(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "Permission denied on the service.", details: [{ reason: "ACCESS_DENIED" }] } }) });
    await assert.rejects(denied.autocomplete({ input: "abc", sessionToken: TOKEN }), (e) => e.reason === "api_disabled" && !e.retryable && !e.message.includes("SECRET"));
  });
});

// ---------------------------------------------------------------------------
describe("location proxy endpoints (fixture provider)", () => {
  const ac = (qs) => ctx.anonymous().get(`/api/places/autocomplete?sessionToken=${TOKEN}&${qs}`);

  test("config reports the provider and attribution", async () => {
    const res = await ctx.anonymous().get("/api/places/config").expect(200);
    assert.deepEqual(res.body, { enabled: true, provider: "fixture", attribution: null, minChars: 3 });
  });

  test("partial area name returns suggestions; similarly named places are distinguishable", async () => {
    const kora = await ac("input=kora&country=IN").expect(200);
    assert.equal(kora.body.suggestions[0].primary, "Koramangala");
    const mg = await ac("input=MG%20Road&country=IN").expect(200);
    const secondaries = mg.body.suggestions.map((s) => s.secondary);
    assert.equal(mg.body.suggestions.length, 3);
    assert.equal(new Set(secondaries).size, 3, "each MG Road has a distinct context line");
    // Bias toward Pune puts the Pune MG Road first.
    const biased = await ac("input=MG%20Road&country=IN&lat=18.52&lng=73.86").expect(200);
    assert.match(biased.body.suggestions[0].secondary, /Pune/);
  });

  test("country selection controls the search area; Unicode input works", async () => {
    assert.equal((await ac("input=Camden&country=IN").expect(200)).body.suggestions.length, 0);
    assert.equal((await ac("input=Camden&country=GB").expect(200)).body.suggestions[0].secondary, "London, UK");
    const springfield = (await ac("input=Springfield&country=US").expect(200)).body.suggestions;
    assert.deepEqual(springfield.map((s) => s.secondary).sort(), ["IL, USA", "MA, USA"]);
    const hindi = await ac(`input=${encodeURIComponent("पुणे")}&country=IN`).expect(200);
    assert.equal(hindi.body.suggestions[0].primary, "Pune");
    assert.equal((await ac(`input=${encodeURIComponent("कनॉट")}`).expect(200)).body.suggestions[0].primary, "Connaught Place");
  });

  test("empty, short and no-match queries", async () => {
    assert.deepEqual((await ac("input=").expect(200)).body, { suggestions: [], tooShort: true });
    assert.deepEqual((await ac("input=ko").expect(200)).body, { suggestions: [], tooShort: true });
    assert.deepEqual((await ac("input=%20%20%20ko%20").expect(200)).body, { suggestions: [], tooShort: true });
    assert.deepEqual((await ac("input=qwxyzv").expect(200)).body, { suggestions: [] });
  });

  test("invalid parameters are rejected", async () => {
    for (const qs of [
      `input=${"a".repeat(121)}`,
      "input=kora&country=IND",
      "input=kora&country=1N",
      "input=kora&lat=12.9",
      "input=kora&lat=91&lng=0",
      "input=kora&lat=abc&lng=1",
      "input=kora&extra=1",
    ]) {
      assert.equal((await ac(qs)).status, 400, qs);
    }
    assert.equal((await ctx.anonymous().get("/api/places/autocomplete?input=kora&sessionToken=bad token!")).status, 400);
    assert.equal((await ctx.anonymous().get("/api/places/autocomplete?input=kora")).status, 400, "session token required");
    for (const id of ["../../etc/passwd", "a b", "<script>", "x".repeat(600), ""]) {
      assert.equal((await ctx.anonymous().get(`/api/places/details?placeId=${encodeURIComponent(id)}`)).status, 400, `placeId ${id}`);
    }
    const unknown = await ctx.anonymous().get("/api/places/details?placeId=fx_does_not_exist").expect(400);
    assert.equal(unknown.body.error.code, "place_not_found");
    for (const qs of ["lat=91&lng=0", "lat=0&lng=-181", "lat=1e1&lng=1", "lat=12.9", "lng=1", "lat=NaN&lng=1", "lat=Infinity&lng=1"]) {
      assert.equal((await ctx.anonymous().get(`/api/places/reverse?${qs}`)).status, 400, qs);
    }
  });

  test("details and reverse geocoding return only what the UI needs", async () => {
    const d = await ctx.anonymous().get(`/api/places/details?placeId=fx_koramangala_blr&sessionToken=${TOKEN}`).expect(200);
    assert.deepEqual(d.body.place, { placeId: "fx_koramangala_blr", lat: 12.93, lng: 77.62, country: "IN", precision: "area", label: "Koramangala, Bengaluru" });
    const r = await ctx.anonymous().get("/api/places/reverse?lat=12.9312&lng=77.6219").expect(200);
    assert.deepEqual(r.body.place, { label: "Koramangala, Bengaluru", country: "IN" });
    assert.equal((await ctx.anonymous().get("/api/places/reverse?lat=-60&lng=-140").expect(200)).body.place, null, "ocean: no area name");
  });

  test("provider failures become safe, typed errors", async () => {
    const expect = { zzerrkey: [503, "key_invalid", false], zzerrdisabled: [503, "api_disabled", false], zzerrbilling: [503, "billing", false], zzerrreferrer: [503, "restricted", false], zzerrquota: [503, "quota", true], zzerrdown: [503, "unavailable", true], zzerrtimeout: [504, "timeout", true] };
    for (const [input, [status, reason, retryable]] of Object.entries(expect)) {
      const res = await ac(`input=${input}`);
      assert.equal(res.status, status, input);
      assert.equal(res.body.error.code, "location_service_unavailable");
      assert.deepEqual(res.body.error.details, { reason, retryable });
    }
    const rev = await ctx.anonymous().get("/api/places/reverse?lat=0&lng=0").expect(503);
    assert.equal(rev.body.error.details.reason, "unavailable");
  });

  test("lookups are rate limited", async () => {
    const limited = await setup({ RATE_LIMIT_MULTIPLIER: "0.05" }); // 3 per minute
    try {
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await limited.anonymous().get(`/api/places/autocomplete?sessionToken=${TOKEN}&input=kora`)).status);
      assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    } finally {
      await limited.teardown();
    }
  });
});

describe("location provider disabled", () => {
  test("endpoints answer 503 unconfigured and listings still accept typed locations", async () => {
    const off = await setup({ PLACES_PROVIDER: "none" });
    try {
      assert.equal((await off.anonymous().get("/api/places/config").expect(200)).body.enabled, false);
      const res = await off.anonymous().get(`/api/places/autocomplete?sessionToken=${TOKEN}&input=kora`).expect(503);
      assert.deepEqual(res.body.error.details, { reason: "unconfigured", retryable: false });
      const user = await off.agent({ email: "off@example.com" });
      const item = await createItem(user, { location: "Near the big temple", locationSource: "manual" });
      assert.equal(item.locationSource, "manual");
      const provider = await user.post("/api/items").field("type", "found").field("title", "Keys").field("category", "keys").field("location", "Koramangala").field("date", new Date().toISOString().slice(0, 10)).field("locationSource", "provider").field("locationPlaceId", "fx_koramangala_blr");
      assert.equal(provider.status, 503);
    } finally {
      await off.teardown();
    }
  });
});

// ---------------------------------------------------------------------------
describe("listing locations", () => {
  let owner;
  before(async () => {
    owner = await ctx.agent({ email: "loc-owner@example.com", name: "Loc Owner" });
  });

  test("provider location: coordinates come from the server-side lookup, not the client", async () => {
    const item = await createItem(owner, { type: "found", title: "Blue umbrella", category: "other", location: "Koramangala, Bengaluru", locationSource: "provider", locationPlaceId: "fx_koramangala_blr", locationCountry: "in", latitude: "1.5", longitude: "2.5" });
    assert.equal(item.latitude, 12.93);
    assert.equal(item.longitude, 77.62);
    assert.equal(item.locationSource, "provider");
    assert.equal(item.locationPlaceId, "fx_koramangala_blr");
    assert.equal(item.locationCountry, "IN");
    assert.equal(item.location, "Koramangala, Bengaluru");
  });

  test("device location is rounded to ~11 m and keeps its accuracy; manual text has no coordinates", async () => {
    const device = await createItem(owner, { type: "found", title: "Water bottle", category: "other", location: "Near Forum Mall", locationSource: "device", latitude: "12.934567891", longitude: "77.611234567", locationAccuracyM: "35" });
    assert.equal(device.latitude, 12.9346);
    assert.equal(device.longitude, 77.6112);
    assert.equal(device.locationAccuracyM, 35);
    const manual = await createItem(owner, { type: "found", title: "Notebook", category: "documents", location: "Bus stop opposite the school", locationSource: "manual" });
    assert.equal(manual.latitude, null);
    assert.equal(manual.hasCoordinates, false);
    // Older clients that send no metadata still work (text-only = manual).
    const plain = await createItem(owner, { type: "found", title: "Cap", category: "clothing", location: "Pune" });
    assert.equal(plain.locationSource, "manual");
  });

  test("invalid location input is rejected", async () => {
    const base = { type: "found", title: "Thing", category: "other", location: "Somewhere", date: new Date().toISOString().slice(0, 10) };
    const post = (extra) => {
      let req = owner.post("/api/items");
      for (const [k, v] of Object.entries({ ...base, ...extra })) req = req.field(k, String(v));
      return req;
    };
    const cases = [
      { locationSource: "manual", latitude: "12.9", longitude: "77.6" },
      { locationSource: "provider" },
      { locationSource: "provider", locationPlaceId: "../../x" },
      { locationSource: "device" },
      { locationSource: "device", latitude: "12.9", longitude: "77.6", locationPlaceId: "fx_pune" },
      { locationSource: "gps", latitude: "1", longitude: "1" },
      { latitude: "91", longitude: "0" },
      { latitude: "-90.5", longitude: "0" },
      { latitude: "10", longitude: "180.01" },
      { latitude: "1e1", longitude: "1" },
      { latitude: "0x10", longitude: "1" },
      { latitude: "abc", longitude: "1" },
      { latitude: "12.9" },
      { locationCountry: "IND", locationSource: "manual" },
      { locationAccuracyM: "-5", locationSource: "device", latitude: "1", longitude: "1" },
    ];
    for (const extra of cases) {
      const res = await post(extra);
      assert.equal(res.status, 400, JSON.stringify(extra));
    }
    const unknown = await post({ locationSource: "provider", locationPlaceId: "fx_nowhere_at_all" });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, "place_not_found");
    const fail = await post({ locationSource: "provider", locationPlaceId: "fx_koramangala_blr", title: "zzz" });
    assert.equal(fail.status, 201, "a valid place after failures still works");
  });

  test("edit: improve a text-only listing, edit text (clears coordinates), untouched location is kept", async () => {
    const item = await createItem(owner, { type: "found", title: "Old gloves", category: "clothing", location: "Pune station" });
    const improved = await owner.patch(`/api/items/${item.id}`).field("location", "Pune Railway Station, Agarkar Nagar").field("locationSource", "provider").field("locationPlaceId", "fx_pune_station").expect(200);
    assert.equal(improved.body.item.latitude, 18.53);
    assert.equal(improved.body.item.locationSource, "provider");
    // Title-only edit leaves location untouched.
    const titled = await owner.patch(`/api/items/${item.id}`).field("title", "Old woollen gloves").expect(200);
    assert.equal(titled.body.item.latitude, 18.53);
    assert.equal(titled.body.item.locationPlaceId, "fx_pune_station");
    // Same place again: no new provider lookup needed, coordinates preserved.
    const same = await owner.patch(`/api/items/${item.id}`).field("location", "Pune station (main gate)").field("locationSource", "provider").field("locationPlaceId", "fx_pune_station").expect(200);
    assert.equal(same.body.item.latitude, 18.53);
    // Switching to typed text clears the coordinates and place identity.
    const typed = await owner.patch(`/api/items/${item.id}`).field("location", "Platform 3").field("locationSource", "manual").expect(200);
    assert.equal(typed.body.item.latitude, null);
    assert.equal(typed.body.item.locationPlaceId, null);
    assert.equal(typed.body.item.locationSource, "manual");
  });

  test("concurrent location edits leave one consistent location", async () => {
    const item = await createItem(owner, { type: "found", title: "Race item", category: "other", location: "x place" });
    const [a, b] = await Promise.all([
      owner.patch(`/api/items/${item.id}`).field("location", "Indiranagar").field("locationSource", "provider").field("locationPlaceId", "fx_indiranagar_blr"),
      owner.patch(`/api/items/${item.id}`).field("location", "MG Road Pune").field("locationSource", "provider").field("locationPlaceId", "fx_mgroad_pune"),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const { rows } = await ctx.pool.query("SELECT location, location_place_id, latitude, longitude FROM items WHERE id = $1", [item.id]);
    const pairs = { fx_indiranagar_blr: ["Indiranagar", 12.97, 77.64], fx_mgroad_pune: ["MG Road Pune", 18.51, 73.88] };
    assert.deepEqual([rows[0].location, rows[0].latitude, rows[0].longitude], pairs[rows[0].location_place_id], "label, place and coordinates come from the same edit");
  });

  test("other users cannot change a listing's location", async () => {
    const item = await createItem(owner, { type: "found", title: "Mine", category: "other", location: "Here" });
    const other = await ctx.agent({ email: "loc-other@example.com" });
    assert.equal((await other.patch(`/api/items/${item.id}`).field("location", "Mine now").field("locationSource", "manual")).status, 403);
  });
});

// ---------------------------------------------------------------------------
describe("radius search", () => {
  let poster;
  const ids = {};
  const center = { lat: 12.93, lng: 77.62 }; // Koramangala fixture

  before(async () => {
    poster = await ctx.agent({ email: "radius@example.com" });
    const dev = (title, lat, lng, extra = {}) => createItem(poster, { type: "found", category: "keys", title, location: `${title} area`, locationSource: "device", latitude: String(lat), longitude: String(lng), ...extra });
    ids.center = (await dev("RZ center keys", 12.93, 77.62)).id; // 0 km
    ids.north4 = (await dev("RZ north keys", 12.97, 77.62)).id; // 4.448 km
    ids.north5 = (await dev("RZ boundary keys", 12.975, 77.62)).id; // grid rounds to 12.98 → 5.56 km (outside 5)
    ids.east9 = (await dev("RZ east wallet", 12.93, 77.70, { category: "wallet" })).id; // ~8.67 km
    ids.lost = (await dev("RZ lost keys", 12.94, 77.62, { type: "lost" })).id; // 1.11 km, lost
    ids.far = (await dev("RZ far keys", 18.52, 73.86)).id; // Pune, ~740 km
    ids.legacy = (await createItem(poster, { type: "found", category: "keys", title: "RZ legacy keys", location: "Koramangala 5th block" })).id;
  });

  const search = (qs) => ctx.anonymous().get(`/api/items?q=RZ&pageSize=50&${qs}`);
  const titles = (res) => res.body.items.map((i) => i.title);

  test("inside / outside the radius on the public grid", async () => {
    const r5 = await search(`lat=${center.lat}&lng=${center.lng}&radiusKm=5&sort=distance`).expect(200);
    assert.deepEqual(titles(r5), ["RZ center keys", "RZ lost keys", "RZ north keys"]);
    const r10 = await search(`lat=${center.lat}&lng=${center.lng}&radiusKm=10&sort=distance`).expect(200);
    assert.deepEqual(titles(r10), ["RZ center keys", "RZ lost keys", "RZ north keys", "RZ boundary keys", "RZ east wallet"]);
    assert.ok(!titles(r10).includes("RZ legacy keys"), "no coordinates: never inside a radius");
    assert.ok(!titles(r10).includes("RZ far keys"));
  });

  test("a listing exactly on the radius boundary is included; a few metres beyond is not", async () => {
    // Center 5.000 km due south of the grid point 12.97,77.62.
    const onBoundary = 12.97 - 5 / KM_PER_DEG;
    assert.ok(Math.abs(haversineKm({ lat: onBoundary, lng: 77.62 }, { lat: 12.97, lng: 77.62 }) - 5) < 1e-9);
    const inside = await search(`lat=${onBoundary.toFixed(10)}&lng=77.62&radiusKm=5`).expect(200);
    assert.ok(titles(inside).includes("RZ north keys"));
    const beyond = await search(`lat=${(onBoundary - 0.0001).toFixed(10)}&lng=77.62&radiusKm=5`).expect(200);
    assert.ok(!titles(beyond).includes("RZ north keys"));
  });

  test("approximate distances; none fabricated for listings without coordinates", async () => {
    const res = await search(`lat=${center.lat}&lng=${center.lng}&sort=distance`).expect(200);
    const byTitle = Object.fromEntries(res.body.items.map((i) => [i.title, i]));
    assert.equal(byTitle["RZ center keys"].distanceKm, 1, "under 1 km is reported as 1 (shown as 'under 1 km')");
    assert.equal(byTitle["RZ north keys"].distanceKm, 4.5);
    assert.equal(byTitle["RZ far keys"].distanceKm, Math.round(haversineKm(center, { lat: 18.52, lng: 73.86 })));
    assert.equal(byTitle["RZ legacy keys"].distanceKm, undefined);
    assert.equal(res.body.items.at(-1).title, "RZ legacy keys", "unknown-coordinate listings sort last");
    assert.deepEqual([0.4, 0.99, 1, 4.26, 9.74, 10.4, 99.5].map(approximateDistance), [1, 1, 1, 4.5, 9.5, 10, 100]);
  });

  test("keyword, type, category and radius combine", async () => {
    const lostOnly = await search(`type=lost&lat=${center.lat}&lng=${center.lng}&radiusKm=5`).expect(200);
    assert.deepEqual(titles(lostOnly), ["RZ lost keys"]);
    const wallets = await search(`category=wallet&lat=${center.lat}&lng=${center.lng}&radiusKm=10`).expect(200);
    assert.deepEqual(titles(wallets), ["RZ east wallet"]);
    const keyword = await ctx.anonymous().get(`/api/items?q=boundary&lat=${center.lat}&lng=${center.lng}&radiusKm=10`).expect(200);
    assert.deepEqual(titles(keyword), ["RZ boundary keys"]);
    const none = await search(`category=pet&lat=${center.lat}&lng=${center.lng}&radiusKm=25`).expect(200);
    assert.equal(none.body.total, 0);
  });

  test("'Anywhere' (no coordinates) returns everything including text-only listings", async () => {
    const res = await search("").expect(200);
    assert.equal(res.body.total, 7);
    assert.ok(res.body.items.every((i) => i.distanceKm === undefined));
  });

  test("invalid radius and coordinates are rejected", async () => {
    for (const qs of ["radiusKm=5", "lat=12.93&lng=77.62&radiusKm=-5", "lat=12.93&lng=77.62&radiusKm=0", "lat=12.93&lng=77.62&radiusKm=3", "lat=12.93&lng=77.62&radiusKm=1000", "lat=12.93&lng=77.62&radiusKm=5km", "lat=12.93&lng=77.62&radiusKm=abc", "lat=12.93&lng=77.62&radiusKm=1e1", "lat=91&lng=0", "lat=-91&lng=0", "lat=0&lng=181", "lat=abc&lng=1", "lat=12.93", "sort=distance"]) {
      const res = await ctx.anonymous().get(`/api/items?${qs}`);
      assert.equal(res.status, 400, qs);
    }
  });

  test("antimeridian and polar searches", async () => {
    const p = await ctx.agent({ email: "globe@example.com" });
    const mk = (title, lat, lng) => createItem(p, { type: "found", category: "bag", title, location: title, locationSource: "device", latitude: String(lat), longitude: String(lng) });
    await mk("GLB date-line east", -18.14, 179.99);
    await mk("GLB date-line west", -18.14, -179.99);
    await mk("GLB suva", -18.14, 178.44);
    await mk("GLB north pole a", 89.99, 10);
    await mk("GLB north pole b", 89.99, -170);
    await mk("GLB null island", 0, 0);
    const g = (qs) => ctx.anonymous().get(`/api/items?q=GLB&pageSize=50&${qs}`).expect(200);
    const dl = await g("lat=-18.14&lng=179.995&radiusKm=5&sort=distance");
    assert.deepEqual(dl.body.items.map((i) => i.title).sort(), ["GLB date-line east", "GLB date-line west"]);
    const dlWest = await g("lat=-18.14&lng=-179.995&radiusKm=5");
    assert.equal(dlWest.body.total, 2);
    const pole = await g("lat=89.99&lng=100&radiusKm=5");
    assert.deepEqual(pole.body.items.map((i) => i.title).sort(), ["GLB north pole a", "GLB north pole b"]);
    const zero = await g("lat=0&lng=0&radiusKm=2");
    assert.deepEqual(zero.body.items.map((i) => i.title), ["GLB null island"], "0,0 is a valid coordinate, not 'missing'");
    assert.deepEqual(boundingBox(89.99, 0, 5).lng, null);
    assert.equal(boundingBox(10, 179.99, 25).lng.wrap, true);
  });

  test("nearest-first pagination is stable with no duplicates or gaps", async () => {
    const p = await ctx.agent({ email: "pages@example.com" });
    for (let i = 0; i < 8; i++) {
      await createItem(p, { type: "found", category: "phone", title: `PG phone ${i}`, location: "same spot", locationSource: "device", latitude: "28.63", longitude: i < 5 ? "77.22" : "77.25" });
    }
    const seen = [];
    let total;
    for (let page = 1; page <= 3; page++) {
      const res = await ctx.anonymous().get(`/api/items?q=PG%20phone&lat=28.63&lng=77.22&radiusKm=10&sort=distance&pageSize=3&page=${page}`).expect(200);
      total = res.body.total;
      seen.push(...res.body.items.map((i) => i.id));
      assert.equal(res.body.totalPages, 3);
    }
    assert.equal(total, 8);
    assert.equal(new Set(seen).size, 8, "no duplicates across pages");
    const again = [];
    for (let page = 1; page <= 3; page++) {
      again.push(...(await ctx.anonymous().get(`/api/items?q=PG%20phone&lat=28.63&lng=77.22&radiusKm=10&sort=distance&pageSize=3&page=${page}`).expect(200)).body.items.map((i) => i.id));
    }
    assert.deepEqual(again, seen, "same order on repeat");
    const beyond = await ctx.anonymous().get("/api/items?q=PG%20phone&lat=28.63&lng=77.22&radiusKm=10&pageSize=3&page=9").expect(200);
    assert.deepEqual(beyond.body.items, []);
    assert.equal(beyond.body.total, 8);
  });

  test("concurrent searches return identical results", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => search(`lat=${center.lat}&lng=${center.lng}&radiusKm=10&sort=distance`)));
    const first = JSON.stringify(results[0].body.items.map((i) => i.id));
    assert.ok(results.every((r) => r.status === 200 && JSON.stringify(r.body.items.map((i) => i.id)) === first));
  });
});

// ---------------------------------------------------------------------------
describe("location privacy", () => {
  test("public responses never include precise coordinates, place IDs or accuracy", async () => {
    const owner = await ctx.agent({ email: "priv-loc@example.com" });
    const item = await createItem(owner, { type: "found", category: "jewelry", title: "PRV ring", location: "Near the lake", locationSource: "device", latitude: "12.934567", longitude: "77.611234", locationAccuracyM: "12" });
    const viewers = [ctx.anonymous(), await ctx.agent({ email: "priv-viewer@example.com" })];
    for (const http of viewers) {
      const detail = await http.get(`/api/items/${item.id}`).expect(200);
      const list = await http.get("/api/items?q=PRV&lat=12.93&lng=77.61&radiusKm=2").expect(200);
      for (const body of [detail.body, list.body]) {
        const json = JSON.stringify(body);
        assert.ok(!json.includes("12.9346") && !json.includes("77.6112"), "no precise coordinates");
        assert.ok(!/"latitude"|"longitude"|locationPlaceId|locationAccuracyM/.test(json));
      }
      assert.equal(detail.body.item.approxLatitude, 12.93);
      assert.equal(detail.body.item.hasCoordinates, true);
    }
  });

  test("radius probing cannot resolve positions below the ~1.1 km grid", async () => {
    const owner = await ctx.agent({ email: "probe@example.com" });
    const a = await createItem(owner, { type: "found", category: "other", title: "PRB a", location: "Lakeside", locationSource: "device", latitude: "12.9251", longitude: "77.6151" });
    const b = await createItem(owner, { type: "found", category: "other", title: "PRB b", location: "Lakeside", locationSource: "device", latitude: "12.9349", longitude: "77.6249" });
    const res = await ctx.anonymous().get("/api/items?q=PRB&lat=12.9&lng=77.6&sort=distance").expect(200);
    const d = Object.fromEntries(res.body.items.map((i) => [i.id, i.distanceKm]));
    assert.equal(d[a.id], d[b.id], "1.4 km apart in reality, identical in public results");
    const { rows } = await ctx.pool.query("SELECT grid_lat, grid_lng FROM items WHERE id = ANY($1)", [[a.id, b.id]]);
    assert.ok(rows.every((r) => r.grid_lat === 12.93 && r.grid_lng === 77.62));
  });
});

// ---------------------------------------------------------------------------
describe("legacy data and retention", () => {
  test("migration 007 classifies existing listings without changing their text", async () => {
    const db = await createDatabase();
    const pool = new Pool({ connectionString: db.url });
    try {
      const dir = path.join(__dirname, "..", "migrations");
      for (const file of ["000_base_schema", "001_update_items_user_fk", "002_add_item_type_check", "003_platform_core", "004_site_analytics", "005_rewards_and_paid_connections", "006_otp_challenges"]) {
        await pool.query(fs.readFileSync(path.join(dir, `${file}.sql`), "utf8"));
      }
      await pool.query(`INSERT INTO users (id, name, email) VALUES (1, 'A', 'a@x.com');
        INSERT INTO items (id, name, location, date, type, user_id, category, latitude, longitude) VALUES
          (1, 'Text only', 'Pune station', '2026-01-01', 'found', 1, 'other', NULL, NULL),
          (2, 'With GPS', 'Pune', '2026-01-01', 'lost', 1, 'phone', 18.565116, 73.907535);`);
      await pool.query(fs.readFileSync(path.join(dir, "007_item_locations.sql"), "utf8"));
      const { rows } = await pool.query("SELECT id, location, location_source, latitude, grid_lat, grid_lng, location_coords_at IS NOT NULL AS dated FROM items ORDER BY id");
      assert.deepEqual(rows, [
        { id: 1, location: "Pune station", location_source: "legacy", latitude: null, grid_lat: null, grid_lng: null, dated: false },
        { id: 2, location: "Pune", location_source: "device", latitude: 18.565116, grid_lat: 18.57, grid_lng: 73.91, dated: true },
      ]);
      // Re-running is a no-op.
      await pool.query(fs.readFileSync(path.join(dir, "007_item_locations.sql"), "utf8"));
      // The shape constraint rejects contradictory rows.
      await assert.rejects(pool.query("UPDATE items SET location_source = 'manual' WHERE id = 2"), /items_location_shape_check/);
      await assert.rejects(pool.query("UPDATE items SET location_source = 'provider' WHERE id = 1"), /items_location_shape_check/);
    } finally {
      await pool.end();
      await db.drop();
    }
  });

  test("legacy listings stay public and searchable by text, and owners can improve them", async () => {
    const owner = await ctx.agent({ email: "legacy-owner@example.com" });
    const item = await createItem(owner, { type: "found", category: "bag", title: "LGC old bag", location: "Hinjewadi phase 2" });
    await ctx.pool.query("UPDATE items SET location_source = 'legacy' WHERE id = $1", [item.id]);
    const pub = await ctx.anonymous().get(`/api/items/${item.id}`).expect(200);
    assert.equal(pub.body.item.locationSource, "legacy");
    assert.equal(pub.body.item.hasCoordinates, false);
    assert.equal((await ctx.anonymous().get("/api/items?location=hinjewadi&q=LGC").expect(200)).body.total, 1);
    const improved = await owner.patch(`/api/items/${item.id}`).field("location", "Shivajinagar, Pune").field("locationSource", "provider").field("locationPlaceId", "fx_shivajinagar_pune").expect(200);
    assert.equal(improved.body.item.locationSource, "provider");
    assert.equal(improved.body.item.hasCoordinates, true);
  });

  test("Google coordinates older than the cache window are refreshed by place ID or cleared", async () => {
    const owner = await ctx.agent({ email: "retention@example.com" });
    const mk = async (title) => {
      const it = await createItem(owner, { type: "found", category: "other", title, location: `Area ${title}`, locationSource: "provider", locationPlaceId: "fx_pune" });
      await ctx.pool.query("UPDATE items SET location_provider = 'google', location_place_id = $2, location_coords_at = now() - interval '31 days' WHERE id = $1", [it.id, `ChIJ_${title}`]);
      return it.id;
    };
    const fresh = await createItem(owner, { type: "found", category: "other", title: "RT fresh", location: "Lakeside", locationSource: "provider", locationPlaceId: "fx_pune" });
    await ctx.pool.query("UPDATE items SET location_provider = 'google' WHERE id = $1", [fresh.id]);
    const okId = await mk("ok");
    const goneId = await mk("gone");
    const busyId = await mk("busy");
    const { PlacesError } = require("../src/integrations/places");
    const fakeGoogle = {
      name: "google",
      async details({ placeId }) {
        if (placeId === "ChIJ_ok") return { placeId, lat: 18.53, lng: 73.85 };
        if (placeId === "ChIJ_busy") throw new PlacesError("quota", "busy", { retryable: true });
        throw new PlacesError("not_found", "gone");
      },
    };
    const logger = { info() {}, warn() {} };
    const result = await refreshProviderCoordinates({ pool: ctx.pool, places: fakeGoogle, config: ctx.config, logger });
    assert.deepEqual(result, { refreshed: 1, cleared: 1 });
    const { rows } = await ctx.pool.query("SELECT id, latitude, location_place_id, location, (location_coords_at > now() - interval '1 minute') AS recent FROM items WHERE id = ANY($1) ORDER BY id", [[fresh.id, okId, goneId, busyId]]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId[fresh.id].latitude, 18.52, "fresh coordinates untouched");
    assert.equal(byId[okId].latitude, 18.53);
    assert.equal(byId[okId].recent, true);
    assert.equal(byId[goneId].latitude, null, "cleared when it can't be refreshed");
    assert.equal(byId[goneId].location_place_id, "ChIJ_gone", "place IDs may be kept");
    assert.equal(byId[goneId].location, "Area gone", "label kept: listing stays usable");
    assert.equal(byId[busyId].latitude, 18.52, "retryable failure: try again next run");
    // Without a Google provider configured, expired Google coordinates are cleared.
    await ctx.pool.query("UPDATE items SET location_coords_at = now() - interval '40 days' WHERE id = $1", [busyId]);
    await refreshProviderCoordinates({ pool: ctx.pool, places: null, config: ctx.config, logger });
    assert.equal((await ctx.pool.query("SELECT latitude FROM items WHERE id = $1", [busyId])).rows[0].latitude, null);
  });
});

