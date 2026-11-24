"use strict";

// Unit tests for configuration and business-rule validation. No database.
// Secret-looking values below are dummies created for these tests.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../src/config");
const { validatePricing, CONNECTION_FEE_PAISE, CATEGORY_REWARD_PAISE, snapshotFor } = require("../src/config/pricing");

const SECRET = "x".repeat(40);
const base = () => ({ NODE_ENV: "development", SESSION_SECRET: SECRET, DB_PASSWORD: "dummy" });

function problemsOf(env) {
  try {
    loadConfig(env);
  } catch (error) {
    return error;
  }
  assert.fail("expected loadConfig to throw");
}

describe("configuration", () => {
  test("a minimal valid environment loads with safe defaults", () => {
    const config = loadConfig(base());
    assert.equal(config.port, 5000);
    assert.equal(config.payments.provider, "test");
    assert.equal(config.places.provider, "none");
    assert.equal(config.appUrl, "http://localhost:3000");
    assert.ok(Object.isFrozen(config));
  });

  test("every problem is reported at once, naming variables but never their values", () => {
    const dummySecret = "dummy-razorpay-secret-value-0001";
    const error = problemsOf({
      NODE_ENV: "development",
      PORT: "not-a-port",
      PAYMENT_PROVIDER: "razorpay",
      RAZORPAY_KEY_SECRET: dummySecret,
      STORAGE_DRIVER: "ftp",
    });
    assert.equal(error.code, "invalid_config");
    assert.ok(error.problems.length >= 4, error.message);
    for (const name of ["SESSION_SECRET", "PORT", "RAZORPAY_WEBHOOK_SECRET", "STORAGE_DRIVER"]) {
      assert.match(error.message, new RegExp(name));
    }
    assert.ok(!error.message.includes(dummySecret), "secret value leaked into the error");
    assert.ok(!error.message.includes("not-a-port"), "raw value echoed into the error");
  });

  test("malformed numbers and URLs are rejected instead of silently defaulted", () => {
    assert.match(problemsOf({ ...base(), DB_PORT: "99999" }).message, /DB_PORT/);
    assert.match(problemsOf({ ...base(), OTP_TTL_MINUTES: "5m" }).message, /OTP_TTL_MINUTES/);
    assert.match(problemsOf({ ...base(), APP_URL: "localhost:3000" }).message, /APP_URL/);
  });

  test("Razorpay key IDs must be well-formed, and live keys are refused outside production", () => {
    const rzp = { ...base(), PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_SECRET: "dummy", RAZORPAY_WEBHOOK_SECRET: "dummy" };
    assert.match(problemsOf({ ...rzp, RAZORPAY_KEY_ID: "pk_test_123" }).message, /RAZORPAY_KEY_ID must look like/);
    assert.match(problemsOf({ ...rzp, RAZORPAY_KEY_ID: "rzp_live_Abc123" }).message, /live key/);
    assert.equal(loadConfig({ ...rzp, RAZORPAY_KEY_ID: "rzp_test_Abc123" }).payments.provider, "razorpay");
  });

  test("production refuses the fake payment and place providers", () => {
    const prod = { ...base(), NODE_ENV: "production" };
    assert.match(problemsOf(prod).message, /PAYMENT_PROVIDER=test is not allowed in production/);
    assert.match(problemsOf({ ...prod, ALLOW_TEST_PAYMENTS: "true", PLACES_PROVIDER: "fixture" }).message, /PLACES_PROVIDER=fixture/);
    assert.match(problemsOf({ ...base(), PLACES_PROVIDER: "google" }).message, /GOOGLE_MAPS_API_KEY is required/);
  });
});

describe("pricing (business configuration)", () => {
  test("the shipped table is valid and the platform fee is ₹100", () => {
    assert.equal(validatePricing(), true);
    assert.equal(CONNECTION_FEE_PAISE, 10000);
  });

  test("invalid amounts are rejected before they could reach checkout", () => {
    assert.throws(() => validatePricing(0, CATEGORY_REWARD_PAISE), /CONNECTION_FEE_PAISE/);
    assert.throws(() => validatePricing(10000, { phone: 499.5 }), /reward for "phone"/);
    assert.throws(() => validatePricing(10000, { phone: -1 }), /reward for "phone"/);
    assert.throws(() => validatePricing(10000, {}), /at least one category/);
  });

  test("an agreement snapshot keeps the fee and the reward separate", () => {
    const snap = snapshotFor("phone");
    assert.equal(snap.feePaise, CONNECTION_FEE_PAISE);
    assert.equal(snap.rewardPaise, CATEGORY_REWARD_PAISE.phone);
  });
});
