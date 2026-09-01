'use strict';

/**
 * Repository for the `projects` table (T-53).
 *
 * Replaces the old loadProjects()/saveProjects() pair in server.js, which
 * read/wrote the *entire* projects.json on every mutation. Every method
 * here does exactly one row-scoped statement.
 *
 * `config` is stored as a JSON string (it holds `secret://` references —
 * see src/secrets/projectSecrets.js — never plaintext credentials). This
 * repository serializes/deserializes it automatically but never inspects
 * or resolves those references; that stays the caller's job.
 *
 * No method mutates its input: every method returns a brand new plain
 * object built from the row that was just read back from SQLite.
 */

const { getDb } = require('./db');

/** @param {Record<string, unknown>} row */
function rowToProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    tenant: row.tenant,
    environment: row.environment,
    provider: row.provider,
    status: row.status,
    lastDeploy: row.last_deploy,
    config: row.config ? JSON.parse(row.config) : {},
  };
}

/**
 * Build a repository bound to `db`. Application code should use the
 * default export (bound to the shared src/idp.db connection); tests pass
 * their own throwaway `DatabaseSync` instance.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function createProjectRepository(db) {
  return {
    /** @returns {object[]} every project, insertion order */
    findAll() {
      const rows = db.prepare('SELECT * FROM projects ORDER BY rowid ASC').all();
      return rows.map(rowToProject);
    },

    /** @returns {object|null} */
    findById(id) {
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
      return rowToProject(row);
    },

    /**
     * Insert a new project row. `project` must already carry an `id`.
     * @returns {object} the created project, as read back from the row
     */
    create(project) {
      db.prepare(`
        INSERT INTO projects (id, name, tenant, environment, provider, status, last_deploy, config)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        project.id,
        project.name,
        project.tenant,
        project.environment,
        project.provider,
        project.status,
        project.lastDeploy,
        JSON.stringify(project.config ?? {})
      );
      return this.findById(project.id);
    },

    /**
     * Merge `patch` onto the existing row and persist. Only keys present
     * in `patch` are changed; anything else on the stored row is left
     * alone. Returns null if no project with this id exists.
     * @returns {object|null}
     */
    update(id, patch) {
      const existing = this.findById(id);
      if (!existing) return null;

      const merged = { ...existing, ...patch };

      db.prepare(`
        UPDATE projects
        SET name = ?, tenant = ?, environment = ?, provider = ?, status = ?, last_deploy = ?, config = ?
        WHERE id = ?
      `).run(
        merged.name,
        merged.tenant,
        merged.environment,
        merged.provider,
        merged.status,
        merged.lastDeploy,
        JSON.stringify(merged.config ?? {}),
        id
      );

      return this.findById(id);
    },

    /** @returns {boolean} true if a row was deleted */
    remove(id) {
      const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      return result.changes > 0;
    },

    /**
     * Narrow update used by the deploy lifecycle: touches only
     * status/last_deploy, never config, so it can never accidentally
     * clobber a concurrently-saved config change.
     * @returns {object|null}
     */
    updateStatus(id, status, lastDeploy) {
      const result = db.prepare(`
        UPDATE projects SET status = ?, last_deploy = ? WHERE id = ?
      `).run(status, lastDeploy, id);

      if (result.changes === 0) return null;
      return this.findById(id);
    },
  };
}

module.exports = createProjectRepository(getDb());
module.exports.createProjectRepository = createProjectRepository;
