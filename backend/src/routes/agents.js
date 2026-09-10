'use strict';

/**
 * Per-agent credential routes.
 *
 *   POST   /api/agents/:id/credentials  -> 201 { agentId, secret, gatewayUrl, cfAccess }
 *   DELETE /api/agents/:id/credentials  -> 204 (404 when the gateway had none)
 *
 * Every agent used to carry the one shared IDP_AGENT_API_TOKEN, so whoever
 * pulled it out of one customer's JAR could send SYSTEM commands to every
 * other customer's agent. The gateway now authenticates each agent with its
 * own secret; these routes let an operator issue/rotate/revoke that secret.
 *
 * Authorization: 'project:write' (admin) — the same permission the desktop
 * app requires to build an agent package (desktop/main/ipc/agentBuilder.js),
 * since the response is exactly what goes into that package.
 *
 * The secret is returned once, with Cache-Control: no-store, and never
 * written to the audit log or any other log.
 *
 * GET /api/agents stays in server.js unchanged; this router only adds the
 * /:id/credentials sub-routes.
 */
const express = require('express');
const { requirePermission } = require('../auth/permissions');
const AgentGatewayClient = require('../services/agent/AgentGatewayClient');

const { isValidAgentId } = AgentGatewayClient;
const INVALID_ID_MESSAGE =
  'Geçersiz agent ID: harf/rakamla başlamalı, 3-128 karakter, yalnızca harf, rakam, ".", "_" ve "-" içerebilir.';

/**
 * @param {object} deps
 * @param {{ publicUrl: string|null, publicUrlError: string|null, cfAccess: {clientId: string, clientSecret: string}|null }} deps.agentConfig
 * @param {{ log: Function }} deps.auditLogger
 * @param {() => AgentGatewayClient} [deps.createClient]
 * @param {import('express').RequestHandler} [deps.rateLimit]
 */
function createAgentsRouter({ agentConfig, auditLogger, createClient = () => new AgentGatewayClient(), rateLimit } = {}) {
  if (!agentConfig) throw new Error('createAgentsRouter: agentConfig is required.');
  if (!auditLogger) throw new Error('createAgentsRouter: auditLogger is required.');

  const router = express.Router();
  // Permission first (401/403 never consume a rate-limit slot), then the limiter.
  const guards = [requirePermission('project:write')];
  if (rateLimit) guards.push(rateLimit);

  router.post('/:id/credentials', ...guards, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const agentId = req.params.id;
    const username = req.session?.user?.username;

    if (!isValidAgentId(agentId)) {
      return res.status(400).json({ error: INVALID_ID_MESSAGE });
    }
    // Checked before any gateway call: a credential nobody can use (no address
    // to dial) must not rotate — and thereby disconnect — a live agent.
    if (!agentConfig.publicUrl) {
      return res.status(503).json({
        error:
          `${agentConfig.publicUrlError || 'IDP_AGENT_PUBLIC_URL tanımlı değil.'} ` +
          "Sunucu backend/.env içine agent'ların bağlanacağı adresi (ör. wss://agent.<alan>) yazıp backend'i yeniden başlatın.",
      });
    }

    let credential;
    try {
      credential = await createClient().issueCredential(agentId);
    } catch (err) {
      auditLogger.log(
        username,
        'AGENT_CREDENTIAL_ISSUE_FAILED',
        `Agent kimliği üretilemedi: ${agentId}`,
        { agentId, error: err.message },
        { outcome: 'failure' }
      );
      return res.status(502).json({ error: `Agent gateway kimlik üretemedi: ${err.message}` });
    }

    // agentId + who, nothing else: the secret must never reach the audit trail.
    auditLogger.log(username, 'AGENT_CREDENTIAL_ISSUED', `Agent kimliği üretildi/yenilendi: ${agentId}`, { agentId });

    return res.status(201).json({
      agentId: credential.agentId,
      secret: credential.secret,
      gatewayUrl: agentConfig.publicUrl,
      cfAccess: agentConfig.cfAccess
        ? { clientId: agentConfig.cfAccess.clientId, clientSecret: agentConfig.cfAccess.clientSecret }
        : null,
    });
  });

  router.delete('/:id/credentials', ...guards, async (req, res) => {
    const agentId = req.params.id;
    const username = req.session?.user?.username;

    if (!isValidAgentId(agentId)) {
      return res.status(400).json({ error: INVALID_ID_MESSAGE });
    }

    let revoked;
    try {
      revoked = await createClient().revokeCredential(agentId);
    } catch (err) {
      auditLogger.log(
        username,
        'AGENT_CREDENTIAL_REVOKE_FAILED',
        `Agent kimliği iptal edilemedi: ${agentId}`,
        { agentId, error: err.message },
        { outcome: 'failure' }
      );
      return res.status(502).json({ error: `Agent gateway kimliği iptal edemedi: ${err.message}` });
    }
    if (!revoked) {
      return res.status(404).json({ error: `Agent ${agentId} için kayıtlı kimlik yok.` });
    }

    auditLogger.log(username, 'AGENT_CREDENTIAL_REVOKED', `Agent kimliği iptal edildi: ${agentId}`, { agentId });
    return res.status(204).end();
  });

  return router;
}

module.exports = { createAgentsRouter };
