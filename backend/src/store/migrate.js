'use strict';

/**
 * One-time migration from the legacy JSON files (projects.json,
 * audit_logs.json) into SQLite (T-53).
 *
 * Idempotent by design: each table is only populated when it is currently
 * empty, so running this on every server boot is safe — after the first
 * successful run it's a no-op forever (until someone truncates the table
 * themselves, which is an explicit choice, not something this script does).
 *
 * Deliberately does NOT delete the source JSON files afterwards. They stay
 * on disk as a backup until a human verifies the migration and removes
 * them; the task that ordered this migration is explicit that automatic
 * deletion would be premature.
 */

const fs = require('node:fs');
const path = require('node:path');

const PROJECTS_JSON = path.join(__dirname, '..', 'projects.json');
const AUDIT_LOGS_JSON = path.join(__dirname, '..', 'audit_logs.json');

/** @returns {object[]} */
function readJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`[migrate] Failed to read/parse ${filePath}:`, err.message);
    return [];
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number} rows migrated
 */
function migrateProjects(db) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM projects').get();
  if (count > 0) return 0;

  const projects = readJsonArray(PROJECTS_JSON);
  if (projects.length === 0) return 0;

  const insert = db.prepare(`
    INSERT INTO projects (id, name, tenant, environment, provider, status, last_deploy, config)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let migrated = 0;
  for (const project of projects) {
    if (!project || !project.id) continue;
    insert.run(
      String(project.id),
      project.name ?? null,
      project.tenant ?? null,
      project.environment ?? null,
      project.provider ?? null,
      project.status ?? null,
      project.lastDeploy ?? null,
      JSON.stringify(project.config ?? {})
    );
    migrated++;
  }
  return migrated;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number} rows migrated
 */
function migrateAuditLogs(db) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get();
  if (count > 0) return 0;

  const logs = readJsonArray(AUDIT_LOGS_JSON);
  if (logs.length === 0) return 0;

  const insert = db.prepare(`
    INSERT INTO audit_logs (id, timestamp, user, action, description, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let migrated = 0;
  for (const entry of logs) {
    if (!entry || !entry.id) continue;
    insert.run(
      String(entry.id),
      entry.timestamp ?? null,
      entry.user ?? null,
      entry.action ?? null,
      entry.description ?? null,
      JSON.stringify(entry.metadata ?? {})
    );
    migrated++;
  }
  return migrated;
}

/**
 * Run the full migration against `db`. Pass an explicit `db` (and JSON
 * source paths, if you need to override them) from tests; application
 * code calls this with no arguments to migrate the real files into the
 * real src/idp.db.
 *
 * @param {import('node:sqlite').DatabaseSync} [db]
 * @returns {{ projectsMigrated: number, auditLogsMigrated: number }}
 */
function runMigration(db) {
  const database = db || require('./db').getDb();

  const projectsMigrated = migrateProjects(database);
  const auditLogsMigrated = migrateAuditLogs(database);

  if (projectsMigrated > 0) {
    console.log(`[migrate] Migrated ${projectsMigrated} project(s) from projects.json into SQLite.`);
  }
  if (auditLogsMigrated > 0) {
    console.log(`[migrate] Migrated ${auditLogsMigrated} audit log entr(y/ies) from audit_logs.json into SQLite.`);
  }
  if (projectsMigrated === 0 && auditLogsMigrated === 0) {
    console.log('[migrate] Nothing to migrate (tables already populated, or no JSON source files found).');
  }

  return { projectsMigrated, auditLogsMigrated };
}

module.exports = { runMigration, migrateProjects, migrateAuditLogs, PROJECTS_JSON, AUDIT_LOGS_JSON };
