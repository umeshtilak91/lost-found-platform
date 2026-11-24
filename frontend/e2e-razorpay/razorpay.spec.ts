// Real Razorpay Test Mode end-to-end tests for the ₹100 connection fee.
// Every payment here is a genuine Razorpay test-mode transaction made through
// Standard Checkout (test card 4100 2800 0000 1007 + demo bank page). Backend
// facts are cross-checked against the Razorpay API and the database.
// Secrets are read from ../.env and never printed.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const ROOT = path.resolve(__dirname, "..", "..");
const ENV = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const KEY_ID = ENV.RAZORPAY_KEY_ID;
const KEY_SECRET = ENV.RAZORPAY_KEY_SECRET;
const WEBHOOK_SECRET = ENV.RAZORPAY_WEBHOOK_SECRET;
// Evidence (IDs and statuses only, no secrets) and screenshots go outside the repo.
const OUT = process.env.E2E_EVIDENCE_DIR || path.join(os.tmpdir(), "lost-found-razorpay");
const EVIDENCE = path.join(OUT, "razorpay-evidence.json");
const SHOTS = path.join(OUT, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const RUN = Date.now().toString(36);
const evidence: Record<string, unknown>[] = fs.existsSync(EVIDENCE) ? JSON.parse(fs.readFileSync(EVIDENCE, "utf8")) : [];
const record = (entry: Record<string, unknown>) => {
  evidence.push({ at: new Date().toISOString(), ...entry });
  fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
};

test.describe.configure({ mode: "serial" });
test.beforeAll(() => {
  expect(KEY_ID?.startsWith("rzp_test_"), "must use Razorpay TEST keys").toBe(true);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function razorpay(pathname: string, init: RequestInit = {}) {
  const r = await fetch(`https://api.razorpay.com/v1${pathname}`, {
    ...init,
    headers: { Authorization: `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64")}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  return r.json();
}

function sql(query: string): string {
  return execFileSync("docker", ["compose", "-p", "lftest", "exec", "-T", "db", "psql", "-U", "postgres", "-d", "lost_found_db", "-tA", "-F", "|", "-c", query], { cwd: ROOT }).toString().trim();
}

// API responses in these tests are arbitrary JSON from our own API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type U = { ctx: BrowserContext; page: Page; email: string; api: (m: string, p: string, d?: unknown) => Promise<{ status: number; body: any }> };

async function signIn(browser: Browser, label: string, { role = "user", phone }: { role?: string; phone?: string } = {}, email = `${label}-${RUN}@e2e.test`): Promise<U> {
  const ctx = await browser.newContext();
  const csrf = async () => (await (await ctx.request.get("/api/auth/me")).json()).csrfToken;
  const res = await ctx.request.post("/api/auth/test-login", { headers: { "X-CSRF-Token": await csrf() }, data: { email, name: `${label} Tester`, role } });
  expect(res.status()).toBe(200);
  const api = async (method: string, p: string, data?: unknown) => {
    const opts: Record<string, unknown> = { method, headers: { "X-CSRF-Token": await csrf() } };
    if (data && (data as { multipart?: unknown }).multipart) opts.multipart = (data as { multipart: unknown }).multipart;
    else if (data !== undefined) opts.data = data;
    const r = await ctx.request.fetch(`/api${p}`, opts as never);
    let body = null;
    try {
      body = await r.json();
    } catch {}
    return { status: r.status(), body };
  };
  if (phone) expect((await api("PATCH", "/account/profile", { phone, phoneCountry: "IN" })).status).toBe(200);
  return { ctx, page: await ctx.newPage(), email, api };
}

// Opens Razorpay Checkout from our "Pay ₹100 and connect" button, pays with the
// official test card and chooses Success/Failure on the demo bank page.
async function payInCheckout(page: Page, outcome: "Success" | "Failure", shot?: string) {
  const orderReq = page.waitForResponse((r) => r.url().includes("/api/claims/") && r.url().endsWith("/checkout"));
  await page.getByRole("button", { name: "Pay ₹100 and connect" }).click();
  const checkout = await (await orderReq).json();
  const fr = page.frameLocator('iframe[src*="api.razorpay.com"]').first();
  await fr.getByPlaceholder("Card Number").waitFor({ timeout: 45000 });
  await page.waitForTimeout(1500);
  if (shot) await page.screenshot({ path: `${SHOTS}/${shot}` });
  await fr.getByPlaceholder("Card Number").pressSequentially("4100280000001007", { delay: 25 });
  await fr.getByPlaceholder("MM / YY").pressSequentially("1230", { delay: 25 });
  await fr.getByPlaceholder("CVV").pressSequentially("123", { delay: 25 });
  const popupPromise = page.context().waitForEvent("page", { timeout: 60000 });
  await fr.locator('[data-test-id="add-card-cta"]').click();
  const later = fr.getByRole("button", { name: "Maybe later" });
  await later.click({ timeout: 15000 }).catch(() => {}); // only shown when Razorpay offers to save the card
  const bank = await popupPromise;
  await bank.waitForLoadState();
  await expect(bank.getByText("This is just a demo bank page.")).toBeVisible();
  await bank.getByRole("button", { name: outcome }).click();
  return { orderId: checkout.checkout.orderId as string, amountPaise: checkout.checkout.amountPaise as number, currency: checkout.checkout.currency as string, fr };
}

async function lostMatch(browser: Browser, label: string, category = "other", reward = 35000) {
  const owner = await signIn(browser, `${label}-owner`, { phone: "9812345671" });
  const finder = await signIn(browser, `${label}-finder`);
  const item = (await owner.api("POST", "/items", { multipart: { type: "lost", title: `${label} item ${RUN}`, category, location: "Pune", date: new Date().toISOString().slice(0, 10), acceptRewardTerms: "true", expectedRewardPaise: String(reward) } })).body.item;
  const claim = (await finder.api("POST", `/items/${item.id}/claims`, { answer: "Blue case with a sticker" })).body.claim;
  expect((await owner.api("POST", `/claims/${claim.id}/accept`, { acceptReward: true, expectedRewardPaise: reward })).status).toBe(200);
  return { owner, finder, item, claim };
}

async function assertCapturedAtRazorpay(orderId: string) {
  const order = await razorpay(`/orders/${orderId}`);
  const payments = (await razorpay(`/orders/${orderId}/payments`)).items as { id: string; status: string; amount: number; currency: string; order_id: string; method: string }[];
  const captured = payments.find((p) => p.status === "captured");
  expect(order.amount).toBe(10000);
  expect(order.currency).toBe("INR");
  expect(order.status).toBe("paid");
  expect(captured, "captured payment exists at Razorpay").toBeTruthy();
  expect(captured!.amount).toBe(10000);
  expect(captured!.currency).toBe("INR");
  expect(captured!.order_id).toBe(orderId);
  return { order, captured: captured!, payments };
}

// ---------------------------------------------------------------------------
// 1-8 + 10: Lost-item journey through the UI, Other = ₹350 reward, ₹100 charged
// ---------------------------------------------------------------------------
test("lost item (Other): owner pays ₹100 via Razorpay Test Mode; ₹350 reward shown; chat unlocks and persists", async ({ browser }) => {
  const owner = await signIn(browser, "lost-owner", { phone: "9812345671" });
  const finder = await signIn(browser, "lost-finder");
  const outsider = await signIn(browser, "outsider");

  // 1. Owner creates the listing through the form; reward panel shows ₹350.
  await owner.page.goto("/report?type=lost");
  await owner.page.getByLabel("What is it?").fill(`Umbrella with wooden handle ${RUN}`);
  await owner.page.getByLabel("Category", { exact: true }).selectOption("other");
  await expect(owner.page.getByTestId("form-reward")).toHaveText("₹350");
  // Incident location: typed (no suggestion) and confirmed, as on the real form.
  const where = owner.page.getByRole("combobox", { name: "Where was the item lost or found?" });
  await where.fill("Deccan, Pune");
  await where.press("Escape");
  await owner.page.getByLabel("I confirm this is where the item was lost or found.").check();
  await owner.page.getByLabel("Ownership question (optional)").fill("What colour is the handle tape?");
  await owner.page.getByLabel(/I agree to pay the ₹350 category reward/).check();
  await owner.page.getByRole("button", { name: "Publish listing" }).click();
  await expect(owner.page).toHaveURL(/\/items\/\d+$/);
  const itemId = Number(owner.page.url().split("/").pop());

  // 2. Finder responds.
  await finder.page.goto(`/items/${itemId}`);
  await finder.page.getByLabel("Your answer (only the poster sees it)").fill("Red tape on the handle");
  await finder.page.getByRole("button", { name: "I found this item" }).click();
  await expect(finder.page.getByText("Your claim is waiting for the poster's decision.")).toBeVisible();

  // Chat is locked before payment for participants and inaccessible to outsiders.
  const claim = (await owner.api("GET", `/items/${itemId}/claims`)).body.claims[0];
  expect((await finder.api("POST", `/conversations/${claim.conversationId}/messages`, { body: "hi" })).status).toBe(402);
  expect((await outsider.api("GET", `/conversations/${claim.conversationId}`)).status).toBe(404);

  // 3. Owner verifies the answer and accepts the match with the ₹350 reward.
  await owner.page.reload();
  await expect(owner.page.getByText("Red tape on the handle")).toBeVisible();
  await owner.page.getByRole("button", { name: "Accept", exact: true }).click();
  await owner.page.getByLabel(/I agree to pay the ₹350 finder reward directly to this finder/).check();
  await owner.page.getByRole("button", { name: /Accept match and agree to pay the ₹350 reward/ }).click();

  // 4. Checkout shows ₹350 direct reward + ₹100 fee.
  await expect(owner.page.getByText("₹100 platform connection fee").first()).toBeVisible();
  await expect(owner.page.getByText("₹350 finder reward")).toBeVisible();
  await owner.page.screenshot({ path: `${SHOTS}/1-checkout-card.png` });

  // 5. Pay through real Razorpay Checkout (test card, Success).
  const paid = await payInCheckout(owner.page, "Success", "2-razorpay-checkout.png");
  expect(paid.amountPaise).toBe(10000);
  expect(paid.currency).toBe("INR");
  await expect(owner.page).toHaveURL(new RegExp(`/inbox/${claim.conversationId}$`), { timeout: 60000 });
  await expect(owner.page.getByText("₹350, payable directly by the owner at handover.")).toBeVisible();
  await owner.page.screenshot({ path: `${SHOTS}/3-success-unlocked.png` });

  // 6. Backend + Razorpay facts: signature verified (verify endpoint returned paid), amount, currency, order, captured.
  const rz = await assertCapturedAtRazorpay(paid.orderId);
  const row = sql(`SELECT claim_id, status, amount_paise, currency, provider, provider_payment_id FROM connection_payments WHERE provider_order_id = '${paid.orderId}'`);
  expect(row).toBe(`${claim.id}|paid|10000|INR|razorpay|${rz.captured.id}`);
  // 7. Recorded against this match; entitlement for this conversation only.
  expect(sql(`SELECT claim_id, conversation_id FROM connection_entitlements WHERE claim_id = ${claim.id}`)).toBe(`${claim.id}|${claim.conversationId}`);
  record({ scenario: "lost/Other success", claimId: claim.id, orderId: paid.orderId, paymentId: rz.captured.id, amount: rz.captured.amount, currency: rz.captured.currency, razorpayStatus: rz.captured.status, method: rz.captured.method });

  // Chat works for both participants; outsider still blocked.
  await owner.page.getByLabel("Write a message…").fill("Thanks! Meet at Deccan bus stop at 6pm?");
  await owner.page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(owner.page.getByText("Thanks! Meet at Deccan bus stop at 6pm?")).toBeVisible();
  await owner.page.screenshot({ path: `${SHOTS}/4-unlocked-chat.png` });
  expect((await finder.api("POST", `/conversations/${claim.conversationId}/messages`, { body: "Sure, see you there" })).status).toBe(201);
  expect((await outsider.api("GET", `/conversations/${claim.conversationId}`)).status).toBe(404);
  expect((await outsider.api("POST", `/conversations/${claim.conversationId}/messages`, { body: "x" })).status).toBe(404);

  // 8. Refresh, sign out, sign in again: access persists.
  await owner.page.reload();
  await expect(owner.page.getByText("Sure, see you there")).toBeVisible();
  await owner.page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(owner.page).toHaveURL("/");
  const again = await signIn(browser, "lost-owner", {}, owner.email);
  await again.page.goto(`/inbox/${claim.conversationId}`);
  await expect(again.page.getByText("Sure, see you there")).toBeVisible();
  await expect(again.page.getByRole("heading", { name: "Chat is locked" })).toHaveCount(0);

  for (const u of [owner, finder, outsider, again]) await u.ctx.close();
});

// ---------------------------------------------------------------------------
// 9: Found-item journey (Phone ₹500) through the UI
// ---------------------------------------------------------------------------
test("found item (Phone): owner claims, finder accepts, ₹100 Razorpay payment, phone sharing needs consent", async ({ browser }) => {
  const finder = await signIn(browser, "found-finder", { phone: "9823456712" });
  const owner = await signIn(browser, "found-owner", { phone: "9812345671" });
  const item = (await finder.api("POST", "/items", { multipart: { type: "found", title: `Black Samsung phone ${RUN}`, category: "phone", location: "FC Road", date: new Date().toISOString().slice(0, 10), ownershipQuestion: "What is the lock screen photo?" } })).body.item;

  await owner.page.goto(`/items/${item.id}`);
  await expect(owner.page.getByRole("region", { name: "Finder reward & connection fee" })).toContainText("₹500");
  await owner.page.getByLabel("Your answer (only the poster sees it)").fill("A photo of my dog on a beach");
  await owner.page.getByLabel(/I agree to pay the ₹500 finder reward/).check();
  await owner.page.getByRole("button", { name: /This could be mine/ }).click();
  await expect(owner.page.getByText("Your claim is waiting for the poster's decision.")).toBeVisible();

  await finder.page.goto(`/items/${item.id}`);
  await finder.page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(finder.page.getByText(/Waiting for the owner to pay the ₹100 connection fee/)).toBeVisible();

  await owner.page.reload();
  await expect(owner.page.getByText("₹500 finder reward")).toBeVisible();
  const paid = await payInCheckout(owner.page, "Success");
  await expect(owner.page).toHaveURL(/\/inbox\/\d+$/, { timeout: 60000 });
  const rz = await assertCapturedAtRazorpay(paid.orderId);
  const claimId = Number(sql(`SELECT claim_id FROM connection_payments WHERE provider_order_id = '${paid.orderId}'`));
  record({ scenario: "found/Phone success", claimId, orderId: paid.orderId, paymentId: rz.captured.id, amount: rz.captured.amount, currency: rz.captured.currency, razorpayStatus: rz.captured.status });

  // Paying doesn't expose numbers; the finder must consent.
  await expect(owner.page.getByText(/phone:/)).toHaveCount(0);
  await finder.page.goto(owner.page.url().replace(/^https?:\/\/[^/]+/, ""));
  await finder.page.getByLabel("Share my phone number in this conversation").check();
  await owner.page.reload();
  await expect(owner.page.getByText("+919823456712")).toBeVisible();
  await owner.ctx.close();
  await finder.ctx.close();
});

// ---------------------------------------------------------------------------
// Failure, cancellation, retry
// ---------------------------------------------------------------------------
test("failed payment and cancelled checkout keep chat locked; retry succeeds", async ({ browser }) => {
  const { owner, claim } = await lostMatch(browser, "fail");
  await owner.page.goto(`/inbox/${claim.conversationId}`);

  const failed = await payInCheckout(owner.page, "Failure");
  await expect(failed.fr.getByText(/fail|declined|cancel/i).first()).toBeVisible({ timeout: 30000 });
  await owner.page.screenshot({ path: `${SHOTS}/5-failure.png` });
  const failedPayments = (await razorpay(`/orders/${failed.orderId}/payments`)).items;
  expect(failedPayments.every((p: { status: string }) => p.status === "failed")).toBe(true);
  record({ scenario: "failure", claimId: claim.id, orderId: failed.orderId, paymentIds: failedPayments.map((p: { id: string }) => p.id), razorpayStatuses: failedPayments.map((p: { status: string }) => p.status) });
  // Razorpay shows "Payment could not be completed / Retry payment of ₹100";
  // our page reports the failure behind it and the chat stays locked.
  await expect(failed.fr.getByText("Payment could not be completed")).toBeVisible({ timeout: 30000 });
  await expect(failed.fr.getByText("Retry payment of ₹100 with")).toBeVisible();
  await expect(owner.page.getByText(/The payment didn't go through/)).toBeVisible();
  await owner.page.screenshot({ path: `${SHOTS}/5-failure.png` });

  // Cancelled checkout: open a fresh checkout and close it before paying.
  await owner.page.reload();
  await owner.page.getByRole("button", { name: "Pay ₹100 and connect" }).click();
  const rzFrame = owner.page.frameLocator('iframe[src*="api.razorpay.com"]').first();
  await rzFrame.getByPlaceholder("Card Number").waitFor({ timeout: 45000 });
  await owner.page.waitForTimeout(1000);
  await rzFrame.getByTestId("checkout-close").click();
  await rzFrame.getByRole("button", { name: "Yes, exit" }).click({ timeout: 15000 });
  await expect(owner.page.getByText("Payment cancelled.")).toBeVisible({ timeout: 20000 });
  await owner.page.screenshot({ path: `${SHOTS}/6-cancelled.png` });
  expect(sql(`SELECT status FROM connection_payments WHERE provider_order_id = '${failed.orderId}'`)).toBe("cancelled");
  expect((await owner.api("POST", `/conversations/${claim.conversationId}/messages`, { body: "x" })).status).toBe(402);

  // Retry with a fresh order -> success.
  await owner.page.reload();
  const ok = await payInCheckout(owner.page, "Success");
  expect(ok.orderId).not.toBe(failed.orderId);
  await expect(owner.page.getByText("₹350, payable directly by the owner at handover.")).toBeVisible({ timeout: 60000 });
  const rz = await assertCapturedAtRazorpay(ok.orderId);
  record({ scenario: "retry after failure", claimId: claim.id, orderId: ok.orderId, paymentId: rz.captured.id, amount: rz.captured.amount });
  expect((await owner.api("POST", `/conversations/${claim.conversationId}/messages`, { body: "now unlocked" })).status).toBe(201);
});

// ---------------------------------------------------------------------------
// Browser closed after paying (callback never reaches us) -> reconciliation
// ---------------------------------------------------------------------------
test("browser closed right after a successful payment is recovered by reconciliation", async ({ browser }) => {
  const { owner, finder, claim } = await lostMatch(browser, "closed");
  await owner.page.goto(`/inbox/${claim.conversationId}`);
  // Drop the browser's verify callback to simulate the tab closing first.
  await owner.page.route("**/api/payments/verify", (route) => route.abort());
  const paid = await payInCheckout(owner.page, "Success");
  await expect.poll(async () => ((await razorpay(`/orders/${paid.orderId}`)).status), { timeout: 60000 }).toBe("paid");
  await owner.page.close();
  expect(sql(`SELECT status FROM connection_payments WHERE provider_order_id = '${paid.orderId}'`)).not.toBe("paid");
  // Either participant viewing the match triggers reconciliation with Razorpay.
  const state = await finder.api("GET", `/claims/${claim.id}/payment`);
  expect(state.body.status).toBe("paid");
  const rz = await assertCapturedAtRazorpay(paid.orderId);
  record({ scenario: "browser closed -> reconciled", claimId: claim.id, orderId: paid.orderId, paymentId: rz.captured.id, amount: rz.captured.amount });
  expect((await finder.api("POST", `/conversations/${claim.conversationId}/messages`, { body: "hello after reconcile" })).status).toBe(201);
});

// ---------------------------------------------------------------------------
// Abuse: concurrency, invalid signatures, tampering, reuse, access
// ---------------------------------------------------------------------------
test("concurrent checkout, invalid signature, tampered amount/match, payment reuse and outsider access are all rejected", async ({ browser }) => {
  const a = await lostMatch(browser, "abuse-a");
  const b = await lostMatch(browser, "abuse-b");
  const outsider = await signIn(browser, "abuse-outsider");

  // Repeated/concurrent clicks -> one open order recorded for the match.
  const results = await Promise.all([1, 2, 3, 4].map(() => a.owner.api("POST", `/claims/${a.claim.id}/checkout`, { amountPaise: 1, currency: "USD" })));
  expect(results.every((r) => r.status === 200)).toBe(true);
  const orderIds = new Set(results.map((r) => r.body.checkout.orderId));
  expect(sql(`SELECT count(*) FROM connection_payments WHERE claim_id = ${a.claim.id} AND status IN ('created','pending')`)).toBe("1");
  for (const r of results) expect(r.body.checkout.amountPaise).toBe(10000);
  const storedOrder = sql(`SELECT provider_order_id FROM connection_payments WHERE claim_id = ${a.claim.id} AND status = 'created'`);
  expect((await razorpay(`/orders/${storedOrder}`)).amount).toBe(10000);
  record({ scenario: "concurrent checkout", claimId: a.claim.id, distinctOrdersReturned: orderIds.size, storedOpenOrder: storedOrder, note: "client-sent amount 1/USD ignored" });

  // Tampered match id: other people's matches.
  expect((await outsider.api("POST", `/claims/${a.claim.id}/checkout`, {})).status).toBe(404);
  expect((await a.finder.api("POST", `/claims/${a.claim.id}/checkout`, {})).status).toBe(403);
  expect((await a.owner.api("POST", `/claims/${b.claim.id}/checkout`, {})).status).toBe(404);

  // Pay match A for real, then try to reuse that payment for match B.
  await a.owner.page.goto(`/inbox/${a.claim.conversationId}`);
  const verifyResp = a.owner.page.waitForRequest((r) => r.url().endsWith("/api/payments/verify"));
  const paidA = await payInCheckout(a.owner.page, "Success");
  const sent = JSON.parse((await verifyResp).postData() || "{}");
  await expect(a.owner.page.getByText("₹350, payable directly by the owner at handover.")).toBeVisible({ timeout: 60000 });
  const rzA = await assertCapturedAtRazorpay(paidA.orderId);
  record({ scenario: "abuse match A success", claimId: a.claim.id, orderId: paidA.orderId, paymentId: rzA.captured.id, amount: rzA.captured.amount });

  // Invalid signature on a genuine payment.
  const bad = await a.owner.api("POST", "/payments/verify", { orderId: paidA.orderId, paymentId: sent.paymentId, signature: "f".repeat(64) });
  expect(bad.status).toBe(400);
  expect(bad.body.error.code).toBe("invalid_signature");

  // Reuse: B's order with A's genuine payment + signature.
  const orderB = (await b.owner.api("POST", `/claims/${b.claim.id}/checkout`, {})).body.checkout.orderId;
  const reuse = await b.owner.api("POST", "/payments/verify", { orderId: orderB, paymentId: sent.paymentId, signature: sent.signature });
  expect(reuse.status).toBe(400);
  // Even a correctly computed signature for (orderB|paymentA) fails the provider association check.
  const forged = crypto.createHmac("sha256", KEY_SECRET).update(`${orderB}|${sent.paymentId}`).digest("hex");
  const assoc = await b.owner.api("POST", "/payments/verify", { orderId: orderB, paymentId: sent.paymentId, signature: forged });
  expect(assoc.status).toBe(400);
  expect(assoc.body.error.code).toBe("order_mismatch");
  expect((await b.owner.api("GET", `/conversations/${b.claim.conversationId}`)).body.conversation.locked).toBe(true);
  expect(sql(`SELECT count(*) FROM connection_entitlements WHERE claim_id = ${b.claim.id}`)).toBe("0");

  // Paying again for A is refused; outsider can't read A's paid chat.
  expect((await a.owner.api("POST", `/claims/${a.claim.id}/checkout`, {})).status).toBe(409);
  expect((await outsider.api("GET", `/conversations/${a.claim.conversationId}`)).status).toBe(404);
  record({ scenario: "rejections", invalidSignature: bad.status, reuseOtherMatch: reuse.status, forgedAssociation: assoc.body.error.code });
});

// ---------------------------------------------------------------------------
// Webhooks: signed with the configured secret, real payment entities,
// duplicate + out-of-order delivery. (Genuine Razorpay delivery is verified
// separately via the public tunnel; see report.)
// ---------------------------------------------------------------------------
test("webhook processing is idempotent for duplicate and out-of-order events on a real payment", async ({ browser, request }) => {
  const { owner, claim } = await lostMatch(browser, "webhook");
  await owner.page.goto(`/inbox/${claim.conversationId}`);
  await owner.page.route("**/api/payments/verify", (route) => route.abort()); // webhook must do the work
  const paid = await payInCheckout(owner.page, "Success");
  await expect.poll(async () => (await razorpay(`/orders/${paid.orderId}`)).status, { timeout: 60000 }).toBe("paid");
  const payment = (await razorpay(`/orders/${paid.orderId}/payments`)).items.find((p: { status: string }) => p.status === "captured");

  const send = async (event: string, entity: Record<string, unknown>, eventId: string, secret = WEBHOOK_SECRET) => {
    const raw = JSON.stringify({ entity: "event", event, payload: { payment: { entity } }, created_at: Math.floor(Date.now() / 1000) });
    return request.post("/api/payments/webhook", {
      headers: { "Content-Type": "application/json", "X-Razorpay-Signature": crypto.createHmac("sha256", secret).update(raw).digest("hex"), "X-Razorpay-Event-Id": eventId },
      data: raw,
    });
  };
  const evt = `evt_local_${RUN}`;
  expect((await send("payment.captured", payment, evt, "wrong-secret")).status()).toBe(400);
  // Out of order: a "failed" for a different attempt arrives first, then captured twice (duplicate id) concurrently.
  expect((await send("payment.failed", { ...payment, id: `pay_fake${RUN}`, status: "failed" }, `${evt}_f`)).status()).toBe(200);
  const [d1, d2] = await Promise.all([send("payment.captured", payment, evt), send("payment.captured", payment, evt)]);
  expect([d1.status(), d2.status()]).toEqual([200, 200]);
  const bodies = [await d1.json(), await d2.json()];
  expect(bodies.filter((x) => x.duplicate).length).toBe(1);
  // Late failure after capture changes nothing.
  expect((await send("payment.failed", { ...payment, status: "failed" }, `${evt}_late`)).status()).toBe(200);
  expect(sql(`SELECT status FROM connection_payments WHERE provider_order_id = '${paid.orderId}'`)).toBe("paid");
  expect(sql(`SELECT count(*) FROM connection_entitlements WHERE claim_id = ${claim.id}`)).toBe("1");
  record({ scenario: "webhook idempotency (locally signed, real payment entity)", claimId: claim.id, orderId: paid.orderId, paymentId: payment.id, duplicateDetected: true });
});

// ---------------------------------------------------------------------------
// Refund through the moderator support flow (real Razorpay test refund)
// ---------------------------------------------------------------------------
test("refund: owner requests, moderator approves, Razorpay refunds ₹100, chat locks", async ({ browser }) => {
  const { owner, claim } = await lostMatch(browser, "refund");
  await owner.page.goto(`/inbox/${claim.conversationId}`);
  const paid = await payInCheckout(owner.page, "Success");
  await expect(owner.page.getByText("₹350, payable directly by the owner at handover.")).toBeVisible({ timeout: 60000 });
  const rz = await assertCapturedAtRazorpay(paid.orderId);

  await owner.page.getByRole("button", { name: "Request a refund of the connection fee" }).click();
  await owner.page.getByLabel("Why are you requesting a refund?").fill("The finder never replied after I paid");
  await owner.page.getByRole("button", { name: "Send refund request" }).click();
  await expect(owner.page.getByText("Refund request sent. Our team will review it.").first()).toBeVisible();

  const mod = await signIn(browser, "refund-mod", { role: "moderator" });
  await mod.page.goto("/moderation");
  const card = mod.page.getByRole("article").filter({ hasText: "The finder never replied after I paid" });
  await card.getByLabel("Resolution note").fill("Finder unresponsive; approved");
  await card.getByRole("button", { name: "Approve refund" }).click();
  await expect(card).toHaveCount(0, { timeout: 30000 });

  const refunds = (await razorpay(`/payments/${rz.captured.id}/refunds`)).items as { id: string; amount: number; status: string }[];
  expect(refunds.length).toBeGreaterThan(0);
  expect(refunds[0].amount).toBe(10000);
  const after = await razorpay(`/payments/${rz.captured.id}`);
  expect(sql(`SELECT status FROM connection_payments WHERE provider_order_id = '${paid.orderId}'`)).toMatch(/refunded|refund_pending/);
  record({ scenario: "refund", claimId: claim.id, orderId: paid.orderId, paymentId: rz.captured.id, refundId: refunds[0].id, refundAmount: refunds[0].amount, refundStatus: refunds[0].status, paymentStatusAfter: after.status, ourStatus: sql(`SELECT status FROM connection_payments WHERE provider_order_id = '${paid.orderId}'`) });

  // Access ends as soon as the refund is approved (even while Razorpay still processes it).
  await owner.page.reload();
  await expect(owner.page.getByRole("heading", { name: "Chat is locked" })).toBeVisible();
  await expect(owner.page.getByText(/connection fee was refunded/)).toBeVisible();
  expect((await owner.api("POST", `/conversations/${claim.conversationId}/messages`, { body: "x" })).status).toBe(402);
  // The status endpoint reconciles the refund with Razorpay; give it up to ~90s to settle.
  let final = "";
  for (let i = 0; i < 18 && final !== "refunded"; i++) {
    final = (await owner.api("GET", `/claims/${claim.id}/payment`)).body.status;
    if (final !== "refunded") await owner.page.waitForTimeout(5000);
  }
  record({ scenario: "refund settlement", claimId: claim.id, paymentId: rz.captured.id, statusAfterPolling: final, razorpayRefund: (await razorpay(`/payments/${rz.captured.id}/refunds`)).items?.[0]?.status });
  expect(final).toMatch(/refunded|refund_pending/);
});

// ---------------------------------------------------------------------------
// Return lifecycle on top of a real Razorpay Test Mode ₹100 connection
// ---------------------------------------------------------------------------
test("return lifecycle: ₹100 Razorpay test payment, finder handover, owner confirms receipt, reward confirmed", async ({ browser }) => {
  const { owner, finder, item, claim } = await lostMatch(browser, "ret-rzp", "phone", 50000);
  const before = (await owner.api("GET", "/stats")).body.returned as number;
  await owner.page.goto(`/items/${item.id}`);
  const paid = await payInCheckout(owner.page, "Success");
  await expect(owner.page).toHaveURL(/\/inbox\/\d+$/, { timeout: 60000 });
  expect([paid.amountPaise, paid.currency]).toEqual([10000, "INR"]);
  const { captured } = await assertCapturedAtRazorpay(paid.orderId);

  await finder.page.goto(`/inbox/${claim.conversationId}`);
  await finder.page.getByTestId("return-panel").getByRole("button", { name: "I handed over this item" }).click();
  await finder.page.getByRole("alertdialog").getByRole("button", { name: "Yes, I handed it over" }).click();
  await expect(finder.page.getByTestId("return-status")).toHaveText("Awaiting owner confirmation");

  await owner.page.goto(`/inbox/${claim.conversationId}`);
  await expect(owner.page.getByTestId("return-status")).toHaveText("Awaiting owner confirmation");
  await owner.page.getByTestId("return-panel").getByRole("button", { name: "I received my item" }).click();
  await owner.page.getByRole("alertdialog", { name: "Have you received your item?" }).getByRole("button", { name: "Yes, I received it" }).click();
  await expect(owner.page.getByTestId("return-status")).toHaveText("Returned");
  await owner.page.screenshot({ path: `${SHOTS}/return-razorpay-returned.png`, fullPage: true });

  await finder.page.reload();
  await finder.page.getByTestId("return-panel").getByRole("button", { name: "I received the reward" }).click();
  await expect(finder.page.getByText("Finder confirmed receipt")).toBeVisible();

  // No second charge: still exactly one captured ₹100 payment for this order, one paid row locally.
  const payments = (await razorpay(`/orders/${paid.orderId}/payments`)).items as { status: string }[];
  expect(payments.filter((p) => p.status === "captured")).toHaveLength(1);
  expect(sql(`SELECT count(*) FROM connection_payments WHERE claim_id = ${claim.id} AND status = 'paid'`)).toBe("1");
  expect(sql(`SELECT status || '|' || closure_reason FROM items WHERE id = ${item.id}`)).toBe("returned|returned_matched");
  expect((await owner.api("GET", "/stats")).body.returned).toBe(before + 1);
  const checkoutAgain = await owner.api("POST", `/claims/${claim.id}/checkout`, {});
  expect(checkoutAgain.status).toBe(409);
  record({ test: "return-lifecycle", orderId: paid.orderId, paymentId: captured.id, amount: captured.amount, currency: captured.currency, itemStatus: "returned" });
  for (const u of [owner, finder]) await u.ctx.close();
});
