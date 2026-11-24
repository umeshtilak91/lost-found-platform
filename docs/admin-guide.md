# Admin and moderation guide

## Roles and permissions

| Role | Can |
|---|---|
| `user` (default) | Everything in the [user guide](user-guide.md) for their own listings and matches. |
| `moderator` | Plus `/moderation` (reports, held listings, support queue, audit log) and `/admin` (visitor analytics). |
| `admin` | Same permissions as `moderator` today; the role exists so that admin-only actions can be added later. |

Grant or revoke a role (the person must have signed in once):

```bash
docker compose exec backend node scripts/set-role.js someone@example.com moderator
docker compose exec backend node scripts/set-role.js someone@example.com user
```

In Kubernetes run the same script with `kubectl exec` in an API pod. Role
changes take effect on the person's next request.

## Moderation queue (`/moderation`)

| Task | How | Recorded in |
|---|---|---|
| Review abuse reports | Reports tab; filter open / actioned / dismissed | `listing_reports` |
| Remove a listing | **Remove** with a reason (3–500 characters). The listing disappears from search and its page; the poster is notified with the reason. | `moderation_actions` |
| Restore a listing | **Restore** with a reason | `moderation_actions` |
| Dismiss a report | **Dismiss** | `listing_reports` |
| Held listings | Listings whose poster asked for review appear under pending | `items.moderation_state` |

Every action is attributed to the moderator and kept after their account is
deleted (the link becomes NULL).

## Support queue

| Request kind | Created when | Actions |
|---|---|---|
| `refund` | Owner asks for a refund of the ₹100 fee, or automatically when a payment is captured after its match was closed | **Approve refund** (issues a Razorpay refund for the captured amount) · **Reject** · **Resolve** |
| `return_issue` | Owner or finder chooses "There is a problem" | **Resolve** · **Reject** (the return state is not changed by the request) |
| `return_correction` | A participant says a completed return was wrong | **Reopen return** (recovery marked corrected; a matched return goes back to "being arranged", self/external closures reopen) · **Reject** |

Every resolution needs a short note. Refunds never touch finder rewards;
those are paid directly between people and the platform has no money to
return.

## Operational procedures

| Procedure | Steps |
|---|---|
| Check health | `GET /healthz` (liveness), `GET /readyz` (database and migrations), `GET /api/stats` |
| Rotate a credential | Create the new value at the provider → update the secret store / `.env` → restart the API (`docker compose up -d backend`) → revoke the old value → watch logs. See [SECURITY.md](../SECURITY.md). |
| Reconcile a payment | Open the match; `GET /api/claims/:id/payment` reconciles with Razorpay. Compare with the Razorpay Dashboard (Test or Live mode as appropriate). |
| Webhook failures | Razorpay Dashboard → Webhooks shows delivery attempts; the API logs `Webhook rejected` for bad signatures. Retries are safe (deduplicated). |
| Places quota or errors | Users see "suggestions unavailable" and can still type places. Check Google Cloud quotas and key restrictions; `node scripts/verify-google-places.js` runs a live check without printing the key. |
| Data requests | Users export or delete data from **Account**. Retention rules: [data-retention.md](data-retention.md). |
| Visitor analytics | `/admin` shows daily page views from cookie-less hashes (no IP stored). |
