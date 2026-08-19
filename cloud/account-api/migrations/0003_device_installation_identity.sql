ALTER TABLE devices ADD COLUMN installation_id TEXT;
UPDATE devices SET installation_id = id WHERE installation_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS devices_user_installation_idx
  ON devices(user_id, installation_id);
