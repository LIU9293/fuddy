ALTER TABLE auth_challenges ADD COLUMN resend_email_id TEXT;
ALTER TABLE auth_challenges ADD COLUMN delivery_status TEXT;
ALTER TABLE auth_challenges ADD COLUMN delivery_updated_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS auth_challenges_resend_email_idx
  ON auth_challenges(resend_email_id)
  WHERE resend_email_id IS NOT NULL;

CREATE TABLE resend_webhook_events (
  svix_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  resend_email_id TEXT NOT NULL,
  event_created_at TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX resend_webhook_events_email_idx
  ON resend_webhook_events(resend_email_id, event_created_at DESC);

CREATE TABLE email_suppressions (
  email_hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
