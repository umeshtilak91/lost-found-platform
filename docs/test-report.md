# Test report

Run date: 2026-11-24, on macOS (Apple Silicon), Docker Desktop, Node 22,
PostgreSQL 16. These are results from this machine, after the restructure.
Each row says whether providers were mocked or real.

## Summary

| Suite | Type | Providers | Result |
|---|---|---|---|
| Backend syntax check | static | — | **PASS** (49 files) |
| Frontend ESLint + `tsc --noEmit` | static | — | **PASS** (0 problems) |
| Frontend production build | build | — | **PASS** |
| `check:bundle`: browser assets vs server secrets | security | — | **PASS** (26 files; 11 variable names, 5 credential shapes, 11 local secret values checked) |
| Backend unit (`config.test.js`) | unit | none | **PASS** 8/8 |
| Backend integration (8 files) | integration, real PostgreSQL | **mocked** payments, places, email | **PASS** 128/128 |
| Playwright `e2e/` (desktop + Pixel 7) | browser E2E, real containers | **mocked**: fixture places, test payment provider; email over real SMTP to Mailpit | **PASS** 129/129 |
| Razorpay Test Mode suite `e2e-razorpay/` | **real sandbox** | **real Razorpay Test Mode**, test card, no real money | **PASS** 8/8 |
| Google Places live check | **real provider** | Places API (New) + Geocoding | **PASS** 3/3 (autocomplete, details, reverse geocode) |
| gitleaks (180 commits + uncommitted changes) | secret scan | — | **PASS** (no leaks; 1 allow-listed test UUID) |
| `server-only` boundary probe | build | — | **PASS** (the build fails when a client component imports `@/config/server`; the probe was removed afterwards) |
| Bundle checker negative probe | security | — | **PASS** (a planted dummy key and a variable name were both detected; exit 1) |
| Resend real delivery | real provider | — | **BLOCKED**: no verified sending domain, so delivery only reaches the Resend account owner. Not re-run here; verified earlier for that address only. |
| Google / Apple OAuth end to end | real provider | — | **BLOCKED**: third-party consent. Google: redirect to the Google sign-in page verified. Apple: no credentials. |

Fix found along the way: the Razorpay suite still used the old "Where?" field
label, which was renamed when location confirmation was added. It was updated
to the current label and confirmation, then passed 8/8.

Baseline before the restructure:
- Backend: 128/128.
- Lint and typecheck: clean.
- The first post-change browser run had 13 failures. The cause was the isolated stack inheriting `ALLOWED_ORIGINS` from the developer `.env` (CSRF "Request origin is not allowed"). Fixed in `docker-compose.e2e.yml`; the next run was 129/129.

## Two-user journey (User A owner, User B finder)

Covered by `frontend/e2e/returns.spec.ts` (mocked payment) and
`frontend/e2e-razorpay/razorpay.spec.ts` (real Razorpay Test Mode). Each user
has a separate browser context.

| Step | Evidence | Result |
|---|---|---|
| 1. Both sign in | test-login fixture; real OTP flow via Mailpit in `otp.spec.ts` | PASS |
| 2. A reports a lost item | returns A, journeys | PASS |
| 3. B reports or finds the found item | returns C/D | PASS |
| 4. Search finds the listing | journeys, locations (distance) | PASS |
| 5. Claim + ownership answer, poster accepts | returns A/C | PASS |
| 6. Contact stays locked before payment (402) | payments.test, razorpay suite | PASS |
| 7. ₹100 payment in Razorpay **Test Mode** | razorpay suite | **PASS** (real Test Mode) |
| 8. Server validates the payment; access correct | signature, amount and currency checks; tamper tests | PASS (mocked and real Test Mode) |
| 9. Reward not in checkout | `pricing.spec.ts` "server rejects tampered amounts", payments.test | PASS |
| 10. Handover and receipt confirmation | returns A/B/C | PASS |
| 11. Item leaves active listings | returns A | PASS |
| 12. Both users see history | returns A (`/me/returns`, account page) | PASS |

## Real sandbox: Razorpay Test Mode

The `e2e-razorpay` suite passed 8/8 in 3.6 minutes, using Test Mode keys
(`rzp_test_…`) and the official test card. Every order was **₹100 (10000 paise)
INR**; the category reward never appeared in an order.

| Scenario | Razorpay IDs |
|---|---|
| Lost item (Other, ₹350 reward shown, not charged): pay ₹100, chat unlocks | `order_U42uT4wtGw6sqV` / `pay_U42uayGiNFLxAU` |
| Found item (Phone): claim, accept, pay ₹100, phone sharing needs consent | `order_U42uycwe92Y9v6` / `pay_U42v4UY1BuB35O` |
| Failed and cancelled payments keep chat locked; retry succeeds | `order_U42vQUAwEpvwoP`, `order_U42vl5wuNFsveE` / `pay_U42vqX32bL8Akn` |
| Browser closed after payment, recovered by reconciliation | `order_U42wHEjDaNYdCN` / `pay_U42wMTbeQuAvef` |
| Concurrent checkout, invalid signature, tampered amount/match, payment reuse, outsider access rejected | `order_U42wVUuPNeUTNZ` / `pay_U42wbqXw8qingN` |
| Duplicate and out-of-order webhooks are idempotent | `order_U42wxbfH9AGrcJ` / `pay_U42x2Y0V09OBUq` |
| Refund approved by a moderator; Razorpay refunds ₹100; chat locks | `order_U42xCSPmqF6iM2` / `pay_U42xHe4rvBiqnw` / `rfnd_U42xdCMpmc22mA` |
| Two-user return: ₹100 payment → finder handover → owner confirms receipt → reward confirmed | `order_U42xm52AfffzGC` / `pay_U42xrm3Njlak8w` |

Webhooks from Razorpay can't reach localhost. The webhook test posts
correctly signed events built from the real Test Mode payment; the API
verifies the signature and cross-checks the payment with the Razorpay API.

## Positive and negative cases

| Case | Where | Result |
|---|---|---|
| Valid configuration loads; malformed or missing config reported by name, values not echoed | `config.test.js` | PASS |
| Live Razorpay key refused outside production; fake providers refused in production | `config.test.js` | PASS |
| OTP: valid, wrong, expired, reused, resend cooldown, delivery failure, unsafe `next` | `auth-account.test.js`, `otp.spec.ts` | PASS |
| Another user's resources (403/404), outsider access to chats | `security.test.js`, `journeys.test.js`, returns negatives | PASS |
| Invalid report data, contact details in public fields | `journeys.*`, `security.test.js` | PASS |
| Location permission denied, provider unavailable, offline, empty results | `locations.spec.ts` | PASS |
| Cancelled or failed payment, tampered amount, invalid signature, duplicate webhook | `payments.test.js`, razorpay suite | PASS (mocked and real Test Mode) |
| Repeated return confirmation, invalid transitions (`/status returned` → 409) | `returns.test.js` | PASS |
| Return status persists across fresh page loads (both users re-open the listing, inbox and notifications) | `returns.spec.ts` | PASS |
| Light/dark theme persists; mobile navigation; narrow viewport without overflow; axe | `platform.spec.ts` | PASS |
| Warm Charcoal rendering, missing background image | — | **N/A**: the theme is not in the codebase (reverted on request) |

## Artifacts (not committed)

- Playwright failure artifacts and location screenshots: `frontend/test-results/` (git-ignored).
- Razorpay evidence (order, payment and refund IDs only) and checkout screenshots: `$E2E_EVIDENCE_DIR` (this run: a scratch directory outside the repository).
- No screenshots are committed, because they can contain personal data.
