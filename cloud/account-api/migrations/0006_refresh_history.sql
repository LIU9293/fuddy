CREATE TABLE auth_refresh_history (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  used_at TEXT NOT NULL
);
CREATE INDEX auth_refresh_history_family_idx ON auth_refresh_history(family_id, used_at DESC);
