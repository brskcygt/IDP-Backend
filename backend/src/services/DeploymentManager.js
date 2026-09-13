const deploymentRepository = require('../store/deploymentRepository');

const TERMINAL_STATUSES = ['succeeded', 'failed', 'aborted'];

/**
 * DeploymentManager — Central orchestrator for active deployments.
 *
 * Tracks all running deployments by ID, stores log buffers, and
 * allows both WebSocket and SSE consumers to subscribe to logs.
 * This decouples the transport layer from the deployment logic.
 *
 * T-54: deployment history is now also persisted to the `deployments`
 * SQLite table via deploymentRepository, so it survives past cleanup()
 * and past a server restart. The in-memory Map is still the source of
 * truth for anything *live* (subscribers, the AbortController, MFA
 * resolvers) — only a finished session's status/log body get mirrored to
 * SQLite. getSession() transparently falls back to the database for an id
 * that's no longer in memory, so callers (like the SSE route) don't need
 * to care whether a deployment is still live or only exists in history.
 */
class DeploymentManager {
  constructor() {
    // Map<deploymentId, DeploymentSession>
    this.sessions = new Map();

    // Deployments the database still lists as in-flight belong to a process
    // that no longer exists. Settle them now, before anything can mistake one
    // for a live run. Non-fatal: a reconciliation failure must not stop boot.
    try {
      const reconciled = deploymentRepository.reconcileInterrupted();
      if (reconciled > 0) {
        console.log(`[deployments] Marked ${reconciled} interrupted deployment(s) as failed.`);
      }
    } catch (err) {
      console.warn('[deployments] Could not reconcile interrupted deployments:', err.message);
    }
  }

  /**
   * Create a new deployment session.
   *
   * `meta` is optional and additive — server.js currently calls this with
   * just (projectId, adapter), and that contract is preserved exactly.
   * Passing `{ triggeredBy, environment }` (once a caller is updated to
   * supply them) lets the persisted row carry that context from the
   * start; until then they're stored as null and can still be backfilled
   * later if needed.
   *
   * @returns {string} deploymentId
   */
  createSession(projectId, adapter, meta = {}) {
    let deploymentId = `deploy_${projectId}_${Date.now()}`;
    // A release build and an artifact deploy of the same project can start in
    // the same millisecond; never let the second one overwrite the first.
    for (let n = 2; this.sessions.has(deploymentId); n++) {
      deploymentId = `deploy_${projectId}_${Date.now()}_${n}`;
    }
    // Backs cooperative cancellation (T-33): the background deploy IIFE in
    // server.js checks `session.signal.aborted` between phases and bails
    // out with an error instead of continuing to run after abort() has been
    // called on it.
    const controller = new AbortController();
    const startedAt = new Date().toISOString();
    const session = {
      id: deploymentId,
      projectId,
      adapter,
      logs: [],
      subscribers: new Set(), // Set<(line: string) => void>
      status: 'pending', // pending | running | succeeded | failed | aborted
      startedAt,
      triggeredBy: meta.triggeredBy ?? null,
      environment: meta.environment ?? null,
      // Artifact deploy: 'build' | 'artifact_deploy' | 'artifact_rollback';
      // null for the legacy provider deploy flow (unchanged callers).
      kind: meta.kind ?? null,
      releaseId: meta.releaseId ?? null,
      targetId: meta.targetId ?? null,
      lastError: null,
      controller,
      signal: controller.signal,
    };

    this.sessions.set(deploymentId, session);

    // Persist immediately so the deployment shows up in history even if the
    // process dies before it reaches a terminal state. `node:sqlite` is
    // synchronous, so this can happen inline without turning createSession
    // async (server.js calls it synchronously and can't be changed). A
    // storage hiccup here must not break the deploy-trigger flow that calls
    // this, so the error is logged, not thrown or swallowed silently.
    try {
      deploymentRepository.create({
        id: deploymentId,
        projectId,
        status: session.status,
        startedAt,
        triggeredBy: session.triggeredBy,
        environment: session.environment,
        kind: session.kind,
        releaseId: session.releaseId,
        targetId: session.targetId,
      });
    } catch (err) {
      console.error(`[DeploymentManager] Failed to persist deployment ${deploymentId}:`, err.message);
    }

    return deploymentId;
  }

  /**
   * Get a session by deployment ID.
   *
   * Checks the live in-memory map first. If the id isn't there — either
   * because the deployment finished and was swept by cleanup(), or the
   * process restarted — falls back to a read-only reconstruction from
   * SQLite so old logs stay reachable (e.g. via the SSE route) even
   * though nothing will ever push new lines into it again.
   */
  getSession(deploymentId) {
    const live = this.sessions.get(deploymentId);
    if (live) return live;

    return this._loadArchivedSession(deploymentId);
  }

  /**
   * Reconstruct a read-only session-shaped object from the persisted row.
   * Returns null if the deployment is unknown or storage can't be read.
   * @returns {object|null}
   */
  _loadArchivedSession(deploymentId) {
    let record;
    try {
      record = deploymentRepository.findById(deploymentId);
    } catch (err) {
      console.error(`[DeploymentManager] Failed to load deployment ${deploymentId} from store:`, err.message);
      return null;
    }
    if (!record) return null;

    return {
      id: record.id,
      projectId: record.projectId,
      adapter: null,
      logs: record.logText ? record.logText.split('\n') : [],
      subscribers: new Set(), // nothing will ever publish to an archived session
      status: record.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      durationMs: record.durationMs,
      triggeredBy: record.triggeredBy,
      environment: record.environment,
      kind: record.kind ?? null,
      releaseId: record.releaseId ?? null,
      targetId: record.targetId ?? null,
      lastError: record.error,
      controller: null,
      signal: { aborted: record.status === 'aborted' },
      readOnly: true,
    };
  }

  /**
   * Push a log line to a session's buffer and notify all subscribers.
   */
  /**
   * Append a log line and notify subscribers.
   *
   * Subscribers receive `(line, index)` where `index` is the line's position in
   * the session buffer. That index is what the SSE layer sends as the event id,
   * so a reconnecting client can resume via `Last-Event-ID`. It is emitted from
   * here — the only place that knows the true position — rather than having each
   * consumer maintain its own shadow counter and hope the two stay in step.
   */
  pushLog(deploymentId, line) {
    const session = this.sessions.get(deploymentId);
    if (!session) return;

    const index = session.logs.length;
    session.logs.push(line);

    // Notify all subscribers (SSE connections, and anything added later).
    for (const callback of session.subscribers) {
      try {
        callback(line, index);
      } catch {
        // Subscriber may have disconnected; remove it
        session.subscribers.delete(callback);
      }
    }

    // server.js pushes a few more lines (the final "✓ completed" /
    // "✗ failed" message, then VPN teardown notices in its `finally`
    // block) *after* the setStatus() call that already persisted the
    // deployment — setStatus() can't know about those yet, and server.js
    // can't be reordered to push them first. Re-persisting the log body
    // here for any line that arrives once the session is already terminal
    // keeps the archived copy complete without writing anything at all
    // during the (much longer, much noisier) running phase.
    if (TERMINAL_STATUSES.includes(session.status)) {
      this._persistLogTail(session);
    }
  }

  /**
   * Refresh just the persisted log body for a session that's already
   * terminal — see the comment in pushLog() for why this exists. Cheap and
   * rare in practice (a handful of trailing lines at most), unlike a
   * per-line write during the live run, which is what T-54 explicitly
   * avoids.
   */
  _persistLogTail(session) {
    try {
      deploymentRepository.appendLogs(session.id, session.logs.join('\n'));
    } catch (err) {
      console.error(`[DeploymentManager] Failed to persist trailing logs for deployment ${session.id}:`, err.message);
    }
  }

  /**
   * Push a structured event to a session. Sent via SSE as a special log line.
   */
  pushEvent(deploymentId, eventType, payload) {
    this.pushLog(deploymentId, `__EVENT__:${JSON.stringify({ type: eventType, payload })}`);
  }

  /**
   * Register a callback to be resolved when MFA input is provided.
   */
  setMfaResolver(deploymentId, resolver, rejecter = null) {
    const session = this.sessions.get(deploymentId);
    if (session) {
      session.mfaResolver = resolver;
      session.mfaRejecter = rejecter;
    }
  }

  /**
   * Abandon a pending MFA challenge.
   *
   * Aborting a deployment that is waiting for a code has to unblock the waiter,
   * not just flip a status flag: the deploy routine is parked on that promise
   * and holds the project's concurrency lock until it settles. Without this the
   * operator cancels, sees nothing happen, and cannot start another deployment
   * for the project until the MFA timeout expires.
   *
   * @returns {boolean} whether a pending challenge was cancelled
   */
  cancelMfa(deploymentId, reason = 'Deployment aborted by user') {
    const session = this.getSession(deploymentId);
    if (!session || !session.mfaRejecter) return false;

    const rejecter = session.mfaRejecter;
    session.mfaResolver = null;
    session.mfaRejecter = null;
    rejecter(new Error(reason));
    return true;
  }

  /**
   * Resolve a pending MFA request.
   */
  resolveMfa(deploymentId, mfaData) {
    const session = this.sessions.get(deploymentId);
    if (session && session.mfaResolver) {
      session.mfaResolver(mfaData);
      session.mfaResolver = null;
      return true;
    }
    return false;
  }

  /**
   * Subscribe to log events for a deployment.
   * @returns {Function} unsubscribe function
   */
  /**
   * Subscribe to a deployment's log stream.
   * @param {(line: string, index: number) => void} callback
   * @returns {Function} unsubscribe
   */
  subscribe(deploymentId, callback) {
    const session = this.sessions.get(deploymentId);
    if (!session) return () => {};

    session.subscribers.add(callback);
    return () => session.subscribers.delete(callback);
  }

  /**
   * Update deployment status.
   *
   * `error` is optional and additive (same reasoning as createSession's
   * `meta` param) — existing 2-arg call sites keep working unchanged.
   * When it's supplied on a terminal status, it's persisted as the
   * deployment's stored error message.
   */
  setStatus(deploymentId, status, error = null) {
    const session = this.sessions.get(deploymentId);
    if (!session) return;

    session.status = status;
    if (error !== null) session.lastError = error;

    if (TERMINAL_STATUSES.includes(status)) {
      this._persistCompletion(session);
    }
  }

  /**
   * Write the final status/duration/error and the full log body to SQLite
   * in one shot per deployment (not per line — see appendLogs()'s docs).
   * Best-effort: storage errors are logged, never thrown, since this runs
   * from inside setStatus(), which callers don't expect to fail.
   */
  _persistCompletion(session) {
    const finishedAt = new Date().toISOString();
    const startedMs = new Date(session.startedAt).getTime();
    const durationMs = Number.isFinite(startedMs) ? Date.now() - startedMs : null;

    try {
      deploymentRepository.finish(session.id, {
        status: session.status,
        finishedAt,
        durationMs,
        error: session.lastError,
      });
      deploymentRepository.appendLogs(session.id, session.logs.join('\n'));
    } catch (err) {
      console.error(`[DeploymentManager] Failed to persist completion of deployment ${session.id}:`, err.message);
    }
  }

  /**
   * Abort a deployment.
   *
   * Flips status to 'aborted', trips the session's AbortController (so the
   * background IIFE in server.js stops advancing to the next phase the
   * next time it checks `session.signal.aborted`), and best-effort asks the
   * adapter itself to abort its in-flight operation.
   */
  async abort(deploymentId) {
    const session = this.sessions.get(deploymentId);
    if (!session) return;

    session.status = 'aborted';

    if (session.controller && !session.controller.signal.aborted) {
      session.controller.abort();
    }

    // Release anything parked on an MFA challenge before touching the adapter —
    // otherwise the deploy routine stays blocked on that promise and the
    // project's lock outlives the abort.
    this.cancelMfa(deploymentId);

    try {
      await session.adapter.abort();
    } catch (err) {
      console.error(`Error aborting deployment ${deploymentId}:`, err.message);
    }

    this._persistCompletion(session);
  }

  /**
   * Clean up finished sessions older than maxAge (default: 1 hour).
   *
   * Only ever touches the in-memory Map — the persisted row in SQLite is
   * untouched and stays queryable via deploymentRepository / getSession()
   * indefinitely. This used to be the only copy of a deployment's history,
   * so cleanup() meant "gone forever"; now it just means "no longer live".
   */
  cleanup(maxAgeMs = 3600000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, session] of this.sessions) {
      const started = new Date(session.startedAt).getTime();
      if (started < cutoff && TERMINAL_STATUSES.includes(session.status)) {
        this.sessions.delete(id);
      }
    }
  }

  /**
   * List all active/recent in-memory deployments. Deliberately memory-only
   * (unlike getSession()) — callers that want persisted history too should
   * combine this with deploymentRepository.listRecent(), as
   * GET /api/deploy/sessions does.
   */
  listSessions() {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      projectId: s.projectId,
      status: s.status,
      startedAt: s.startedAt,
      logCount: s.logs.length,
      kind: s.kind ?? null,
    }));
  }
}

// Singleton instance
const deploymentManager = new DeploymentManager();

module.exports = deploymentManager;
