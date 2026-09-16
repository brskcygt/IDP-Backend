/**
 * Agent source-IP allowlist: AgentGatewayClient.listAllowlist /
 * addAllowlistEntry / removeAllowlistEntry, and the GET/POST/DELETE
 * /api/agents/allowlist routes in routes/agents.js.
 *
 * Same shape as agent-credentials.test.js: the gateway is a fake HTTP server
 * that records every request, so "the gateway was never contacted" is
 * asserted rather than assumed.
 *
 * What is NOT tested here: whether an entry actually matches a connecting
 * agent. The gateway owns that — see idp-agent-gateway/test/ipMatch.test.js
 * and the allowlist cases in gateway.test.js.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const http = require('node:http');
const express = require('express');

const AgentGatewayClient = require('../src/services/agent/AgentGatewayClient');
const { createAgentsRouter } = require('../src/routes/agents');

const CONTROL_TOKEN = 'control-token-for-tests';
const PUBLIC_CONFIG = Object.freeze({ publicUrl: 'wss://agent.example.com', publicUrlError: null, cfAccess: null });

const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function startFakeGateway(routes = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null, body });
      const route = routes[`${req.method} ${req.url}`];
      const reply = typeof route === 'function' ? route(req, body) : route;
      if (!reply) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: false, message: 'Not found.' }));
      }
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => closeServer(server));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function fakeAudit() {
  return {
    entries: [],
    log(user, action, description, metadata = {}, options = {}) {
      this.entries.push({ user, action, description, metadata, options });
    },
  };
}

function fakeSession(req, _res, next) {
  const role = req.get('x-test-role');
  req.session = role ? { user: { username: `user-${role}`, role } } : {};
  next();
}

async function startApp({ gatewayUrl, auditLogger = fakeAudit() } = {}) {
  const app = express();
  app.use(express.json());
  app.use(fakeSession);
  app.use('/api/agents', createAgentsRouter({
    agentConfig: PUBLIC_CONFIG,
    auditLogger,
    createClient: () => new AgentGatewayClient({ baseUrl: gatewayUrl, token: CONTROL_TOKEN }),
  }));
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  cleanups.push(() => closeServer(server));
  return { base: `http://127.0.0.1:${server.address().port}`, auditLogger };
}

const call = (base, method, role, body) => fetch(`${base}/api/agents/allowlist`, {
  method,
  headers: { ...(role ? { 'x-test-role': role } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

const listBody = (entries, enforcing = entries.length > 0) => ({
  type: true,
  message: 'ok',
  data: { enforcing, entries },
});

// ------------------------------------------------------------------- client

test('listAllowlist reports enforcing separately from the entry count', async () => {
  const gateway = await startFakeGateway({
    'GET /agent/allowlist': { status: 200, body: listBody([{ entry: '203.0.113.0/24', note: 'ofis', addedAt: '2026-09-16T00:00:00.000Z', addedBy: 'admin' }]) },
  });
  const client = new AgentGatewayClient({ baseUrl: gateway.url, token: CONTROL_TOKEN });

  const result = await client.listAllowlist();
  assert.equal(result.enforcing, true);
  assert.equal(result.entries.length, 1);
  assert.equal(gateway.requests[0].authorization, `Bearer ${CONTROL_TOKEN}`);
});

test('listAllowlist tolerates a gateway payload with no data', async () => {
  const gateway = await startFakeGateway({ 'GET /agent/allowlist': { status: 200, body: { type: true } } });
  const client = new AgentGatewayClient({ baseUrl: gateway.url, token: CONTROL_TOKEN });

  assert.deepEqual(await client.listAllowlist(), { enforcing: false, entries: [] });
});

test('removeAllowlistEntry maps 404 to null instead of throwing', async () => {
  const gateway = await startFakeGateway({
    'DELETE /agent/allowlist': { status: 404, body: { type: false, message: 'Entry not found.' } },
  });
  const client = new AgentGatewayClient({ baseUrl: gateway.url, token: CONTROL_TOKEN });

  assert.equal(await client.removeAllowlistEntry('203.0.113.4'), null);
});

// ------------------------------------------------------------------- routes

test('the allowlist routes require admin; a deployer never reaches the gateway', async () => {
  const gateway = await startFakeGateway({ 'GET /agent/allowlist': { status: 200, body: listBody([]) } });
  const { base } = await startApp({ gatewayUrl: gateway.url });

  assert.equal((await call(base, 'GET', null)).status, 401);
  assert.equal((await call(base, 'GET', 'viewer')).status, 403);
  assert.equal((await call(base, 'GET', 'deployer')).status, 403);
  assert.equal((await call(base, 'POST', 'deployer', { entry: '203.0.113.4' })).status, 403);
  assert.equal((await call(base, 'DELETE', 'deployer', { entry: '203.0.113.4' })).status, 403);
  assert.equal(gateway.requests.length, 0, 'gateway must not be contacted for a rejected caller');
});

test('adding an entry forwards the caller as addedBy and writes an audit record', async () => {
  const gateway = await startFakeGateway({
    'POST /agent/allowlist': { status: 201, body: listBody([{ entry: '203.0.113.4', note: 'ofis', addedAt: 'now', addedBy: 'user-admin' }]) },
  });
  const { base, auditLogger } = await startApp({ gatewayUrl: gateway.url });

  const response = await call(base, 'POST', 'admin', { entry: ' 203.0.113.4 ', note: 'ofis' });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).enforcing, true);

  const forwarded = JSON.parse(gateway.requests[0].body);
  assert.equal(forwarded.entry, '203.0.113.4', 'trimmed before forwarding');
  assert.equal(forwarded.addedBy, 'user-admin');

  const entry = auditLogger.entries.find((e) => e.action === 'AGENT_ALLOWLIST_ADDED');
  assert.ok(entry);
  assert.equal(entry.metadata.entry, '203.0.113.4');
});

test('a malformed entry is rejected locally, without calling the gateway', async () => {
  const gateway = await startFakeGateway({});
  const { base } = await startApp({ gatewayUrl: gateway.url });

  for (const body of [{}, { entry: '' }, { entry: '   ' }]) {
    assert.equal((await call(base, 'POST', 'admin', body)).status, 400);
  }
  assert.equal(gateway.requests.length, 0);
});

test("the gateway's own 400 passes through instead of becoming a 502", async () => {
  // Otherwise "203.0.113.999 is not an address" would reach the operator as
  // "the gateway is broken", and they would go looking in the wrong place.
  const gateway = await startFakeGateway({
    'POST /agent/allowlist': { status: 400, body: { type: false, message: 'Entry must be an IPv4/IPv6 address or CIDR.' } },
  });
  const { base, auditLogger } = await startApp({ gatewayUrl: gateway.url });

  const response = await call(base, 'POST', 'admin', { entry: '203.0.113.999' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /IPv4\/IPv6/);
  assert.equal(auditLogger.entries.filter((e) => e.action === 'AGENT_ALLOWLIST_ADD_FAILED').length, 0, 'operator error is not a gateway failure');
});

test('an unreachable gateway is a 502 and is recorded as a failure', async () => {
  const gateway = await startFakeGateway({
    'POST /agent/allowlist': { status: 500, body: { type: false, message: 'Allowlist could not be written: EACCES' } },
  });
  const { base, auditLogger } = await startApp({ gatewayUrl: gateway.url });

  const response = await call(base, 'POST', 'admin', { entry: '203.0.113.4' });
  assert.equal(response.status, 502);

  const entry = auditLogger.entries.find((e) => e.action === 'AGENT_ALLOWLIST_ADD_FAILED');
  assert.ok(entry);
  assert.equal(entry.options.outcome, 'failure');
});

test('removing an unknown entry is a 404, not a 502', async () => {
  const gateway = await startFakeGateway({
    'DELETE /agent/allowlist': { status: 404, body: { type: false, message: 'Entry not found.' } },
  });
  const { base } = await startApp({ gatewayUrl: gateway.url });

  assert.equal((await call(base, 'DELETE', 'admin', { entry: '198.51.100.1' })).status, 404);
});

test('emptying the list is spelled out in the audit description', async () => {
  // Dropping the last entry silently turns the whole restriction off; the
  // audit trail has to make that visible.
  const gateway = await startFakeGateway({
    'DELETE /agent/allowlist': { status: 200, body: listBody([], false) },
  });
  const { base, auditLogger } = await startApp({ gatewayUrl: gateway.url });

  const response = await call(base, 'DELETE', 'admin', { entry: '203.0.113.4' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).enforcing, false);

  const entry = auditLogger.entries.find((e) => e.action === 'AGENT_ALLOWLIST_REMOVED');
  assert.ok(entry);
  assert.equal(entry.metadata.enforcing, false);
  assert.match(entry.description, /kısıt artık uygulanmıyor/);
});
