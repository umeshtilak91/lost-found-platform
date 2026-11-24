# Finder rewards and the ₹100 paid connection

## Business model

| Who pays | What | To whom | How |
|---|---|---|---|
| Owner | **₹100 connection fee** (10000 paise, INR) per accepted match | Platform | Razorpay Standard Checkout (or the local test provider) |
| Owner | **Category finder reward** | Finder, directly | UPI, cash, or any method the two people agree on. The platform only **records** the agreed amount and the finder's confirmation. |

Posting listings and verifying ownership are free.

### Category rewards (pricing version `2026-11-v1`)

| Category | Finder reward | Connection fee |
|---|---|---|
| Phone | ₹500 | ₹100 |
| Electronics | ₹500 | ₹100 |
| Wallet / purse | ₹300 | ₹100 |
| Bag | ₹300 | ₹100 |
| Keys | ₹300 | ₹100 |
| Documents / ID | ₹300 | ₹100 |
| Jewellery | ₹500 | ₹100 |
| Clothing | ₹300 | ₹100 |
| Pet | ₹500 | ₹100 |
| Other | **₹350** | ₹100 |

All of these come from one table, `backend/src/config/pricing.js`:

- The amounts are stored in paise.
- The table is exposed at `GET /api/pricing`.
- Card and detail labels come from the API (`item.reward`).
- If an amount changes, bump `PRICING_VERSION`. Pending agreements made under the old version must then be accepted again; accepted agreements keep their snapshot.

## Flows

The **owner** pays and accepts the reward in both paths. The **finder** never pays.

| Path | Steps |
|---|---|
| A: lost listing | Owner publishes and acknowledges the reward → finder responds ("I found this item") with a structured answer → owner accepts the match and the current reward (snapshot) → owner pays ₹100 → chat unlocks |
| B: found listing | Finder publishes → owner claims ("This could be mine"), answers the question and accepts the reward (snapshot) → finder accepts → owner pays ₹100 → chat unlocks |

**What's visible before payment:**

- The listing, the poster's first name and last initial, and an approximate area.
- The ownership question and answer, which only the poster sees.

**Locked until payment:** messages, phone sharing and any handover details. The API returns `402 connection_locked`.

### The reward agreement snapshot

Each match stores an immutable snapshot on `claims`:

- `agreement_category`, `reward_paise`, `fee_paise` and `currency`
- `pricing_version` and `terms_version`
- `owner_accepted_at`

A database trigger rejects any change to an accepted snapshot.

**When the owner must accept again:**

- In Path B, if the listing's category or the pricing changes after the owner claimed, the finder's accept returns `409 terms_renewal_required`. The owner is notified and re-accepts with `POST /api/claims/:id/terms`.
- The category of a listing can't change while a match is in progress.

**Tampering:** the client echoes the amount it displayed (`expectedRewardPaise`). A stale or tampered amount returns `409 pricing_changed`, along with the current amount.

## Checkout and payment states

1. The owner calls `POST /api/claims/:id/checkout`.
   - **Checks:** the payer is the owner, the match is accepted, the snapshot exists, the fee isn't already paid, and the conversation isn't already unlocked.
   - The server creates (or reuses) **one** open Razorpay order of 10000 paise INR, tied to the match through `connection_payments.claim_id` and the order `notes`. Anything the client sends about the amount is ignored.
2. After checkout, the browser calls `POST /api/payments/verify`:
   - It checks the HMAC-SHA256 signature of `order_id|payment_id` with the key secret.
   - It fetches the payment from Razorpay.
   - It checks the order ID, the amount (10000) and the currency (INR).
   - **Payment status:**
     - `captured`: marked paid.
     - `authorized`: captured first, then marked paid.
     - `failed`: marked failed.
3. `POST /api/payments/webhook` receives provider events:
   - **Signature:** checked against the raw body with `RAZORPAY_WEBHOOK_SECRET`.
   - **Deduplication:** on `x-razorpay-event-id`. If processing fails, the event ID is forgotten so Razorpay's retry is processed.
   - **Events handled:** `payment.captured`, `payment.authorized`, `payment.failed`, `order.paid`, and `refund.processed`/`payment.refunded`.
4. **Recovery:** `GET /api/claims/:id/payment` reconciles with Razorpay (`GET /orders/:id/payments`) when nothing has settled yet. This covers a closed browser tab or a missed webhook. The checkout screen polls it while a payment is pending.

**Concurrency:**

- Every state change locks the payment row.
- Partial unique indexes allow one open order and one paid payment per match.
- `connection_entitlements.claim_id` is unique.
- A late "failed" event after a capture changes nothing.

**What a successful payment unlocks:** the single conversation for that owner–finder pair on that item (`conversations.unlocked_at`), plus an entitlement row. It's stored in the database, so it survives page refreshes, logging out and back in, and server restarts.

**Phone numbers:** still need the explicit, per-conversation consent of the person whose number it is. Paying never exposes one.

## Return confirmation and reward receipt

The return and the reward are separate records. Each stores who acted and when.

| Fact | Who | Endpoint | Labels |
|---|---|---|---|
| Item returned | Owner ("I have received my item") | `POST /api/claims/:id/return` | "Item returned on …" |
| Reward received | Finder | `POST /api/claims/:id/reward {status:"confirmed"}` | "Finder confirmed receipt" |
| Reward problem | Finder (with a note; opens a support request) | `POST /api/claims/:id/reward {status:"issue", note}` | "Finder reported a payment issue" |

- Until the finder acts, the reward shows **"Awaiting finder confirmation"**.
- A return can be recorded while a reward dispute is open; both facts are kept.
- External reward payments are never labelled as verified.
- The repository had no handover-code system, so none was added. Return confirmation uses the owner's explicit action.

## Refunds (proposed rules, for owner review)

1. **Request:** the owner asks from the chat (`POST /api/claims/:id/refund-request`), within 7 days of paying and before confirming they received the item.
2. **Usually approved:**
   - the finder sends no reply within 72 hours of the chat unlocking, or
   - it's clearly not the owner's item.

   The support queue shows the finder's message count to help decide.
3. **Not available** after the return is confirmed, or for reward disputes (those go through the reward-issue path).
4. **Approval:** a moderator approves the request in **Moderation → Support requests**. That calls the Razorpay refund API, sets the payment to `refunded` (confirmed by `refund.processed`), **revokes the entitlement** and re-locks the conversation (`locked_reason = refunded`). Earlier messages are kept but hidden.
5. **Reconnecting:** the owner may pay again, and the entitlement is reinstated once.

## Existing data (migration `005`)

- **Existing conversations are grandfathered:** `unlock_source = 'grandfathered'`, and they stay free. Only conversations created after the migration start locked.
- **Existing claims** get explicit `owner_id`/`finder_id`. No one is marked as having accepted reward terms; they accept when entering a new paid flow.
- **Existing listings with category `other`** may be leftovers from the prototype's default. They're marked `category_confirmed = false`, and the poster must confirm the category (and, for lost items, accept the reward) before new matches can start.
- **Payment records** keep their claim link nulled if a match or account is deleted, for accounting.

## Setup

| Variable | Purpose |
|---|---|
| `PAYMENT_PROVIDER` | `test` (local default) or `razorpay` |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | From the Razorpay Dashboard (test mode first: `rzp_test_…`) |
| `RAZORPAY_WEBHOOK_SECRET` | Set when creating the webhook |
| `ALLOW_TEST_PAYMENTS` | Must be `true` to run the test provider with `NODE_ENV=production`. Compose sets it locally; Helm never does. |

**Razorpay Dashboard:**

1. Turn on **auto-capture** under Payment Capture settings.
2. Add a webhook to `https://<host>/api/payments/webhook` with the events `payment.captured`, `payment.authorized`, `payment.failed`, `order.paid` and `refund.processed`.

## Ways contact details can still be shared before payment

The contact-detail filter blocks phone numbers, emails, UPI IDs, links and "WhatsApp/call me" wording in listing text and claim answers. A listing that trips the filter by mistake can be sent for moderator review (`moderation_state = pending`). These gaps remain:

- **Photos:** a number written in a photo isn't detected, because there's no text recognition.
- **Disguised numbers:** numbers written as words ("nine eight seven…") or with unusual separators can slip through.
- **Exact meeting places:** a listing can say "I'll be at gate 3 every morning" without any contact detail.
- **Searching by name:** the reporter's first name and last initial are public, so someone might find them on social media.
- **Old and refunded chats:** grandfathered conversations stay free, and messages exchanged before a refund (which may include contact details) can't be taken back.

Listing reports and moderation are the backstop for these.
