-- Email sign-in challenges (extends otp_codes from 003).
-- Each request creates a challenge with an opaque id; the code itself is only
-- stored as an HMAC keyed by the server secret and bound to the challenge id.
-- Delivery status from the email provider is recorded (never the code).

ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS challenge_id UUID;
UPDATE otp_codes SET challenge_id = gen_random_uuid() WHERE challenge_id IS NULL;
ALTER TABLE otp_codes ALTER COLUMN challenge_id SET DEFAULT gen_random_uuid();
ALTER TABLE otp_codes ALTER COLUMN challenge_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS otp_codes_challenge_idx ON otp_codes (challenge_id);

-- sending:   created, provider call in flight
-- sent:      provider accepted the message
-- unconfirmed: provider timed out; the email may still arrive, so the code stays valid
-- failed:    provider rejected the message; the challenge can never be used
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'sent'
  CHECK (delivery_status IN ('sending', 'sent', 'unconfirmed', 'failed'));
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS provider_error TEXT CHECK (provider_error IS NULL OR char_length(provider_error) <= 300);
-- Why the challenge ended: verified, superseded by a newer code, too many attempts, delivery failure.
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS consumed_reason TEXT
  CHECK (consumed_reason IS NULL OR consumed_reason IN ('verified', 'superseded', 'attempts', 'delivery_failed'));
