CREATE TABLE project_shares (
  project_id TEXT PRIMARY KEY,
  local_project_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  execution_host_id TEXT NOT NULL REFERENCES hosts(id),
  key_authority_host_id TEXT NOT NULL REFERENCES hosts(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  permission_revision INTEGER NOT NULL DEFAULT 1,
  key_epoch INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE(owner_user_id, local_project_id)
);
CREATE INDEX project_shares_owner_idx ON project_shares(owner_user_id, status);

CREATE TABLE project_share_publishers (
  project_id TEXT NOT NULL REFERENCES project_shares(project_id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, host_id)
);

CREATE TABLE project_memberships (
  project_id TEXT NOT NULL REFERENCES project_shares(project_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role = 'member'),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_memberships_user_idx ON project_memberships(user_id, revoked_at);

CREATE TABLE project_invitations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project_shares(project_id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_by_user_id TEXT REFERENCES users(id),
  accepted_at TEXT,
  revoked_at TEXT
);
CREATE UNIQUE INDEX project_invitations_pending_email_idx
  ON project_invitations(project_id, invited_email) WHERE status = 'pending';
CREATE INDEX project_invitations_project_idx ON project_invitations(project_id, created_at DESC);

CREATE TABLE project_device_grants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project_shares(project_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
  key_epoch INTEGER NOT NULL,
  wrapped_project_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(project_id, device_id)
);
CREATE INDEX project_device_grants_pending_idx ON project_device_grants(project_id, status, created_at);

CREATE TABLE project_chats (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project_shares(project_id) ON DELETE CASCADE,
  execution_host_id TEXT NOT NULL REFERENCES hosts(id),
  created_by_user_id TEXT REFERENCES users(id),
  visibility TEXT NOT NULL CHECK (visibility IN ('draft', 'published')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX project_chats_project_idx ON project_chats(project_id, execution_host_id);

CREATE TABLE project_host_presence (
  project_id TEXT NOT NULL REFERENCES project_shares(project_id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  last_heartbeat_at TEXT NOT NULL,
  PRIMARY KEY (project_id, host_id)
);

CREATE TABLE project_commands (
  command_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project_shares(project_id) ON DELETE CASCADE,
  run_id TEXT,
  request_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('create-chat', 'send-message', 'cancel-turn', 'stop-turn', 'rename-chat', 'archive-chat')),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  actor_display_name TEXT NOT NULL,
  source_device_id TEXT NOT NULL REFERENCES devices(id),
  target_host_id TEXT NOT NULL REFERENCES hosts(id),
  key_epoch INTEGER NOT NULL,
  permission_revision INTEGER NOT NULL,
  envelope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'completed', 'failed', 'cancelled', 'interrupted')),
  claimed_by_device_id TEXT REFERENCES devices(id),
  lease_expires_at TEXT,
  result_run_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX project_commands_host_idx ON project_commands(target_host_id, status, created_at);
CREATE INDEX project_commands_actor_idx ON project_commands(actor_user_id, project_id, created_at);
CREATE UNIQUE INDEX project_commands_request_idx ON project_commands(project_id, request_id)
  WHERE request_id IS NOT NULL AND type = 'send-message';
