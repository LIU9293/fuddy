ALTER TABLE sync_spaces ADD COLUMN relay_url TEXT;
ALTER TABLE sync_spaces ADD COLUMN relay_bound_at TEXT;

CREATE INDEX IF NOT EXISTS device_grants_space_status_idx
  ON device_grants(space_id, status, expires_at);
