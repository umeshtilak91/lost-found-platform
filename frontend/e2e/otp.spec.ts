import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, openMenuIfCollapsed, RUN, test } from "./fixtures";

// Email one-time-code sign-in through the real UI. The e2e stack sends via
// SMTP to an isolated Mailpit inbox (never Resend); codes are read from
// Mailpit's API. Nothing here can run outside the test compose project.
const MAILPIT = process.env.E2E_MAILPIT_URL || "http://localhost:8026";
const ROOT = path.resolve(__dirname, "..", "..");

async function latestCode(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const search = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    const id = search.messages?.[0]?.ID;
    if (id) {
      const msg = await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json();
      const match = String(msg.Text).match(/\b(\d{6})\b/);
      if (match) return match[1];
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no code email for ${email}`);
}

async function mailCount(email: string): Promise<number> {
  const search = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
  return search.messages_count ?? search.messages?.length ?? 0;
}

function sql(query: string) {
  return execFileSync("docker", ["compose", "-p", "lftest", "exec", "-T", "db", "psql", "-U", "postgres", "-d", "lost_found_db", "-tA", "-c", query], { cwd: ROOT }).toString().trim();
}

const unique = (label: string) => `${label}-${RUN}-${Math.random().toString(36).slice(2, 7)}@otp.test`;

test("email code sign-in: recipient shown, paste works, redirects to a safe destination, protected action, logout @responsive", async ({ page }) => {
  const email = unique("ok");
  await page.goto("/login?next=/report");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByTestId("otp-recipient")).toHaveText(email);
  await expect(page.getByText(/Code expires in 4:5\d|Code expires in 5:00/)).toBeVisible();
  await expect(page.getByText(/Resend in \d+s/)).toBeVisible();
  await expect(page.getByLabel("6-digit code")).toBeFocused();
  await expect(page.getByLabel("6-digit code")).toHaveAttribute("autocomplete", "one-time-code");
  await expect(page.getByLabel("6-digit code")).toHaveAttribute("inputmode", "numeric");

  // Paste with a space (as copied from many mail apps): digits are kept and it auto-submits.
  const code = await latestCode(email);
  await page.getByLabel("6-digit code").focus();
  await page.evaluate((text) => {
    const input = document.activeElement as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, `${code.slice(0, 3)} ${code.slice(3)}`);
  await expect(page).toHaveURL(/\/report$/);
  await expect(page.getByRole("status").filter({ hasText: "You're signed in." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Report an item" })).toBeVisible();
  await expect(page.getByLabel("What is it?")).toBeVisible(); // protected form rendered

  // Session persists across reload; logout ends it.
  await page.reload();
  await expect(page.getByLabel("What is it?")).toBeVisible();
  await openMenuIfCollapsed(page);
  await page.getByRole("button", { name: "Sign out" }).filter({ visible: true }).first().click();
  await expect(page).toHaveURL("/");
  await page.goto("/report");
  await expect(page.getByText("Sign in to post a listing.")).toBeVisible();
});

test("wrong code shows attempts left; expired code offers resend; change email returns to entry", async ({ page }) => {
  const email = unique("wrong");
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  const code = await latestCode(email);
  const wrong = code === "000000" ? "111111" : "000000";
  await page.getByLabel("6-digit code").pressSequentially(wrong);
  await expect(page.getByRole("alert").filter({ hasText: "That code is incorrect. 4 attempts left." })).toBeVisible();
  await expect(page.getByLabel("6-digit code")).toHaveValue("");

  sql(`UPDATE otp_codes SET expires_at = now() - interval '1 second' WHERE email = '${email}'`);
  await page.getByLabel("6-digit code").pressSequentially(code);
  await expect(page.getByRole("alert").filter({ hasText: "This code has expired. Request a new code." })).toBeVisible();

  await page.getByRole("button", { name: "Use a different email" }).click();
  await expect(page.getByLabel("Email address")).toBeVisible();
});

test("resend countdown, resend supersedes the old code, and cooldown is enforced server-side", async ({ page, request }) => {
  const email = unique("resend");
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  const first = await latestCode(email);
  await expect(page.getByText(/Resend in \d+s/)).toBeVisible();
  // Direct API spam is refused during the cooldown.
  const csrf = (await (await request.get("/api/auth/me")).json()).csrfToken;
  const spam = await request.post("/api/auth/email/request", { headers: { "X-CSRF-Token": csrf }, data: { email } });
  expect(spam.status()).toBe(429);
  expect((await spam.json()).error.code).toBe("otp_cooldown");
  expect(await mailCount(email)).toBe(1);

  // Fast-forward the cooldown, then resend from the UI.
  sql(`UPDATE otp_codes SET created_at = created_at - interval '2 minutes' WHERE email = '${email}'`);
  await page.reload();
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect.poll(() => mailCount(email)).toBe(2);
  const second = await latestCode(email);
  expect(second).not.toBe("");
  if (first !== second) {
    await page.getByLabel("6-digit code").pressSequentially(first);
    await expect(page.getByRole("alert").filter({ hasText: /newer code was sent|no longer valid|incorrect/ })).toBeVisible();
  }
  await page.getByLabel("6-digit code").pressSequentially(second);
  await expect(page).toHaveURL("/");
});

test("delivery-service failure and unsafe next parameter are handled", async ({ page }) => {
  // Provider rejection surfaced by the API (fixture: intercepted response).
  await page.route("**/api/auth/email/request", (route) =>
    route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: { code: "email_delivery_failed", message: "x" } }) })
  );
  await page.goto("/login");
  await page.getByLabel("Email address").fill(unique("fail"));
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "We couldn't send the email right now" })).toBeVisible();
  await expect(page.getByLabel("Email address")).toBeVisible();
  await page.unroute("**/api/auth/email/request");

  // Unsafe next: after a real sign-in we land on "/" not on an external site.
  const email = unique("next");
  await page.goto("/login?next=//evil.example");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("6-digit code").pressSequentially(await latestCode(email));
  await expect(page).toHaveURL("http://localhost:3100/");
});

test("keyboard-only email sign-in", async ({ page }) => {
  const email = unique("kb");
  await page.goto("/login");
  await page.getByLabel("Email address").focus();
  await page.keyboard.type(email);
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("6-digit code")).toBeFocused();
  await page.keyboard.type(await latestCode(email));
  await expect(page).toHaveURL("/");
});
