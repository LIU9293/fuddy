ALTER TABLE sync_spaces ADD COLUMN relay_generation INTEGER NOT NULL DEFAULT 1;

ALTER TABLE relay_revocation_jobs ADD COLUMN source_generation INTEGER NOT NULL DEFAULT 1;

CREATE TABLE auth_email_cooldowns (
  email TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  available_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
