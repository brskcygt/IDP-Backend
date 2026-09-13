'use strict';

/**
 * Repository for the `deployments` table (T-54).
 *
 * Before this, DeploymentManager kept every deployment (status + full log
 * buffer) only in memory and dropped it an hour after it finished — so a
 * closed log stream could never be reopened, and a server restart lost the
 * entire deploy history. The `deployments` table itself already existed
 * from T-53; this is the first repository that actually writes to it.
 *
 * Follows the same shape as projectRepository / auditRepository: plain
 * functions bound to a `DatabaseSync`, no method mutates its input, the
 * default export is bound to the shared src/idp.db connection, and tests
 * build their own repository against a throwaway database via
 * `createDeploymentRepository(db)`.
 */

const { getDb } = require('./db');

/** Hard caps for the stored log body — see truncateLogText() below. */
const MAX_LOG_LINES = 5000;
const MAX_LOG_BYTES = 1024 * 1024; // 1 MiB

/**
 * Row → full deployment object, including the (potentially large) log body.
 * Used by findById(), where callers explicitly want the log text.
 * @param {Record<string, unknown>} row
 */
function rowToDeployment(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    triggeredBy: row.triggered_by,
    environment: row.environment,
    error: row.error,
    kind: row.kind ?? null,
    releaseId: row.release_id ?? null,
    targetId: row.target_id ?? null,
    logText: row.log_text ?? null,
  };
}

/**
 * Row → lightweight deployment summary, without the log body. Used by
 * listRecent() / listByProject() so a page of history doesn't drag along
 * megabytes of log text it isn't going to render.
 * @param {Record<string, unknown>} row
 */
function rowToSummary(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    triggeredBy: row.triggered_by,
    environment: row.environment,
    error: row.error,
    kind: row.kind ?? null,
    releaseId: row.release_id ?? null,
    targetId: row.target_id ?? null,
  };
}

const SUMMARY_COLUMNS =
  'id, project_id, status, started_at, finished_at, duration_ms, triggered_by, environment, error, kind, release_id, target_id';

/**
 * Trim a log body down to the last MAX_LOG_LINES lines or MAX_LOG_BYTES
 * bytes, whichever limit is hit first, keeping the *end* of the log (the
 * most recent output, which is what matters when something just failed).
 * When anything was cut, a `[truncated: showing last N lines]` marker is
 * prepended so a reader knows the body isn't complete.
 *
 * Pure function — never touches the database, easy to unit test in
 * isolation from SQLite.
 *
 * @param {string} text
 * @returns {{ text: string, truncated: boolean }}
 */
function truncateLogText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: '', truncated: false };
  }

  let lines = text.split('\n');
  let truncated = false;

  if (lines.length > MAX_LOG_LINES) {
    lines = lines.slice(lines.length - MAX_LOG_LINES);
    truncated = true;
  }

  // Byte cap applies on top of the line cap — a handful of very long lines
  // can still blow past 1 MiB even under the 5000-line limit. Walk a
  // running byte total instead of re-joining the array on every iteration
  // (O(n) instead of O(n^2) — matters once this is 5000 lines deep).
  const lineBytes = lines.map((l) => Buffer.byteLength(l, 'utf8'));
  let totalBytes = lineBytes.reduce((sum, b) => sum + b, 0) + Math.max(lines.length - 1, 0); // '\n' joiners
  let dropFromStart = 0;
  while (dropFromStart < lines.length - 1 && totalBytes > MAX_LOG_BYTES) {
    totalBytes -= lineBytes[dropFromStart] + 1; // line + its trailing '\n'
    dropFromStart++;
    truncated = true;
  }
  if (dropFromStart > 0) {
    lines = lines.slice(dropFromStart);
  }

  let joined = lines.join('\n');

  // Pathological case: even the single remaining line exceeds the byte
  // budget on its own. Hard-truncate by bytes as a last resort so the
  // stored body never exceeds the cap.
  if (Buffer.byteLength(joined, 'utf8') > MAX_LOG_BYTES) {
    truncated = true;
    joined = Buffer.from(joined, 'utf8').subarray(-MAX_LOG_BYTES).toString('utf8');
  }

  if (truncated) {
    joined = `[truncated: showing last ${lines.length} lines]\n${joined}`;
  }

  return { text: joined, truncated };
}

/**
 * Build a repository bound to `db`. Application code should use the
 * default export (bound to the shared src/idp.db connection); tests pass
 * their own throwaway `DatabaseSync` instance.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function createDeploymentRepository(db) {
  return {
  /**
   * Mark deployments still recorded as in-flight as failed.
   *
   * A row reaches "running" and stays there if the process dies mid-deploy —
   * nothing is left to write the terminal status. Those rows then look like
   * live deployments forever: they show up in the history as running, and the
   * abort endpoint (which falls back to the database) would report success for
   * something that stopped existing at the crash.
   *
   * Called once at startup, before anything can create a new deployment.
   *
   * @returns {number} how many rows were reconciled
   */
  reconcileInterrupted(reason = 'Interrupted by a server restart') {
    const stale = db
      .prepare("SELECT id FROM deployments WHERE status IN ('pending', 'running', 'connecting')")
      .all();

    if (stale.length === 0) return 0;

    const stamp = new Date().toISOString();
    const update = db.prepare(
      "UPDATE deployments SET status = 'failed', finished_at = ?, error = ? WHERE id = ?"
    );
    for (const row of stale) update.run(stamp, reason, row.id);

    return stale.length;
  },
    /**
     * Insert a new deployment row. `deployment` must already carry an
     * `id`. `finishedAt` / `durationMs` / `error` / log text are left
     * unset — they're only known once the deployment finishes, via
     * finish() and appendLogs().
     * @returns {object} the created deployment, as read back from the row
     */
    create(deployment) {
      db.prepare(`
        INSERT INTO deployments (id, project_id, status, started_at, triggered_by, environment, kind, release_id, target_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deployment.id,
        deployment.projectId ?? null,
        deployment.status ?? null,
        deployment.startedAt ?? null,
        deployment.triggeredBy ?? null,
        deployment.environment ?? null,
        deployment.kind ?? null,
        deployment.releaseId ?? null,
        deployment.targetId ?? null
      );
      return this.findById(deployment.id);
    },

    /**
     * Record the terminal outcome of a deployment. Only touches the
     * finish-time columns — status, finishedAt, durationMs, error — never
     * the log body (that's appendLogs()'s job, kept separate so a caller
     * can finish() without necessarily having assembled the log text yet).
     * @returns {object|null} null if no deployment with this id exists
     */
    finish(id, patch) {
      const existing = this.findById(id);
      if (!existing) return null;

      db.prepare(`
        UPDATE deployments
        SET status = ?, finished_at = ?, duration_ms = ?, error = ?
        WHERE id = ?
      `).run(
        patch.status ?? existing.status,
        patch.finishedAt ?? existing.finishedAt,
        patch.durationMs ?? existing.durationMs,
        patch.error ?? existing.error,
        id
      );

      return this.findById(id);
    },

    /** @returns {object|null} */
    findById(id) {
      const row = db.prepare('SELECT * FROM deployments WHERE id = ?').get(id);
      return rowToDeployment(row);
    },

    /**
     * Most recent `limit` deployments across all projects, newest first.
     * Excludes the log body — see rowToSummary().
     * @returns {object[]}
     */
    listRecent(limit = 50) {
      const rows = db.prepare(`
        SELECT ${SUMMARY_COLUMNS}
        FROM deployments
        ORDER BY started_at DESC, rowid DESC
        LIMIT ?
      `).all(limit);
      return rows.map(rowToSummary);
    },

    /**
     * Most recent `limit` deployments for a single project, newest first.
     * @returns {object[]}
     */
    listByProject(projectId, limit = 50) {
      const rows = db.prepare(`
        SELECT ${SUMMARY_COLUMNS}
        FROM deployments
        WHERE project_id = ?
        ORDER BY started_at DESC, rowid DESC
        LIMIT ?
      `).all(projectId, limit);
      return rows.map(rowToSummary);
    },

    /**
     * Persist the full log body for a deployment in one write (called once,
     * when the deployment reaches a terminal state — never per-line, which
     * is exactly the "rewrite everything on every event" problem T-53
     * fixed for projects/audit logs). Truncated per truncateLogText() above
     * before being stored.
     * @returns {object|null} the updated deployment, or null if unknown id
     */
    appendLogs(id, logsText) {
      const existing = this.findById(id);
      if (!existing) return null;

      const { text } = truncateLogText(logsText ?? '');
      db.prepare('UPDATE deployments SET log_text = ? WHERE id = ?').run(text, id);
      return this.findById(id);
    },
  };
}

module.exports = createDeploymentRepository(getDb());
module.exports.createDeploymentRepository = createDeploymentRepository;
module.exports.truncateLogText = truncateLogText;
module.exports.MAX_LOG_LINES = MAX_LOG_LINES;
module.exports.MAX_LOG_BYTES = MAX_LOG_BYTES;
