'use strict';

/**
 * SQLite database connection (T-53).
 *
 * Replaces the previous "read the whole JSON file, mutate the in-memory
 * array, write the whole JSON file back" pattern for projects.json and
 * audit_logs.json — a pattern where two concurrent requests can race and
 * one write silently clobbers the other. SQLite gives us real per-row
 * writes plus WAL mode for concurrent readers.
 *
 * Deliberately built on Node's built-in `node:sqlite` (stable as of
 * Node 22.5+ / this project's Node 24) instead of `better-sqlite3`: a
 * native npm dependency would need to be rebuilt per Electron target,
 * which is exactly the packaging problem this project avoids by staying
 * on the runtime-provided module. See T-53 task notes.
 *
 * `openDatabase(filePath)` is exported (rather than only a singleton) so
 * tests can point at a throwaway file in a temp directory instead of the
 * real src/idp.db.
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB_FILE = path.join(__dirname, '..', 'idp.db');

/**
 * Where the database actually lives.
 *
 * `IDP_DB_PATH` exists so tests never touch the real file. Several suites
 * exercise singletons (DeploymentManager, the repositories) that open the
 * database at import time, so without an override a test run writes rows into
 * production data — and parallel test files then race each other over it, which
 * is exactly the intermittent failure this override removes.
 */
function resolveDbFile() {
  const override = process.env.IDP_DB_PATH;
  return override && override.trim() !== '' ? override : DEFAULT_DB_FILE;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tenant TEXT,
    environment TEXT,
    provider TEXT,
    status TEXT,
    last_deploy TEXT,
    config TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    user TEXT,
    action TEXT,
    description TEXT,
    metadata TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs (timestamp);

  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    status TEXT,
    started_at TEXT,
    finished_at TEXT,
    duration_ms INTEGER,
    triggered_by TEXT,
    environment TEXT,
    error TEXT,
    log_text TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_deployments_project_id ON deployments (project_id);

  -- SEC-10 / T-17: known SSH host keys, used by hostKeyVerifier.js to
  -- implement trust-on-first-use (and strict pinning) instead of blindly
  -- accepting whatever key a server — or a machine-in-the-middle
  -- impersonating it — presents.
  CREATE TABLE IF NOT EXISTS host_keys (
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    key_type TEXT,
    fingerprint TEXT NOT NULL,
    first_seen TEXT,
    last_seen TEXT,
    PRIMARY KEY (host, port)
  );

  -- Artifact deploy (docs/ARTIFACT-DEPLOY.md): versioned releases built by
  -- CI/Jenkins, their artifacts (stored at Bitbucket Downloads / GitHub
  -- Release assets, never here), deploy targets (one agent = one target),
  -- per-deployment stage events and short-lived artifact download tokens.
  CREATE TABLE IF NOT EXISTS releases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    version TEXT NOT NULL,
    commit_sha TEXT,
    source_platform TEXT,
    source_identity_json TEXT,
    status TEXT NOT NULL,
    manifest_json TEXT,
    build_deployment_id TEXT,
    error TEXT,
    created_by TEXT,
    ready_order INTEGER,
    created_at TEXT,
    updated_at TEXT,
    UNIQUE (project_id, version)
  );

  CREATE TABLE IF NOT EXISTS release_artifacts (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    component TEXT NOT NULL,
    os TEXT NOT NULL,
    file_name TEXT NOT NULL,
    source_ref TEXT,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_release_artifacts_release_id ON release_artifacts (release_id);

  CREATE TABLE IF NOT EXISTS deploy_targets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    agent_id TEXT NOT NULL UNIQUE,
    os TEXT NOT NULL,
    environment TEXT,
    base_path TEXT,
    components_json TEXT,
    runtime_config_json TEXT,
    current_release_id TEXT,
    current_versions_json TEXT,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_deploy_targets_project_id ON deploy_targets (project_id);

  CREATE TABLE IF NOT EXISTS deployment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    component TEXT,
    stage TEXT,
    status TEXT,
    progress REAL,
    message TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_deployment_events_deployment_id ON deployment_events (deployment_id);

  -- Only the sha256 of a token is stored; the token itself exists solely in
  -- the artifact_deploy payload sent to the agent. expires_at is epoch ms.
  CREATE TABLE IF NOT EXISTS artifact_download_tokens (
    token_hash TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    agent_id TEXT,
    deployment_id TEXT,
    expires_at INTEGER NOT NULL,
    max_uses INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    created_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_artifact_download_tokens_deployment_id ON artifact_download_tokens (deployment_id);

  -- Server-wide settings, one JSON document per key (currently only
  -- 'buildParameters'). Deliberately not a column per setting: these are
  -- operator-edited documents, not queried fields, and a new setting should
  -- not need a migration. Secrets never live here — the table is plain text.
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT,
    updated_by TEXT
  );
`;

/**
 * `deployments` gained `environment` and `log_text` after the table was
 * first created (T-54). `CREATE TABLE IF NOT EXISTS` above is a no-op
 * against a database file that already has the table from before this
 * change, so it would never pick up the new columns on its own — this
 * adds them in place, once, without touching (or renaming) any existing
 * column. Safe to call on every boot: it only issues `ALTER TABLE` for a
 * column that isn't already there.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function ensureDeploymentColumns(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(deployments)').all().map((row) => row.name));
  const wanted = [
    ['environment', 'TEXT'],
    ['log_text', 'TEXT'],
    // Artifact deploy: 'deploy' (legacy provider flow, NULL on older rows),
    // 'build', 'artifact_deploy', 'artifact_rollback' or
    // 'artifact_config_apply', plus the release and
    // deploy target a row belongs to. Nullable — existing rows are unaffected.
    ['kind', 'TEXT'],
    ['release_id', 'TEXT'],
    ['target_id', 'TEXT'],
  ];

  for (const [name, type] of wanted) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE deployments ADD COLUMN ${name} ${type}`);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_deployments_target_id ON deployments (target_id)');
}

/** Adds artifact-release columns introduced after the first F1 schema. */
function ensureReleaseColumns(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(releases)').all().map((row) => row.name));
  if (!existing.has('source_identity_json')) {
    db.exec('ALTER TABLE releases ADD COLUMN source_identity_json TEXT');
  }
  if (!existing.has('ready_order')) {
    db.exec('ALTER TABLE releases ADD COLUMN ready_order INTEGER');
  }
  // Keys parsed from each component's .env.example (see core/artifacts/envExample.js).
  if (!existing.has('config_schema_json')) {
    db.exec('ALTER TABLE releases ADD COLUMN config_schema_json TEXT');
  }
}

/**
 * `audit_logs` gained `ip`, `request_id`, `outcome`, and `duration_ms`
 * after the table (and this project's real database, with its existing
 * audit history) already existed (T-55 / SEC-12). Same pattern as
 * `ensureDeploymentColumns` above, for the same reason: `ADD COLUMN`
 * against a table that already has rows leaves every existing row's new
 * columns as SQL NULL — nothing about the ~350 pre-existing entries is
 * read, rewritten, or dropped.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function ensureAuditLogColumns(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(audit_logs)').all().map((row) => row.name));
  const wanted = [
    ['ip', 'TEXT'],
    ['request_id', 'TEXT'],
    ['outcome', 'TEXT'],
    ['duration_ms', 'INTEGER'],
  ];

  for (const [name, type] of wanted) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE audit_logs ADD COLUMN ${name} ${type}`);
    }
  }
}

/**
 * Restrict the database and its WAL/shm sidecars to owner-only access.
 * Best-effort: a filesystem that doesn't support chmod (or a file that doesn't
 * exist yet) must not stop the server from starting.
 */
function restrictPermissions(filePath) {
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    try {
      if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o600);
    } catch {
      // Non-fatal — worst case the file keeps the default umask permissions.
    }
  }
}

/**
 * Open (creating if necessary) the SQLite database at `filePath`, apply
 * pragmas, and ensure the schema exists. Safe to call repeatedly against
 * the same file — every statement is `IF NOT EXISTS`.
 *
 * @param {string} [filePath] - defaults to src/idp.db
 * @returns {import('node:sqlite').DatabaseSync}
 */
function openDatabase(filePath = resolveDbFile()) {
  const db = new DatabaseSync(filePath);

  // WAL mode lets readers proceed while a write is in progress instead of
  // blocking behind a single file lock — the concurrency property this
  // whole migration is for.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  ensureDeploymentColumns(db);
  ensureAuditLogColumns(db);
  ensureReleaseColumns(db);

  // The database holds project configuration and the full audit trail, so it
  // should not be world-readable. SQLite creates the file with the process
  // umask, which is typically 0644. Tighten it — along with the WAL/shm
  // sidecars, which carry the same data before a checkpoint.
  restrictPermissions(filePath);

  return db;
}

let sharedDb = null;

/**
 * Lazily-initialized singleton connection to the real src/idp.db, for
 * application code (repositories) that doesn't need an isolated database.
 * Tests should use `openDatabase(tmpFilePath)` directly instead.
 */
function getDb() {
  if (!sharedDb) {
    sharedDb = openDatabase();
  }
  return sharedDb;
}

module.exports = { openDatabase, getDb, DEFAULT_DB_FILE, resolveDbFile };
