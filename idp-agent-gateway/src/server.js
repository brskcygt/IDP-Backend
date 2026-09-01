'use strict';

const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { AgentGateway, isAuthorized } = require('./gateway');

const host = process.env.IDP_AGENT_GATEWAY_HOST || '0.0.0.0';
const port = Number(process.env.IDP_AGENT_GATEWAY_PORT || 7003);
const token = String(process.env.IDP_AGENT_API_TOKEN || '');
const registryPath = process.env.IDP_AGENT_REGISTRY_PATH || path.join(process.cwd(), 'data', 'agents.json');
const gateway = new AgentGateway({ token, registryPath });

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

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true, service: 'idp-agent-gateway', agents: gateway.listAgents().length });
  if (!isAuthorized(request, token)) return json(response, 401, { type: false, message: 'Unauthorized' });
  if (request.method === 'GET' && url.pathname === '/agent/all') return json(response, 200, { type: true, message: 'Agents fetched.', data: gateway.listAgents() });

  const updateMatch = request.method === 'GET' && url.pathname.match(/^\/agent\/send-app-update-command\/([A-Za-z0-9._-]{3,128})$/);
  if (updateMatch) {
    const agentId = decodeURIComponent(updateMatch[1]);
    return gateway.sendCommand(agentId, 'update')
      ? json(response, 200, { type: true, message: 'Update command sent.' })
      : json(response, 404, { type: false, message: `Agent ${agentId} is not connected.` });
  }
  const deployMatch = request.method === 'POST' && url.pathname.match(/^\/agent\/run-deploy-command\/([A-Za-z0-9._-]{3,128})$/);
  if (deployMatch) {
    return readJson(request).then((body) => {
      const command = typeof body.command === 'string' ? body.command : '';
      if (!command || command.length > 64 * 1024) return json(response, 400, { type: false, message: 'A deployment command up to 64 KB is required.' });
      const agentId = decodeURIComponent(deployMatch[1]);
      return gateway.sendCommand(agentId, 'run_deploy', { command })
        ? json(response, 200, { type: true, message: 'Deployment command sent.' })
        : json(response, 404, { type: false, message: `Agent ${agentId} is not connected.` });
    }).catch((error) => json(response, 400, { type: false, message: error.message }));
  }
  return json(response, 404, { type: false, message: 'Not found.' });
});

const webSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname !== '/') return socket.destroy();
  webSockets.handleUpgrade(request, socket, head, (ws) => gateway.accept(ws, request));
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ level: 'info', event: 'gateway_started', host, port, authEnabled: Boolean(token) }));
  if (!token) console.warn('[gateway] IDP_AGENT_API_TOKEN ayarlı değil; yalnızca yerel geliştirmede bu şekilde kullanın.');
});

function shutdown(signal) {
  console.log(JSON.stringify({ level: 'info', event: 'gateway_stopping', signal }));
  webSockets.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
