PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  signing_public_key TEXT NOT NULL,
  exchange_public_key TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version TEXT,
  os_version TEXT,
  last_seen_at INTEGER,
  enrolled_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS enrollment_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  agent_name TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  project_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out')),
  timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds BETWEEN 1 AND 86400),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  leased_at INTEGER,
  lease_expires_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  exit_code INTEGER,
  error_code TEXT
);

CREATE TABLE IF NOT EXISTS job_log_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (job_id, sequence)
);

CREATE TABLE IF NOT EXISTS request_nonces (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, nonce)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('desktop', 'agent', 'system')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_enrollment_tokens_expiry ON enrollment_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_jobs_agent_status_created ON jobs(agent_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_job_logs_job_sequence ON job_log_chunks(job_id, sequence);
CREATE INDEX IF NOT EXISTS idx_nonces_expiry ON request_nonces(expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
