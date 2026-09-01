'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FORWARDED_PROCESSES = new Set([
  'ping', 'current_version', 'download_file_progress', 'app_logs',
  'update_version', 'command_execution_result', 'get_app_config',
]);

function safeEqual(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bearerToken(request) {
  const header = String(request.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function isAuthorized(request, configuredToken) {
  return !configuredToken || safeEqual(bearerToken(request), configuredToken);
}

function send(socket, message) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

class AgentGateway {
  constructor({ token = '', logger = console, registryPath = '' } = {}) {
    this.token = token;
    this.logger = logger;
    this.sessions = new Map();
    this.agents = new Map();
    this.subscriptions = new Map();
    this.registryPath = registryPath;
    this.lastRegistryWrite = 0;
    this.loadRegistry();
  }

  loadRegistry() {
    if (!this.registryPath) return;
    try {
      const values = JSON.parse(fs.readFileSync(this.registryPath, 'utf8'));
      for (const item of Array.isArray(values) ? values : []) {
        if (item && typeof item.id === 'string') this.agents.set(item.id, { ...item, online: false });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger.warn('[gateway] Agent registry could not be read', { error: error.message });
    }
  }

  persistRegistry(force = false) {
    if (!this.registryPath || (!force && Date.now() - this.lastRegistryWrite < 30_000)) return;
    try {
      fs.mkdirSync(path.dirname(this.registryPath), { recursive: true });
      fs.writeFileSync(this.registryPath, JSON.stringify([...this.agents.values()].map((item) => ({ ...item, online: false })), null, 2));
      this.lastRegistryWrite = Date.now();
    } catch (error) {
      this.logger.warn('[gateway] Agent registry could not be written', { error: error.message });
    }
  }

  accept(socket, request) {
    if (!isAuthorized(request, this.token)) {
      socket.close(1008, 'Unauthorized');
      return;
    }

    const connection = { socket, id: null, type: null, details: {}, connectedAt: new Date().toISOString(), lastPing: null };
    socket.on('message', (raw) => this.handle(connection, raw));
    socket.on('close', () => this.remove(connection));
    socket.on('error', (error) => this.logger.warn('[gateway] WebSocket error', { connectionId: connection.id, error: error.message }));
  }

  handle(connection, raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return send(connection.socket, { type: 'server', process: 'error', payload: { message: 'Invalid JSON' } }); }
    if (!message || typeof message !== 'object' || typeof message.process !== 'string') return;

    if (message.process === 'handshake') return this.handshake(connection, message);
    if (!connection.id || message.agentId !== connection.id) return connection.socket.close(1008, 'Handshake required');

    if (message.process === 'subscribe' || message.process === 'unsubscribe') {
      if (connection.type !== 'web') return;
      return this.setSubscription(connection.id, message.payload?.targetAgentId, message.process === 'subscribe');
    }

    if (connection.type !== 'agent') return;
    if (message.process === 'ping') {
      connection.lastPing = new Date().toISOString();
      const agent = this.agents.get(connection.id);
      if (agent) { agent.lastPing = connection.lastPing; agent.online = true; }
      this.persistRegistry();
      send(connection.socket, { date: connection.lastPing, type: 'server', agentId: connection.id, process: 'pong', payload: {} });
    }
    if (FORWARDED_PROCESSES.has(message.process)) this.forward(connection.id, message.process, message.payload ?? {});
  }

  handshake(connection, message) {
    const id = String(message.agentId || '').trim();
    const type = message.type === 'agent' ? 'agent' : message.type === 'web' ? 'web' : null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(id) || !type) return connection.socket.close(1008, 'Invalid handshake');

    const previous = this.sessions.get(id);
    if (previous && previous.socket !== connection.socket) previous.socket.close(4001, 'Replaced by a newer connection');
    connection.id = id;
    connection.type = type;
    connection.details = message.payload && typeof message.payload === 'object' ? message.payload : {};
    this.sessions.set(id, connection);
    if (type === 'agent') this.agents.set(id, {
      id,
      connectedAt: connection.connectedAt,
      lastPing: null,
      details: connection.details,
      online: true,
    });
    if (type === 'agent') this.persistRegistry(true);
    send(connection.socket, { date: new Date().toISOString(), type: 'server', agentId: id, process: 'handshake_ack', payload: { connected: true } });
    this.logger.info('[gateway] Client connected', { id, type });
  }

  setSubscription(webId, targetAgentId, enabled) {
    const target = String(targetAgentId || '').trim();
    if (!target) return;
    const targets = this.subscriptions.get(webId) || new Set();
    if (enabled) targets.add(target); else targets.delete(target);
    if (targets.size) this.subscriptions.set(webId, targets); else this.subscriptions.delete(webId);
  }

  forward(agentId, process, payload) {
    for (const [webId, targets] of this.subscriptions) {
      if (!targets.has(agentId)) continue;
      const web = this.sessions.get(webId);
      if (web) send(web.socket, { date: new Date().toISOString(), type: 'agent', agentId, process, payload });
    }
  }

  remove(connection) {
    if (connection.id && this.sessions.get(connection.id) === connection) this.sessions.delete(connection.id);
    if (connection.type === 'agent') {
      const agent = this.agents.get(connection.id);
      if (agent) agent.online = false;
      this.persistRegistry(true);
    }
    if (connection.id) this.subscriptions.delete(connection.id);
  }

  listAgents() {
    return [...this.agents.values()].map((item) => ({
      id: item.id,
      online: item.online,
      last_ping: item.lastPing,
      connected_at: item.connectedAt,
      details: {
        version: String(item.details.version || ''),
        agent_version: String(item.details.agent_version || ''),
        os_info: String(item.details.os_info || ''),
      },
    })).sort((a, b) => b.connected_at.localeCompare(a.connected_at));
  }

  sendCommand(agentId, process, payload = '') {
    const connection = this.sessions.get(agentId);
    if (!connection || connection.type !== 'agent') return false;
    send(connection.socket, { date: new Date().toISOString(), type: 'server', agentId, process, payload });
    return true;
  }
}

module.exports = { AgentGateway, bearerToken, isAuthorized };
