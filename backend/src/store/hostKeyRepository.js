'use strict';

/**
 * Repository for the `host_keys` table (SEC-10 / T-17).
 *
 * Stores SSH host keys the app has previously seen, keyed by (host, port),
 * so `services/ssh/hostKeyVerifier.js` can implement trust-on-first-use
 * (TOFU) and strict pinning policies instead of blindly accepting whatever
 * key a server — or a machine-in-the-middle impersonating it — presents.
 *
 * Follows the same shape as projectRepository.js: a factory bound to a
 * `DatabaseSync` instance, application code uses the default export bound
 * to the shared src/idp.db connection, tests build their own with
 * `createHostKeyRepository(testDb)`.
 *
 * No method mutates its input: every method returns a brand new plain
 * object built from the row that was just read back from SQLite.
 */

const { getDb } = require('./db');

/** @param {Record<string, unknown>} row */
function rowToHostKey(row) {
  if (!row) return null;
  return {
    host: row.host,
    port: row.port,
    keyType: row.key_type,
    fingerprint: row.fingerprint,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  };
}

/**
 * Build a repository bound to `db`.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function createHostKeyRepository(db) {
  return {
    /** @returns {object|null} the stored key for (host, port), or null */
    find(host, port) {
      const row = db.prepare('SELECT * FROM host_keys WHERE host = ? AND port = ?').get(host, port);
      return rowToHostKey(row);
    },

    /**
     * Record (or refresh) the key seen for (host, port). Upserts: a first
     * sighting inserts a new row (first_seen = last_seen = now); a
     * subsequent call — whether the fingerprint changed or not — updates
     * key_type/fingerprint and bumps last_seen. Callers decide policy
     * (whether it's safe to call this at all for a given verification
     * outcome) — this method just persists whatever it's told.
     *
     * @returns {object} the stored row, as read back from SQLite
     */
    remember(host, port, keyType, fingerprint) {
      const now = new Date().toISOString();
      const existing = this.find(host, port);

      if (existing) {
        db.prepare(`
          UPDATE host_keys
          SET key_type = ?, fingerprint = ?, last_seen = ?
          WHERE host = ? AND port = ?
        `).run(keyType, fingerprint, now, host, port);
      } else {
        db.prepare(`
          INSERT INTO host_keys (host, port, key_type, fingerprint, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(host, port, keyType, fingerprint, now, now);
      }

      return this.find(host, port);
    },

    /** @returns {boolean} true if a row was deleted */
    forget(host, port) {
      const result = db.prepare('DELETE FROM host_keys WHERE host = ? AND port = ?').run(host, port);
      return result.changes > 0;
    },

    /** @returns {object[]} every known host key, host then port */
    listAll() {
      const rows = db.prepare('SELECT * FROM host_keys ORDER BY host ASC, port ASC').all();
      return rows.map(rowToHostKey);
    },
  };
}

module.exports = createHostKeyRepository(getDb());
module.exports.createHostKeyRepository = createHostKeyRepository;
