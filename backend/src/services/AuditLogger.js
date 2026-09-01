const auditRepository = require('../store/auditRepository');
const { getRequestContext } = require('../middleware/requestContext');

/**
 * Actions that represent an explicit failure/rejection outcome. Anything
 * not listed here defaults to 'success' — most audit actions (LOGIN,
 * PROJECT_CREATED, DEPLOY_TRIGGERED, ...) describe something that
 * completed, not an attempt that failed.
 */
const FAILURE_ACTIONS = new Set([
  'LOGIN_FAILED',
  'DEPLOY_FAILED',
  'DEPLOY_ABORTED',
]);

/**
 * Best-effort outcome classification from the action name alone, so every
 * existing call site gets a populated `outcome` column without having to
 * pass it explicitly. A call site that knows better can still override via
 * `options.outcome` (see `log()` below).
 * @param {string} action
 * @returns {'success'|'failure'}
 */
function inferOutcome(action) {
  return FAILURE_ACTIONS.has(action) ? 'failure' : 'success';
}

/**
 * AuditLogger (T-53, extended by T-55 / SEC-12).
 *
 * Public API (`log()` / `getLogs()`) is unchanged in the sense that every
 * existing call site (server.js, routes/deploy.js, routes/mfa.js) keeps
 * working untouched — `log(user, action, description, metadata)` still
 * does exactly what it did. What's new is that every entry now also
 * carries `ip`, `requestId`, `outcome`, and `durationMs`:
 *
 *   - `ip` / `requestId` are read automatically from the AsyncLocalStorage
 *     request context (see middleware/requestContext.js) — no call site
 *     needs to pass `req.ip` in by hand anymore. A call made outside any
 *     HTTP request (startup code, a background timer) simply gets `null`
 *     for both, which is correct, not a bug.
 *   - `outcome` is inferred from the action name (see `inferOutcome`
 *     above) unless a caller passes one explicitly via the optional 5th
 *     `options` argument.
 *   - `durationMs` is read from `metadata.durationMs` when present (every
 *     DEPLOY_SUCCEEDED/DEPLOY_FAILED call already includes it there) or
 *     from `options.durationMs`; otherwise `null`.
 *
 * Storage-wise this is still a single SQLite INSERT via auditRepository —
 * the T-53 concurrency guarantee (no lost writes under concurrent
 * requests) is untouched.
 */
class AuditLogger {
  /**
   * Log an action to the audit trail.
   * @param {string} user - The username or 'System'
   * @param {string} action - The main action (e.g., 'LOGIN', 'PROJECT_CREATED')
   * @param {string} description - Human readable description
   * @param {object} [metadata] - Optional metadata (projectId, etc.)
   * @param {object} [options] - Optional explicit overrides
   * @param {'success'|'failure'} [options.outcome] - Overrides the inferred outcome
   * @param {number} [options.durationMs] - Overrides metadata.durationMs
   */
  log(user, action, description, metadata = {}, options = {}) {
    const context = getRequestContext();

    const entry = {
      id: Date.now().toString() + Math.random().toString(36).substring(2, 5),
      timestamp: new Date().toISOString(),
      user: user || (context && context.username) || 'System',
      action,
      description,
      metadata,
      // metadata.ip stays supported (LOGIN_FAILED has passed it explicitly
      // since T-11/SEC-04) — the request context, when available, is the
      // more reliable source and takes precedence.
      ip: (context && context.ip) || metadata.ip || null,
      requestId: (context && context.requestId) || null,
      outcome: options.outcome || inferOutcome(action),
      durationMs: Number.isFinite(options.durationMs)
        ? options.durationMs
        : Number.isFinite(metadata.durationMs)
          ? metadata.durationMs
          : null,
    };

    try {
      auditRepository.append(entry);
    } catch (error) {
      console.error('Error saving audit log entry:', error);
    }
  }

  getLogs(limit = 100) {
    try {
      return auditRepository.list(limit);
    } catch (error) {
      console.error('Error loading audit logs:', error);
      return [];
    }
  }
}

// Export a singleton instance
module.exports = new AuditLogger();
