'use strict';

/**
 * Per-agent credential routes.
 *
 *   POST   /api/agents/:id/credentials  -> 201 { agentId, secret, gatewayUrl, cfAccess }
 *   DELETE /api/agents/:id/credentials  -> 204 (404 when the gateway had none)
 *   GET    /api/agents/allowlist        -> 200 { enforcing, entries }
 *   POST   /api/agents/allowlist        -> 201 { enforcing, entries }
 *   DELETE /api/agents/allowlist        -> 200 { enforcing, entries } (404 when absent)
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

  // Source-IP allowlist for the agent listener. Registered before the
  // '/:id/...' routes below; '/allowlist' is a single segment and those need
  // two, so the two never collide.
  //
  // The gateway is the one that validates an entry and owns the file; these
  // routes only shape-check, forward, and write the audit record.
  router.get('/allowlist', ...guards, async (req, res) => {
    try {
      return res.json(await createClient().listAllowlist());
    } catch (err) {
      return res.status(502).json({ error: `Agent gateway erişim listesi okunamadı: ${err.message}` });
    }
  });

  router.post('/allowlist', ...guards, async (req, res) => {
    const username = req.session?.user?.username;
    const entry = typeof req.body?.entry === 'string' ? req.body.entry.trim() : '';
    const note = typeof req.body?.note === 'string' ? req.body.note : '';

    if (!entry) {
      return res.status(400).json({ error: 'entry alanı zorunlu: bir IPv4/IPv6 adresi ya da CIDR (örn. 203.0.113.4 veya 203.0.113.0/24).' });
    }

    let result;
    try {
      result = await createClient().addAllowlistEntry(entry, { note, addedBy: username || null });
    } catch (err) {
      // A malformed or duplicate entry is the operator's mistake, not a
      // gateway failure — pass 400 through instead of masking it as 502.
      if (err.status === 400 || err.status === 409) {
        return res.status(err.status).json({ error: err.message });
      }
      auditLogger.log(
        username,
        'AGENT_ALLOWLIST_ADD_FAILED',
        `Agent erişim listesine eklenemedi: ${entry}`,
        { entry, error: err.message },
        { outcome: 'failure' }
      );
      return res.status(502).json({ error: `Agent gateway erişim listesine ekleyemedi: ${err.message}` });
    }

    auditLogger.log(username, 'AGENT_ALLOWLIST_ADDED', `Agent erişim listesine eklendi: ${entry}`, { entry, note });
    return res.status(201).json(result);
  });

  router.delete('/allowlist', ...guards, async (req, res) => {
    const username = req.session?.user?.username;
    const entry = typeof req.body?.entry === 'string' ? req.body.entry.trim() : '';

    if (!entry) {
      return res.status(400).json({ error: 'entry alanı zorunlu.' });
    }

    let result;
    try {
      result = await createClient().removeAllowlistEntry(entry);
    } catch (err) {
      auditLogger.log(
        username,
        'AGENT_ALLOWLIST_REMOVE_FAILED',
        `Agent erişim listesinden çıkarılamadı: ${entry}`,
        { entry, error: err.message },
        { outcome: 'failure' }
      );
      return res.status(502).json({ error: `Agent gateway erişim listesinden çıkaramadı: ${err.message}` });
    }
    if (!result) {
      return res.status(404).json({ error: `${entry} listede yok.` });
    }

    // Worth its own action name: dropping the last entry turns the whole
    // restriction off, and the audit trail has to show who did that.
    auditLogger.log(
      username,
      'AGENT_ALLOWLIST_REMOVED',
      `Agent erişim listesinden çıkarıldı: ${entry}${result.enforcing ? '' : ' (liste boşaldı, kısıt artık uygulanmıyor)'}`,
      { entry, enforcing: result.enforcing }
    );
    return res.json(result);
  });

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
