'use strict';

const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { AgentGateway, FailureRateLimiter, bearerToken, isAuthorized, isValidAgentId } = require('./gateway');

const SERVICE = 'idp-agent-gateway';
const MAX_WS_PAYLOAD = 1024 * 1024;
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
  };
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
    if (size > maxBytes) throw new Error('Request body is too large.');
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
  if (agentPort !== 0 && agentPort === controlPort) {
    throw new Error(`Agent ve kontrol listener aynı porta (${agentPort}) bağlanamaz.`);
  }

  const rateLimiter = new FailureRateLimiter(rateLimit);
  const gateway = new AgentGateway({ logger, registryPath, heartbeatIntervalMs, handshakeTimeoutMs, rateLimiter });

  // ------------------------------------------------------------ agent listener

  const agentServer = http.createServer((request, response) => {
    if (request.method === 'GET' && requestPath(request) === '/health') return json(response, 200, { ok: true, service: SERVICE });
    return json(response, 404, NOT_FOUND);
  });
  const agentSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

  agentServer.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    const remoteAddress = request.socket.remoteAddress || 'unknown';
    // CF-Connecting-IP doğrulanamaz; yalnızca log bağlamı içindir, hiçbir karar buna dayanmaz.
    const cfConnectingIp = String(request.headers['cf-connecting-ip'] || '').slice(0, 64) || undefined;
    if (requestPath(request) !== '/') return rejectUpgrade(socket, 404, NOT_FOUND.message);

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

  async function handleControlRequest(request, response) {
    const pathname = requestPath(request);
    if (request.method === 'GET' && pathname === '/health') return json(response, 200, { ok: true, service: SERVICE, ...gateway.stats() });
    if (!isAuthorized(request, controlToken)) return json(response, 401, { type: false, message: 'Unauthorized' });
    if (request.method === 'GET' && pathname === '/agent/all') return json(response, 200, { type: true, message: 'Agents fetched.', data: gateway.listAgents() });

    const credentialMatch = pathname.match(/^\/agent\/credentials\/([^/]+)$/);
    if (credentialMatch) return handleCredential(request, response, credentialMatch[1]);

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
    if (!isLoopback(config.controlHost)) {
      console.warn(`[gateway] UYARI: kontrol listener loopback dışı bir adrese (${config.controlHost}) bağlı; bu portu tünele veya dış ağa açmayın.`);
    }
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
