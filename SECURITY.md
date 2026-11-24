# Security policy

## Reporting a vulnerability

Report it privately through GitHub: the repository's **Security** tab →
**Report a vulnerability** (private vulnerability reporting). If that is not
enabled, contact a repository maintainer directly through GitHub and ask
for a private channel. Do not open a public issue with exploit details.

Please include:

- the affected endpoint or page
- the steps to reproduce
- the impact
- any proof of concept that uses only your own test accounts

Do not access other people's data, run denial-of-service tests or make
real payments. There is no dedicated security mailbox yet.

## Credential handling

- Secrets come only from environment variables:
  - locally, the git-ignored `.env` and `backend/.env`
  - in production, the platform secret store
- `.env.example` holds placeholders only.
- Server-only secrets never reach browser code: Razorpay key secret and webhook secret, the Resend key, database URLs, the session secret, OAuth client secrets and the Google Maps server key.
  - The web app has no `NEXT_PUBLIC_*` variables.
  - CI runs `npm run check:bundle` to catch leaks.
- The Razorpay **key ID** is a public identifier by design. It is delivered to the browser at runtime.
- Logs redact cookies, tokens, codes, emails, phone numbers, answers and message bodies (`backend/src/logger.js`). Configuration errors name variables, never values.
- gitleaks runs in CI over the full history (`npm run secrets:scan` locally).

## Rotation

Removing a credential from code or history does **not** invalidate it. If a
value was committed, pasted into chat, a ticket or an email, or shown in a
screenshot, rotate it:

| Credential | Rotate at | Then |
|---|---|---|
| `SESSION_SECRET` | `openssl rand -hex 32` | Restart the API. All sessions end. |
| `RAZORPAY_KEY_SECRET` / key ID | Razorpay Dashboard → API Keys → Regenerate | Update the secret store, restart, then revoke the old key. |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay Dashboard → Webhooks → edit | Update and restart at the same time. Deliveries fail in between and are retried. |
| `RESEND_API_KEY` | Resend → API Keys | Create the new key, deploy it, then delete the old one. |
| `GOOGLE_CLIENT_SECRET` | Google Cloud → Credentials → OAuth client → reset secret | Update and restart. |
| `GOOGLE_MAPS_API_KEY` | Google Cloud → Credentials → regenerate, or create a new restricted key | Update, restart, then delete the old key. |
| Database password | `ALTER USER …` / RDS modify | Update `DATABASE_URL`/`DB_PASSWORD`, then restart. |

After rotating, check provider logs for any use of the old credential.
