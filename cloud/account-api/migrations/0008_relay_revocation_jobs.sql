CREATE TABLE relay_revocation_jobs (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('account', 'device')),
  source_id TEXT NOT NULL,
  relay_account_id TEXT NOT NULL,
  device_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX relay_revocation_jobs_pending_idx
  ON relay_revocation_jobs(status, next_attempt_at, created_at);
