import AxeBuilder from "@axe-core/playwright";
import type { BrowserContext, Page } from "@playwright/test";
import { apiCall, CONFIRM_LABEL, createListing, expect, INCIDENT_LABEL, newUser, persona, RUN, test } from "./fixtures";

// Location search and selection through the real UI. The e2e stack runs the
// API with PLACES_PROVIDER=fixture: deterministic places, no Google calls.
// Fixture places (lat,lng on the 0.01° grid): Koramangala 12.93,77.62;
// Indiranagar 12.97,77.64; MG Road (Bengaluru / Pune / Gurugram); Camden Town
// (GB). Device positions are controlled per test.

const WHERE = "Where?";
const where = (page: Page) => page.getByRole("combobox", { name: WHERE });
const options = (page: Page) => page.getByRole("listbox", { name: "Location suggestions" }).getByRole("option");
const status = (page: Page) => page.getByTestId("location-status").first();

// Replaces navigator.geolocation with a scripted one for this page.
async function fakeGeolocation(page: Page, script: { mode: "ok" | "denied" | "timeout" | "unavailable" | "unsupported" | "insecure"; lat?: number; lng?: number; accuracy?: number; delay?: number }) {
  await page.addInitScript((s) => {
    if (s.mode === "insecure") Object.defineProperty(window, "isSecureContext", { value: false });
    if (s.mode === "unsupported") {
      // @ts-expect-error test override
      delete Navigator.prototype.geolocation;
      return;
    }
    const geo = {
      getCurrentPosition(ok: PositionCallback, fail: PositionErrorCallback) {
        setTimeout(() => {
          const err = (code: number) => fail({ code, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: "x" } as GeolocationPositionError);
          if (s.mode === "denied") return err(1);
          if (s.mode === "unavailable") return err(2);
          if (s.mode === "timeout") return err(3);
          ok({ coords: { latitude: s.lat ?? 12.9312, longitude: s.lng ?? 77.6219, accuracy: s.accuracy ?? 25, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() } as GeolocationPosition);
        }, s.delay ?? 50);
      },
      watchPosition: () => 0,
      clearWatch: () => {},
    };
    Object.defineProperty(Navigator.prototype, "geolocation", { get: () => geo, configurable: true });
  }, script);
}

async function seed(context: BrowserContext, title: string, lat: number | null, lng: number | null, extra: Record<string, string> = {}) {
  const fields: Record<string, string> = { type: "found", category: "keys", title, location: `${title} spot`, ...extra };
  if (lat !== null && lng !== null) Object.assign(fields, { locationSource: "device", latitude: String(lat), longitude: String(lng) });
  return createListing(context, fields);
}

test.describe("location search", () => {
  const tag = `LOC${RUN}`;
  test.beforeAll(async ({ browser }) => {
    const { context } = await newUser(browser, persona("loc-seeder"));
    await seed(context, `${tag} centre keys`, 12.93, 77.62); // 0 km from Koramangala
    await seed(context, `${tag} north keys`, 12.97, 77.62); // 4.4 km
    await seed(context, `${tag} far keys`, 12.93, 77.71); // ~9.8 km: outside 5, inside 10
    await seed(context, `${tag} pune keys`, 18.52, 73.86); // ~740 km
    await seed(context, `${tag} wallet`, 12.93, 77.62, { category: "wallet" });
    await seed(context, `${tag} text-only keys`, null, null);
    await context.close();
  });

  test("homepage: partial name, keyboard selection, 5 km default, nearest-first results, refresh and share keep the search @responsive", async ({ page, browser }, info) => {
    await page.goto("/");
    await page.getByRole("searchbox", { name: "Keyword" }).fill(tag);
    await expect(page.getByTestId("radius")).toHaveValue("any");
    await where(page).fill("kora");
    await expect(options(page).first()).toContainText("Koramangala");
    await expect(options(page).first()).toContainText("Bengaluru, Karnataka, India");
    await page.screenshot({ path: `test-results/loc-suggestions-${info.project.name}.png` });
    await where(page).press("ArrowDown");
    await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
    await where(page).press("Enter");
    await expect(where(page)).toHaveValue("Koramangala, Bengaluru, Karnataka, India");
    await expect(status(page)).toContainText("Place selected");
    await expect(page.getByTestId("radius")).toHaveValue("5");
    await page.getByRole("button", { name: "Search", exact: true }).click();

    await expect(page).toHaveURL(/\/items\?.*lat=12\.9300&lng=77\.6200&radiusKm=5/);
    await expect(page).toHaveURL(/sort=distance/);
    // Nearest first; equal distances fall back to newest first (wallet was created after centre keys).
    await expect(page.locator("main article").getByRole("heading")).toHaveText([`${tag} wallet`, `${tag} centre keys`, `${tag} north keys`]);
    await expect(page.getByRole("link", { name: /Within 5 km of Koramangala/ })).toBeVisible();
    await expect(page.locator("main article").filter({ hasText: `${tag} centre keys` }).getByTestId("distance")).toHaveText("· under 1 km away");
    await expect(page.locator("main article").filter({ hasText: `${tag} north keys` }).getByTestId("distance")).toHaveText("· about 4.5 km away");
    await page.screenshot({ path: `test-results/loc-results-${info.project.name}.png`, fullPage: true });

    // Refresh keeps it.
    const url = page.url();
    await page.reload();
    await expect(where(page)).toHaveValue("Koramangala, Bengaluru, Karnataka, India");
    await expect(page.getByTestId("radius")).toHaveValue("5");
    await expect(page.locator("main article")).toHaveCount(3);
    // A shared link opened elsewhere gives the same results.
    const other = await browser.newContext();
    const shared = await other.newPage();
    await shared.goto(url);
    await expect(shared.locator("main article")).toHaveCount(3);
    await other.close();

    // Widen to 10 km from the browse filters.
    await page.getByTestId("radius").selectOption("10");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/radiusKm=10/);
    await expect(page.locator("main article")).toHaveCount(4);
    await expect(page.locator("main article").filter({ hasText: "text-only" })).toHaveCount(0);
  });

  test("Anywhere search includes every listing and is labelled as such", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("searchbox", { name: "Keyword" }).fill(tag);
    await where(page).fill("kora");
    await options(page).first().click();
    await page.getByTestId("radius").selectOption("any");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/items\\?q=${tag}$`));
    await expect(page.getByTestId("anywhere-chip")).toHaveText(/Anywhere/);
    await expect(page.locator("main article")).toHaveCount(6);
    await expect(page.locator("main article").filter({ hasText: "text-only" }).getByTestId("distance")).toHaveCount(0);
  });

  test("keyword, type, category and radius combine; typed text without a suggestion matches listing text", async ({ page }) => {
    await page.goto(`/items?q=${tag}&lat=12.93&lng=77.62&radiusKm=5&near=Koramangala&src=place&category=wallet`);
    await expect(page.locator("main article")).toHaveCount(1);
    await expect(page.locator("main article")).toContainText(`${tag} wallet`);
    await page.goto(`/items?q=${tag}&type=lost&lat=12.93&lng=77.62&radiusKm=25`);
    await expect(page.getByText("No listings match")).toBeVisible();

    await page.goto(`/items?q=${tag}`);
    await where(page).fill("text-only");
    await where(page).press("Escape");
    await expect(status(page)).toContainText("Typed text");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/location=text-only/);
    await expect(page.locator("main article")).toHaveCount(1);
  });

  test("radius pagination keeps filters and never repeats a listing", async ({ page, browser }) => {
    const { context } = await newUser(browser, persona("loc-pager"));
    const pg = `PGN${RUN}`;
    for (let i = 0; i < 14; i++) await seed(context, `${pg} item ${i}`, 28.63, i % 2 ? 77.22 : 77.23);
    await context.close();
    await page.goto(`/items?q=${pg}&lat=28.6300&lng=77.2200&radiusKm=2&near=Connaught%20Place&src=place&sort=distance`);
    const page1 = await page.locator("main article").getByRole("heading").allInnerTexts();
    expect(page1).toHaveLength(12);
    await page.getByRole("navigation", { name: "Pagination" }).getByRole("link", { name: "Next" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page).toHaveURL(/radiusKm=2/);
    const page2 = await page.locator("main article").getByRole("heading").allInnerTexts();
    expect(page2).toHaveLength(2);
    expect(new Set([...page1, ...page2]).size).toBe(14);
  });
});

test.describe("location suggestions", () => {
  test("similarly named places are distinguishable; pointer or touch selection", async ({ page }, info) => {
    await page.goto("/");
    await where(page).fill("MG Road");
    await expect(options(page)).toHaveCount(3);
    await expect(options(page)).toContainText(["Bengaluru", "Pune", "Gurugram"].map((c) => new RegExp(c)));
    const pune = options(page).filter({ hasText: "Pune" });
    if (info.project.name === "mobile") await pune.tap();
    else await pune.click();
    await expect(where(page)).toHaveValue("MG Road, Camp, Pune, Maharashtra, India");
    await expect(status(page)).toContainText("Place selected");
  });

  test("India by default; changing country searches elsewhere; Unicode input", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("combobox", { name: "Country" }).first()).toHaveValue("IN");
    await where(page).fill("Camden");
    await expect(page.getByText("No matching places")).toBeVisible();
    await page.getByRole("combobox", { name: "Country" }).first().selectOption("GB");
    await where(page).fill("Camden ");
    await expect(options(page).first()).toContainText("London, UK");
    await page.getByRole("combobox", { name: "Country" }).first().selectOption("IN");
    await where(page).fill("पुणे");
    await expect(options(page).first()).toContainText("Pune");
  });

  test("short input waits; rapid typing is debounced; edits after selection clear the place", async ({ page }) => {
    const calls: string[] = [];
    page.on("request", (r) => r.url().includes("/api/places/autocomplete") && calls.push(r.url()));
    await page.goto("/");
    await where(page).fill("ko");
    await expect(page.getByText("Type at least 3 characters for suggestions.")).toBeVisible();
    await page.waitForTimeout(500);
    expect(calls).toHaveLength(0);
    await where(page).fill("");
    await where(page).pressSequentially("koramangala", { delay: 40 });
    await expect(options(page).first()).toContainText("Koramangala");
    expect(calls.length).toBeLessThanOrEqual(2);
    await options(page).first().click();
    await expect(page.getByTestId("radius")).toHaveValue("5");
    // Edit the chosen text: identity and coordinates are dropped.
    await where(page).press("End");
    await where(page).pressSequentially(" 5th block");
    await where(page).press("Escape");
    await expect(status(page)).toContainText("Typed text");
    await expect(page.getByTestId("radius")).toHaveValue("any");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/location=Koramangala/);
    await expect(page).not.toHaveURL(/lat=/);
    // Repeated selection and clearing.
    await where(page).fill("indira");
    await options(page).first().click();
    await where(page).fill("indira");
    await options(page).first().click();
    await expect(where(page)).toHaveValue(/Indiranagar/);
    await page.getByRole("button", { name: "Clear location" }).first().click();
    await expect(where(page)).toHaveValue("");
    await expect(where(page)).toBeFocused();
  });

  test("stale responses arriving out of order are ignored", async ({ page }) => {
    await page.route("**/api/places/autocomplete?*", async (route) => {
      const input = new URL(route.request().url()).searchParams.get("input") || "";
      if (input.startsWith("Shiv")) await new Promise((r) => setTimeout(r, 1500));
      await route.continue().catch(() => {});
    });
    await page.goto("/");
    await where(page).fill("Shivajinagar");
    await page.waitForTimeout(450); // slow request in flight
    await where(page).fill("Indiranagar");
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText("Indiranagar");
    await page.waitForTimeout(1600); // late answer for "Shivajinagar" would land now
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText("Indiranagar");
  });

  test("provider errors, offline and retry", async ({ page, context }) => {
    await page.goto("/");
    await where(page).fill("zzerrquota");
    await expect(page.getByText("Place search is busy right now.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await where(page).fill("zzerrkey");
    await expect(page.getByText("Place suggestions are unavailable. You can keep the text you typed.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    for (const trigger of ["zzerrdisabled", "zzerrbilling", "zzerrreferrer"]) {
      await where(page).fill(trigger);
      await expect(page.getByText("Place suggestions are unavailable. You can keep the text you typed.")).toBeVisible();
    }
    await where(page).fill("zzerrtimeout");
    await expect(page.getByText("Place search is busy right now.")).toBeVisible();

    await context.setOffline(true);
    await where(page).fill("koram");
    await expect(page.getByText("You're offline. Check your connection.")).toBeVisible();
    await context.setOffline(false);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(options(page).first()).toContainText("Koramangala");
  });

  test("no suggestions keeps the typed text usable", async ({ page }) => {
    await page.goto("/");
    await where(page).fill("Qwxyzv bazaar");
    await expect(page.getByText("No matching places")).toBeVisible();
    await where(page).press("Escape");
    await expect(options(page)).toHaveCount(0);
    await expect(where(page)).toHaveValue("Qwxyzv bazaar");
  });
});

test.describe("use my location", () => {
  test("permission granted: area named, coordinates rounded in the shared URL, user can correct it @responsive", async ({ browser }, info) => {
    const context = await browser.newContext({ geolocation: { latitude: 12.9312, longitude: 77.6219, accuracy: 25 }, permissions: ["geolocation"] });
    const page = await context.newPage();
    await page.goto("/");
    await page.getByRole("button", { name: "Use my location" }).click();
    await expect(where(page)).toHaveValue("Koramangala, Bengaluru");
    await expect(status(page)).toContainText("Using your device position (accurate to about 25 m)");
    await expect(page.getByTestId("radius")).toHaveValue("5");
    await page.screenshot({ path: `test-results/loc-current-location-${info.project.name}.png` });
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/lat=12\.93&lng=77\.62&radiusKm=5&src=device/);
    expect(page.url()).not.toContain("12.9312");
    expect(page.url()).not.toContain("near=");
    await expect(page.getByRole("link", { name: /Within 5 km of your location/ })).toBeVisible();
    // Correct the detected location by choosing another place.
    await where(page).fill("indira");
    await options(page).first().click();
    await expect(status(page)).toContainText("Place selected");
    await context.close();
  });

  for (const [mode, message] of [
    ["denied", "Location permission was denied"],
    ["timeout", "Finding your position took too long"],
    ["unavailable", "Your device couldn't determine its position"],
    ["unsupported", "This browser can't share its location"],
    ["insecure", "Location needs a secure (https) connection"],
  ] as const) {
    test(`geolocation ${mode} shows a recovery path`, async ({ page }) => {
      await fakeGeolocation(page, { mode });
      await page.goto("/");
      await page.getByRole("button", { name: "Use my location" }).click();
      await expect(page.getByText(message)).toBeVisible();
      // Manual selection still works.
      await where(page).fill("kora");
      await options(page).first().click();
      await expect(status(page)).toContainText("Place selected");
    });
  }

  test("real permission denial from the browser", async ({ browser }) => {
    const context = await browser.newContext({ permissions: [] });
    const page = await context.newPage();
    await page.goto("/");
    await page.getByRole("button", { name: "Use my location" }).click();
    await expect(page.getByText("Location permission was denied")).toBeVisible();
    await context.close();
  });

  test("low-accuracy position is flagged", async ({ page }) => {
    await fakeGeolocation(page, { mode: "ok", accuracy: 5200 });
    await page.goto("/");
    await page.getByRole("button", { name: "Use my location" }).click();
    await expect(page.getByText("Your device position is only accurate to about 5.2 km")).toBeVisible();
  });

  test("a delayed position never overwrites a newer manual selection", async ({ page }) => {
    await fakeGeolocation(page, { mode: "ok", delay: 1500, lat: 18.53, lng: 73.87 });
    await page.goto("/");
    await page.getByRole("button", { name: "Use my location" }).click();
    await where(page).fill("kora");
    await options(page).first().click();
    await expect(where(page)).toHaveValue("Koramangala, Bengaluru, Karnataka, India");
    await expect(page.getByText("Your position arrived after you changed the location.")).toBeVisible({ timeout: 4000 });
    await expect(where(page)).toHaveValue("Koramangala, Bengaluru, Karnataka, India");
    await page.getByRole("button", { name: "Keep my choice" }).click();
    await expect(where(page)).toHaveValue("Koramangala, Bengaluru, Karnataka, India");
    await expect(status(page)).toContainText("Place selected");
  });

  test("reverse-geocoding failure in search mode still gives a usable search", async ({ page }) => {
    await fakeGeolocation(page, { mode: "ok", lat: 0, lng: 0 }); // fixture: reverse geocoding fails here
    await page.goto("/");
    await page.getByRole("button", { name: "Use my location" }).click();
    await expect(where(page)).toHaveValue("Your location");
    await expect(status(page)).toContainText("Using your device position");
  });
});

test.describe("report and edit with locations", () => {
  test("report: select a suggestion, confirmation required, saved with the place @responsive", async ({ browser }, info) => {
    const { context, page } = await newUser(browser, persona("loc-reporter"));
    const title = `Suggestion umbrella ${RUN}`;
    await page.goto("/report?type=found");
    await page.locator("label", { hasText: "I found something" }).click();
    await page.getByLabel("What is it?").fill(title);
    await page.getByLabel("Category", { exact: true }).selectOption("other");
    const incident = page.getByRole("combobox", { name: INCIDENT_LABEL });
    await incident.fill("Pune Rail");
    await page.getByRole("option", { name: /Pune Railway Station/ }).click();
    await expect(incident).toHaveValue("Pune Railway Station, Agarkar Nagar, Pune, Maharashtra, India");
    await page.screenshot({ path: `test-results/loc-report-form-${info.project.name}.png`, fullPage: true });
    await page.getByRole("button", { name: "Publish listing" }).click();
    await expect(page.getByText("Confirm the location before publishing.").first()).toBeVisible();
    await page.getByLabel(CONFIRM_LABEL).check();
    const before = (await (await context.request.get("/api/me/items")).json()).items.length;
    // Double click: only one listing is created.
    await page.getByRole("button", { name: "Publish listing" }).dblclick();
    await expect(page).toHaveURL(/\/items\/\d+$/);
    await expect(page.getByText("Approximate area shown for privacy.")).toBeVisible();
    const mine = (await (await context.request.get("/api/me/items")).json()).items;
    expect(mine.length).toBe(before + 1);
    const saved = mine.find((i: { title: string }) => i.title === title);
    expect(saved).toMatchObject({ locationSource: "provider", locationPlaceId: "fx_pune_station", latitude: 18.53, longitude: 73.87, hasCoordinates: true });
    // Public view: no precise coordinates or place ID.
    const anon = await browser.newContext();
    const pub = await (await anon.request.get(`/api/items/${saved.id}`)).json();
    expect(JSON.stringify(pub)).not.toMatch(/"latitude"|locationPlaceId/);
    await anon.close();
    await context.close();
  });

  test("report with device position: unnamed area must be named; position kept", async ({ browser }) => {
    const { context, page } = await newUser(browser, persona("loc-device"));
    await fakeGeolocation(page, { mode: "ok", lat: 0, lng: 0, accuracy: 30 }); // reverse geocoding fails
    await page.goto("/report?type=found");
    await page.locator("label", { hasText: "I found something" }).click();
    await page.getByLabel("What is it?").fill(`Device bag ${RUN}`);
    await page.getByLabel("Category", { exact: true }).selectOption("bag");
    await page.getByRole("button", { name: "Use my location" }).click();
    await expect(page.getByText("couldn't name the area")).toBeVisible();
    const incident = page.getByRole("combobox", { name: INCIDENT_LABEL });
    await expect(incident).toBeFocused();
    await incident.fill("Fountain near the park gate");
    await incident.press("Escape");
    await expect(status(page)).toContainText("Using your device position");
    await page.getByLabel(CONFIRM_LABEL).check();
    await page.getByRole("button", { name: "Publish listing" }).click();
    await expect(page).toHaveURL(/\/items\/\d+$/);
    const item = (await (await context.request.get(`/api/items/${page.url().split("/").pop()}`)).json()).item;
    expect(item).toMatchObject({ location: "Fountain near the park gate", locationSource: "device", latitude: 0, longitude: 0, locationAccuracyM: 30 });
    await context.close();
  });

  test("legacy text-only listing: owner sees how to improve it; edit adds a place; title-only edit keeps it", async ({ browser }) => {
    const { context, page } = await newUser(browser, persona("loc-legacy"));
    const item = await createListing(context, { type: "found", category: "keys", title: `Legacy keys ${RUN}`, location: "Near old market" });
    await page.goto(`/items/${item.id}`);
    await expect(page.getByText("Location given as text")).toBeVisible();
    await page.getByRole("link", { name: "Improve location" }).click();
    await expect(page.getByText("This listing's location is text only")).toBeVisible();
    const incident = page.getByRole("combobox", { name: INCIDENT_LABEL });
    await expect(incident).toHaveValue("Near old market");
    await incident.fill("Indira");
    await page.getByRole("option", { name: /Indiranagar/ }).click();
    await page.getByLabel(CONFIRM_LABEL).check();
    await page.getByRole("button", { name: /Save changes/ }).click();
    await expect(page).toHaveURL(new RegExp(`/items/${item.id}$`));
    await expect(page.getByText("Approximate area shown for privacy.")).toBeVisible();
    let saved = (await (await context.request.get(`/api/items/${item.id}`)).json()).item;
    expect(saved).toMatchObject({ locationSource: "provider", locationPlaceId: "fx_indiranagar_blr", latitude: 12.97 });

    // Title-only edit: location untouched, no confirmation asked.
    await page.goto(`/items/${item.id}/edit`);
    await expect(page.getByLabel(CONFIRM_LABEL)).toHaveCount(0);
    await page.getByLabel("What is it?").fill(`Legacy keys renamed ${RUN}`);
    await page.getByRole("button", { name: /Save changes/ }).click();
    await expect(page).toHaveURL(new RegExp(`/items/${item.id}$`));
    saved = (await (await context.request.get(`/api/items/${item.id}`)).json()).item;
    expect(saved).toMatchObject({ locationPlaceId: "fx_indiranagar_blr", latitude: 12.97 });
    await context.close();
  });

  test("API rejects private-coordinate tricks and malformed location input", async ({ browser }) => {
    const { context } = await newUser(browser, persona("loc-api"));
    const bad = await apiCall(context, "POST", "/items", { multipart: { type: "found", title: "Bad loc", category: "other", location: "Somewhere", date: new Date().toISOString().slice(0, 10), locationSource: "manual", latitude: "12.9", longitude: "77.6" } });
    expect(bad.status()).toBe(400);
    for (const qs of ["lat=95&lng=1", "lat=12&lng=77&radiusKm=7", "lat=12&lng=77&radiusKm=-1", "radiusKm=5"]) {
      expect((await context.request.get(`/api/items?${qs}`)).status(), qs).toBe(400);
    }
    expect((await context.request.get("/api/places/details?placeId=..%2F..%2Fx")).status()).toBe(400);
    await context.close();
  });
});

test("location UI is accessible (suggestions open, report form)", async ({ browser }) => {
  const { context, page } = await newUser(browser, persona("loc-a11y"));
  const scan = async () => {
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`);
  };
  await page.goto("/");
  await where(page).fill("MG Road");
  await expect(options(page)).toHaveCount(3);
  expect(await scan()).toEqual([]);
  await page.goto("/report");
  await page.getByRole("combobox", { name: INCIDENT_LABEL }).fill("kora");
  await expect(page.getByRole("listbox", { name: "Location suggestions" }).getByRole("option").first()).toBeVisible();
  expect(await scan()).toEqual([]);
  await context.close();
});
