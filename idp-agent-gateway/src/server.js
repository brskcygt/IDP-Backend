'use strict';

const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { AgentGateway, ARTIFACT_COMMAND_PROCESSES, FailureRateLimiter, bearerToken, isAuthorized, isValidAgentId } = require('./gateway');
const { Allowlist } = require('./allowlist');
const { normalizeAddress, matchesAny } = require('./ipMatch');

const SERVICE = 'idp-agent-gateway';
const MAX_WS_PAYLOAD = 1024 * 1024;
const MAX_ARTIFACT_COMMAND_BYTES = 256 * 1024;
const BODY_TOO_LARGE = 'Request body is too large.';
const NOT_FOUND = { type: false, message: 'Not found.' };

function parsePort(value, fallback, name) {
  if (value === undefined || String(value).trim() === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${name} geçerli bir port değil: ${value}`);
  return port;
}

function loadConfig(env = process.env) {
  return {
    agentHost: env.IDP_AGENT_GATEWAY_HOST || '0.0.0.0',
    agentPort: parsePort(env.IDP_AGENT_GATEWAY_PORT, 7003, 'IDP_AGENT_GATEWAY_PORT'),
    controlHost: env.IDP_AGENT_GATEWAY_CONTROL_HOST || '127.0.0.1',
    controlPort: parsePort(env.IDP_AGENT_GATEWAY_CONTROL_PORT, 7004, 'IDP_AGENT_GATEWAY_CONTROL_PORT'),
    token: String(env.IDP_AGENT_API_TOKEN || '').trim(),
    registryPath: env.IDP_AGENT_REGISTRY_PATH || path.join(process.cwd(), 'data', 'agents.json'),
    allowlistPath: env.IDP_AGENT_ALLOWLIST_PATH || path.join(process.cwd(), 'data', 'agent-allowlist.json'),
    trustedProxies: parseTrustedProxies(env.IDP_AGENT_TRUSTED_PROXIES),
  };
}

/**
 * Networks whose `X-Forwarded-For` / `CF-Connecting-IP` headers may be believed.
 *
 * Empty by default, and that default is the safe one: with nothing trusted the
 * gateway only ever looks at the TCP peer address, so a client that reaches
 * port 7003 directly cannot hand itself an approved source IP in a header.
 * Only set this once a tunnel or reverse proxy really does sit in front, and
 * set it to that proxy's addresses only.
 */
function parseTrustedProxies(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function isLoopback(host) {
  return host === 'localhost' || host === '::1' || String(host).startsWith('127.');
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  response.end(payload);
}

async function readJson(request, maxBytes = 70 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error(BODY_TOO_LARGE), { tooLarge: true });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function requestPath(request) {
  try { return new URL(request.url, 'http://localhost').pathname; } catch { return ''; }
}

/** Upgrade edilmeden önce ham sokete HTTP yanıtı yazıp bağlantıyı kapatır. */
function rejectUpgrade(socket, status, message, extraHeaders = {}) {
  if (!socket.writable || socket.destroyed) return socket.destroy();
  const body = JSON.stringify({ type: false, message });
  const headers = {
    Connection: 'close',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  };
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n${body}`);
}

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => { server.off('error', onError); resolve(server.address()); });
  });
}

/**
 * İki listener kurar:
 * - agent listener (dışarı açık, Cloudflare tüneli buraya): yalnızca kimliği doğrulanmış agent WS + GET /health.
 * - control listener (loopback): backend REST uçları, kimlik yönetimi ve `type:'web'` abonelik WS'i.
 */
function createGatewayApp({
  token,
  registryPath = '',
  allowlistPath = '',
  trustedProxies = [],
  agentHost = '0.0.0.0',
  agentPort = 7003,
  controlHost = '127.0.0.1',
  controlPort = 7004,
  logger = console,
  heartbeatIntervalMs = 30_000,
  handshakeTimeoutMs = 15_000,
  rateLimit = {},
} = {}) {
  const controlToken = String(token || '').trim();
  if (!controlToken) {
    throw new Error('IDP_AGENT_API_TOKEN ayarlı değil. Kontrol API token\'ı zorunludur (backend ile aynı, uzun ve rastgele bir değer); gateway başlatılmadı.');
  }
  if (!isLoopback(controlHost)) {
    throw new Error(`Kontrol listener yalnizca loopback adrese baglanabilir; '${controlHost}' reddedildi.`);
  }
  if (agentPort !== 0 && agentPort === controlPort) {
    throw new Error(`Agent ve kontrol listener aynı porta (${agentPort}) bağlanamaz.`);
  }

  const rateLimiter = new FailureRateLimiter(rateLimit);
  const gateway = new AgentGateway({ logger, registryPath, heartbeatIntervalMs, handshakeTimeoutMs, rateLimiter });
  const allowlist = new Allowlist({ filePath: allowlistPath, logger });
  if (!allowlist.enforcing) {
    logger.info('[gateway] Agent source-IP allowlist is empty — every source address is accepted.');
  }

  /**
   * The address an allowlist decision is made against.
   *
   * Forwarded headers are only read when the TCP peer is a trusted proxy;
   * otherwise they are ignored entirely, since anyone who can open a socket to
   * this port could otherwise set them freely.
   */
  function effectiveClientIp(request) {
    const peer = normalizeAddress(request.socket.remoteAddress) || 'unknown';
    if (trustedProxies.length === 0 || !matchesAny(trustedProxies, peer)) return peer;

    const cfConnecting = normalizeAddress(request.headers['cf-connecting-ip']);
    if (cfConnecting) return cfConnecting;

    // Right-most entry: the ones further left were supplied by hops we do not
    // control and can be forged.
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',');
    for (let i = forwarded.length - 1; i >= 0; i -= 1) {
      const candidate = normalizeAddress(forwarded[i]);
      if (candidate) return candidate;
    }
    return peer;
  }

  // ------------------------------------------------------------ agent listener

  const agentServer = http.createServer((request, response) => {
    if (request.method === 'GET' && requestPath(request) === '/health') return json(response, 200, { ok: true, service: SERVICE });
    return json(response, 404, NOT_FOUND);
  });
  const agentSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

  agentServer.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    const remoteAddress = request.socket.remoteAddress || 'unknown';
    // CF-Connecting-IP doğrulanamaz; yalnızca log bağlamı içindir. Allowlist
    // kararı effectiveClientIp() üzerinden verilir ve bu header'a yalnızca
    // güvenilir bir proxy arkasındayken bakılır.
    const cfConnectingIp = String(request.headers['cf-connecting-ip'] || '').slice(0, 64) || undefined;
    if (requestPath(request) !== '/') return rejectUpgrade(socket, 404, NOT_FOUND.message);

    // Ahead of credential verification on purpose: a source that is not
    // allowed never gets to probe agent ids or secrets. Rejections here are
    // deliberately NOT fed to the failure rate limiter — behind a tunnel every
    // agent shares one peer address, and one blocked source would then lock
    // out the legitimate ones.
    const clientIp = effectiveClientIp(request);
    if (!allowlist.allows(clientIp)) {
      logger.warn('[gateway] Agent upgrade rejected by source allowlist', { remoteAddress, clientIp, cfConnectingIp });
      return rejectUpgrade(socket, 403, 'Forbidden');
    }

    const agentId = String(request.headers['x-idp-agent-id'] || '').trim();
    const result = gateway.verifyAgentCredential(agentId, bearerToken(request));
    if (!result.ok) {
      const failures = rateLimiter.recordFailure(remoteAddress);
      if (failures > rateLimiter.limit) {
        if (failures === rateLimiter.limit + 1) logger.warn('[gateway] Agent upgrade rate limited', { remoteAddress, cfConnectingIp, failures });
        return rejectUpgrade(socket, 429, 'Too many failed attempts.', { 'Retry-After': rateLimiter.retryAfterSeconds(remoteAddress) });
      }
      logger.warn('[gateway] Agent upgrade rejected', { remoteAddress, cfConnectingIp, agentId: isValidAgentId(agentId) ? agentId : undefined, reason: result.reason });
      return rejectUpgrade(socket, 401, 'Unauthorized');
    }
    agentSockets.handleUpgrade(request, socket, head, (ws) => gateway.acceptAgent(ws, request, agentId));
  });

  // ---------------------------------------------------------- control listener

  function handleCredential(request, response, rawId) {
    if (request.method !== 'POST' && request.method !== 'DELETE') {
      response.setHeader('allow', 'POST, DELETE');
      return json(response, 405, { type: false, message: 'Method not allowed.' });
    }
    let agentId = '';
    try { agentId = decodeURIComponent(rawId); } catch { /* geçersiz yüzde kodlaması → 400 */ }
    if (!isValidAgentId(agentId)) return json(response, 400, { type: false, message: 'Invalid agent id. Expected ^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$.' });

    if (request.method === 'POST') {
      const { secret } = gateway.issueCredential(agentId);
      return json(response, 201, { agentId, secret });
    }
    if (!gateway.revokeCredential(agentId)) return json(response, 404, { type: false, message: `Agent ${agentId} is not registered.` });
    response.writeHead(204, { 'cache-control': 'no-store' });
    return response.end();
  }

  /**
   * POST /agent/artifact-command/:agentId {process, payload}: typed artifact
   * deploy commands (docs/ARTIFACT-DEPLOY.md). Only allowlisted processes,
   * object payloads, bodies up to 256 KB. The payload carries per-deploy
   * download tokens, so it is never logged — only agent id, process and
   * deployId/requestId.
   */
  async function handleArtifactCommand(request, response, rawId) {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return json(response, 405, { type: false, message: 'Method not allowed.' });
    }
    let agentId = '';
    try { agentId = decodeURIComponent(rawId); } catch { /* geçersiz yüzde kodlaması → 400 */ }
    if (!isValidAgentId(agentId)) return json(response, 400, { type: false, message: 'Invalid agent id. Expected ^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$.' });

    let body;
    try {
      body = await readJson(request, MAX_ARTIFACT_COMMAND_BYTES);
    } catch (error) {
      if (error.tooLarge) return json(response, 413, { type: false, message: 'Artifact command body exceeds 256 KB.' });
      return json(response, 400, { type: false, message: 'Invalid JSON body.' });
    }
    const process = body && typeof body.process === 'string' ? body.process : '';
    if (!ARTIFACT_COMMAND_PROCESSES.has(process)) {
      return json(response, 400, { type: false, message: `process must be one of: ${[...ARTIFACT_COMMAND_PROCESSES].join(', ')}.` });
    }
    const payload = body.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return json(response, 400, { type: false, message: 'payload must be a JSON object.' });
    }
    if (!gateway.sendCommand(agentId, process, payload)) {
      return json(response, 404, { type: false, message: `Agent ${agentId} is not connected.` });
    }
    const correlation = typeof payload.deployId === 'string' ? { deployId: payload.deployId.slice(0, 64) }
      : typeof payload.requestId === 'string' ? { requestId: payload.requestId.slice(0, 64) } : {};
    logger.info('[gateway] Artifact command sent', { id: agentId, process, ...correlation });
    return json(response, 200, { type: true, sent: true });
  }

  /** GET lists the allowlist, POST adds an entry, DELETE removes one. */
  async function handleAllowlist(request, response) {
    if (request.method === 'GET') {
      return json(response, 200, {
        type: true,
        message: 'Allowlist fetched.',
        data: { enforcing: allowlist.enforcing, entries: allowlist.list() },
      });
    }

    if (request.method === 'POST' || request.method === 'DELETE') {
      let body;
      try {
        body = await readJson(request);
      } catch (error) {
        if (error.tooLarge) return json(response, 413, { type: false, message: BODY_TOO_LARGE });
        return json(response, 400, { type: false, message: 'Invalid JSON body.' });
      }
      const entry = body && typeof body.entry === 'string' ? body.entry : '';

      if (request.method === 'DELETE') {
        let removed;
        try {
          removed = allowlist.remove(entry);
        } catch (error) {
          return json(response, 500, { type: false, message: `Allowlist could not be written: ${error.message}` });
        }
        if (!removed) return json(response, 404, { type: false, message: 'Entry not found.' });
        logger.info('[gateway] Allowlist entry removed', { entry, enforcing: allowlist.enforcing });
        return json(response, 200, { type: true, message: 'Entry removed.', data: { enforcing: allowlist.enforcing, entries: allowlist.list() } });
      }

      let result;
      try {
        result = allowlist.add(entry, {
          note: typeof body.note === 'string' ? body.note : '',
          addedBy: typeof body.addedBy === 'string' ? body.addedBy : null,
        });
      } catch (error) {
        return json(response, 500, { type: false, message: `Allowlist could not be written: ${error.message}` });
      }
      if (!result.ok) {
        const message = result.reason === 'duplicate' ? 'Entry is already on the list.'
          : result.reason === 'limit_reached' ? 'Allowlist is full.'
            : 'Entry must be an IPv4/IPv6 address or CIDR (e.g. 203.0.113.4 or 203.0.113.0/24).';
        return json(response, result.reason === 'limit_reached' ? 409 : 400, { type: false, message });
      }
      logger.info('[gateway] Allowlist entry added', { entry: result.entry.entry, enforcing: allowlist.enforcing });
      return json(response, 201, { type: true, message: 'Entry added.', data: { enforcing: allowlist.enforcing, entries: allowlist.list() } });
    }

    response.setHeader('allow', 'GET, POST, DELETE');
    return json(response, 405, { type: false, message: 'Method not allowed.' });
  }

  async function handleControlRequest(request, response) {
    const pathname = requestPath(request);
    if (request.method === 'GET' && pathname === '/health') return json(response, 200, { ok: true, service: SERVICE, ...gateway.stats() });
    if (!isAuthorized(request, controlToken)) return json(response, 401, { type: false, message: 'Unauthorized' });
    if (request.method === 'GET' && pathname === '/agent/all') return json(response, 200, { type: true, message: 'Agents fetched.', data: gateway.listAgents() });

    if (pathname === '/agent/allowlist') return handleAllowlist(request, response);

    const credentialMatch = pathname.match(/^\/agent\/credentials\/([^/]+)$/);
    if (credentialMatch) return handleCredential(request, response, credentialMatch[1]);

    const artifactMatch = pathname.match(/^\/agent\/artifact-command\/([^/]+)$/);
    if (artifactMatch) return handleArtifactCommand(request, response, artifactMatch[1]);

    const updateMatch = request.method === 'GET' && pathname.match(/^\/agent\/send-app-update-command\/([A-Za-z0-9._-]{3,128})$/);
    if (updateMatch) {
      const agentId = updateMatch[1];
      return gateway.sendCommand(agentId, 'update')
        ? json(response, 200, { type: true, message: 'Update command sent.' })
        : json(response, 404, { type: false, message: `Agent ${agentId} is not connected.` });
    }

    const deployMatch = request.method === 'POST' && pathname.match(/^\/agent\/run-deploy-command\/([A-Za-z0-9._-]{3,128})$/);
    if (deployMatch) {
      let body;
      try { body = await readJson(request); } catch (error) { return json(response, 400, { type: false, message: error.message }); }
      const command = typeof body?.command === 'string' ? body.command : '';
      if (!command || command.length > 64 * 1024) return json(response, 400, { type: false, message: 'A deployment command up to 64 KB is required.' });
      const agentId = deployMatch[1];
      return gateway.sendCommand(agentId, 'run_deploy', { command })
        ? json(response, 200, { type: true, message: 'Deployment command sent.' })
        : json(response, 404, { type: false, message: `Agent ${agentId} is not connected.` });
    }
    return json(response, 404, NOT_FOUND);
  }

  const controlServer = http.createServer((request, response) => {
    handleControlRequest(request, response).catch((error) => {
      logger.warn('[gateway] Control request failed', { error: error.message });
      if (!response.headersSent) json(response, 500, { type: false, message: 'Internal error.' });
      else response.destroy();
    });
  });
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

  controlServer.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    if (requestPath(request) !== '/') return rejectUpgrade(socket, 404, NOT_FOUND.message);
    if (!isAuthorized(request, controlToken)) return rejectUpgrade(socket, 401, 'Unauthorized');
    webSockets.handleUpgrade(request, socket, head, (ws) => gateway.acceptWeb(ws, request));
  });

  // ---------------------------------------------------------------- lifecycle

  async function listen() {
    try {
      const [agent, control] = await Promise.all([
        listenOn(agentServer, agentPort, agentHost),
        listenOn(controlServer, controlPort, controlHost),
      ]);
      gateway.startHeartbeat();
      return { agent, control };
    } catch (error) {
      for (const server of [agentServer, controlServer]) if (server.listening) server.close();
      throw error;
    }
  }

  function close({ graceMs = 2000 } = {}) {
    gateway.stop();
    const force = setTimeout(() => {
      for (const ws of [...agentSockets.clients, ...webSockets.clients]) ws.terminate();
    }, graceMs);
    force.unref();
    agentSockets.close();
    webSockets.close();
    return Promise.all([agentServer, controlServer].map((server) => new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeIdleConnections?.();
    }))).finally(() => clearTimeout(force));
  }

  return { gateway, agentServer, controlServer, listen, close };
}

function main() {
  let config;
  let app;
  try {
    config = loadConfig();
    app = createGatewayApp({ ...config, logger: console });
  } catch (error) {
    console.error(`[gateway] Başlatılamadı: ${error.message}`);
    process.exit(1);
  }

  app.listen().then(({ agent, control }) => {
    console.log(JSON.stringify({
      level: 'info',
      event: 'gateway_started',
      agentListener: `${config.agentHost}:${agent.port}`,
      controlListener: `${config.controlHost}:${control.port}`,
    }));
  }).catch((error) => {
    console.error(`[gateway] Başlatılamadı: ${error.message}`);
    process.exit(1);
  });

  let stopping = false;
  function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ level: 'info', event: 'gateway_stopping', signal }));
    setTimeout(() => process.exit(0), 10_000).unref();
    app.close().then(() => process.exit(0));
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) main();

module.exports = { createGatewayApp, loadConfig };
