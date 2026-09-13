'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const CREDENTIAL_HASH_PATTERN = /^[0-9a-f]{64}$/;
const FORWARDED_PROCESSES = new Set([
  'ping', 'current_version', 'download_file_progress', 'app_logs',
  'update_version', 'command_execution_result', 'get_app_config',
  // Artifact deploy (docs/ARTIFACT-DEPLOY.md): stage events, the single terminal result, status answers.
  'deploy_event', 'deploy_result', 'artifact_status_result',
]);
/** Typed commands the backend may send via POST /agent/artifact-command/:agentId. */
const ARTIFACT_COMMAND_PROCESSES = new Set(['artifact_deploy', 'artifact_rollback', 'artifact_cancel', 'artifact_status']);
const MAX_SUBSCRIPTIONS_PER_WEB = 256;
const DETAIL_FIELDS = ['version', 'agent_version', 'os_info'];

const CLOSE_POLICY = 1008;
const CLOSE_GOING_AWAY = 1001;
const CLOSE_REPLACED = 4001;
const CLOSE_CREDENTIAL = 4003;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// Bilinmeyen ID ile doğru ID arasında zamanlama farkı olmasın diye karşılaştırma her zaman yapılır.
const PLACEHOLDER_HASH = sha256Hex(`idp-agent-gateway:${crypto.randomUUID()}`);

/** Sabit zamanlı karşılaştırma: iki taraf da hash'lendiği için uzunluk bilgisi sızmaz. */
function safeEqual(actual, expected) {
  const expectedValue = String(expected ?? '');
  const a = crypto.createHash('sha256').update(String(actual ?? '')).digest();
  const b = crypto.createHash('sha256').update(expectedValue).digest();
  return crypto.timingSafeEqual(a, b) && expectedValue.length > 0;
}

function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(String(request?.headers?.authorization || '').trim());
  return match ? match[1].trim() : '';
}

/** Kontrol token'ı zorunludur: token boşsa hiçbir istek yetkili sayılmaz. */
function isAuthorized(request, configuredToken) {
  return Boolean(configuredToken) && safeEqual(bearerToken(request), configuredToken);
}

function isValidAgentId(value) {
  return typeof value === 'string' && AGENT_ID_PATTERN.test(value);
}

function generateSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function send(socket, message) {
  if (socket.readyState !== 1) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function closeSocket(socket, code, reason) {
  try { socket.close(code, reason); } catch { socket.terminate?.(); }
}

function sanitizeDetails(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const details = {};
  for (const field of DETAIL_FIELDS) {
    if (source[field] !== undefined && source[field] !== null) details[field] = String(source[field]).slice(0, 256);
  }
  return details;
}

function parseMessage(raw) {
  try {
    const message = JSON.parse(raw.toString());
    return message && typeof message === 'object' && typeof message.process === 'string' ? message : null;
  } catch {
    return undefined;
  }
}

/**
 * IP başına sabit pencereli başarısız deneme sayacı.
 * Yalnızca başarısız denemeler sayılır; geçerli kimlikle gelen agent hiçbir zaman engellenmez
 * (Cloudflare tüneli arkasında tüm bağlantılar aynı cloudflared adresinden gelir).
 */
class FailureRateLimiter {
  constructor({ limit = 30, windowMs = 60_000, maxEntries = 10_000, now = Date.now } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  entry(key) {
    const current = this.entries.get(key);
    if (current && current.resetAt > this.now()) return current;
    if (current) this.entries.delete(key);
    return null;
  }

  isBlocked(key) {
    const current = this.entry(String(key || 'unknown'));
    return Boolean(current && current.count >= this.limit);
  }

  /** Başarısızlığı kaydeder, penceredeki toplam başarısız deneme sayısını döner. */
  recordFailure(key) {
    const id = String(key || 'unknown');
    const current = this.entry(id);
    if (current) { current.count += 1; return current.count; }
    if (this.entries.size >= this.maxEntries) this.prune();
    this.entries.set(id, { count: 1, resetAt: this.now() + this.windowMs });
    return 1;
  }

  retryAfterSeconds(key) {
    const current = this.entry(String(key || 'unknown'));
    return current ? Math.max(1, Math.ceil((current.resetAt - this.now()) / 1000)) : 0;
  }

  prune() {
    const now = this.now();
    for (const [key, value] of this.entries) if (value.resetAt <= now) this.entries.delete(key);
    // Hâlâ doluysa en eski kayıtları at (Map ekleme sırasını korur).
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maxEntries) break;
      this.entries.delete(key);
    }
  }
}

class AgentGateway {
  constructor({
    logger = console,
    registryPath = '',
    heartbeatIntervalMs = 30_000,
    handshakeTimeoutMs = 15_000,
    rateLimiter = null,
  } = {}) {
    this.logger = logger;
    this.registryPath = registryPath;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.rateLimiter = rateLimiter;
    this.agents = new Map(); // kalıcı kayıt: id -> { id, connectedAt, lastPing, details, credentialHash, credentialIssuedAt }
    this.agentSessions = new Map(); // handshake'i tamamlanmış agent oturumları: id -> connection
    this.agentConnections = new Set(); // handshake bekleyenler dahil tüm agent soketleri
    this.webConnections = new Set(); // kontrol listener'daki backend abonelik soketleri
    this.lastRegistryWrite = 0;
    this.heartbeatTimer = null;
    this.loadRegistry();
  }

  // ---------------------------------------------------------------- registry

  loadRegistry() {
    if (!this.registryPath) return;
    try {
      const values = JSON.parse(fs.readFileSync(this.registryPath, 'utf8'));
      let withoutCredential = 0;
      for (const item of Array.isArray(values) ? values : []) {
        if (!item || !isValidAgentId(item.id)) continue;
        const hash = typeof item.credentialHash === 'string' && CREDENTIAL_HASH_PATTERN.test(item.credentialHash) ? item.credentialHash : null;
        if (!hash) withoutCredential += 1;
        this.agents.set(item.id, {
          id: item.id,
          connectedAt: typeof item.connectedAt === 'string' ? item.connectedAt : null,
          lastPing: typeof item.lastPing === 'string' ? item.lastPing : null,
          details: sanitizeDetails(item.details),
          credentialHash: hash,
          credentialIssuedAt: hash && typeof item.credentialIssuedAt === 'string' ? item.credentialIssuedAt : null,
        });
      }
      if (withoutCredential) {
        this.logger.warn('[gateway] Some registry entries have no credential and cannot connect until one is issued', { count: withoutCredential });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger.warn('[gateway] Agent registry could not be read', { error: error.message });
    }
  }

  serializeRegistry() {
    return [...this.agents.values()].map((item) => ({
      id: item.id,
      connectedAt: item.connectedAt ?? null,
      lastPing: item.lastPing ?? null,
      details: item.details ?? {},
      online: false,
      credentialHash: item.credentialHash ?? null,
      credentialIssuedAt: item.credentialIssuedAt ?? null,
    }));
  }

  /** Atomik yazım: geçici dosya + rename. Kimlik değişikliklerinde hata yukarı fırlatılır. */
  persistRegistry(force = false, { throwOnError = false } = {}) {
    if (!this.registryPath || (!force && Date.now() - this.lastRegistryWrite < 30_000)) return;
    const tmpPath = `${this.registryPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.registryPath), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(this.serializeRegistry(), null, 2), { mode: 0o600 });
      fs.renameSync(tmpPath, this.registryPath);
      this.lastRegistryWrite = Date.now();
    } catch (error) {
      try { fs.unlinkSync(tmpPath); } catch { /* geçici dosya oluşmamış olabilir */ }
      this.logger.warn('[gateway] Agent registry could not be written', { error: error.message });
      if (throwOnError) throw error;
    }
  }

  // ------------------------------------------------------------- credentials

  /**
   * Upgrade anında çağrılır. Bilinmeyen ID, kimliği olmayan kayıt veya yanlış secret için ok:false döner.
   * reason yalnızca log içindir; istemciye her durumda aynı 401 verilir.
   */
  verifyAgentCredential(agentId, secret) {
    const record = isValidAgentId(agentId) ? this.agents.get(agentId) : undefined;
    const expected = record?.credentialHash || null;
    const matches = crypto.timingSafeEqual(
      Buffer.from(sha256Hex(secret || ''), 'hex'),
      Buffer.from(expected || PLACEHOLDER_HASH, 'hex'),
    );
    if (!agentId || !secret) return { ok: false, reason: 'missing_credentials' };
    if (!isValidAgentId(agentId)) return { ok: false, reason: 'invalid_agent_id' };
    if (!record) return { ok: false, reason: 'unknown_agent' };
    if (!expected) return { ok: false, reason: 'no_credential' };
    return matches ? { ok: true, reason: null } : { ok: false, reason: 'invalid_secret' };
  }

  /** Yeni kimlik verir veya mevcut olanı döndürür (rotasyon). Secret yalnızca bu dönüşte bulunur. */
  issueCredential(agentId) {
    if (!isValidAgentId(agentId)) throw Object.assign(new Error('Invalid agent id.'), { code: 'INVALID_AGENT_ID' });
    const secret = generateSecret();
    const existing = this.agents.get(agentId);
    const previous = existing ? { credentialHash: existing.credentialHash, credentialIssuedAt: existing.credentialIssuedAt } : null;
    const record = existing || { id: agentId, connectedAt: null, lastPing: null, details: {} };
    record.credentialHash = sha256Hex(secret);
    record.credentialIssuedAt = new Date().toISOString();
    this.agents.set(agentId, record);
    try {
      this.persistRegistry(true, { throwOnError: true });
    } catch (error) {
      if (previous) Object.assign(record, previous); else this.agents.delete(agentId);
      throw error;
    }
    const rotated = Boolean(previous?.credentialHash);
    this.closeAgentConnections(agentId, 'Credential rotated');
    this.logger.info('[gateway] Agent credential issued', { id: agentId, rotated });
    return { agentId, secret, rotated };
  }

  /** Kaydı siler ve canlı oturumu kapatır. Bilinmeyen ID için false döner. */
  revokeCredential(agentId) {
    const record = isValidAgentId(agentId) ? this.agents.get(agentId) : undefined;
    if (!record) return false;
    this.agents.delete(agentId);
    try {
      this.persistRegistry(true, { throwOnError: true });
    } catch (error) {
      this.agents.set(agentId, record);
      throw error;
    }
    this.closeAgentConnections(agentId, 'Credential revoked');
    this.logger.info('[gateway] Agent credential revoked', { id: agentId });
    return true;
  }

  closeAgentConnections(agentId, reason) {
    for (const connection of [...this.agentConnections]) {
      if (connection.claimedId !== agentId) continue;
      this.detachAgent(connection);
      closeSocket(connection.socket, CLOSE_CREDENTIAL, reason);
    }
  }

  // ------------------------------------------------------------ agent sockets

  /** Agent listener'da, kimlik upgrade anında doğrulandıktan sonra çağrılır. */
  acceptAgent(socket, request, agentId) {
    const connection = {
      kind: 'agent',
      socket,
      claimedId: agentId,
      credentialHash: this.agents.get(agentId)?.credentialHash || null,
      id: null,
      closed: false,
      details: {},
      connectedAt: new Date().toISOString(),
      lastPing: null,
      missedPongs: 0,
      remoteAddress: request?.socket?.remoteAddress || 'unknown',
      handshakeTimer: null,
    };
    this.agentConnections.add(connection);
    connection.handshakeTimer = setTimeout(() => {
      if (connection.id || connection.closed) return;
      this.rejectAgent(connection, 'Handshake timeout');
    }, this.handshakeTimeoutMs);
    connection.handshakeTimer.unref?.();

    socket.on('pong', () => { connection.missedPongs = 0; });
    socket.on('message', (raw) => this.handleAgentMessage(connection, raw));
    socket.on('close', () => this.detachAgent(connection));
    socket.on('error', (error) => this.logger.warn('[gateway] Agent WebSocket error', { id: connection.claimedId, error: error.message }));
    return connection;
  }

  rejectAgent(connection, reason) {
    this.rateLimiter?.recordFailure(connection.remoteAddress);
    this.logger.warn('[gateway] Agent handshake rejected', { id: connection.claimedId, reason, remoteAddress: connection.remoteAddress });
    this.detachAgent(connection);
    closeSocket(connection.socket, CLOSE_POLICY, reason);
  }

  handleAgentMessage(connection, raw) {
    if (connection.closed) return;
    const message = parseMessage(raw);
    if (message === undefined) return send(connection.socket, { type: 'server', process: 'error', payload: { message: 'Invalid JSON' } });
    if (!message) return;
    if (message.type !== 'agent') return this.rejectAgent(connection, 'Only agent messages are accepted');

    if (!connection.id) {
      if (message.process !== 'handshake') return this.rejectAgent(connection, 'Handshake required');
      if (message.agentId !== connection.claimedId) return this.rejectAgent(connection, 'Agent ID mismatch');
      return this.completeAgentHandshake(connection, message);
    }

    if (message.agentId !== connection.id) return this.rejectAgent(connection, 'Agent ID mismatch');
    if (message.process === 'ping') {
      connection.lastPing = new Date().toISOString();
      const agent = this.agents.get(connection.id);
      if (agent) agent.lastPing = connection.lastPing;
      this.persistRegistry();
      send(connection.socket, { date: connection.lastPing, type: 'server', agentId: connection.id, process: 'pong', payload: {} });
    }
    if (FORWARDED_PROCESSES.has(message.process)) this.forward(connection.id, message.process, message.payload ?? {});
  }

  completeAgentHandshake(connection, message) {
    const id = connection.claimedId;
    const record = this.agents.get(id);
    // Upgrade ile handshake arasında kimlik döndürüldü/iptal edildiyse bağlantı geçersizdir.
    if (!record || !record.credentialHash || record.credentialHash !== connection.credentialHash) {
      this.detachAgent(connection);
      return closeSocket(connection.socket, CLOSE_CREDENTIAL, 'Credential revoked');
    }
    clearTimeout(connection.handshakeTimer);
    connection.id = id;
    connection.details = sanitizeDetails(message.payload);

    const previous = this.agentSessions.get(id);
    this.agentSessions.set(id, connection);
    if (previous && previous !== connection) {
      // Aynı kimlikle doğrulanmış yeni bağlantı: meşru yeniden bağlanma.
      this.detachAgent(previous);
      closeSocket(previous.socket, CLOSE_REPLACED, 'Replaced by a newer connection');
    }

    Object.assign(record, { connectedAt: connection.connectedAt, lastPing: null, details: connection.details });
    this.persistRegistry(true);
    send(connection.socket, { date: new Date().toISOString(), type: 'server', agentId: id, process: 'handshake_ack', payload: { connected: true } });
    this.logger.info('[gateway] Agent connected', { id, remoteAddress: connection.remoteAddress });
  }

  /** Bağlantıyı tüm tablolardan çıkarır. Birden çok kez çağrılabilir. */
  detachAgent(connection) {
    if (connection.closed) return;
    connection.closed = true;
    clearTimeout(connection.handshakeTimer);
    this.agentConnections.delete(connection);
    if (connection.id && this.agentSessions.get(connection.id) === connection) {
      this.agentSessions.delete(connection.id);
      this.persistRegistry(true);
      this.logger.info('[gateway] Agent disconnected', { id: connection.id });
    }
  }

  // ------------------------------------------------------------- heartbeat

  startHeartbeat() {
    if (this.heartbeatTimer || !this.heartbeatIntervalMs) return;
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  /** Her aralıkta ws ping gönderir; iki aralık boyunca pong gelmeyen soket sonlandırılır. */
  checkHeartbeats() {
    for (const connection of [...this.agentConnections]) {
      if (connection.missedPongs >= 2) {
        this.logger.warn('[gateway] Agent heartbeat timed out', { id: connection.claimedId });
        this.detachAgent(connection);
        connection.socket.terminate();
        continue;
      }
      connection.missedPongs += 1;
      try { connection.socket.ping(); } catch { /* soket kapanıyor olabilir */ }
    }
  }

  // --------------------------------------------------------------- web sockets

  /** Kontrol listener'da, kontrol token'ı upgrade anında doğrulandıktan sonra çağrılır. */
  acceptWeb(socket) {
    const connection = { kind: 'web', socket, id: null, closed: false, subscriptions: new Set(), handshakeTimer: null };
    this.webConnections.add(connection);
    connection.handshakeTimer = setTimeout(() => {
      if (!connection.id) closeSocket(socket, CLOSE_POLICY, 'Handshake timeout');
    }, this.handshakeTimeoutMs);
    connection.handshakeTimer.unref?.();
    socket.on('message', (raw) => this.handleWebMessage(connection, raw));
    socket.on('close', () => {
      connection.closed = true;
      clearTimeout(connection.handshakeTimer);
      this.webConnections.delete(connection);
    });
    socket.on('error', (error) => this.logger.warn('[gateway] Web WebSocket error', { id: connection.id, error: error.message }));
    return connection;
  }

  handleWebMessage(connection, raw) {
    if (connection.closed) return;
    const message = parseMessage(raw);
    if (message === undefined) return send(connection.socket, { type: 'server', process: 'error', payload: { message: 'Invalid JSON' } });
    if (!message) return;
    if (message.type !== 'web') return closeSocket(connection.socket, CLOSE_POLICY, 'Only web messages are accepted');

    if (!connection.id) {
      const id = String(message.agentId || '').trim();
      if (message.process !== 'handshake' || !isValidAgentId(id)) return closeSocket(connection.socket, CLOSE_POLICY, 'Invalid handshake');
      clearTimeout(connection.handshakeTimer);
      connection.id = id;
      send(connection.socket, { date: new Date().toISOString(), type: 'server', agentId: id, process: 'handshake_ack', payload: { connected: true } });
      return;
    }
    if (message.agentId !== connection.id) return closeSocket(connection.socket, CLOSE_POLICY, 'Handshake required');

    if (message.process === 'subscribe' || message.process === 'unsubscribe') {
      const target = String(message.payload?.targetAgentId || '').trim();
      if (!isValidAgentId(target)) return;
      if (message.process === 'unsubscribe') connection.subscriptions.delete(target);
      else if (connection.subscriptions.size < MAX_SUBSCRIPTIONS_PER_WEB) connection.subscriptions.add(target);
    }
  }

  forward(agentId, process, payload) {
    for (const web of this.webConnections) {
      if (web.id && web.subscriptions.has(agentId)) send(web.socket, { date: new Date().toISOString(), type: 'agent', agentId, process, payload });
    }
  }

  // ------------------------------------------------------------------ queries

  listAgents() {
    const sortKey = (item) => item.connected_at || item.credential_issued_at || '';
    return [...this.agents.values()].map((item) => ({
      id: item.id,
      online: this.agentSessions.has(item.id),
      last_ping: item.lastPing ?? null,
      connected_at: item.connectedAt ?? null,
      credential_issued_at: item.credentialIssuedAt ?? null,
      details: {
        version: String(item.details?.version || ''),
        agent_version: String(item.details?.agent_version || ''),
        os_info: String(item.details?.os_info || ''),
      },
    })).sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  }

  stats() {
    return { agents: this.agents.size, online: this.agentSessions.size };
  }

  sendCommand(agentId, process, payload = '') {
    const connection = this.agentSessions.get(agentId);
    if (!connection || connection.closed) return false;
    return send(connection.socket, { date: new Date().toISOString(), type: 'server', agentId, process, payload });
  }

  stop() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const connection of [...this.agentConnections]) {
      this.detachAgent(connection);
      closeSocket(connection.socket, CLOSE_GOING_AWAY, 'Gateway shutting down');
    }
    for (const connection of [...this.webConnections]) closeSocket(connection.socket, CLOSE_GOING_AWAY, 'Gateway shutting down');
  }
}

module.exports = {
  AgentGateway,
  ARTIFACT_COMMAND_PROCESSES,
  FORWARDED_PROCESSES,
  FailureRateLimiter,
  bearerToken,
  isAuthorized,
  isValidAgentId,
  safeEqual,
  sha256Hex,
  AGENT_ID_PATTERN,
};
