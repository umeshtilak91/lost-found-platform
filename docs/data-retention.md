# Data retention and deletion

This page describes what the code does today. Retention periods marked
**[owner]** are operational decisions that still need confirming.

| Data | Where | Kept until | Deleted by |
|---|---|---|---|
| Account (name, email, avatar URL, phone, locale, role) | `users` | The account is deleted | `DELETE /api/account` |
| Sign-in identities (Google/Apple/email subject) | `auth_identities` | The account is deleted | Cascades from the account |
| Sessions | `session` | 14 days after last activity, or sign-out | Sign-out destroys the session; expired rows are pruned every 15 minutes |
| Email sign-in codes (HMAC only, never the code) | `otp_codes` | Expire after 10 minutes, single use | Hourly purge of rows older than 1 day |
| Listings | `items` | The owner deletes it or the account is deleted | Deleting a listing hides it at once and removes its photos; the row is kept (`deleted_at`) so conversations stay readable. Deleting the account removes the rows. |
| Photos (re-encoded WebP, metadata stripped) | Storage (local or S3) plus `item_images` | Listing or photo deletion, or account deletion | Objects are deleted from storage after the database commit, and CDN copies are purged |
| Prototype uploads (`uploads/`) | Legacy directory | Left in place by the migration | **[owner]** Delete the directory after confirming the backfill summary |
| Claims (including private answers) | `claims` | The listing or account is deleted | Cascades |
| Conversations and messages | `conversations`, `messages` | Either participant deletes their account, or the listing's rows are removed | Cascades |
| Notifications | `notifications` | The account is deleted | Cascades; **[owner]** optional purge after 180 days |
| Abuse reports | `listing_reports` | Kept for moderation history | The reporter link is set to NULL when their account is deleted |
| Moderator audit log | `moderation_actions` | Kept | The moderator link is set to NULL when their account is deleted |
| Visitor analytics (page path, referrer domain, daily-rotating visitor hash — no IP, no cookie) | `page_views`, `analytics_salts` | Page views about 400 days; daily salts 2 days | Hourly purge of both |
| Rate-limit counters | `rate_limits` | Their window | Hourly purge of expired rows |
| Request logs | stdout, then the log platform | **[owner]** e.g. 30 days | Log platform retention |
| Database backups | RDS | **[owner]** e.g. 7–35 days | Backups are overwritten; deleted data persists in them until then |

## Export

`GET /api/account/export` ("Download my data" on the account page) returns
JSON with:

- the profile and sign-in methods
- listings, image IDs and URLs
- claims submitted, with their answers
- conversations and the messages the user sent
- notifications and reports filed

## Public vs private fields

The public API and the server-rendered pages build their output from an
explicit allow-list (`backend/src/services/serializers.js`).

**Public:**

- title, category, description, location text and date
- status and photos
- the reporter's first name and last initial
- approximate coordinates (rounded to about 1.1 km)

**Never public:**

- email and phone number
- precise coordinates
- claim answers and messages
- internal IDs of users

Phone numbers are shown only inside a conversation where the owner has turned
sharing on. Removing the number from the account turns sharing off
everywhere.
