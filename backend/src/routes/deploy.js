/**
 * SSE Log Streaming Route
 * 
 * GET /api/deploy/logs/:deploymentId
 *
 * Establishes a Server-Sent Events connection that streams real-time
 * deployment logs to the client. Supports:
 * - Replaying buffered logs (for late-joining clients)
 * - Real-time streaming of new log lines
 * - Automatic cleanup on client disconnect
 * - Deployment status events (started, succeeded, failed, aborted)
 */
const express = require('express');
const router = express.Router();
const deploymentManager = require('../services/DeploymentManager');
const auditLogger = require('../services/AuditLogger');
const deploymentRepository = require('../store/deploymentRepository');
const { requirePermission } = require('../auth/permissions');

/** Clamp a `?limit=` query param to a sane, always-defined page size. */
function parseLimit(rawLimit, { fallback = 50, max = 500 } = {}) {
  const parsed = Number.parseInt(rawLimit, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * GET /api/deploy/logs/:deploymentId
 * 
 * SSE endpoint. Client connects and receives:
 *   event: log       → data: { line: "..." }
 *   event: status    → data: { status: "running|succeeded|failed|aborted" }
 *   event: end       → data: { message: "Stream ended" }
 */
router.get('/logs/:deploymentId', requirePermission('project:read'), (req, res) => {
  const { deploymentId } = req.params;
  const session = deploymentManager.getSession(deploymentId);

  if (!session) {
    return res.status(404).json({ error: `Deployment ${deploymentId} not found.` });
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // Helper to send an SSE event. `id` is only set for log lines so the
  // client's EventSource can track its place in the buffer and send it
  // back via the `Last-Event-ID` header on reconnect (used to avoid
  // re-replaying lines the client already received).
  const sendEvent = (event, data, id) => {
    let frame = '';
    if (id !== undefined) {
      frame += `id: ${id}\n`;
    }
    frame += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    res.write(frame);
    // Flush the response if possible (Express doesn't have flush by default,
    // but the write above will be sent immediately with keep-alive)
  };

  // Determine where to resume from. A reconnecting EventSource automatically
  // sends back the `id` of the last event it received via `Last-Event-ID`,
  // which lets us replay only the lines the client hasn't seen yet instead
  // of dumping the whole buffer again on every reconnect.
  const lastEventIdHeader = req.headers['last-event-id'];
  let replayStartIndex = 0;
  if (lastEventIdHeader !== undefined) {
    const lastEventId = Number(lastEventIdHeader);
    const isValidIndex = Number.isInteger(lastEventId) &&
      lastEventId >= 0 &&
      lastEventId < session.logs.length;
    // Valid, in-range id → resume right after it. Missing/invalid/out-of-range
    // → fall back to a full replay from the start (safe default).
    replayStartIndex = isValidIndex ? lastEventId + 1 : 0;
  }

  // Phase 1: Replay buffered logs the client hasn't seen yet (for clients
  // that join mid-deployment, or reconnect after a drop).
  for (let i = replayStartIndex; i < session.logs.length; i++) {
    sendEvent('log', { line: session.logs[i] }, i);
  }

  // Send current status
  sendEvent('status', { status: session.status });

  // Phase 2: Subscribe to new log lines. Continue the index sequence from
  // wherever the replay left off so ids stay monotonic across the buffer
  // and live stream.
  // The index comes from DeploymentManager, which owns the buffer — no local
  // counter to drift out of sync with it (T-34b).
  const unsubscribe = deploymentManager.subscribe(deploymentId, (line, index) => {
    sendEvent('log', { line }, index);
  });

  // Phase 3: Watch for status changes via polling (lightweight)
  let lastStatus = session.status;
  const statusInterval = setInterval(() => {
    const currentSession = deploymentManager.getSession(deploymentId);
    if (!currentSession) {
      clearInterval(statusInterval);
      sendEvent('end', { message: 'Deployment session expired.' });
      res.end();
      return;
    }

    if (currentSession.status !== lastStatus) {
      lastStatus = currentSession.status;
      sendEvent('status', { status: lastStatus });

      // If deployment is terminal, end the stream
      if (['succeeded', 'failed', 'aborted'].includes(lastStatus)) {
        sendEvent('end', { message: `Deployment ${lastStatus}.` });
        clearInterval(statusInterval);
        // Give a brief delay so the client receives the final events
        setTimeout(() => res.end(), 500);
      }
    }
  }, 1000);

  // Keep-alive heartbeat (every 30s to prevent proxy/load balancer timeouts)
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  // Cleanup on client disconnect
  req.on('close', () => {
    unsubscribe();
    clearInterval(statusInterval);
    clearInterval(heartbeat);
    console.log(`SSE client disconnected from deployment ${deploymentId}`);
  });
});

/**
 * GET /api/deploy/sessions
 * List all active deployment sessions (for debugging / UI).
 *
 * T-54: merged with recent persisted history so a deployment that just
 * finished doesn't disappear from this list the moment cleanup() sweeps it
 * from memory. In-memory entries win on id collisions since they carry a
 * live `logCount`; persisted-only entries are appended after them.
 */
router.get('/sessions', requirePermission('project:read'), (req, res) => {
  const live = deploymentManager.listSessions();
  const liveIds = new Set(live.map((s) => s.id));

  const persisted = deploymentRepository
    .listRecent(50)
    .filter((d) => !liveIds.has(d.id))
    .map((d) => ({
      id: d.id,
      projectId: d.projectId,
      status: d.status,
      startedAt: d.startedAt,
      logCount: null, // not tracked for archived sessions; fetch logs-archive for the body
    }));

  res.json([...live, ...persisted]);
});

/**
 * GET /api/deploy/history?projectId=&limit=
 *
 * Persisted deployment history (T-54) — unlike /sessions, this reads only
 * from SQLite, so it includes deployments long past their in-memory
 * cleanup(). Omit `projectId` for the most recent deployments across every
 * project; pass it to scope to one project's history ("why did last
 * week's deploy break").
 */
router.get('/history', requirePermission('project:read'), (req, res) => {
  const { projectId } = req.query;
  const limit = parseLimit(req.query.limit);

  const history = projectId
    ? deploymentRepository.listByProject(String(projectId), limit)
    : deploymentRepository.listRecent(limit);

  res.json(history);
});

/**
 * GET /api/deploy/:deploymentId/logs-archive
 *
 * Plain-text log body for a finished deployment, read straight from
 * storage. This is the only way to get the full log for a deployment
 * that's no longer live (in-memory session already cleaned up, or the
 * server restarted since it ran) — the SSE endpoint below still works for
 * those too via DeploymentManager's DB fallback, but this is the simpler
 * one-shot fetch when a live stream isn't needed.
 */
router.get('/:deploymentId/logs-archive', requirePermission('project:read'), (req, res) => {
  const { deploymentId } = req.params;
  const deployment = deploymentRepository.findById(deploymentId);

  if (!deployment) {
    return res.status(404).json({ error: `Deployment ${deploymentId} not found.` });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(deployment.logText || '');
});

/**
 * POST /api/deploy/:deploymentId/abort
 * Abort a running deployment via REST (alternative to WebSocket abort).
 */
router.post('/:deploymentId/abort', requirePermission('deploy:abort'), async (req, res) => {
  const { deploymentId } = req.params;
  const session = deploymentManager.getSession(deploymentId);

  if (!session) {
    return res.status(404).json({ error: 'Deployment not found.' });
  }

  if (['succeeded', 'failed', 'aborted'].includes(session.status)) {
    return res.status(400).json({ error: `Deployment already ${session.status}.` });
  }

  // getSession() falls back to the database, so a row left at "running" by a
  // crashed server resolves here as a perfectly normal-looking session. Aborting
  // it would report success while doing nothing — the process it belonged to is
  // gone. Only a session still held in memory can actually be stopped.
  if (session.readOnly || !session.adapter) {
    return res.status(409).json({
      error:
        'This deployment is no longer running in this server process (it predates a restart), ' +
        'so it cannot be aborted. Its recorded status is stale.',
      deploymentId,
    });
  }

  await deploymentManager.abort(deploymentId);
  deploymentManager.pushLog(deploymentId, '[System] Deployment aborted by user via API.');
  auditLogger.log(req.session?.user?.username, 'DEPLOY_ABORTED', `Deployment aborted`, { deploymentId });
  res.json({ message: 'Abort signal sent.', deploymentId });
});

/**
 * POST /api/deploy/:deploymentId/submit-mfa
 * Submits an MFA code or approval back to the waiting deployment process.
 */
router.post('/:deploymentId/submit-mfa', requirePermission('deploy:trigger'), (req, res) => {
  const { deploymentId } = req.params;
  const { code } = req.body;

  const resolved = deploymentManager.resolveMfa(deploymentId, code);

  if (!resolved) {
    return res.status(400).json({ error: 'No active MFA request found for this deployment.' });
  }

  auditLogger.log(req.session?.user?.username, 'MFA_SUBMITTED', `MFA response submitted`, { deploymentId });
  res.json({ message: 'MFA response submitted successfully.' });
});

module.exports = router;
