import { apiCall, claimFoundApi, createListing, expect, newUser, payApi, persona, REWARD_PAISE, RUN, test } from "./fixtures";

const LABELS: Record<string, string> = {
  phone: "Phone",
  electronics: "Electronics",
  wallet: "Wallet / purse",
  bag: "Bag",
  keys: "Keys",
  documents: "Documents / ID",
  jewelry: "Jewellery",
  clothing: "Clothing",
  pet: "Pet",
  other: "Other",
};
const rupees = (paise: number) => `₹${paise / 100}`;

test("API pricing matches the configured table; Other is ₹350 and the fee is ₹100", async ({ request }) => {
  const pricing = await (await request.get("/api/pricing")).json();
  expect(pricing.connectionFeePaise).toBe(10000);
  expect(Object.fromEntries(pricing.categories.map((c: { category: string; rewardPaise: number }) => [c.category, c.rewardPaise]))).toEqual(REWARD_PAISE);
});

test("report form shows the right reward for every category, and a category change resets the acknowledgement @responsive", async ({ browser }) => {
  const { context, page } = await newUser(browser, persona("pricing-form"));
  await page.goto("/report?type=lost");
  const panel = page.getByRole("region", { name: "Finder reward & connection fee" });
  await expect(panel).toContainText("Choose a category to see the reward.");
  for (const [category, paise] of Object.entries(REWARD_PAISE)) {
    await page.getByLabel("Category", { exact: true }).selectOption(category);
    await expect(page.getByTestId("form-reward")).toHaveText(rupees(paise));
    await expect(panel).toContainText(`I agree to pay the ${rupees(paise)} category reward`);
    await expect(panel).toContainText("₹100");
  }
  // Acknowledge for Other (₹350), then switch to Phone: checkbox clears, new amount shown.
  await page.getByLabel("Category", { exact: true }).selectOption("other");
  const ack = page.getByLabel(/I agree to pay the ₹350 category reward/);
  await ack.check();
  await page.getByLabel("Category", { exact: true }).selectOption("phone");
  await expect(page.getByLabel(/I agree to pay the ₹500 category reward/)).not.toBeChecked();
  await expect(panel).toContainText("The category changed, so the reward is now ₹500.");

  // Found variant explains the direct payment, no checkbox.
  await page.locator("label", { hasText: "I found something" }).click();
  await expect(page.getByLabel("I found something")).toBeChecked();
  await page.getByLabel("Category", { exact: true }).selectOption("other");
  await expect(panel).toContainText("Category reward");
  await expect(page.getByTestId("form-reward")).toHaveText("₹350");
  await expect(panel).toContainText("The owner pays a separate ₹100 connection fee");
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
  // Readable on phones: no horizontal overflow.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await context.close();
});

test("cards and detail pages show the reward for every category; lost = finder reward, found = category reward @responsive", async ({ browser, page }) => {
  const poster = await newUser(browser, persona("pricing-cards"));
  for (const category of Object.keys(REWARD_PAISE)) {
    await createListing(poster.context, { type: "lost", title: `PriceLost ${category} ${RUN}`, category });
    await createListing(poster.context, { type: "found", title: `PriceFound ${category} ${RUN}`, category });
  }
  await page.goto(`/items?q=${encodeURIComponent(`PriceLost`)}&status=all&pageSize=50`);
  for (const [category, paise] of Object.entries(REWARD_PAISE)) {
    const card = page.locator("article").filter({ hasText: `PriceLost ${category} ${RUN}` });
    await expect(card).toContainText(`Finder reward ${rupees(paise)}`);
  }
  await page.goto(`/items?q=${encodeURIComponent(`PriceFound`)}&status=all`);
  for (const [category, paise] of Object.entries(REWARD_PAISE)) {
    const card = page.locator("article").filter({ hasText: `PriceFound ${category} ${RUN}` });
    await expect(card).toContainText(`Category reward ${rupees(paise)}`);
    await expect(card).not.toContainText("Finder reward");
  }
  // Detail page for Other shows ₹350 + ₹100.
  await page.locator("article").filter({ hasText: `PriceFound other ${RUN}` }).getByRole("link").click();
  const panel = page.getByRole("region", { name: "Finder reward & connection fee" });
  await expect(panel).toContainText("₹350");
  await expect(panel).toContainText("₹100");
  await expect(page.getByText(LABELS.other).first()).toBeVisible();
  await poster.context.close();
});

test("server rejects tampered amounts and keeps access per match", async ({ browser }) => {
  const finder = await newUser(browser, persona("tamper-finder"));
  const a = await createListing(finder.context, { type: "found", title: `Tamper A ${RUN}`, category: "other" });
  const b = await createListing(finder.context, { type: "found", title: `Tamper B ${RUN}`, category: "other" });
  const owner = await newUser(browser, persona("tamper-owner"));
  const tampered = await apiCall(owner.context, "POST", `/items/${a.id}/claims`, { data: { answer: "mine", acceptReward: true, expectedRewardPaise: 100 } });
  expect(tampered.status()).toBe(409);
  const c1 = await claimFoundApi(owner.context, a, "other");
  const c2 = await claimFoundApi(owner.context, b, "other");
  for (const c of [c1, c2]) expect((await apiCall(finder.context, "POST", `/claims/${c.id}/accept`, { data: {} })).status()).toBe(200);
  const checkout = await (await apiCall(owner.context, "POST", `/claims/${c1.id}/checkout`, { data: { amountPaise: 1 } })).json();
  expect(checkout.checkout.amountPaise).toBe(10000);
  expect(checkout.checkout.rewardPaise).toBe(35000);
  await payApi(owner.context, c1.id);
  expect((await (await owner.context.request.get(`/api/conversations/${c1.conversationId}`)).json()).conversation.locked).toBe(false);
  expect((await (await owner.context.request.get(`/api/conversations/${c2.conversationId}`)).json()).conversation.locked).toBe(true);
  expect((await apiCall(owner.context, "POST", `/conversations/${c2.conversationId}/messages`, { data: { body: "x" } })).status()).toBe(402);
  await finder.context.close();
  await owner.context.close();
});
