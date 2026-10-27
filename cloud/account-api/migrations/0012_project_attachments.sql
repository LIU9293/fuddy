CREATE TABLE project_attachments (
  attachment_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES project_shares(project_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES project_chats(run_id) ON DELETE CASCADE,
  request_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('input', 'artifact')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'published')),
  uploaded_by_user_id TEXT NOT NULL REFERENCES users(id),
  uploaded_by_device_id TEXT NOT NULL REFERENCES devices(id),
  key_epoch INTEGER NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  cipher_size INTEGER NOT NULL,
  cipher_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  PRIMARY KEY (project_id, key_epoch, attachment_id)
);
CREATE INDEX project_attachments_project_idx ON project_attachments(project_id, status, created_at);
CREATE INDEX project_attachments_request_idx ON project_attachments(project_id, run_id, request_id);
