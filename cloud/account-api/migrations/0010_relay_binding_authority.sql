ALTER TABLE sync_spaces ADD COLUMN relay_binding_id TEXT;
ALTER TABLE relay_revocation_jobs ADD COLUMN binding_id TEXT;

CREATE TABLE relay_binding_attempts (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES sync_spaces(id) ON DELETE CASCADE,
  relay_account_id TEXT NOT NULL UNIQUE,
  relay_url TEXT NOT NULL,
  generation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE UNIQUE INDEX relay_binding_attempts_space_idx
  ON relay_binding_attempts(space_id);
