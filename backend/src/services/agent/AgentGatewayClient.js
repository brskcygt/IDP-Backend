'use strict';

const { fetch } = require('undici');
const WebSocket = require('ws');
const crypto = require('crypto');

/**
 * Agent ID format shared with idp-agent-gateway (its credential endpoints
 * reject anything else). Checked here too so a malformed ID never hits the wire.
 */
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

function isValidAgentId(value) {
  return typeof value === 'string' && AGENT_ID_PATTERN.test(value);
}

function assertValidAgentId(agentId) {
  if (!isValidAgentId(agentId)) {
    const error = new Error('Invalid agent ID.');
    error.status = 400;
    throw error;
  }
}

function normalizeBaseUrl(value) {
  const url = String(value || process.env.IDP_AGENT_API_URL || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('IDP agent backend URL is not configured (IDP_AGENT_API_URL).');
  return url;
}

function websocketUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

class AgentGatewayClient {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token || process.env.IDP_AGENT_API_TOKEN || '';
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        accept: 'application/json',
        ...(this.token ? { authorization: this.token.startsWith('Bearer ') ? this.token : `Bearer ${this.token}` } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
      signal: options.signal || AbortSignal.timeout(15000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.type === false) {
      const error = new Error(body?.message || body?.error || `Agent backend request failed (${response.status}).`);
      // Lets callers map a specific gateway answer (e.g. 404 on revoke) without parsing messages.
      error.status = response.status;
      throw error;
    }
    return body;
  }

  async listAgents() {
    const body = await this.request('/agent/all');
    return Array.isArray(body?.data) ? body.data : [];
  }

  async sendDeploy(agentId, command) {
    return this.request(`/agent/run-deploy-command/${encodeURIComponent(agentId)}`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
  }

  /**
   * Issues (or rotates) the per-agent credential. On rotation the gateway
   * closes the session that used the previous secret. The secret is meant to
   * be shown to the caller once; never log it.
   * @param {string} agentId
   * @returns {Promise<{ agentId: string, secret: string }>}
   */
  async issueCredential(agentId) {
    assertValidAgentId(agentId);
    const body = await this.request(`/agent/credentials/${encodeURIComponent(agentId)}`, { method: 'POST' });
    if (!body || typeof body.secret !== 'string' || body.secret === '') {
      throw new Error('Agent gateway returned no credential secret.');
    }
    return { agentId: typeof body.agentId === 'string' && body.agentId ? body.agentId : agentId, secret: body.secret };
  }

  /**
   * Revokes the per-agent credential.
   * @param {string} agentId
   * @returns {Promise<boolean>} true when revoked, false when the gateway had no credential for this ID (404).
   */
  async revokeCredential(agentId) {
    assertValidAgentId(agentId);
    try {
      await this.request(`/agent/credentials/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
      return true;
    } catch (error) {
      if (error.status === 404) return false;
      throw error;
    }
  }

  subscribe(agentId, handlers = {}) {
    const listenerId = `idp-${crypto.randomUUID()}`;
    const socket = new WebSocket(websocketUrl(this.baseUrl), {
      headers: this.token ? { authorization: this.token.startsWith('Bearer ') ? this.token : `Bearer ${this.token}` } : undefined,
    });
    let closed = false;

    const send = (process, payload = '') => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({
        date: new Date().toISOString(),
        type: 'web',
        agentId: listenerId,
        process,
        payload,
      }));
    };

    socket.on('open', () => {
      send('handshake');
      send('subscribe', { targetAgentId: agentId });
      handlers.onOpen?.();
    });
    socket.on('message', (raw) => {
      try { handlers.onMessage?.(JSON.parse(raw.toString())); }
      catch (error) { handlers.onError?.(error); }
    });
    socket.on('error', (error) => handlers.onError?.(error));
    socket.on('close', () => {
      if (!closed) handlers.onClose?.();
    });

    return () => {
      if (closed) return;
      closed = true;
      send('unsubscribe', { targetAgentId: agentId });
      socket.close();
    };
  }
}

module.exports = AgentGatewayClient;
module.exports.normalizeBaseUrl = normalizeBaseUrl;
module.exports.AGENT_ID_PATTERN = AGENT_ID_PATTERN;
module.exports.isValidAgentId = isValidAgentId;
