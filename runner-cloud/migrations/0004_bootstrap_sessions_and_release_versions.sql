CREATE TABLE IF NOT EXISTS runner_bootstrap_sessions (
  id TEXT PRIMARY KEY,
  poll_secret_hash TEXT NOT NULL,
  user_code TEXT NOT NULL UNIQUE,
  agent_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bootstrap_user_code
  ON runner_bootstrap_sessions(user_code, expires_at);

ALTER TABLE agents ADD COLUMN installed_release_id TEXT;
