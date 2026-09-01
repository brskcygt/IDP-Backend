/**
 * Host key management routes (T-17b / SEC-10).
 *
 * Thin HTTP wrapper around hostKeyRepository.js (already written for T-17
 * — used internally by services/ssh/hostKeyVerifier.js for TOFU/strict
 * pinning). This gives an operator a way to see what's pinned and to
 * forget a key — e.g. after a legitimate host key rotation, where 'tofu'
 * would otherwise permanently refuse to reconnect.
 *
 * Follows the same router-per-concern shape as routes/deploy.js / routes/
 * users.js. Mounted in server.js behind requireAuth, same as every other
 * route module.
 */
const express = require('express');
const router = express.Router();
const hostKeyRepository = require('../store/hostKeyRepository');
const auditLogger = require('../services/AuditLogger');
const { requirePermission } = require('../auth/permissions');

/**
 * GET /api/host-keys
 * Lists every pinned SSH host key (host, port, key type, fingerprint,
 * first/last seen). Same permission as VPN session management — both are
 * "operate the deployment infrastructure" admin actions.
 */
router.get('/', requirePermission('vpn:manage'), (req, res) => {
  res.json(hostKeyRepository.listAll());
});

/**
 * DELETE /api/host-keys/:host/:port
 * Forgets a pinned key so the next connection is treated as first-use
 * again (tofu re-learns it; strict will refuse until it's re-pinned some
 * other way). 404 when there was nothing pinned for (host, port).
 */
router.delete('/:host/:port', requirePermission('vpn:manage'), (req, res) => {
  const { host, port } = req.params;
  const parsedPort = Number.parseInt(port, 10);

  if (!Number.isInteger(parsedPort)) {
    return res.status(400).json({ error: 'port must be an integer.' });
  }

  const forgotten = hostKeyRepository.forget(host, parsedPort);
  if (!forgotten) {
    return res.status(404).json({ error: `No host key pinned for ${host}:${parsedPort}.` });
  }

  auditLogger.log(
    req.session?.user?.username,
    'HOST_KEY_FORGOTTEN',
    `Forgot pinned SSH host key for ${host}:${parsedPort}`,
    { host, port: parsedPort }
  );

  res.json({ success: true });
});

module.exports = router;
