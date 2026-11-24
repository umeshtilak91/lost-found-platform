import { execSync } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { createListing, expect, newUser, openMenuIfCollapsed, persona, RUN, signIn, test, typeIncidentLocation, INCIDENT_LABEL, CONFIRM_LABEL } from "./fixtures";

// ---------------------------------------------------------------------------
// 7. Logout and session persistence across an API restart
// ---------------------------------------------------------------------------
test("logout ends the session; sessions survive an API restart", async ({ browser }) => {
  const { context, page } = await newUser(browser, persona("session"));
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "My account", exact: true })).toBeVisible();

  if (process.env.E2E_COMPOSE_PROJECT !== "none") {
    execSync(`docker compose -p ${process.env.E2E_COMPOSE_PROJECT || "lftest"} restart backend`, { cwd: "..", stdio: "ignore" });
    await expect
      .poll(async () => (await context.request.get("/api/auth/me").catch(() => null))?.status() ?? 0, { timeout: 60_000 })
      .toBe(200);
    expect((await (await context.request.get("/api/auth/me")).json()).loggedIn).toBe(true);
  }

  await page.reload();
  await openMenuIfCollapsed(page);
  await page.getByRole("button", { name: "Sign out" }).filter({ visible: true }).first().click();
  await expect(page).toHaveURL("/");
  expect((await (await context.request.get("/api/auth/me")).json()).loggedIn).toBe(false);
  await page.goto("/account");
  await expect(page.getByText("Sign in to see your account.")).toBeVisible();
  await context.close();
});

test("login page explains provider availability and email codes are wired up", async ({ page }) => {
  await page.goto("/login?error=oauth_failed");
  await expect(page.getByText("Sign-in was cancelled or failed")).toBeVisible();
  await expect(page.getByLabel("Email address")).toBeVisible();
  await page.goto("/login?error=google_unconfigured");
  await expect(page.getByText(/Google sign-in isn't set up/)).toBeVisible();
});

// ---------------------------------------------------------------------------
// 8. Responsive layout, accessibility, keyboard navigation
// ---------------------------------------------------------------------------
const PAGES = ["/", "/items?type=lost", "/login", "/privacy"];

for (const path of PAGES) {
  test(`no serious accessibility violations on ${path} @responsive`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
  });
}

test("signed-in pages pass accessibility checks @responsive", async ({ browser }) => {
  const { context, page } = await newUser(browser, persona("a11y"));
  const item = await createListing(context, { title: `A11y keys ${RUN}`, category: "keys", type: "found" });
  for (const path of ["/report", "/account", `/items/${item.id}`, "/notifications", "/inbox"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${path} ${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
  }
  await context.close();
});

test("mobile navigation menu opens, traps nothing, and closes with Escape @mobile-only", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Menu" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("navigation", { name: "Mobile" }).getByRole("link", { name: "Found items" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  await toggle.click();
  await page.getByRole("navigation", { name: "Mobile" }).getByRole("link", { name: "Lost items" }).click();
  await expect(page).toHaveURL(/type=lost/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // No horizontal scrolling on a phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("keyboard-only: skip link, search, report form and contact", async ({ browser, page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();

  // Search via keyboard.
  await page.getByRole("searchbox", { name: "Keyword" }).focus();
  await page.keyboard.type("umbrella");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/items\?q=umbrella/);

  // Report form entirely by keyboard.
  const context = page.context();
  await signIn(context, persona("keyboard"));
  await page.goto("/report");
  await page.getByLabel("I lost something").focus();
  await page.keyboard.press("ArrowDown"); // radio group -> found
  await expect(page.getByLabel("I found something")).toBeChecked();
  await page.keyboard.press("Tab");
  await page.keyboard.type(`Keyboard phone ${RUN}`);
  await page.keyboard.press("Tab"); // category (native select: arrow keys choose)
  await expect(page.getByLabel("Category", { exact: true })).toBeFocused();
  // Native <select> keyboard behaviour differs per OS; choose the option directly.
  await page.getByLabel("Category", { exact: true }).selectOption("phone");
  await page.getByRole("combobox", { name: INCIDENT_LABEL }).focus(); // date input has one tab stop per segment in Chromium
  await page.keyboard.type("Deccan Gymkhana");
  await page.keyboard.press("Escape");
  await page.getByLabel(CONFIRM_LABEL).focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Publish listing" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/items\/\d+$/);

  // Submitting with errors moves focus to the error summary.
  await page.goto("/report");
  await page.getByRole("button", { name: "Publish listing" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Please fix the highlighted fields.")).toBeVisible();
  await expect(page.locator("form div[tabindex='-1']").filter({ hasText: "Please fix the highlighted fields." })).toBeFocused();

  // Respond to a lost listing via keyboard ("I found this item").
  const other = await newUser(browser, persona("kb-contact"));
  const target = await createListing(other.context, { title: `Keyboard target ${RUN}`, category: "keys" });
  await page.goto(`/items/${target.id}`);
  await page.getByLabel("Your answer (only the poster sees it)").focus();
  await page.keyboard.type("Silver keys with a red tag");
  // This user has their own open found listing, so the optional "link my listing" select comes next.
  await page.keyboard.press("Tab");
  await expect(page.getByLabel(/Is this the same item as one of your listings/)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "I found this item" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Your claim is waiting for the poster's decision.")).toBeVisible();
  await other.context.close();
});

test("main journeys render on mobile without overflow @responsive", async ({ browser }) => {
  const { context, page } = await newUser(browser, persona("mobile"));
  const item = await createListing(context, { title: `Mobile layout bag ${RUN}`, category: "bag" });
  for (const path of ["/", "/items?type=lost", `/items/${item.id}`, "/report", "/account"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  await context.close();
});

// ---------------------------------------------------------------------------
// Site visitor analytics
// ---------------------------------------------------------------------------
test("visits are counted without cookies and shown on the admin dashboard", async ({ browser }) => {
  const REAL_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
  const visitor = await browser.newContext({ userAgent: REAL_UA });
  const page = await visitor.newPage();
  const path = `/items?q=analytics-${RUN}`;
  const tracked = page.waitForResponse((r) => r.url().endsWith("/api/analytics/pageview") && r.status() === 204);
  await page.goto(path);
  await tracked;
  expect((await visitor.cookies()).map((c) => c.name)).not.toContain("_ga");
  await visitor.close();

  const admin = await newUser(browser, persona("admin", "admin"));
  await admin.page.goto("/admin");
  await expect(admin.page.getByRole("heading", { level: 1, name: "Admin dashboard" })).toBeVisible();
  await expect(admin.page.getByText("Visitors today")).toBeVisible();
  await expect(admin.page.getByRole("link", { name: "/items", exact: true })).toBeVisible();
  await admin.page.getByText("Show as table").click();
  await expect(admin.page.getByRole("columnheader", { name: "Visitors" }).first()).toBeVisible();
  await admin.context.close();

  const user = await newUser(browser, persona("not-admin"));
  await user.page.goto("/admin");
  await expect(user.page.getByText("You need admin or moderator access")).toBeVisible();
  await user.context.close();
});

test("dark theme by default; toggle to light persists across reloads @responsive", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(13, 17, 23)");
  await openMenuIfCollapsed(page);
  await page.getByRole("button", { name: "Switch to light theme" }).filter({ visible: true }).first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  // Server renders the saved theme directly, so there is no flash of dark.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(247, 248, 250)");
  const results = await new AxeBuilder({ page }).withTags(["wcag2aa"]).analyze();
  expect(
    results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(" ")} ${n.any[0]?.message ?? ""}`).join(" || ")}`)
  ).toEqual([]);
});

// ---------------------------------------------------------------------------
// Interaction feedback: active nav, chips, filter pills, viewer, toasts, viewed
// ---------------------------------------------------------------------------
test("interaction feedback: nav state, chips, removable filters, photo viewer, toasts, viewed badge", async ({ browser, page }) => {
  const poster = await newUser(browser, persona("ux-poster"));
  const png = await (async () => {
    const p = await poster.context.newPage();
    await p.setContent('<div style="width:320px;height:240px;background:linear-gradient(45deg,#0a0,#00c)"></div>');
    return p.locator("div").screenshot({ type: "png" });
  })();
  const token = (await (await poster.context.request.get("/api/auth/me")).json()).csrfToken;
  const created = await poster.context.request.post("/api/items", {
    headers: { "X-CSRF-Token": token },
    multipart: {
      type: "found",
      title: `UX umbrella ${RUN}`,
      category: "other",
      location: "Camp",
      date: new Date().toISOString().slice(0, 10),
      images: { name: "a.png", mimeType: "image/png", buffer: png },
    },
  });
  const item = (await created.json()).item;
  await apiTwoPhotos(poster.context, item.id, png);

  // Active nav link
  await page.goto("/items?type=found");
  await openMenuIfCollapsed(page);
  await expect(page.getByRole("link", { name: "Found items" }).filter({ visible: true }).first()).toHaveAttribute("aria-current", "page");

  // Type chip + removable filter pill
  await page.goto(`/items?q=${encodeURIComponent(`UX umbrella ${RUN}`)}`);
  await page.getByRole("button", { name: "Found", exact: true }).click();
  await expect(page).toHaveURL(/type=found/);
  const pill = page.getByRole("link", { name: /Remove filter: Found/ });
  await expect(pill).toBeVisible();
  await pill.click();
  await expect(page).not.toHaveURL(/type=found/);

  // Photo viewer: open, next with keyboard, close with Escape and focus returns
  await page.goto(`/items/${item.id}`);
  const opener = page.getByRole("button", { name: /Open photo 1 full screen/ });
  await opener.click();
  const viewer = page.getByRole("dialog");
  await expect(viewer).toBeVisible();
  await expect(viewer.getByText("Photo 1 of 2")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(viewer.getByText("Photo 2 of 2")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(page.getByRole("button", { name: /Open photo 2 full screen/ })).toBeFocused();

  // Toast on copy link (clipboard may be unavailable; toast still confirms)
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Link copied to clipboard" })).toBeVisible();

  // Viewed badge on the card after opening the listing
  await page.goto(`/items?q=${encodeURIComponent(`UX umbrella ${RUN}`)}`);
  await expect(page.locator("article").filter({ hasText: `UX umbrella ${RUN}` }).getByText("Viewed")).toBeVisible();
  await poster.context.close();
});

async function apiTwoPhotos(context: import("@playwright/test").BrowserContext, id: number, png: Buffer) {
  const token = (await (await context.request.get("/api/auth/me")).json()).csrfToken;
  const res = await context.request.patch(`/api/items/${id}`, {
    headers: { "X-CSRF-Token": token },
    multipart: { images: { name: "b.png", mimeType: "image/png", buffer: png } },
  });
  expect(res.status()).toBe(200);
}

test("disabled buttons explain why; publishing shows a toast after redirect", async ({ browser }) => {
  const { context, page } = await newUser(browser, persona("ux-toast"));
  const other = await newUser(browser, persona("ux-target"));
  const target = await createListing(other.context, { title: `UX target ${RUN}`, category: "keys", type: "found" });
  await page.goto(`/items/${target.id}`);
  const claim = page.getByRole("button", { name: /This could be mine/ });
  await expect(claim).toBeDisabled();
  await expect(claim).toHaveAttribute("title", "Answer the question first");

  await page.goto("/report?type=lost");
  await page.getByLabel("What is it?").fill(`UX toast item ${RUN}`);
  await page.getByLabel("Category", { exact: true }).selectOption("other");
  await typeIncidentLocation(page, "Pune");
  await page.getByLabel(/I agree to pay the ₹350 category reward/).check();
  await page.getByRole("button", { name: "Publish listing" }).click();
  await expect(page).toHaveURL(/\/items\/\d+$/);
  await expect(page.getByRole("status").filter({ hasText: "Listing published" })).toBeVisible();
  await context.close();
  await other.context.close();
});
