CREATE TABLE IF NOT EXISTS runner_release_upload_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS runner_releases (
  id TEXT PRIMARY KEY,
  installer_base64 TEXT NOT NULL,
  installer_sha256 TEXT NOT NULL,
  root_cert_base64 TEXT NOT NULL,
  root_thumbprint TEXT NOT NULL,
  publisher_cert_base64 TEXT NOT NULL,
  publisher_thumbprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_runner_releases_active_created
  ON runner_releases(active, created_at DESC);
