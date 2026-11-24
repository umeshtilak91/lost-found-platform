import type { BrowserContext, Page } from "@playwright/test";
import { apiCall, claimFoundApi, createListing, expect, newUser, payApi, persona, REWARD_PAISE, RUN, test } from "./fixtures";

// Item-return lifecycle through the real UI with two separate browser
// sessions: User A = owner, User B = finder (plus an outsider / moderator).
// Payments use the e2e stack's local test-mode provider (fixture, ₹100 order);
// category rewards never go through checkout.

const shot = (page: Page, name: string, project: string) => page.screenshot({ path: `test-results/returns-${name}-${project}.png`, fullPage: true });
const stats = async (ctx: BrowserContext) => (await (await ctx.request.get("/api/stats")).json()) as { returned: number; selfRecovered: number; externalReturns: number };
const panel = (page: Page) => page.getByTestId("return-panel").first();

// Lost listing by A, response by B, accepted and paid by A (API shortcuts).
async function connectedLostMatch(A: BrowserContext, B: BrowserContext, title: string) {
  const item = await createListing(A, { type: "lost", category: "phone", title });
  const claim = (await (await apiCall(B, "POST", `/items/${item.id}/claims`, { data: { answer: "Blue case with a sticker" } })).json()).claim;
  expect((await apiCall(A, "POST", `/claims/${claim.id}/accept`, { data: { acceptReward: true, expectedRewardPaise: REWARD_PAISE.phone } })).status()).toBe(200);
  await payApi(A, claim.id);
  return { item, claim: claim as { id: number; conversationId: number } };
}

test("A. lost listing: finder hands over first, owner confirms; item leaves search; both see history; counted once @responsive", async ({ browser }, info) => {
  const A = await newUser(browser, persona("ret-owner-a"));
  const B = await newUser(browser, persona("ret-finder-a"));
  const before = await stats(A.context);
  const title = `Return journey phone ${RUN}`;
  const item = await createListing(A.context, { type: "lost", category: "phone", title });

  // B responds through the item page.
  await B.page.goto(`/items/${item.id}`);
  await B.page.getByLabel("Your answer (only the poster sees it)").fill("Blue case with a cricket sticker");
  await B.page.getByRole("button", { name: "I found this item" }).click();
  await expect(B.page.getByText("Your claim is waiting for the poster's decision.")).toBeVisible();

  // A accepts (agreeing to the reward) and pays the ₹100 test connection fee.
  await A.page.goto(`/items/${item.id}`);
  await A.page.getByRole("button", { name: "Accept", exact: true }).click();
  await A.page.getByLabel(/I agree to pay the ₹500 finder reward directly to this finder/).check();
  await A.page.getByRole("button", { name: /Accept match and agree to pay the ₹500 reward/ }).click();
  await A.page.getByRole("button", { name: "Pay ₹100 and connect" }).click();
  await A.page.getByRole("dialog", { name: "Test payment (no real money)" }).getByRole("button", { name: "Simulate successful payment" }).click();
  await expect(A.page).toHaveURL(/\/inbox\/\d+$/);
  const conversationPath = new URL(A.page.url()).pathname;
  await expect(panel(A.page).getByTestId("return-status")).toHaveText("Return being arranged");

  // Listing still active while the return is arranged; new claims are paused.
  await A.page.goto(`/items?q=${encodeURIComponent(title)}`);
  await expect(A.page.locator("main article")).toHaveCount(1);
  await expect(A.page.locator("main article")).toContainText("Return being arranged");

  // B: "I handed over this item".
  await B.page.goto(conversationPath);
  await panel(B.page).getByRole("button", { name: "I handed over this item" }).click();
  await B.page.getByRole("alertdialog", { name: "Did you hand over the item?" }).getByRole("button", { name: "Yes, I handed it over" }).click();
  await expect(panel(B.page).getByTestId("return-status")).toHaveText("Awaiting owner confirmation");
  await expect(B.page.getByText("Waiting for the owner to confirm they received the item.")).toBeVisible();

  // A gets the confirmation request in notifications and lands on the panel.
  await A.page.goto("/notifications");
  await A.page.getByRole("link", { name: new RegExp(`The finder says they handed over “${title}”`) }).click();
  await expect(A.page).toHaveURL(new RegExp(`${conversationPath}$`));
  await expect(panel(A.page).getByTestId("return-status")).toHaveText("Awaiting owner confirmation");
  await shot(A.page, "pending-confirmation", info.project.name);
  await panel(A.page).getByRole("button", { name: "I received my item" }).click();
  const dialog = A.page.getByRole("alertdialog", { name: "Have you received your item?" });
  await expect(dialog).toContainText("Confirming will close this listing and remove it from active search results.");
  await expect(dialog.getByRole("button", { name: "There is a problem" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await A.page.waitForTimeout(400); // let the open animation finish for the screenshot
  await shot(A.page, "owner-confirm-dialog", info.project.name);
  await dialog.getByRole("button", { name: "Yes, I received it" }).click();
  await expect(panel(A.page).getByTestId("return-status")).toHaveText("Returned");
  await expect(panel(A.page).getByText("Awaiting finder confirmation")).toBeVisible();

  // Closed for everyone: banner on the old link, gone from search.
  const anon = await browser.newContext();
  const visitor = await anon.newPage();
  await visitor.goto(`/items/${item.id}`);
  await expect(visitor.getByTestId("closed-banner")).toHaveText("This item has been returned.");
  await expect(visitor).toHaveTitle(/^Returned · /);
  await expect(visitor.getByText("Sign in to contact the poster or claim this item.")).toHaveCount(0);
  await shot(visitor, "returned-status", info.project.name);
  await visitor.goto(`/items?q=${encodeURIComponent(title)}`);
  await expect(visitor.getByText("No listings match")).toBeVisible();
  await shot(visitor, "search-removed", info.project.name);
  await visitor.goto("/");
  await expect(visitor.getByText(title)).toHaveCount(0);

  // Both participants keep the history.
  for (const [user, role] of [
    [A, "You: owner"],
    [B, "You: finder"],
  ] as const) {
    await user.page.goto("/account");
    const history = user.page.getByTestId("completed-returns");
    await expect(history).toContainText(title);
    await expect(history).toContainText("Returned to owner");
    await expect(history).toContainText(role);
    await expect(history).toContainText("Connection fee receipt: ₹100");
  }
  await shot(A.page, "account-history", info.project.name);
  // B was notified; the statistic increased exactly once.
  await B.page.goto("/notifications");
  await expect(B.page.getByText(`The owner confirmed receiving “${title}”`)).toBeVisible();
  expect((await stats(A.context)).returned).toBe(before.returned + 1);
  for (const c of [A.context, B.context, anon]) await c.close();
});

test("B. owner confirms before the finder's handover; the finder is notified and the return stays complete", async ({ browser }) => {
  const A = await newUser(browser, persona("ret-owner-b"));
  const B = await newUser(browser, persona("ret-finder-b"));
  const { item, claim } = await connectedLostMatch(A.context, B.context, `Owner first phone ${RUN}`);
  await A.page.goto(`/items/${item.id}`);
  await panel(A.page).getByRole("button", { name: "I received my item" }).click();
  await A.page.getByRole("alertdialog").getByRole("button", { name: "Yes, I received it" }).click();
  await expect(panel(A.page).getByTestId("return-status")).toHaveText("Returned");
  await B.page.goto(`/items/${item.id}`);
  await expect(panel(B.page).getByTestId("return-status")).toHaveText("Returned");
  await expect(panel(B.page).getByRole("button", { name: "I handed over this item" })).toHaveCount(0);
  const late = await apiCall(B.context, "POST", `/claims/${claim.id}/handover`, { data: {} });
  expect(late.status()).toBe(200);
  expect((await late.json()).claim.returnState).toBe("returned");
  await B.page.goto("/notifications");
  await expect(B.page.getByText(/The owner confirmed receiving “Owner first phone/)).toBeVisible();
  await A.context.close();
  await B.context.close();
});

test("C. found listing: owner claims with evidence, finder accepts, owner pays, handover and receipt", async ({ browser }) => {
  const A = await newUser(browser, persona("ret-owner-c"));
  const B = await newUser(browser, persona("ret-finder-c"));
  const title = `Found journey wallet ${RUN}`;
  const item = await createListing(B.context, { type: "found", category: "wallet", title, ownershipQuestion: "What card is inside?" });
  await A.page.goto(`/items/${item.id}`);
  await A.page.getByLabel("Your answer (only the poster sees it)").fill("A blue library card with my name");
  await A.page.getByLabel(/I agree to pay the ₹300 finder reward/).check();
  await A.page.getByRole("button", { name: "This could be mine" }).click();
  await B.page.goto(`/items/${item.id}`);
  await B.page.getByRole("button", { name: "Accept", exact: true }).click();
  await A.page.goto(`/items/${item.id}`);
  await A.page.getByRole("button", { name: "Pay ₹100 and connect" }).click();
  await A.page.getByRole("dialog").getByRole("button", { name: "Simulate successful payment" }).click();
  await expect(A.page).toHaveURL(/\/inbox\/\d+$/);
  await B.page.goto(`/items/${item.id}`);
  await panel(B.page).getByRole("button", { name: "I handed over this item" }).click();
  await B.page.getByRole("alertdialog").getByRole("button", { name: "Yes, I handed it over" }).click();
  await expect(panel(B.page).getByTestId("return-status")).toHaveText("Awaiting owner confirmation");
  await A.page.goto(`/items/${item.id}`);
  await panel(A.page).getByRole("button", { name: "I received my item" }).click();
  await A.page.getByRole("alertdialog").getByRole("button", { name: "Yes, I received it" }).click();
  await expect(panel(A.page).getByTestId("return-status")).toHaveText("Returned");
  await expect(A.page.getByTestId("closed-banner")).toHaveText("This item has been returned.");
  await A.context.close();
  await B.context.close();
});

test("D. linked lost and found listings close together and count as one recovery", async ({ browser }) => {
  const A = await newUser(browser, persona("ret-owner-d"));
  const B = await newUser(browser, persona("ret-finder-d"));
  const tag = `Linked return ${RUN}`;
  const lost = await createListing(A.context, { type: "lost", category: "bag", title: `${tag} lost bag` });
  const found = await createListing(B.context, { type: "found", category: "bag", title: `${tag} found bag` });
  const before = await stats(A.context);
  await A.page.goto(`/items/${found.id}`);
  await A.page.getByLabel("Your answer (only the poster sees it)").fill("Grey with a red zip");
  await A.page.getByLabel(/Is this the same item as one of your listings/).selectOption(String(lost.id));
  await A.page.getByLabel(/I agree to pay the ₹300 finder reward/).check();
  await A.page.getByRole("button", { name: "This could be mine" }).click();
  await expect(A.page.getByText("Your claim is waiting for the poster's decision.")).toBeVisible();
  const claim = (await (await A.context.request.get(`/api/items/${found.id}/claims`)).json()).claims[0];
  expect(claim.linkedItemId).toBe(lost.id);
  expect((await apiCall(B.context, "POST", `/claims/${claim.id}/accept`, { data: {} })).status()).toBe(200);
  await payApi(A.context, claim.id);
  await A.page.goto(`/items/${found.id}`);
  await panel(A.page).getByRole("button", { name: "I received my item" }).click();
  await A.page.getByRole("alertdialog").getByRole("button", { name: "Yes, I received it" }).click();
  await expect(panel(A.page).getByTestId("return-status")).toHaveText("Returned");
  for (const id of [lost.id, found.id]) {
    await A.page.goto(`/items/${id}`);
    await expect(A.page.getByTestId("closed-banner")).toHaveText("This item has been returned.");
  }
  await A.page.goto(`/items?q=${encodeURIComponent(tag)}`);
  await expect(A.page.getByText("No listings match")).toBeVisible();
  expect((await stats(A.context)).returned).toBe(before.returned + 1);
  await A.context.close();
  await B.context.close();
});

test("E. self-recovery: owner closes the lost listing; pending claimant sees why", async ({ browser }, info) => {
  const A = await newUser(browser, persona("ret-owner-e"));
  const B = await newUser(browser, persona("ret-finder-e"));
  const title = `Self recovered keys ${RUN}`;
  const item = await createListing(A.context, { type: "lost", category: "keys", title });
  await apiCall(B.context, "POST", `/items/${item.id}/claims`, { data: { answer: "Found near the gym" } });
  const before = await stats(A.context);
  await A.page.goto(`/items/${item.id}`);
  await A.page.getByRole("button", { name: "I found it myself" }).click();
  const dialog = A.page.getByRole("alertdialog", { name: "Did you find your item yourself?" });
  await expect(dialog).toContainText("1 pending claim(s) will be closed with an explanation.");
  await A.page.waitForTimeout(400);
  await shot(A.page, "self-recovery-dialog", info.project.name);
  await dialog.getByRole("button", { name: "Yes, I found it" }).click();
  await expect(A.page.getByTestId("closed-banner")).toHaveText("The owner found this item themselves.");
  await A.page.goto("/account");
  await expect(A.page.getByTestId("completed-returns")).toContainText("Found by owner");
  await B.page.goto(`/items/${item.id}`);
  await expect(B.page.getByText("The owner found this item themselves, so your claim was closed.")).toBeVisible();
  const after = await stats(A.context);
  expect(after.selfRecovered).toBe(before.selfRecovered + 1);
  expect(after.returned).toBe(before.returned);
  await A.context.close();
  await B.context.close();
});

test("F. external return: reporter archives a found listing with a distinct label", async ({ browser }) => {
  const B = await newUser(browser, persona("ret-finder-f"));
  const title = `External return umbrella ${RUN}`;
  const item = await createListing(B.context, { type: "found", category: "other", title });
  const before = await stats(B.context);
  await B.page.goto(`/items/${item.id}`);
  await B.page.getByRole("button", { name: "Returned outside the platform" }).click();
  const dialog = B.page.getByRole("alertdialog", { name: "Returned outside the platform?" });
  await dialog.getByLabel(/How was it returned/).fill("Handed to the station master");
  await dialog.getByRole("button", { name: "Yes, it was returned" }).click();
  await expect(B.page.getByTestId("closed-banner")).toHaveText("The finder reports this item was returned outside the platform.");
  await B.page.goto("/account");
  await expect(B.page.getByTestId("completed-returns")).toContainText("Returned outside the platform");
  expect((await stats(B.context)).externalReturns).toBe(before.externalReturns + 1);
  await B.context.close();
});

test("G. reward confirmation is separate from the return; a payment issue never reopens the listing", async ({ browser }) => {
  const A = await newUser(browser, persona("ret-owner-g"));
  const B = await newUser(browser, persona("ret-finder-g"));
  const first = await connectedLostMatch(A.context, B.context, `Reward ok phone ${RUN}`);
  await apiCall(A.context, "POST", `/claims/${first.claim.id}/return`, { data: {} });
  await B.page.goto(`/items/${first.item.id}`);
  await expect(panel(B.page).getByText("Awaiting finder confirmation")).toBeVisible();
  await panel(B.page).getByRole("button", { name: "I received the reward" }).click();
  await expect(panel(B.page).getByText("Finder confirmed receipt")).toBeVisible();
  await expect(B.page.getByTestId("closed-banner")).toHaveText("This item has been returned.");

  const second = await connectedLostMatch(A.context, B.context, `Reward issue phone ${RUN}`);
  await apiCall(A.context, "POST", `/claims/${second.claim.id}/return`, { data: {} });
  await B.page.goto(`/items/${second.item.id}`);
  await panel(B.page).getByRole("button", { name: "Reward payment issue" }).click();
  const dialog = B.page.getByRole("alertdialog");
  await dialog.getByLabel("What went wrong? (sent to support)").fill("The owner said they'd pay later");
  await dialog.getByRole("button", { name: "Report issue" }).click();
  await expect(panel(B.page).getByText("Finder reported a payment issue")).toBeVisible();
  await expect(panel(B.page).getByTestId("return-status")).toHaveText("Returned");
  expect((await (await B.context.request.get(`/api/items/${second.item.id}`)).json()).item.status).toBe("returned");
  await A.context.close();
  await B.context.close();
});

test("H. correction: owner requests it, a moderator reopens; history and statistics reconcile", async ({ browser }) => {
  const A = await newUser(browser, persona("ret-owner-h"));
  const B = await newUser(browser, persona("ret-finder-h"));
  const mod = await newUser(browser, persona("ret-mod-h", "moderator"));
  const { item, claim } = await connectedLostMatch(A.context, B.context, `Correction phone ${RUN}`);
  await apiCall(A.context, "POST", `/claims/${claim.id}/return`, { data: {} });
  const completed = await stats(A.context);
  await A.page.goto(`/items/${item.id}`);
  await panel(A.page).getByRole("button", { name: "Request a correction" }).click();
  const dialog = A.page.getByRole("alertdialog", { name: "Request a correction" });
  await dialog.getByLabel("What should be corrected?").fill("I tapped received by mistake, we haven't met yet");
  await dialog.getByRole("button", { name: "Send request" }).click();
  await expect(A.page.getByText("Correction requested. A moderator will review it.").first()).toBeVisible();

  await mod.page.goto("/moderation");
  const request = mod.page.getByRole("article").filter({ hasText: "I tapped received by mistake" });
  await expect(request).toContainText("Return correction request");
  await request.getByLabel("Resolution note").fill("Confirmed with both users");
  await request.getByRole("button", { name: "Reopen return" }).click();
  await expect(request).toHaveCount(0);

  await A.page.goto(`/items/${item.id}`);
  await expect(A.page.getByTestId("closed-banner")).toHaveCount(0);
  await expect(panel(A.page).getByTestId("return-status")).toHaveText("Return being arranged");
  expect((await stats(A.context)).returned).toBe(completed.returned - 1);
  await A.page.goto("/account");
  await expect(A.page.getByTestId("completed-returns")).toContainText("Corrected (reopened)");
  for (const c of [A.context, B.context, mod.context]) await c.close();
});

test("negative UI: problem report keeps the return open; outsiders see a closed listing; keyboard dialog @responsive", async ({ browser }) => {
  const A = await newUser(browser, persona("ret-owner-n"));
  const B = await newUser(browser, persona("ret-finder-n"));
  const outsider = await newUser(browser, persona("ret-outsider-n"));
  const { item } = await connectedLostMatch(A.context, B.context, `Problem phone ${RUN}`);

  // Keyboard: open the dialog, Escape cancels and returns focus.
  await A.page.goto(`/items/${item.id}`);
  const receive = panel(A.page).getByRole("button", { name: "I received my item" });
  await receive.focus();
  await A.page.keyboard.press("Enter");
  const dialog = A.page.getByRole("alertdialog", { name: "Have you received your item?" });
  await expect(dialog.getByRole("button", { name: "Yes, I received it" })).toBeFocused();
  await A.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(receive).toBeFocused();

  // "There is a problem": recorded, return unresolved.
  await receive.click();
  await dialog.getByRole("button", { name: "There is a problem" }).click();
  const problem = A.page.getByRole("alertdialog", { name: "Tell us what went wrong" });
  await problem.getByLabel("What happened?").fill("The phone they brought is not mine");
  await problem.getByRole("button", { name: "Send to support" }).click();
  await expect(panel(A.page).getByText("A problem was reported.")).toBeVisible();
  await expect(panel(A.page).getByTestId("return-status")).toHaveText("Return being arranged");
  expect((await (await A.context.request.get(`/api/items/${item.id}`)).json()).item.status).toBe("claimed");

  // Complete it, then an outsider sees a closed listing with no claim or pay actions.
  await apiCall(A.context, "POST", `/claims/${(await (await A.context.request.get(`/api/items/${item.id}/claims`)).json()).claims[0].id}/return`, { data: {} });
  await outsider.page.goto(`/items/${item.id}`);
  await expect(outsider.page.getByTestId("closed-banner")).toHaveText("This item has been returned.");
  await expect(outsider.page.getByText("This listing is closed and no longer accepts claims.")).toBeVisible();
  await expect(outsider.page.getByRole("button", { name: /I found this item|Pay ₹100/ })).toHaveCount(0);
  const late = await apiCall(outsider.context, "POST", `/items/${item.id}/claims`, { data: { answer: "mine" } });
  expect(late.status()).toBe(409);
  for (const c of [A.context, B.context, outsider.context]) await c.close();
});

test("found listing poster can't complete the return for the owner", async ({ browser }) => {
  const A = await newUser(browser, persona("ret-owner-x"));
  const B = await newUser(browser, persona("ret-finder-x"));
  const item = await createListing(B.context, { type: "found", category: "wallet", title: `Poster cannot complete ${RUN}` });
  const claim = await claimFoundApi(A.context, item, "wallet");
  await apiCall(B.context, "POST", `/claims/${claim.id}/accept`, { data: {} });
  await payApi(A.context, claim.id);
  expect((await apiCall(B.context, "POST", `/claims/${claim.id}/return`, { data: {} })).status()).toBe(403);
  expect((await apiCall(B.context, "POST", `/items/${item.id}/status`, { data: { status: "returned" } })).status()).toBe(409);
  await B.page.goto(`/items/${item.id}`);
  await expect(B.page.getByRole("button", { name: "I received my item" })).toHaveCount(0);
  await expect(B.page.getByRole("button", { name: "Mark as returned" })).toHaveCount(0);
  await A.context.close();
  await B.context.close();
});
