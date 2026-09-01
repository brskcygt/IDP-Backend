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
  ];

  for (const [name, type] of wanted) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE deployments ADD COLUMN ${name} ${type}`);
    }
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
