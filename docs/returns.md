# Item-return lifecycle

## States (existing columns, no new item statuses)

| Business state | items.status | Match (claims) | In active search | New claims |
|---|---|---|---|---|
| OPEN | `open` | none accepted | yes | yes |
| RETURN BEING ARRANGED | `claimed` | accepted; `handover_at` null | yes, labelled | paused (pending claims kept) |
| AWAITING OWNER CONFIRMATION | `claimed` | `handover_at` set, `return_confirmed_at` null | yes, labelled | paused |
| RETURNED | `returned` + `closure_reason=returned_matched` | `return_confirmed_at` set | no | no |
| Found by owner | `closed` + `self_recovered` | active match revoked | no | no |
| Returned outside the platform | `closed` + `returned_external` | active match revoked | no | no |
| Closed by poster | `closed` + `closed_by_reporter` | active match revoked | no | no (can reopen) |
| Legacy "returned" (no owner confirmation) | `returned` + `legacy_returned` | unchanged | no | no |

## Permitted transitions (all server-side, authorized, locked, idempotent)

| Action | Who | From | Result |
|---|---|---|---|
| Accept match | poster | open (+ linked listing open) | both listings `claimed` |
| `POST /claims/:id/handover` "I handed over this item" | match finder | accepted + connected | awaiting owner confirmation; owner notified; no-op if already returned |
| `POST /claims/:id/return` "Yes, I received it" | match owner | accepted + connected (before or after handover) | RETURNED; one recovery row; linked listing returned too; other pending claims closed with reason; finder notified |
| `POST /claims/:id/return-issue` "There is a problem" | owner or finder | not yet returned | support request (`return_issue`); state unchanged |
| `POST /items/:id/self-recovered` "I found it myself" | lost-listing poster | open / claimed | closed (`self_recovered`); match revoked + counterpart notified; payment kept; refund via support |
| `POST /items/:id/returned-externally` | found-listing poster | open / claimed | closed (`returned_external`); same match handling |
| `POST /items/:id/status` closed / open | poster | open↔closed, claimed→open/closed | `returned` is refused (409) |
| `POST /claims/:id/reward` confirmed / issue | match finder | after RETURNED only | reward status + actor + time; never changes the return |
| `POST /items/:id/correction-request` | recovery participant | RETURNED / recovery closure | support request (`return_correction`) |
| Support queue "Reopen return" | moderator/admin | open correction request | recovery marked corrected; matched → back to "being arranged"; self/external → open; claims closed by the completion stay closed (new claim required) |

Locking: every transition locks the listing rows in id order, then the claim
row. Repeats return `changed: false`. Partial unique indexes allow at most
one live recovery per match, per lost listing and per found listing.

Money stays separate from the listing:
- Closing a listing never refunds, charges or deletes a payment.
- If a ₹100 payment is captured after its match was closed, chat stays locked
  and a refund request opens automatically.
- Returned or closed listings can't start a checkout.

## Reminders

When a finder has reported handover but the owner hasn't confirmed, the owner
gets one reminder at 48 hours and another at 7 days. These go out through the
hourly housekeeping job and are deduplicated in `notifications`. Receipt is
never confirmed automatically.

## Statistics (`GET /api/stats`)

| Field | Counts | Homepage label |
|---|---|---|
| `total` | visible listings ever posted | "Active and past listings" |
| `active` | open + claimed listings | — |
| `returned` | live `recoveries` of kind `matched` (owner-confirmed); linked listings count once; corrected rows excluded | "Returned to owners" |
| `selfRecovered` | live `self_recovered` recoveries | — |
| `externalReturns` | live `external` recoveries | — |
| `legacyReturned` | listings marked returned before owner confirmations existed | — |

The number can't be inflated:
- Repeated confirmations are no-ops.
- Both linked listings share one recovery row.
- Webhook or job retries don't create recoveries.
- Corrections mark the row corrected instead of deleting it.

## Audit and history

- `return_events` is append-only and records each event with its actor, time and note. Events: handover, receipt, completion, problem, self-recovery, external return, match cancelled, correction requested/applied/rejected, reward confirmed/issue, reminder, legacy backfill.
- `GET /me/returns` gives both participants their completed returns, including the conversation link, reward status and connection-fee receipt.
- Conversations stay readable to their participants after completion.

## Migration 008

- Additive only.
- Each existing `returned` listing with an owner-confirmed accepted claim becomes one `matched` recovery.
- Other `returned` listings become `legacy` recoveries, kept as returned but counted separately.
- `closed` listings get `closed_by_reporter`.
- The migration can be re-run safely.
