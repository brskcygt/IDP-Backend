'use strict';

/**
 * Repository for the `settings` table: server-wide documents keyed by name.
 *
 * Each row holds one JSON document. A row that is absent and a row holding an
 * empty document are the same thing to callers — `read()` returns null for both
 * — so a setting that was never configured needs no special case anywhere else.
 *
 * Plain text by design: secrets belong in the secret store, and the one setting
 * that exists today (build parameters) is explicitly not allowed to hold any.
 */

const { getDb } = require('./db');

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function createSettingsRepository(db) {
  return {
    /**
     * @param {string} key
     * @returns {{ value: object, updatedAt: string|null, updatedBy: string|null }|null}
     */
    read(key) {
      const row = db.prepare('SELECT value, updated_at, updated_by FROM settings WHERE key = ?').get(key);
      if (!row) return null;
      let value = null;
      try {
        value = JSON.parse(row.value);
      } catch {
        // A hand-edited or truncated row must not take the server down on boot.
        return null;
      }
      return { value, updatedAt: row.updated_at ?? null, updatedBy: row.updated_by ?? null };
    },

    /**
     * Writes (or replaces) one document.
     * @param {string} key
     * @param {object} value
     * @param {string|null} updatedBy
     */
    write(key, value, updatedBy = null) {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO settings (key, value, updated_at, updated_by)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `).run(key, JSON.stringify(value ?? {}), now, updatedBy);
      return { value: value ?? {}, updatedAt: now, updatedBy };
    },

    /** @param {string} key */
    remove(key) {
      return db.prepare('DELETE FROM settings WHERE key = ?').run(key).changes > 0;
    },
  };
}

module.exports = createSettingsRepository(getDb());
module.exports.createSettingsRepository = createSettingsRepository;
