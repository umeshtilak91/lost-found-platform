import { defineConfig, devices } from "@playwright/test";

// Live Razorpay TEST MODE suite (real orders, real test payments, real refunds).
// Requires the stack to run with PAYMENT_PROVIDER=razorpay and rzp_test_ keys.
// Run: npx playwright test -c playwright.razorpay.config.ts
export default defineConfig({
  testDir: "./e2e-razorpay",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
