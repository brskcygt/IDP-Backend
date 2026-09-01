ALTER TABLE jobs ADD COLUMN cancel_requested_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_jobs_running_timeout
  ON jobs(status, started_at, timeout_seconds);
