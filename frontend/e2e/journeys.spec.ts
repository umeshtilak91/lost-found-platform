import { apiCall, claimFoundApi, createListing, expect, newUser, openMenuIfCollapsed, payApi, persona, pngFixture, RUN, test, typeIncidentLocation } from "./fixtures";

test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------
// 1. Browse, search beyond page 1, filters, pagination, direct link
// ---------------------------------------------------------------------------
test("visitor finds a listing beyond the first page with search, filters and pagination", async ({ browser, page }) => {
  const seeder = await newUser(browser, persona("seeder"));
  const marker = `Compass${RUN}`;
  const oldest = await createListing(seeder.context, {
    title: `Vintage brass ${marker}`,
    category: "other",
    location: "Shaniwar Wada",
    date: new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10),
  });
  for (let i = 0; i < 24; i++) {
    await createListing(seeder.context, { title: `Umbrella ${RUN} ${i}`, category: i % 2 ? "bag" : "other", location: i % 3 ? "Koregaon Park" : "Hinjewadi" });
  }

  await page.goto("/items?type=lost");
  await expect(page.getByRole("heading", { level: 1, name: "Lost items" })).toBeVisible();
  await expect(page.locator("main article")).toHaveCount(12);
  await expect(page.getByText(marker)).toHaveCount(0);

  // Paginate to the last page: the oldest listing is there.
  const pager = page.getByRole("navigation", { name: "Pagination" });
  await expect(pager).toBeVisible();
  const totalText = await pager.getByText(/Page 1 of \d+/).innerText();
  const totalPages = Number(totalText.match(/of (\d+)/)![1]);
  for (let n = 2; n <= totalPages && (await page.getByText(marker).count()) === 0; n++) {
    await pager.getByRole("link", { name: "Next" }).click();
    await expect(pager.getByText(`Page ${n} of ${totalPages}`)).toBeVisible();
  }
  await expect(page.getByRole("link", { name: new RegExp(marker) })).toBeVisible();

  // Keyword search from page 1 finds it directly.
  await page.goto("/items?type=lost");
  await page.getByLabel("Keyword").fill(marker);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(new RegExp(`q=${marker}`));
  await expect(page.getByText("1 listing")).toBeVisible();

  // Filters are reflected in a shareable URL.
  await page.goto("/items?type=lost");
  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByRole("button", { name: "Bag", exact: true }).click(); // chip applies immediately
  await expect(page).toHaveURL(/category=bag/);
  await expect(page.getByRole("button", { name: "Bag", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("combobox", { name: "Where?" }).fill("Koregaon");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/category=bag/);
  await expect(page).toHaveURL(/location=Koregaon/);
  const cards = page.locator("main article");
  expect(await cards.count()).toBeGreaterThan(0);
  for (const text of await cards.allInnerTexts()) expect(text).toMatch(/Koregaon/);

  // Direct link renders on the server with share metadata.
  const res = await page.goto(`/items/${oldest.id}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(marker) })).toBeVisible();
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", new RegExp(marker));

  // Invalid URL filters fall back gracefully.
  await page.goto("/items?type=lost&from=2026-02-30");
  await expect(page.getByText("Some filters are invalid")).toBeVisible();
  await seeder.context.close();
});

// ---------------------------------------------------------------------------
// 2. Reporter creates (with images), finds, edits, refreshes
// ---------------------------------------------------------------------------
test("reporter creates a listing with photos, finds it, edits it and sees changes after refresh", async ({ browser }) => {
  const { context, page } = await newUser(browser, persona("reporter"));
  const png = await pngFixture(page);
  const title = `Grey Wildcraft backpack ${RUN}`;

  await page.goto("/report?type=found");
  await page.locator("label", { hasText: "I found something" }).click();
  await expect(page.getByLabel("I found something")).toBeChecked();
  await page.getByLabel("What is it?").fill(title);
  await page.getByLabel("Category", { exact: true }).selectOption("bag");
  await typeIncidentLocation(page, "Baner Road bus stop");
  await page.getByLabel("Description").fill("Grey with a laptop sleeve");
  await page.getByLabel("Ownership question (optional)").fill("What brand is the water bottle inside?");
  await page.getByTestId("photo-input").setInputFiles([
    { name: "one.png", mimeType: "image/png", buffer: png },
    { name: "two.png", mimeType: "image/png", buffer: png },
  ]);
  await expect(page.getByRole("button", { name: /Remove photo/ })).toHaveCount(2);
  await page.getByRole("button", { name: "Publish listing" }).click();

  await expect(page).toHaveURL(/\/items\/\d+$/);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByRole("button", { name: /Photo 2 of 2/ })).toBeVisible();
  const imgSrc = await page.locator("main img").first().getAttribute("src");
  const img = await context.request.get(imgSrc!);
  expect(img.headers()["content-type"]).toBe("image/webp");
  const itemUrl = page.url();

  // Discoverable by search.
  await page.goto(`/items?q=${encodeURIComponent(title)}`);
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();

  // Edit and refresh.
  await page.goto(itemUrl);
  await page.getByRole("link", { name: "Edit listing" }).click();
  await page.getByLabel("What is it?").fill(`${title} (edited)`);
  await page.getByRole("button", { name: "Remove photo 1" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `${title} (edited)` })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: `${title} (edited)` })).toBeVisible();
  await expect(page.getByRole("button", { name: /Photo \d of/ })).toHaveCount(0); // one photo left => no thumbnails strip
  await context.close();
});

// ---------------------------------------------------------------------------
// 3 + 4. Contact, claim, notification, accept, return; third-user isolation
// ---------------------------------------------------------------------------
test("Path B (found item): owner claims with reward, finder accepts, owner pays ₹100, chat unlocks, return + reward confirmed", async ({ browser }) => {
  const finder = await newUser(browser, persona("finder"));
  await apiCall(finder.context, "PATCH", "/account/profile", { data: { phone: "+91 98765 43210" } });
  const item = await createListing(finder.context, {
    type: "found",
    title: `Brown leather wallet ${RUN}`,
    category: "wallet",
    ownershipQuestion: "Which card is in the front slot?",
    location: "FC Road",
  });

  // Owner sees the category reward on the item page and claims it.
  const owner = await newUser(browser, persona("owner"));
  await owner.page.goto(`/items/${item.id}`);
  const pricing = owner.page.getByRole("region", { name: "Finder reward & connection fee" });
  await expect(pricing).toContainText("₹300");
  await expect(pricing).toContainText("₹100");
  await expect(owner.page.getByText("Posting and ownership verification are free.")).toBeVisible();
  await owner.page.getByLabel("Your answer (only the poster sees it)").fill("My college library card");
  const claimButton = owner.page.getByRole("button", { name: /This could be mine/ });
  await expect(claimButton).toBeDisabled();
  await owner.page.getByLabel(/I agree to pay the ₹300 finder reward/).check();
  await claimButton.click();
  await expect(owner.page.getByRole("status").filter({ hasText: "Claim submitted" })).toBeVisible();
  await expect(owner.page.getByText("Your claim is waiting for the poster's decision.")).toBeVisible();

  // An outsider can't read anything about this match.
  const outsider = await newUser(browser, persona("outsider"));
  const claims = await (await finder.context.request.get(`/api/items/${item.id}/claims`)).json();
  const claim = claims.claims[0];
  expect((await outsider.context.request.get(`/api/conversations/${claim.conversationId}`)).status()).toBe(404);
  expect((await outsider.context.request.get(`/api/claims/${claim.id}/payment`)).status()).toBe(404);
  expect((await apiCall(outsider.context, "POST", `/claims/${claim.id}/checkout`, { data: {} })).status()).toBe(404);

  // Before payment, the chat is locked even for the participants (UI + API).
  await finder.page.goto(`/inbox/${claim.conversationId}`);
  await expect(finder.page.getByRole("heading", { name: "Chat is locked" })).toBeVisible();
  await expect(finder.page.getByText("My college library card")).toBeVisible();
  expect((await apiCall(finder.context, "POST", `/conversations/${claim.conversationId}/messages`, { data: { body: "hi" } })).status()).toBe(402);

  // Finder accepts; owner gets the checkout.
  await finder.page.goto(`/items/${item.id}`);
  await finder.page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(finder.page.getByText(/Waiting for the owner to pay the ₹100 connection fee/)).toBeVisible();

  await owner.page.reload();
  const checkout = owner.page.getByRole("heading", { name: "Connect with the finder" }).locator("..");
  await expect(owner.page.getByText("Your match has been accepted.")).toBeVisible();
  await expect(owner.page.getByText("₹100 platform connection fee").first()).toBeVisible();
  await expect(owner.page.getByText("₹300 finder reward")).toBeVisible();
  await expect(checkout).toContainText("The platform does not collect or guarantee the reward.");
  await owner.page.getByRole("button", { name: "Pay ₹100 and connect" }).click();
  const dialog = owner.page.getByRole("dialog", { name: "Test payment (no real money)" });
  await expect(dialog).toContainText("₹100");
  await dialog.getByRole("button", { name: "Simulate successful payment" }).click();
  await expect(owner.page).toHaveURL(new RegExp(`/inbox/${claim.conversationId}$`));
  await expect(owner.page.getByText("₹300, payable directly by the owner at handover.")).toBeVisible();

  // Chat works; phone stays hidden until the finder consents.
  await owner.page.getByLabel("Write a message…").fill("Thank you! Can we meet at FC Road at 6?");
  await owner.page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(owner.page.getByText("Thank you! Can we meet at FC Road at 6?")).toBeVisible();
  await expect(owner.page.getByText(/phone:/)).toHaveCount(0);
  await finder.page.goto(`/inbox/${claim.conversationId}`);
  await finder.page.getByLabel("Share my phone number in this conversation").check();
  await owner.page.reload();
  await expect(owner.page.getByText("+919876543210")).toBeVisible();

  // Return (owner) and reward receipt (finder) are separate actions.
  await expect(owner.page.getByTestId("return-status")).toHaveText("Return being arranged");
  await owner.page.getByRole("button", { name: "I received my item" }).click();
  await owner.page.getByRole("alertdialog", { name: "Have you received your item?" }).getByRole("button", { name: "Yes, I received it" }).click();
  await expect(owner.page.getByText(/Item returned on/)).toBeVisible();
  await expect(owner.page.getByText("Awaiting finder confirmation")).toBeVisible();
  await finder.page.reload();
  await finder.page.getByRole("button", { name: "I received the reward" }).click();
  await expect(finder.page.getByText("Finder confirmed receipt")).toBeVisible();
  const anon = await browser.newContext();
  expect((await (await anon.request.get(`/api/items/${item.id}`)).json()).item.status).toBe("returned");

  for (const c of [finder.context, owner.context, outsider.context, anon]) await c.close();
});

test("Path A (lost item): finder responds, owner accepts with ₹500 reward, pays, reports issue path works", async ({ browser }) => {
  const owner = await newUser(browser, persona("lost-owner"));
  // Owner publishes through the form: reward panel + required acknowledgement.
  await owner.page.goto("/report?type=lost");
  await owner.page.getByLabel("What is it?").fill(`Grey Samsung phone ${RUN}`);
  await owner.page.getByLabel("Category", { exact: true }).selectOption("phone");
  await typeIncidentLocation(owner.page, "Shivajinagar");
  await owner.page.getByLabel("Ownership question (optional)").fill("What colour is the case?");
  await owner.page.getByRole("button", { name: "Publish listing" }).click();
  await expect(owner.page.getByText("Please agree to the reward and connection fee to publish.")).toBeVisible();
  await owner.page.getByLabel(/I agree to pay the ₹500 category reward directly to the finder/).check();
  await owner.page.getByRole("button", { name: "Publish listing" }).click();
  await expect(owner.page).toHaveURL(/\/items\/\d+$/);
  const itemId = Number(owner.page.url().split("/").pop());
  await expect(owner.page.getByText("Finder reward ₹500")).toHaveCount(0); // detail page uses the panel, cards use the tag
  await expect(owner.page.getByRole("region", { name: "Finder reward & connection fee" })).toContainText("₹500");

  const finder = await newUser(browser, persona("lost-finder"));
  await finder.page.goto(`/items/${itemId}`);
  await finder.page.getByLabel("Your answer (only the poster sees it)").fill("Blue case with a cricket sticker");
  await finder.page.getByRole("button", { name: "I found this item" }).click();
  await expect(finder.page.getByText("Your claim is waiting for the poster's decision.")).toBeVisible();

  // Owner accepts the finder and agrees to the recorded reward, then pays.
  await owner.page.reload();
  await owner.page.getByRole("button", { name: "Accept", exact: true }).click();
  const acceptReward = owner.page.getByRole("button", { name: /Accept match and agree to pay the ₹500 reward/ });
  await expect(acceptReward).toBeDisabled();
  await owner.page.getByLabel(/I agree to pay the ₹500 finder reward directly to this finder/).check();
  await acceptReward.click();
  await owner.page.getByRole("button", { name: "Pay ₹100 and connect" }).click();
  await owner.page.getByRole("dialog").getByRole("button", { name: "Simulate failed payment" }).click();
  await expect(owner.page.getByText(/The payment didn't go through/)).toBeVisible();
  await owner.page.getByRole("button", { name: "Pay ₹100 and connect" }).click();
  await owner.page.getByRole("dialog").getByRole("button", { name: "Simulate successful payment" }).click();
  await expect(owner.page).toHaveURL(/\/inbox\/\d+$/);
  await expect(owner.page.getByText("₹500, payable directly by the owner at handover.")).toBeVisible();

  // Finder reports an issue; the return is still recorded independently.
  await owner.page.getByRole("button", { name: "I received my item" }).click();
  await owner.page.getByRole("alertdialog").getByRole("button", { name: "Yes, I received it" }).click();
  await expect(owner.page.getByText(/Item returned on/)).toBeVisible();
  const convUrl = owner.page.url();
  await finder.page.goto(convUrl.replace(/^https?:\/\/[^/]+/, ""));
  await finder.page.getByRole("button", { name: "Reward payment issue" }).click();
  await finder.page.getByLabel("What went wrong? (sent to support)").fill(`Owner left without paying the reward ${RUN}`);
  await finder.page.getByRole("alertdialog").getByRole("button", { name: "Report issue" }).click();
  await expect(finder.page.getByText("Finder reported a payment issue")).toBeVisible();
  await expect(finder.page.getByText(/Item returned on/)).toBeVisible();

  // Moderator sees it in the support queue.
  const mod = await newUser(browser, persona("support-mod", "moderator"));
  await mod.page.goto("/moderation");
  await expect(mod.page.getByText(`Owner left without paying the reward ${RUN}`)).toBeVisible();
  for (const c of [owner.context, finder.context, mod.context]) await c.close();
});

// ---------------------------------------------------------------------------
// 5. Uploads: valid, invalid format, too large, consistency after failure
// ---------------------------------------------------------------------------
test("upload validation gives clear feedback and leaves no partial data", async ({ browser }) => {
  const { context, page } = await newUser(browser, persona("uploader"));
  const before = (await (await context.request.get("/api/me/items")).json()).items.length;

  await page.goto("/report");
  await page.getByLabel("What is it?").fill(`Fake image test ${RUN}`);
  await page.getByLabel("Category", { exact: true }).selectOption("other");
  await typeIncidentLocation(page, "Aundh");
  await page.getByLabel(/I agree to pay the ₹350 category reward/).check();

  // Too large: rejected in the browser before upload.
  await page.getByTestId("photo-input").setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(9 * 1024 * 1024, 1) });
  await expect(page.getByText("huge.png is larger than 8 MB.")).toBeVisible();
  // Wrong type by extension/MIME: rejected in the browser.
  await page.getByTestId("photo-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.getByText("notes.txt is not a JPEG, PNG or WebP image.")).toBeVisible();
  // Disguised file (HTML named .png): passes the browser check, rejected by the server.
  await page.getByTestId("photo-input").setInputFiles({ name: "evil.png", mimeType: "image/png", buffer: Buffer.from("<script>alert(1)</script>") });
  await page.getByRole("button", { name: "Publish listing" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /not a valid JPEG, PNG or WebP/ }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/report/);
  expect((await (await context.request.get("/api/me/items")).json()).items.length).toBe(before);

  // Server-side size limit enforced even if the browser check is bypassed.
  const big = await apiCall(context, "POST", "/items", {
    multipart: { type: "lost", title: "Big", category: "other", location: "Pune", date: new Date().toISOString().slice(0, 10), images: { name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(9 * 1024 * 1024, 1) } },
  });
  expect(big.status()).toBe(413);
  expect((await (await context.request.get("/api/me/items")).json()).items.length).toBe(before);

  // Replace with a valid photo: succeeds.
  await page.getByRole("button", { name: "Remove photo 1" }).click();
  await page.getByTestId("photo-input").setInputFiles({ name: "ok.png", mimeType: "image/png", buffer: await pngFixture(await context.newPage()) });
  await page.getByRole("button", { name: "Publish listing" }).click();
  await expect(page).toHaveURL(/\/items\/\d+$/);
  expect((await (await context.request.get("/api/me/items")).json()).items.length).toBe(before + 1);
  await context.close();
});

// ---------------------------------------------------------------------------
// 6. Report -> moderator removes -> public search, link and image reflect it
// ---------------------------------------------------------------------------
test("a reported listing removed by a moderator disappears publicly with its image", async ({ browser }) => {
  const poster = await newUser(browser, persona("spammer"));
  const png = await pngFixture(poster.page);
  const res = await apiCall(poster.context, "POST", "/items", {
    multipart: { type: "found", title: `Cheap watches for sale ${RUN}`, category: "other", location: "MG Road", date: new Date().toISOString().slice(0, 10), images: { name: "a.png", mimeType: "image/png", buffer: png } },
  });
  const item = (await res.json()).item;

  const flagger = await newUser(browser, persona("flagger"));
  await flagger.page.goto(`/items/${item.id}`);
  await flagger.page.getByRole("button", { name: "Report listing" }).click();
  await flagger.page.getByLabel("Reason").selectOption("spam");
  await flagger.page.getByLabel("Details (optional)").fill("This is an advert");
  await flagger.page.getByRole("button", { name: "Send report" }).click();
  await expect(flagger.page.getByText("Thanks. A moderator will review it.")).toBeVisible();

  const mod = await newUser(browser, persona("moderator", "moderator"));
  await mod.page.goto("/moderation");
  const entry = mod.page.getByRole("article", { name: `Cheap watches for sale ${RUN}` });
  await expect(entry.getByText("This is an advert")).toBeVisible();
  await entry.getByLabel("Reason for decision (recorded in the audit log)").fill("Commercial spam");
  await entry.getByRole("button", { name: "Remove listing" }).click();
  await expect(mod.page.getByText(`remove listing #${item.id} — Commercial spam`)).toBeVisible();

  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(`/items/${item.id}`);
  await expect(anonPage.getByRole("heading", { name: "Listing removed" })).toBeVisible();
  expect((await anon.request.get(`/api/items/${item.id}`)).status()).toBe(410);
  expect((await anon.request.get(item.images[0].url)).status()).toBe(404);
  await anonPage.goto(`/items?q=${encodeURIComponent(`Cheap watches for sale ${RUN}`)}`);
  await expect(anonPage.getByText("No listings match")).toBeVisible();

  // Owner still sees it with a notice and gets notified.
  await poster.page.goto(`/items/${item.id}`);
  await expect(poster.page.getByText("A moderator removed this listing")).toBeVisible();
  await poster.page.goto("/notifications");
  await expect(poster.page.getByText(/A moderator removed/)).toBeVisible();
  for (const c of [poster.context, flagger.context, mod.context, anon]) await c.close();
});

// ---------------------------------------------------------------------------
// 9. Concurrency, dedupe and alternate locale
// ---------------------------------------------------------------------------
test("double-submitted claims and messages stay consistent; Hindi locale formats dates", async ({ browser }) => {
  const reporter = await newUser(browser, persona("dup-reporter"));
  const item = await createListing(reporter.context, { type: "found", title: `Black umbrella ${RUN}`, category: "other", date: "2026-03-05" });
  const a = await newUser(browser, persona("dup-a"));
  const b = await newUser(browser, persona("dup-b"));
  const body = { answer: "Wooden handle", acceptReward: true, expectedRewardPaise: 35000 };

  const [c1, c2] = await Promise.all([
    apiCall(a.context, "POST", `/items/${item.id}/claims`, { data: body }),
    apiCall(a.context, "POST", `/items/${item.id}/claims`, { data: body }),
  ]);
  expect([c1.status(), c2.status()].sort()).toEqual([200, 201]);
  const claimA = (await c1.json()).claim;
  const claimB = await claimFoundApi(b.context, item, "other", "Hook handle");
  const accepts = await Promise.all([apiCall(reporter.context, "POST", `/claims/${claimA.id}/accept`, { data: {} }), apiCall(reporter.context, "POST", `/claims/${claimB.id}/accept`, { data: {} })]);
  expect(accepts.map((r) => r.status()).sort()).toEqual([200, 409]);
  const winner = accepts[0].status() === 200 ? { ctx: a.context, claim: claimA } : { ctx: b.context, claim: claimB };

  // Repeated checkout clicks share one order; paying twice is refused.
  const orders = await Promise.all([1, 2, 3].map(() => apiCall(winner.ctx, "POST", `/claims/${winner.claim.id}/checkout`, { data: {} }).then((r) => r.json())));
  expect(new Set(orders.map((o) => o.checkout.orderId)).size).toBe(1);
  await payApi(winner.ctx, winner.claim.id);
  expect((await apiCall(winner.ctx, "POST", `/claims/${winner.claim.id}/checkout`, { data: {} })).status()).toBe(409);

  const clientId = crypto.randomUUID();
  await Promise.all([1, 2, 3].map(() => apiCall(winner.ctx, "POST", `/conversations/${winner.claim.conversationId}/messages`, { data: { body: "Same message", clientId } })));
  const view = await (await reporter.context.request.get(`/api/conversations/${winner.claim.conversationId}`)).json();
  expect(view.conversation.messages.filter((m: { body: string }) => m.body === "Same message")).toHaveLength(1);
  const notes = await (await reporter.context.request.get("/api/notifications")).json();
  expect(notes.notifications.filter((n: { type: string; data: { conversationId?: number } }) => n.type === "message" && n.data.conversationId === winner.claim.conversationId)).toHaveLength(1);

  // Hindi
  const page = reporter.page;
  await page.goto(`/items/${item.id}`);
  await openMenuIfCollapsed(page);
  await page.getByLabel("Language").filter({ visible: true }).first().selectOption("hi");
  await expect(page.locator("html")).toHaveAttribute("lang", "hi");
  await expect(page.getByText("मिलने की तारीख़")).toBeVisible();
  await expect(page.getByText("5 मार्च 2026")).toBeVisible();
  await page.goto("/items?type=found");
  await expect(page.getByRole("heading", { level: 1, name: "मिली चीज़ें" })).toBeVisible();
  const hindiMenu = page.getByRole("button", { name: "मेनू" });
  if ((await hindiMenu.isVisible()) && (await hindiMenu.getAttribute("aria-expanded")) === "false") await hindiMenu.click();
  await page.getByLabel("भाषा").filter({ visible: true }).first().selectOption("en");
  for (const c of [reporter.context, a.context, b.context]) await c.close();
});
