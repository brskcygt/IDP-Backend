/**
 * Per-agent credentials: AgentGatewayClient.issueCredential/revokeCredential,
 * POST/DELETE /api/agents/:id/credentials (routes/agents.js) and the
 * IDP_AGENT_PUBLIC_URL / Cloudflare Access env validation (config.js).
 *
 * The gateway is always a fake HTTP server on 127.0.0.1 that records every
 * request, so "the gateway was never contacted" is asserted, not assumed.
 *
 * Layers:
 *  1. validateAgentCredentialEnv() / validateHttpServerEnv() — pure.
 *  2. AgentGatewayClient against the fake gateway.
 *  3. The router in a minimal Express app (fake session via a test header).
 *  4. The real src/server.js as a child process (wiring, login, audit trail,
 *     startup abort on a half-configured Cloudflare Access pair).
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const http = require('node:http');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const AgentGatewayClient = require('../src/services/agent/AgentGatewayClient');
const { createAgentsRouter } = require('../src/routes/agents');
const { createRateLimit } = require('../src/middleware/rateLimit');
const { validateAgentCredentialEnv, validateHttpServerEnv } = require('../src/config');

const BACKEND_DIR = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(BACKEND_DIR, 'src', 'server.js');
const STARTUP_TIMEOUT_MS = 20000;
const CONTROL_TOKEN = 'control-token-for-tests';
const SECRET = `agent-secret-${crypto.randomBytes(16).toString('hex')}`;
const CF_SECRET = `cf-secret-${crypto.randomBytes(16).toString('hex')}`;
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

/**
 * @param {Record<string, {status: number, body?: object} | ((req) => {status: number, body?: object})>} routes
 *   keyed by "METHOD /path"; anything else gets the gateway's 404 shape.
 */
async function startFakeGateway(routes = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null, body });
      const route = routes[`${req.method} ${req.url}`];
      const reply = typeof route === 'function' ? route(req) : route;
      if (!reply) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: false, message: 'Not found.' }));
      }
      if (reply.body === undefined) {
        res.writeHead(reply.status);
        return res.end();
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

/** Role comes from the x-test-role header; no header = no session user. */
function fakeSession(req, _res, next) {
  const role = req.get('x-test-role');
  req.session = role ? { user: { username: `user-${role}`, role } } : {};
  next();
}

async function startApp({ gatewayUrl, agentConfig = PUBLIC_CONFIG, auditLogger = fakeAudit(), rateLimit } = {}) {
  const app = express();
  app.use(express.json());
  app.use(fakeSession);
  app.use(
    '/api/agents',
    createAgentsRouter({
      agentConfig,
      auditLogger,
      rateLimit,
      createClient: () => new AgentGatewayClient({ baseUrl: gatewayUrl, token: CONTROL_TOKEN }),
    })
  );
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  cleanups.push(() => closeServer(server));
  return { base: `http://127.0.0.1:${server.address().port}`, auditLogger };
}

function call(base, method, agentId, role) {
  return fetch(`${base}/api/agents/${agentId}/credentials`, {
    method,
    headers: role ? { 'x-test-role': role } : {},
  });
}

// ---------------------------------------------------------------------------
// 1. Env validation
// ---------------------------------------------------------------------------

test('validateAgentCredentialEnv: nothing set -> no public URL, no CF Access, no error', () => {
  const result = validateAgentCredentialEnv({});
  assert.equal(result.publicUrl, null);
  assert.match(result.publicUrlError, /IDP_AGENT_PUBLIC_URL/);
  assert.equal(result.cfAccess, null);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, [], 'an unset optional feature is not worth a warning');
});

test('validateAgentCredentialEnv: ws:// and wss:// accepted (trimmed, trailing slash dropped)', () => {
  assert.equal(validateAgentCredentialEnv({ IDP_AGENT_PUBLIC_URL: ' wss://agent.example.com/ ' }).publicUrl, 'wss://agent.example.com');
  assert.equal(validateAgentCredentialEnv({ IDP_AGENT_PUBLIC_URL: 'ws://192.168.0.242:7003' }).publicUrl, 'ws://192.168.0.242:7003');
});

test('validateAgentCredentialEnv: a non-ws URL is a warning (endpoint -> 503), never a startup error', () => {
  for (const value of ['http://agent.example.com', 'https://agent.example.com', 'agent.example.com', 'wss://user:pw@agent.example.com']) {
    const result = validateAgentCredentialEnv({ IDP_AGENT_PUBLIC_URL: value });
    assert.equal(result.publicUrl, null, value);
    assert.match(result.publicUrlError, /geçersiz/, value);
    assert.equal(result.errors.length, 0, value);
    assert.equal(result.warnings.length, 1, value);
  }
});

test('validateAgentCredentialEnv: Cloudflare Access pair is both-or-neither', () => {
  const both = validateAgentCredentialEnv({ IDP_AGENT_CF_ACCESS_CLIENT_ID: ' id.access ', IDP_AGENT_CF_ACCESS_CLIENT_SECRET: CF_SECRET });
  assert.deepEqual(both.cfAccess, { clientId: 'id.access', clientSecret: CF_SECRET });
  assert.deepEqual(both.errors, []);

  const onlySecret = validateAgentCredentialEnv({ IDP_AGENT_CF_ACCESS_CLIENT_SECRET: CF_SECRET });
  assert.equal(onlySecret.cfAccess, null);
  assert.equal(onlySecret.errors.length, 1);
  assert.ok(!onlySecret.errors[0].includes(CF_SECRET), 'the error must not echo the secret');

  const onlyId = validateHttpServerEnv({ IDP_AGENT_CF_ACCESS_CLIENT_ID: 'id.access', IDP_AGENT_CF_ACCESS_CLIENT_SECRET: '  ' });
  assert.equal(onlyId.valid, false, 'a half pair aborts the HTTP server');
  assert.match(onlyId.errors.join('\n'), /IDP_AGENT_CF_ACCESS_CLIENT_ID ve IDP_AGENT_CF_ACCESS_CLIENT_SECRET birlikte/);
});

test('validateHttpServerEnv exposes the agent credential settings', () => {
  const result = validateHttpServerEnv({
    IDP_AGENT_PUBLIC_URL: 'wss://agent.example.com',
    IDP_AGENT_CF_ACCESS_CLIENT_ID: 'id.access',
    IDP_AGENT_CF_ACCESS_CLIENT_SECRET: CF_SECRET,
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.agentCredentials, {
    publicUrl: 'wss://agent.example.com',
    publicUrlError: null,
    cfAccess: { clientId: 'id.access', clientSecret: CF_SECRET },
  });
});

// ---------------------------------------------------------------------------
// 2. AgentGatewayClient
// ---------------------------------------------------------------------------

test('issueCredential: POST /agent/credentials/:id with the control token, returns { agentId, secret }', async () => {
  const gateway = await startFakeGateway({
    'POST /agent/credentials/agent.prod-01': { status: 201, body: { agentId: 'agent.prod-01', secret: SECRET } },
  });
  const client = new AgentGatewayClient({ baseUrl: gateway.url, token: CONTROL_TOKEN });

  assert.deepEqual(await client.issueCredential('agent.prod-01'), { agentId: 'agent.prod-01', secret: SECRET });
  assert.equal(gateway.requests.length, 1);
  assert.equal(gateway.requests[0].method, 'POST');
  assert.equal(gateway.requests[0].url, '/agent/credentials/agent.prod-01');
  assert.equal(gateway.requests[0].authorization, `Bearer ${CONTROL_TOKEN}`);
});

test('issueCredential: invalid IDs are rejected before any request', async () => {
  const gateway = await startFakeGateway();
  const client = new AgentGatewayClient({ baseUrl: gateway.url, token: CONTROL_TOKEN });
  for (const id of ['ab', '-abc', '.abc', 'a/bc', 'a bc', 'x'.repeat(129), '', undefined]) {
    await assert.rejects(client.issueCredential(id), (err) => err.status === 400, String(id));
  }
  await assert.rejects(client.revokeCredential('../etc'), (err) => err.status === 400);
  assert.equal(gateway.requests.length, 0);
});

test('issueCredential: gateway errors and a missing secret surface as errors carrying the status', async () => {
  const gateway = await startFakeGateway({
    'POST /agent/credentials/denied-agent': { status: 401, body: { type: false, message: 'Unauthorized.' } },
    'POST /agent/credentials/empty-agent': { status: 201, body: { agentId: 'empty-agent' } },
  });
  const client = new AgentGatewayClient({ baseUrl: gateway.url, token: CONTROL_TOKEN });
  await assert.rejects(client.issueCredential('denied-agent'), (err) => err.status === 401 && /Unauthorized/.test(err.message));
  await assert.rejects(client.issueCredential('empty-agent'), /no credential secret/);
});

test('revokeCredential: 204 -> true, 404 -> false, other failures throw', async () => {
  const gateway = await startFakeGateway({
    'DELETE /agent/credentials/known-agent': { status: 204 },
    'DELETE /agent/credentials/broken-agent': { status: 500, body: { type: false, message: 'boom' } },
  });
  const client = new AgentGatewayClient({ baseUrl: gateway.url, token: CONTROL_TOKEN });
  assert.equal(await client.revokeCredential('known-agent'), true);
  assert.equal(await client.revokeCredential('unknown-agent'), false);
  await assert.rejects(client.revokeCredential('broken-agent'), (err) => err.status === 500);
  assert.deepEqual(
    gateway.requests.map((r) => `${r.method} ${r.url} ${r.authorization}`),
    ['known-agent', 'unknown-agent', 'broken-agent'].map((id) => `DELETE /agent/credentials/${id} Bearer ${CONTROL_TOKEN}`)
  );
});

// ---------------------------------------------------------------------------
// 3. Routes
// ---------------------------------------------------------------------------

test('routes: no session -> 401, viewer/deployer -> 403, gateway never contacted', async () => {
  const gateway = await startFakeGateway();
  const { base, auditLogger } = await startApp({ gatewayUrl: gateway.url });
  for (const method of ['POST', 'DELETE']) {
    assert.equal((await call(base, method, 'agent-01')).status, 401, method);
    assert.equal((await call(base, method, 'agent-01', 'viewer')).status, 403, method);
    assert.equal((await call(base, method, 'agent-01', 'deployer')).status, 403, method);
  }
  assert.equal(gateway.requests.length, 0);
  assert.equal(auditLogger.entries.length, 0);
});

test('routes: malformed agent ID -> 400 without contacting the gateway', async () => {
  const gateway = await startFakeGateway();
  const { base } = await startApp({ gatewayUrl: gateway.url });
  // ('%2E%2E' is not listed: the client normalizes it to '..' before sending,
  // so it never reaches the route at all — a plain 404.)
  for (const id of ['ab', '-agent', '..abc', 'a%20bc', 'a%2Fbc', 'x'.repeat(129)]) {
    for (const method of ['POST', 'DELETE']) {
      const res = await call(base, method, id, 'admin');
      assert.equal(res.status, 400, `${method} ${id}`);
      assert.match((await res.json()).error, /Geçersiz agent ID/);
    }
  }
  assert.equal(gateway.requests.length, 0);
});

test('routes: no usable IDP_AGENT_PUBLIC_URL -> 503, gateway never contacted', async () => {
  const gateway = await startFakeGateway({
    'POST /agent/credentials/agent-01': { status: 201, body: { agentId: 'agent-01', secret: SECRET } },
  });
  for (const agentConfig of [
    { publicUrl: null, publicUrlError: null, cfAccess: null },
    validateAgentCredentialEnv({ IDP_AGENT_PUBLIC_URL: 'https://agent.example.com' }),
  ]) {
    const { base, auditLogger } = await startApp({ gatewayUrl: gateway.url, agentConfig });
    const res = await call(base, 'POST', 'agent-01', 'admin');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match((await res.json()).error, /IDP_AGENT_PUBLIC_URL/);
    assert.equal(auditLogger.entries.length, 0);
  }
  assert.equal(gateway.requests.length, 0, 'a credential nobody can use must not rotate a live agent');
});

test('routes: POST success -> 201 with the exact response shape and no-store; audit has agentId + user, never the secret', async () => {
  const gateway = await startFakeGateway({
    'POST /agent/credentials/agent.prod-01': { status: 201, body: { agentId: 'agent.prod-01', secret: SECRET } },
  });

  const plain = await startApp({ gatewayUrl: gateway.url });
  const res = await call(plain.base, 'POST', 'agent.prod-01', 'admin');
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), {
    agentId: 'agent.prod-01',
    secret: SECRET,
    gatewayUrl: 'wss://agent.example.com',
    cfAccess: null,
  });
  assert.deepEqual(
    plain.auditLogger.entries.map((e) => [e.user, e.action, e.metadata]),
    [['user-admin', 'AGENT_CREDENTIAL_ISSUED', { agentId: 'agent.prod-01' }]]
  );
  assert.ok(!JSON.stringify(plain.auditLogger.entries).includes(SECRET), 'the secret must never be audited');

  const withCf = await startApp({
    gatewayUrl: gateway.url,
    agentConfig: { ...PUBLIC_CONFIG, cfAccess: { clientId: 'id.access', clientSecret: CF_SECRET } },
  });
  const cfRes = await call(withCf.base, 'POST', 'agent.prod-01', 'admin');
  assert.equal(cfRes.status, 201);
  assert.deepEqual((await cfRes.json()).cfAccess, { clientId: 'id.access', clientSecret: CF_SECRET });
  const audited = JSON.stringify(withCf.auditLogger.entries);
  assert.ok(!audited.includes(SECRET) && !audited.includes(CF_SECRET));
});

test('routes: gateway failure -> 502 and a failure audit entry (no secret)', async () => {
  const gateway = await startFakeGateway({
    'POST /agent/credentials/agent-01': { status: 401, body: { type: false, message: 'Unauthorized.' } },
  });
  const { base, auditLogger } = await startApp({ gatewayUrl: gateway.url });
  const res = await call(base, 'POST', 'agent-01', 'admin');
  assert.equal(res.status, 502);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(auditLogger.entries.length, 1);
  assert.equal(auditLogger.entries[0].action, 'AGENT_CREDENTIAL_ISSUE_FAILED');
  assert.equal(auditLogger.entries[0].options.outcome, 'failure');
});

test('routes: DELETE -> 204 + audit; unknown credential -> 404 without a success audit', async () => {
  const gateway = await startFakeGateway({ 'DELETE /agent/credentials/agent-01': { status: 204 } });
  const { base, auditLogger } = await startApp({ gatewayUrl: gateway.url });

  const res = await call(base, 'DELETE', 'agent-01', 'admin');
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
  assert.deepEqual(
    auditLogger.entries.map((e) => [e.user, e.action, e.metadata]),
    [['user-admin', 'AGENT_CREDENTIAL_REVOKED', { agentId: 'agent-01' }]]
  );

  const missing = await call(base, 'DELETE', 'agent-02', 'admin');
  assert.equal(missing.status, 404);
  assert.equal(auditLogger.entries.length, 1);
});

test('routes: the rate limiter runs after the permission check', async () => {
  const gateway = await startFakeGateway({ 'DELETE /agent/credentials/agent-01': { status: 204 } });
  const rateLimit = createRateLimit({ windowMs: 60 * 1000, max: 2 });
  cleanups.push(() => rateLimit.stop());
  const { base } = await startApp({ gatewayUrl: gateway.url, rateLimit });

  for (let i = 0; i < 3; i += 1) assert.equal((await call(base, 'DELETE', 'agent-01', 'viewer')).status, 403);
  assert.equal((await call(base, 'DELETE', 'agent-01', 'admin')).status, 204);
  assert.equal((await call(base, 'DELETE', 'agent-01', 'admin')).status, 204);
  assert.equal((await call(base, 'DELETE', 'agent-01', 'admin')).status, 429);
});

// ---------------------------------------------------------------------------
// 4. Real src/server.js
// ---------------------------------------------------------------------------

const LISTEN_LINE = /Backend server running on \[?([^\]\s]+?)\]?:(\d+)/;

function spawnServer(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-agent-cred-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const adminPassword = crypto.randomBytes(12).toString('hex');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.IDP_DB_PATH_OWNER_PID;
  Object.assign(
    env,
    {
      PORT: '0',
      NODE_ENV: 'development',
      IDP_HOST: '127.0.0.1',
      IDP_COOKIE_SECURE: '',
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      IDP_SECRET_KEY: crypto.randomBytes(32).toString('base64'),
      IDP_ADMIN_PASSWORD: adminPassword,
      IDP_DB_PATH: path.join(dir, 'idp.db'),
      IDP_USERS_PATH: path.join(dir, 'users.json'),
      IDP_SESSIONS_PATH: path.join(dir, 'sessions.json'),
      IDP_SECRETS_PATH: path.join(dir, 'secrets.enc.json'),
      IDP_AGENT_API_URL: '',
      IDP_AGENT_API_TOKEN: '',
      IDP_AGENT_PUBLIC_URL: '',
      IDP_AGENT_CF_ACCESS_CLIENT_ID: '',
      IDP_AGENT_CF_ACCESS_CLIENT_SECRET: '',
    },
    overrides
  );
  const child = spawn(process.execPath, [SERVER_ENTRY], { cwd: BACKEND_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  };
  cleanups.push(stop);

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start\n${stdout}\n${stderr}`)), STARTUP_TIMEOUT_MS);
    child.stdout.on('data', () => {
      const match = stdout.match(LISTEN_LINE);
      if (match) {
        clearTimeout(timer);
        resolve(`http://${match[1]}:${match[2]}`);
      }
    });
    exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code})\n${stdout}\n${stderr}`));
    });
  });
  ready.catch(() => {});

  return { adminPassword, ready, exited, stop, output: () => ({ stdout, stderr }) };
}

test('real server: a half-configured Cloudflare Access pair aborts startup', async () => {
  const srv = spawnServer({ IDP_AGENT_CF_ACCESS_CLIENT_ID: 'only-the-id.access' });
  const code = await Promise.race([
    srv.exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('server did not exit')), STARTUP_TIMEOUT_MS)),
  ]);
  assert.equal(code, 1);
  assert.match(srv.output().stderr, /IDP_AGENT_CF_ACCESS_CLIENT_ID ve IDP_AGENT_CF_ACCESS_CLIENT_SECRET birlikte/);
});

test('real server: credential route is mounted behind login, reaches the control URL, and audits without the secret', async () => {
  const gateway = await startFakeGateway({
    'POST /agent/credentials/agent-e2e-01': { status: 201, body: { agentId: 'agent-e2e-01', secret: SECRET } },
    'DELETE /agent/credentials/agent-e2e-01': { status: 204 },
  });
  const srv = spawnServer({
    IDP_AGENT_API_URL: gateway.url,
    IDP_AGENT_API_TOKEN: CONTROL_TOKEN,
    IDP_AGENT_PUBLIC_URL: 'wss://agent.example.com',
    IDP_AGENT_CF_ACCESS_CLIENT_ID: 'id.access',
    IDP_AGENT_CF_ACCESS_CLIENT_SECRET: CF_SECRET,
  });
  const base = await srv.ready;

  assert.equal((await fetch(`${base}/api/agents/agent-e2e-01/credentials`, { method: 'POST' })).status, 401);

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: srv.adminPassword }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('connect.sid=')).split(';')[0];
  const authed = (method, id) => fetch(`${base}/api/agents/${id}/credentials`, { method, headers: { Cookie: cookie } });

  assert.equal((await authed('POST', 'ab')).status, 400);

  const issued = await authed('POST', 'agent-e2e-01');
  assert.equal(issued.status, 201);
  assert.equal(issued.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await issued.json(), {
    agentId: 'agent-e2e-01',
    secret: SECRET,
    gatewayUrl: 'wss://agent.example.com',
    cfAccess: { clientId: 'id.access', clientSecret: CF_SECRET },
  });
  assert.equal((await authed('DELETE', 'agent-e2e-01')).status, 204);

  assert.deepEqual(
    gateway.requests.map((r) => `${r.method} ${r.url} ${r.authorization}`),
    [`POST /agent/credentials/agent-e2e-01 Bearer ${CONTROL_TOKEN}`, `DELETE /agent/credentials/agent-e2e-01 Bearer ${CONTROL_TOKEN}`]
  );

  // The existing list route is untouched and still served from the same URL.
  const logs = await (await fetch(`${base}/api/audit-logs`, { headers: { Cookie: cookie } })).json();
  const ours = logs.filter((e) => String(e.action).startsWith('AGENT_CREDENTIAL_'));
  assert.deepEqual(ours.map((e) => e.action).sort(), ['AGENT_CREDENTIAL_ISSUED', 'AGENT_CREDENTIAL_REVOKED']);
  for (const entry of ours) {
    assert.equal(entry.user, 'admin');
    assert.equal(entry.metadata.agentId, 'agent-e2e-01');
  }
  const persisted = JSON.stringify(logs);
  assert.ok(!persisted.includes(SECRET) && !persisted.includes(CF_SECRET), 'no secret in the persisted audit trail');

  await srv.stop();
  const { stdout, stderr } = srv.output();
  assert.ok(!`${stdout}${stderr}`.includes(SECRET), 'the secret is never logged');
});
