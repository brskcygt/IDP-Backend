'use strict';

/**
 * Per-deploy artifact download tokens (contract 1.3).
 *
 * A token is 32 random bytes (base64url), handed to the agent ONLY inside
 * the `artifact_deploy` payload and presented back as
 * `Authorization: Bearer <token>` on GET /api/artifacts/:id/download.
 * Only its sha256 is stored. A token is bound to one artifact, expires after
 * TOKEN_TTL_MS, allows TOKEN_MAX_USES downloads (agent retries) and is
 * deleted as soon as its deployment reaches a terminal state.
 *
 * Tokens are never logged — not here, not by callers.
 */

const crypto = require('node:crypto');

const TOKEN_TTL_MS = 30 * 60 * 1000;
const TOKEN_MAX_USES = 5;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * @param {object} deps
 * @param {object} deps.repository - artifactDeployRepository (insertToken/consumeToken/...).
 * @param {() => number} [deps.now]
 * @param {number} [deps.ttlMs]
 * @param {number} [deps.maxUses]
 */
function createDownloadTokenService({ repository, now = () => Date.now(), ttlMs = TOKEN_TTL_MS, maxUses = TOKEN_MAX_USES } = {}) {
  if (!repository) throw new Error('createDownloadTokenService: repository is required.');

  return {
    /**
     * @param {{ artifactId: string, agentId: string, deploymentId: string }} binding
     * @returns {string} the plaintext token (goes into the agent payload only)
     */
    issue({ artifactId, agentId, deploymentId }) {
      if (!artifactId) throw new Error('A download token must be bound to an artifact.');
      try {
        repository.deleteExpiredTokens(now());
      } catch (err) {
        console.warn('[artifacts] Could not prune expired download tokens:', err.message);
      }
      const token = crypto.randomBytes(32).toString('base64url');
      repository.insertToken({
        tokenHash: hashToken(token),
        artifactId,
        agentId: agentId || null,
        deploymentId: deploymentId || null,
        expiresAt: now() + ttlMs,
        maxUses,
        createdAt: new Date(now()).toISOString(),
      });
      return token;
    },

    /**
     * Verifies a presented token for `artifactId` and counts one use.
     * Returns null for anything invalid — callers answer 401 without detail.
     * `agentId` (optional `X-IDP-Agent-Id` header) must match the binding when sent.
     * @returns {{ artifactId: string, agentId: string|null, deploymentId: string|null }|null}
     */
    consume(token, artifactId, { agentId } = {}) {
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
      if (typeof artifactId !== 'string' || artifactId === '') return null;
      const record = repository.consumeToken(hashToken(token), artifactId, now());
      if (!record) return null;
      if (agentId && record.agentId && agentId !== record.agentId) return null;
      return record;
    },

    /** Called when a deployment finishes: its tokens stop working immediately. */
    revokeForDeployment(deploymentId) {
      if (!deploymentId) return 0;
      return repository.deleteTokensForDeployment(deploymentId);
    },
  };
}

module.exports = { createDownloadTokenService, hashToken, TOKEN_TTL_MS, TOKEN_MAX_USES, TOKEN_PATTERN };
