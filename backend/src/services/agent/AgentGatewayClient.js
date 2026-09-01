'use strict';

const { fetch } = require('undici');
const WebSocket = require('ws');
const crypto = require('crypto');

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
      throw new Error(body?.message || body?.error || `Agent backend request failed (${response.status}).`);
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
