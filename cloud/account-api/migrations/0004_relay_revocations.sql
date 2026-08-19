ALTER TABLE device_grants ADD COLUMN relay_revoked_at TEXT;
CREATE INDEX IF NOT EXISTS device_grants_relay_revocation_idx
  ON device_grants(space_id, status, relay_revoked_at);
