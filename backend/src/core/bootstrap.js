'use strict';

/**
 * Transport-agnostic startup sequence (T-91).
 *
 * Both the Express HTTP shell (`src/server.js`) and the Electron IPC shell
 * (`desktop/main/index.js`) need the exact same "get the process ready to
 * serve requests" work done before any request/handler can run:
 *
 *   - open/migrate the SQLite database and seed it on a fresh install
 *     (legacy projects.json / audit_logs.json migration included)
 *   - recover any project stuck in 'Deploying' from a previous run back to
 *     'Idle' (a crash or force-quit can't leave a project permanently
 *     locked out of future deploys)
 *   - construct the DeploymentManager singleton, which — as a side effect
 *     of being required for the first time — reconciles any deployment row
 *     the database still lists as in-flight (belongs to a process that no
 *     longer exists) into 'failed'
 *   - resolve the secret store singleton (logs whether encryption is
 *     configured)
 *
 * None of this is HTTP-specific — nothing here touches Express, a port, or
 * a socket. `server.js` calls this instead of duplicating the sequence, so
 * there is exactly one place this logic can drift from what Electron does.
 *
 * Idempotent: calling `bootstrapCore()` more than once in the same process
 * is a no-op after the first call (each `require()` below is already
 * memoized by Node's module cache — `projectService.loadProjects()` is the
 * only piece that isn't naturally idempotent on its own, so this module
 * guards it explicitly).
 */
const projectService = require('./projects/projectService');
// Requiring these has real side effects at module-load time (DeploymentManager's
// constructor reconciles interrupted deployments; secretStoreInstance logs its
// key status) — required here, not just incidentally pulled in by something
// else, so `bootstrapCore()` alone is a complete, self-contained startup
// sequence regardless of what else has been required yet.
require('../services/DeploymentManager');
require('./secrets/secretStoreInstance');

let bootstrapped = false;

/**
 * Runs the shared startup sequence exactly once per process.
 * Safe to call from both the Express shell and the Electron main process.
 */
function bootstrapCore() {
  if (bootstrapped) return;
  bootstrapped = true;
  projectService.loadProjects();
}

module.exports = { bootstrapCore };
