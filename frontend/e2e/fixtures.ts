import { test as base, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

export { expect };

export type Role = { email: string; name: string; role?: "user" | "moderator" | "admin" };

// Unique per run so reruns against the same stack never collide.
export const RUN = Date.now().toString(36);
export const persona = (label: string, role: Role["role"] = "user"): Role => ({
  email: `${label}-${RUN}@e2e.test`,
  name: `${label[0].toUpperCase()}${label.slice(1)} Tester`,
  role,
});

async function csrf(request: APIRequestContext) {
  const res = await request.get("/api/auth/me");
  return (await res.json()).csrfToken as string;
}

// Signs a browser context in through the test-only fixture endpoint (only
// registered when the API runs with NODE_ENV=test and ENABLE_TEST_AUTH=true).
export async function signIn(context: BrowserContext, who: Role) {
  const token = await csrf(context.request);
  const res = await context.request.post("/api/auth/test-login", { headers: { "X-CSRF-Token": token }, data: who });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).user as { id: number };
}

export async function newUser(browser: Browser, who: Role) {
  const context = await browser.newContext();
  const user = await signIn(context, who);
  const page = await context.newPage();
  return { context, page, user };
}

// Authenticated JSON/multipart API helper for a context (adds CSRF).
export async function apiCall(context: BrowserContext, method: string, path: string, options: { data?: unknown; multipart?: Record<string, unknown> } = {}) {
  const token = await csrf(context.request);
  return context.request.fetch(`/api${path}`, { method, headers: { "X-CSRF-Token": token }, ...options } as never);
}

// Reward per category (mirrors the API's pricing table; asserted against /api/pricing in tests).
export const REWARD_PAISE: Record<string, number> = { phone: 50000, electronics: 50000, wallet: 30000, bag: 30000, keys: 30000, documents: 30000, jewelry: 50000, clothing: 30000, pet: 50000, other: 35000 };

export async function createListing(context: BrowserContext, fields: Record<string, string>) {
  const body: Record<string, string> = { type: "lost", category: "other", location: "Pune", date: new Date().toISOString().slice(0, 10), ...fields };
  if (body.type === "lost" && !body.acceptRewardTerms) {
    body.acceptRewardTerms = "true";
    body.expectedRewardPaise = String(REWARD_PAISE[body.category]);
  }
  const res = await apiCall(context, "POST", "/items", { multipart: body });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).item as { id: number; title: string; images: { url: string }[] };
}

// A real PNG for upload tests, produced by the browser itself.
export async function pngFixture(page: Page) {
  await page.setContent('<div style="width:320px;height:240px;background:linear-gradient(45deg,#c00,#06c)"></div>');
  return page.locator("div").screenshot({ type: "png" });
}

// On small screens the language switcher and account actions live in the
// collapsible menu; open it when present.
export async function openMenuIfCollapsed(page: Page) {
  const toggle = page.getByRole("button", { name: "Menu" });
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
}

// API shortcut: owner claims a found item (accepting the current reward).
export async function claimFoundApi(context: BrowserContext, item: { id: number; category?: string }, category: string, answer = "It has my initials") {
  const res = await apiCall(context, "POST", `/items/${item.id}/claims`, { data: { answer, acceptReward: true, expectedRewardPaise: REWARD_PAISE[category] } });
  expect([200, 201]).toContain(res.status());
  return (await res.json()).claim as { id: number; conversationId: number };
}

// API shortcut: owner pays the ₹100 fee via the local test-mode provider.
export async function payApi(context: BrowserContext, claimId: number) {
  const checkout = await (await apiCall(context, "POST", `/claims/${claimId}/checkout`, { data: {} })).json();
  const done = await (await apiCall(context, "POST", "/payments/test/complete", { data: { orderId: checkout.checkout.orderId, outcome: "success" } })).json();
  const verify = await apiCall(context, "POST", "/payments/verify", { data: { orderId: checkout.checkout.orderId, paymentId: done.paymentId, signature: done.signature } });
  expect((await verify.json()).status).toBe("paid");
}

export const test = base;

// Report/edit form: type an incident location (no suggestion) and confirm it.
export const INCIDENT_LABEL = "Where was the item lost or found?";
export const CONFIRM_LABEL = "I confirm this is where the item was lost or found.";
export async function typeIncidentLocation(page: Page, text: string) {
  await page.getByRole("combobox", { name: INCIDENT_LABEL }).fill(text);
  await page.getByRole("combobox", { name: INCIDENT_LABEL }).press("Escape");
  await page.getByLabel(CONFIRM_LABEL).check();
}
