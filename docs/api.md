# HTTP API

Base path: `/api` on the web origin (the web app proxies `/api/*` to the
API; in Kubernetes the ingress routes it directly). JSON in, JSON out, except
uploads (`multipart/form-data`) and the Razorpay webhook (raw body).

Source of truth: `backend/src/routes/*.js` (validation schemas sit next to each
handler) and `backend/src/app.js` (wiring). This page lists what is
implemented; there is no OpenAPI document.

## Conventions

**Authentication.** A session cookie (`lf.sid`, HttpOnly, SameSite=Lax, Secure
over HTTPS) set by email-code, Google or Apple sign-in. "user" below means a
signed-in session is required (`401 auth_required` otherwise); "moderator"
means role `moderator` or `admin` (`403 forbidden` otherwise).

**CSRF.** Every state-changing request (POST/PATCH/PUT/DELETE, except the
webhook) must send `X-CSRF-Token` with the token returned by `GET /api/auth/me`
(and by sign-in), and must come from an allowed origin (`APP_URL` or
`ALLOWED_ORIGINS`). Otherwise `403`.

**Errors.** One shape everywhere:

```json
{ "error": { "code": "validation_failed", "message": "Some fields are invalid",
             "fields": [{ "path": "title", "message": "Title is too short" }] },
  "requestId": "9b0f…" }
```

Common codes: `validation_failed` (400), `invalid_json` (400), `auth_required`
(401), `connection_locked` (402, the ₹100 fee is not paid), `forbidden` (403),
`*_not_found` (404), state conflicts such as `match_not_accepted` or
`item_closed` (409), `contact_detected` (422, phone/email/UPI/link in a field
visible before payment), `payload_too_large` (413), rate limits (429),
`location_service_unavailable` (503, with `details.reason` and `details.retryable`).

**Pagination.** `GET /items` takes `page` (≥1) and `pageSize` (1–50, default 12)
and returns `page`, `pageSize`, `total`, `totalPages`. Other lists return a
bounded recent window.

**Idempotency.** Return-lifecycle transitions, checkout start and payment
verification are safe to repeat; repeats return `changed: false` or the
existing order instead of acting twice.

## Health

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/healthz` | — | Liveness `{ "ok": true }`. |
| GET | `/readyz` | — | 503 while the database is unreachable or migrations are pending. |
| GET | `/metrics` | — | Prometheus metrics when `METRICS_ENABLED`. Do not expose publicly. |
| GET | web `/healthz` | — | Web container liveness. |

## Auth (`/api/auth`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/auth/providers` | — | Which sign-in methods are configured. |
| GET | `/auth/me` | — | `{ loggedIn, user?, csrfToken }`. |
| POST | `/auth/email/request` | — | Body `{ "email": "a@example.com" }` → `202 { challengeId, email, expiresAt, resendAvailableAt, delivery }`. Same response whether or not an account exists. Rate limited per email and IP; resend cooldown. `503 email_unconfigured` without Resend/SMTP. |
| POST | `/auth/email/verify` | — | Body `{ "challengeId": "<uuid>", "code": "123456", "next": "/report" }` → `{ user, csrfToken, redirectTo }`. Codes are 6 digits, single use, expire after `OTP_TTL_MINUTES`, lock after `OTP_MAX_ATTEMPTS`. Rotates the session ID. |
| GET | `/auth/google`, `/auth/google/callback` | — | Google OAuth. |
| GET/POST | `/auth/apple`, `/auth/apple/callback` | — | Apple Sign in. |
| POST | `/auth/logout` | — (CSRF) | Destroys the session and clears the cookie. |
| POST | `/auth/test-login` | — | **Only when `NODE_ENV=test` and `ENABLE_TEST_AUTH=true`.** Browser tests use it. |

## Listings

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/items` | — | Search. Query: `type` (lost/found), `q`, `category`, `status` (`active` default, `open`, `claimed`, `returned`, `closed`, `all`), `from`, `to` (YYYY-MM-DD), `location` (text), `lat`, `lng`, `radiusKm` (2/5/10/25/50/100), `sort` (`newest`, `oldest`, `date`, `distance`), `page`, `pageSize`. Unknown parameters → 400. Response `{ items, page, pageSize, total, totalPages }`; distance is banded (approximate) for privacy. |
| GET | `/items/:id` | — (owner/moderator see more) | Listing detail. Never contains email, phone, exact coordinates or claim answers. |
| GET | `/stats` | — | `{ total, active, returned, selfRecovered, externalReturns, legacyReturned }`; see [returns.md](returns.md#statistics-get-apistats). |
| GET | `/pricing` | — | Fee and category rewards (`connectionFeePaise`, `categories[]`, versions). |
| GET | `/me/items` | user | Your listings. |
| POST | `/items` | user | `multipart/form-data`: `type`, `title`, `category`, `description`, `location`, `date` (not in the future), location fields (`placeId`+`sessionToken` or device `lat`/`lng`/`accuracyM`, `locationConfirmed`), `ownershipQuestion`, lost items: `acceptRewardTerms=true` + `expectedRewardPaise` (must equal the current reward), up to 5 `images`. Images are re-encoded to WebP with metadata stripped. |
| PATCH | `/items/:id` | owner | Same fields, all optional; `removeImageIds`. |
| DELETE | `/items/:id` | owner | Soft delete; images removed. |
| POST | `/items/:id/status` | owner | `{ "status": "open" \| "closed" }`. `returned` is refused (409): only the owner's receipt confirmation completes a return. |
| POST | `/items/:id/confirm-category` | owner | Re-accept reward after a category change. |
| GET | `/items/:id/matches` | owner | Suggested opposite-type listings. |
| POST | `/items/:id/reports` | user | Report abuse `{ "reason": "spam" \| "scam" \| "inappropriate" \| "personal_info" \| "duplicate" \| "other", "details"? }`. |

## Claims, matches and returns

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/items/:id/claims` | user (not the poster) | `{ answer, acceptReward?, expectedRewardPaise?, linkedItemId? }`. Answer is private to the poster; contact details are rejected (422). |
| GET | `/items/:id/claims` | user | Poster sees all claims; claimant sees their own. |
| POST | `/claims/:id/terms` | user | Accept the current reward snapshot. |
| POST | `/claims/:id/accept` \| `decline` \| `withdraw` | poster / claimant | Decide. Accepting moves both listings to "Return being arranged". |
| POST | `/claims/:id/handover` | finder | "I handed over this item" → awaiting owner confirmation. Requires the paid connection. |
| POST | `/claims/:id/return` | owner | "Yes, I received it" → RETURNED (one recovery, idempotent). |
| POST | `/claims/:id/return-issue` | owner or finder | "There is a problem" → support request; state unchanged. |
| POST | `/claims/:id/reward` | finder | After RETURNED: `{ "status": "confirmed" \| "issue" }` records whether the direct reward was received. Never moves money. |
| POST | `/claims/:id/refund-request` | owner | Ask support to refund the ₹100 fee. |
| GET | `/items/:id/lifecycle` | participant | Closure preview and history. |
| POST | `/items/:id/self-recovered` | lost-listing poster | `{ "confirm": true, "note"? }` "I found it myself". |
| POST | `/items/:id/returned-externally` | found-listing poster | `{ "confirm": true, "note"? }`. |
| POST | `/items/:id/correction-request` | recovery participant | `{ reason }` (≥10 characters). |
| GET | `/me/returns` | user | Completed returns for both participants. |

State machine and locking: [returns.md](returns.md).

## Payments (₹100 connection fee)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/payments/config` | — | `{ provider, testMode, keyId, appName, currency, appUrl }`. `keyId` is the **public** Razorpay key ID. |
| POST | `/claims/:id/checkout` | owner of an accepted match | Creates or reuses one open order. **The body is ignored**: amount is always `CONNECTION_FEE_PAISE` (10000) INR from `backend/src/config/pricing.js`. The reward is never part of the order. Returns `{ checkout: { orderId, amountPaise: 10000, currency: "INR", rewardPaise, keyId, … } }`; `rewardPaise` is shown for information only (paid directly, not charged). |
| POST | `/payments/verify` | owner | `{ orderId, paymentId, signature }`. Verifies the Razorpay checkout signature (HMAC-SHA256, constant-time compare), re-fetches the payment from Razorpay and checks amount and currency before unlocking. |
| POST | `/payments/:orderId/cancel` | owner | Marks a pending order cancelled. |
| GET | `/claims/:id/payment` | participant | Payment status; reconciles with Razorpay when nothing settled yet (closed tab, missed webhook). |
| POST | `/payments/webhook` | Razorpay | Raw body, `X-Razorpay-Signature` verified with `RAZORPAY_WEBHOOK_SECRET`; invalid signature → 400 and nothing changes. Deduplicated on `x-razorpay-event-id`; if processing fails the event ID is released so Razorpay's retry is processed. Events: `payment.captured`, `payment.authorized`, `payment.failed`, `order.paid`, `refund.processed`. A payment captured after its match was closed opens a refund request instead of unlocking. |
| POST | `/payments/test/complete` | owner | **Only with `PAYMENT_PROVIDER=test`.** Simulates success/failure for local runs. |

Details: [payments.md](payments.md).

## Conversations (unlocked by the paid connection)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/items/:id/conversations` | user | Open or reuse a conversation for a match. |
| GET | `/conversations` | user | Your inbox. |
| GET | `/conversations/:id` | participant | Messages and match state. `402 connection_locked` until the owner pays. |
| POST | `/conversations/:id/messages` | participant | `{ body }`. |
| POST | `/conversations/:id/phone-sharing` | participant | `{ "share": true \| false }`: show or hide your phone number to the other person (needs a phone on your profile; only after payment). |

## Notifications, account, media, places, analytics

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/notifications`, `/notifications/unread-count` | user | In-app notifications. |
| POST | `/notifications/read` | user | Mark read. |
| PATCH | `/account/profile` | user | Name, phone, locale. |
| GET | `/account/export` | user | Data export (JSON). |
| DELETE | `/account` | user | Body `{ "confirm": "DELETE" }`. Deletes the account and personal data ([data-retention.md](data-retention.md)). |
| GET | `/images/:id`, `/images/:id/thumb` | visibility-checked | Images are only served through the API. Legacy `/uploads/*` → 410. |
| GET | `/places/config` | — | Whether suggestions are available. |
| GET | `/places/autocomplete?input=&sessionToken=&country=` | — | ≥3 characters; 60 requests/min. |
| GET | `/places/details?placeId=&sessionToken=` | — | Label and area (coordinates stay server-side). |
| GET | `/places/reverse?lat=&lng=` | — | Area name for "Use my location". |
| POST | `/analytics/pageview` | — | Cookie-less page view (no IP stored). |
| GET | `/admin/analytics` | moderator | Visitor chart data. |

## Moderation (`moderator`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/moderation/queue?status=open\|actioned\|dismissed` | Abuse reports. |
| GET | `/moderation/actions` | Audit log. |
| GET | `/moderation/pending` | Listings held for review. |
| POST | `/moderation/items/:id/remove` \| `restore` | `{ reason }` (3–500 characters); recorded in `moderation_actions`. |
| POST | `/moderation/reports/:id/dismiss` | Dismiss a report. |
| GET | `/moderation/support` | Support requests (refunds, return issues, corrections). |
| POST | `/moderation/support/:id/resolve` | `{ action: approve_refund \| reject \| resolve \| reopen, note }`. |
