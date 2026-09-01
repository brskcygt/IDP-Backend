'use strict';

/**
 * Repository for the `audit_logs` table (T-53).
 *
 * Replaces AuditLogger's old saveLogs(), which rewrote the entire
 * audit_logs.json file on every single log line — under concurrent
 * requests (e.g. two logins racing) the last writer wins and earlier
 * entries from the other request can be lost. `append()` here is a single
 * `INSERT`, so entries can no longer stomp each other.
 */

const { getDb } = require('./db');

/** @param {Record<string, unknown>} row */
function rowToEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    timestamp: row.timestamp,
    user: row.user,
    action: row.action,
    description: row.description,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    // T-55 / SEC-12: NULL (pre-existing rows created before these columns
    // existed, or entries logged outside any HTTP request) surfaces as
    // `null`, not a fabricated value — callers must treat that as "unknown",
    // not "empty".
    ip: row.ip ?? null,
    requestId: row.request_id ?? null,
    outcome: row.outcome ?? null,
    durationMs: row.duration_ms ?? null,
  };
}

/**
 * Build a repository bound to `db`. Application code should use the
 * default export (bound to the shared src/idp.db connection); tests pass
 * their own throwaway `DatabaseSync` instance.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function createAuditRepository(db) {
  return {
    /**
     * Insert one audit entry. `entry` must already carry an `id` and
     * `timestamp` (AuditLogger.log() generates both, same as before).
     * `ip` / `requestId` / `outcome` / `durationMs` are optional
     * (T-55 / SEC-12) — omit any of them and the column stores NULL.
     * @returns {object} the entry as read back from the row
     */
    append(entry) {
      db.prepare(`
        INSERT INTO audit_logs (id, timestamp, user, action, description, metadata, ip, request_id, outcome, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.id,
        entry.timestamp,
        entry.user,
        entry.action,
        entry.description,
        JSON.stringify(entry.metadata ?? {}),
        entry.ip ?? null,
        entry.requestId ?? null,
        entry.outcome ?? null,
        Number.isFinite(entry.durationMs) ? entry.durationMs : null
      );
      return rowToEntry(db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(entry.id));
    },

    /**
     * Most recent `limit` entries, newest first.
     * @returns {object[]}
     */
    list(limit = 100) {
      const rows = db.prepare(`
        SELECT * FROM audit_logs ORDER BY timestamp DESC, rowid DESC LIMIT ?
      `).all(limit);
      return rows.map(rowToEntry);
    },

    /**
     * Most recent `limit` entries for a single project, newest first.
     * Matches on `metadata.projectId`, the convention every audit call
     * site in server.js already uses.
     * @returns {object[]}
     */
    listByProject(projectId, limit = 100) {
      const rows = db.prepare(`
        SELECT * FROM audit_logs
        WHERE json_extract(metadata, '$.projectId') = ?
        ORDER BY timestamp DESC, rowid DESC
        LIMIT ?
      `).all(projectId, limit);
      return rows.map(rowToEntry);
    },
  };
}

module.exports = createAuditRepository(getDb());
module.exports.createAuditRepository = createAuditRepository;
