'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const WebSocket = require('ws');
const { AgentGateway, FailureRateLimiter, isAuthorized, sha256Hex } = require('../src/gateway');
const { createGatewayApp } = require('../src/server');

const TOKEN = 'test-control-token-0123456789abcdef';
const silent = { info() {}, warn() {}, error() {} };

// ------------------------------------------------------------------ helpers

function tmpRegistry() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idp-gw-')), 'data', 'agents.json');
}

async function startApp(t, overrides = {}) {
  const registryPath = overrides.registryPath || tmpRegistry();
  const app = createGatewayApp({
    token: TOKEN, registryPath, agentHost: '127.0.0.1', agentPort: 0, controlHost: '127.0.0.1', controlPort: 0, logger: silent, ...overrides,
  });
  const { agent, control } = await app.listen();
  t.after(() => app.close());
  const controlUrl = `http://127.0.0.1:${control.port}`;
  const agentUrl = `http://127.0.0.1:${agent.port}`;
  const api = (pathname, { method = 'GET', token = TOKEN, body, base = controlUrl } = {}) => fetch(`${base}${pathname}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { app, registryPath, agentPort: agent.port, controlPort: control.port, agentUrl, controlUrl, api };
}

function track(ws) {
  const messages = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
    }
  });
  ws.messages = messages;
  ws.waitFor = (predicate, ms = 2000) => {
    const found = messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for message')), ms);
      waiters.push({ predicate, resolve: (message) => { clearTimeout(timer); resolve(message); } });
    });
  };
  ws.closed = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  return ws;
}

/** WS bağlantısı açar; upgrade reddedilirse HTTP durum kodunu döner. */
function connect(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = track(new WebSocket(url, { headers }));
    ws.on('error', () => {});
    ws.once('open', () => resolve({ ws, status: 101 }));
    ws.once('unexpected-response', (req, res) => {
      res.resume();
      req.destroy();
      resolve({ ws: null, status: res.statusCode, headers: res.headers });
    });
    ws.once('error', (error) => resolve({ ws: null, status: 0, error }));
  });
}

const agentHeaders = (id, secret) => ({ 'x-idp-agent-id': id, authorization: `Bearer ${secret}` });
const agentMessage = (id, process, payload = {}, type = 'agent') => JSON.stringify({ type, agentId: id, process, payload });

async function openAgent(env, id, secret, payload = { version: '2.1', agent_version: '1.0', os_info: 'Windows' }) {
  const { ws, status } = await connect(`ws://127.0.0.1:${env.agentPort}/`, agentHeaders(id, secret));
  assert.equal(status, 101);
  ws.send(agentMessage(id, 'handshake', payload));
  await ws.waitFor((m) => m.process === 'handshake_ack');
  return ws;
}

async function openWeb(env, id = 'idp-listener-1') {
  const { ws, status } = await connect(`ws://127.0.0.1:${env.controlPort}/`, { authorization: `Bearer ${TOKEN}` });
  assert.equal(status, 101);
  ws.send(agentMessage(id, 'handshake', '', 'web'));
  await ws.waitFor((m) => m.process === 'handshake_ack');
  return ws;
}

async function issue(env, id) {
  const response = await env.api(`/agent/credentials/${id}`, { method: 'POST' });
  assert.equal(response.status, 201);
  return (await response.json()).secret;
}

async function listAgents(env) {
  const response = await env.api('/agent/all');
  assert.equal(response.status, 200);
  return (await response.json()).data;
}

async function waitUntil(condition, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition not met in time');
}

class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; this.pings = 0; }
  send(value) { this.sent.push(JSON.parse(value)); }
  ping() { this.pings += 1; }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; this.emit('close', code, reason); }
  terminate() { this.terminated = true; this.readyState = 3; this.emit('close', 1006, ''); }
}

// --------------------------------------------------------------- unit tests

test('kontrol token doğrulaması: token boşsa hiçbir istek yetkili değildir', () => {
  const request = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });
  assert.equal(isAuthorized(request(''), ''), false);
  assert.equal(isAuthorized(request('anything'), ''), false);
  assert.equal(isAuthorized(request('secret'), 'secret'), true);
  assert.equal(isAuthorized(request('wrong'), 'secret'), false);
  assert.equal(isAuthorized(request(''), 'secret'), false);
});

test('token boşken gateway açılmayı reddeder', () => {
  assert.throws(() => createGatewayApp({ token: '', agentPort: 0, controlPort: 0 }), /IDP_AGENT_API_TOKEN/);
  assert.throws(() => createGatewayApp({ token: '   ', agentPort: 0, controlPort: 0 }), /IDP_AGENT_API_TOKEN/);

  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, IDP_AGENT_API_TOKEN: '', IDP_AGENT_GATEWAY_PORT: '0', IDP_AGENT_GATEWAY_CONTROL_PORT: '0', IDP_AGENT_REGISTRY_PATH: tmpRegistry() },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /IDP_AGENT_API_TOKEN/);
});

test('sunucu tarafı canlılık: iki aralık pong gelmezse agent sonlandırılır', () => {
  const gateway = new AgentGateway({ logger: silent });
  gateway.issueCredential('WIN-01');
  const socket = new FakeSocket();
  gateway.acceptAgent(socket, { socket: { remoteAddress: '10.0.0.1' } }, 'WIN-01');
  socket.emit('message', agentMessage('WIN-01', 'handshake'));
  assert.equal(gateway.listAgents()[0].online, true);

  gateway.checkHeartbeats();
  socket.emit('pong');
  gateway.checkHeartbeats();
  gateway.checkHeartbeats();
  assert.equal(socket.terminated, undefined);
  assert.equal(socket.pings, 3);
  gateway.checkHeartbeats();
  assert.equal(socket.terminated, true);
  assert.equal(gateway.listAgents()[0].online, false);
  gateway.stop();
});

test('handshake zaman aşımı ve upgrade ile handshake arasında rotasyon', async () => {
  const gateway = new AgentGateway({ logger: silent, handshakeTimeoutMs: 20 });
  gateway.issueCredential('WIN-01');
  const idle = new FakeSocket();
  gateway.acceptAgent(idle, { socket: {} }, 'WIN-01');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(idle.closed, { code: 1008, reason: 'Handshake timeout' });

  const pending = new FakeSocket();
  gateway.acceptAgent(pending, { socket: {} }, 'WIN-01');
  gateway.issueCredential('WIN-01');
  assert.deepEqual(pending.closed, { code: 4003, reason: 'Credential rotated' });
  gateway.stop();
});

test('rate limiter penceresi dolunca sıfırlanır', () => {
  let now = 0;
  const limiter = new FailureRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
  assert.equal(limiter.recordFailure('1.1.1.1'), 1);
  assert.equal(limiter.recordFailure('1.1.1.1'), 2);
  assert.equal(limiter.recordFailure('1.1.1.1'), 3);
  assert.equal(limiter.recordFailure('2.2.2.2'), 1);
  now = 1500;
  assert.equal(limiter.recordFailure('1.1.1.1'), 1);
});

// -------------------------------------------------------- integration tests

test('/health: agent portunda sayı yok, kontrol portunda toplam ve çevrimiçi sayısı var', async (t) => {
  const env = await startApp(t);
  const agentHealth = await (await fetch(`${env.agentUrl}/health`)).json();
  assert.deepEqual(agentHealth, { ok: true, service: 'idp-agent-gateway' });

  await issue(env, 'WIN-01');
  const controlHealth = await (await fetch(`${env.controlUrl}/health`)).json();
  assert.deepEqual(controlHealth, { ok: true, service: 'idp-agent-gateway', agents: 1, online: 0 });
});

test('agent portunda kontrol uçları 404 döner (kontrol token ile bile)', async (t) => {
  const env = await startApp(t);
  const cases = [
    ['GET', '/agent/all'],
    ['POST', '/agent/run-deploy-command/WIN-01'],
    ['GET', '/agent/send-app-update-command/WIN-01'],
    ['POST', '/agent/credentials/WIN-01'],
    ['DELETE', '/agent/credentials/WIN-01'],
    ['GET', '/'],
    ['POST', '/health'],
  ];
  for (const [method, pathname] of cases) {
    const response = await env.api(pathname, { method, base: env.agentUrl, body: method === 'POST' ? { command: 'dir' } : undefined });
    assert.equal(response.status, 404, `${method} ${pathname}`);
  }
});

test('kontrol uçları ve abonelik WS kontrol token ister', async (t) => {
  const env = await startApp(t);
  for (const token of ['', 'wrong-token']) {
    assert.equal((await env.api('/agent/all', { token })).status, 401);
    assert.equal((await env.api('/agent/credentials/WIN-01', { method: 'POST', token })).status, 401);
    assert.equal((await env.api('/agent/credentials/WIN-01', { method: 'DELETE', token })).status, 401);
    assert.equal((await env.api('/agent/run-deploy-command/WIN-01', { method: 'POST', token, body: { command: 'dir' } })).status, 401);
    const { status } = await connect(`ws://127.0.0.1:${env.controlPort}/`, token ? { authorization: `Bearer ${token}` } : {});
    assert.equal(status, 401);
  }
});

test('kimlik verilen agent /agent/all içinde hemen çevrimdışı görünür, hash dışarı çıkmaz', async (t) => {
  const env = await startApp(t);
  const response = await env.api('/agent/credentials/WIN-01', { method: 'POST' });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['agentId', 'secret']);
  assert.equal(body.agentId, 'WIN-01');
  assert.match(body.secret, /^[A-Za-z0-9_-]{43}$/);

  const listResponse = await env.api('/agent/all');
  const text = await listResponse.text();
  const [agent] = JSON.parse(text).data;
  assert.equal(agent.id, 'WIN-01');
  assert.equal(agent.online, false);
  assert.equal(agent.connected_at, null);
  assert.equal(agent.last_ping, null);
  assert.equal(typeof agent.credential_issued_at, 'string');
  assert.deepEqual(agent.details, { version: '', agent_version: '', os_info: '' });
  assert.ok(!text.includes(sha256Hex(body.secret)));
  assert.ok(!text.includes('credentialHash'));

  const stored = fs.readFileSync(env.registryPath, 'utf8');
  assert.equal(JSON.parse(stored)[0].credentialHash, sha256Hex(body.secret));
  assert.ok(!stored.includes(body.secret));
  assert.deepEqual(fs.readdirSync(path.dirname(env.registryPath)), ['agents.json']);
});

test('geçersiz agent ID ile kimlik isteği 400 döner', async (t) => {
  const env = await startApp(t);
  for (const id of ['-bad', 'ab', 'a%20b', 'x'.repeat(129), 'a%2Fb', '%E0%A4%A']) {
    assert.equal((await env.api(`/agent/credentials/${id}`, { method: 'POST' })).status, 400, id);
  }
  assert.equal((await env.api('/agent/credentials/WIN-01', { method: 'PUT' })).status, 405);
});

test('agent upgrade: header yok, yanlış secret, bilinmeyen ID veya kontrol token ile 401', async (t) => {
  const env = await startApp(t);
  const secret = await issue(env, 'WIN-01');
  const url = `ws://127.0.0.1:${env.agentPort}/`;
  assert.equal((await connect(url)).status, 401);
  assert.equal((await connect(url, { authorization: `Bearer ${secret}` })).status, 401);
  assert.equal((await connect(url, { 'x-idp-agent-id': 'WIN-01' })).status, 401);
  assert.equal((await connect(url, agentHeaders('WIN-01', 'wrong-secret'))).status, 401);
  assert.equal((await connect(url, agentHeaders('WIN-02', secret))).status, 401);
  assert.equal((await connect(url, agentHeaders('WIN-01', TOKEN))).status, 401);
  assert.equal((await connect(`ws://127.0.0.1:${env.agentPort}/other`, agentHeaders('WIN-01', secret))).status, 404);
});

test('doğru secret ama farklı handshake ID ile bağlantı 1008 ile kapanır', async (t) => {
  const env = await startApp(t);
  const secret = await issue(env, 'WIN-01');
  await issue(env, 'WIN-02');
  const { ws, status } = await connect(`ws://127.0.0.1:${env.agentPort}/`, agentHeaders('WIN-01', secret));
  assert.equal(status, 101);
  ws.send(agentMessage('WIN-02', 'handshake'));
  assert.equal((await ws.closed).code, 1008);
  assert.ok((await listAgents(env)).every((agent) => agent.online === false));
});

test('agent portunda web tipi reddedilir, kontrol portunda agent tipi reddedilir', async (t) => {
  const env = await startApp(t);
  const secret = await issue(env, 'WIN-01');
  const { ws } = await connect(`ws://127.0.0.1:${env.agentPort}/`, agentHeaders('WIN-01', secret));
  ws.send(agentMessage('WIN-01', 'handshake', {}, 'web'));
  assert.equal((await ws.closed).code, 1008);

  const control = await connect(`ws://127.0.0.1:${env.controlPort}/`, { authorization: `Bearer ${TOKEN}` });
  assert.equal(control.status, 101);
  control.ws.send(agentMessage('WIN-01', 'handshake'));
  assert.equal((await control.ws.closed).code, 1008);
  assert.equal((await listAgents(env))[0].online, false);
});

test('uçtan uca: komut agent\'a gider, sonuç aboneye akar', async (t) => {
  const env = await startApp(t);
  const secret = await issue(env, 'WIN-01');
  const agent = await openAgent(env, 'WIN-01', secret);
  const [listed] = await listAgents(env);
  assert.equal(listed.online, true);
  assert.equal(listed.details.os_info, 'Windows');

  const web = await openWeb(env);
  web.send(agentMessage('idp-listener-1', 'subscribe', { targetAgentId: 'WIN-01' }, 'web'));
  await waitUntil(() => [...env.app.gateway.webConnections].some((c) => c.subscriptions.has('WIN-01')));

  const deploy = await env.api('/agent/run-deploy-command/WIN-01', { method: 'POST', body: { command: 'dir' } });
  assert.equal(deploy.status, 200);
  const command = await agent.waitFor((m) => m.process === 'run_deploy');
  assert.deepEqual(command.payload, { command: 'dir' });

  agent.send(agentMessage('WIN-01', 'ping', { cpu: 1 }));
  await agent.waitFor((m) => m.process === 'pong');
  agent.send(agentMessage('WIN-01', 'command_execution_result', { success: true }));
  const forwarded = await web.waitFor((m) => m.process === 'command_execution_result');
  assert.equal(forwarded.agentId, 'WIN-01');
  assert.deepEqual(forwarded.payload, { success: true });
  assert.ok((await listAgents(env))[0].last_ping);
});

test('web bağlantısı aynı ID ile bile agent oturumunu düşüremez', async (t) => {
  const env = await startApp(t);
  const secret = await issue(env, 'WIN-01');
  const agent = await openAgent(env, 'WIN-01', secret);
  const web = await openWeb(env, 'WIN-01');
  web.send(agentMessage('WIN-01', 'subscribe', { targetAgentId: 'WIN-01' }, 'web'));

  assert.equal(agent.readyState, WebSocket.OPEN);
  assert.equal((await listAgents(env))[0].online, true);
  assert.equal((await env.api('/agent/run-deploy-command/WIN-01', { method: 'POST', body: { command: 'whoami' } })).status, 200);
  assert.equal((await agent.waitFor((m) => m.process === 'run_deploy')).payload.command, 'whoami');
  assert.equal(agent.readyState, WebSocket.OPEN);
});

test('rotasyonda canlı oturum 4003 ile kapanır, eski secret geçersizleşir', async (t) => {
  const env = await startApp(t);
  const oldSecret = await issue(env, 'WIN-01');
  const agent = await openAgent(env, 'WIN-01', oldSecret);
  const newSecret = await issue(env, 'WIN-01');
  assert.notEqual(newSecret, oldSecret);
  assert.deepEqual(await agent.closed, { code: 4003, reason: 'Credential rotated' });
  assert.equal((await listAgents(env))[0].online, false);
  assert.equal((await connect(`ws://127.0.0.1:${env.agentPort}/`, agentHeaders('WIN-01', oldSecret))).status, 401);
  await openAgent(env, 'WIN-01', newSecret);
  assert.equal((await listAgents(env))[0].online, true);
});

test('iptalde canlı oturum 4003 ile kapanır ve kayıt silinir', async (t) => {
  const env = await startApp(t);
  const secret = await issue(env, 'WIN-01');
  const agent = await openAgent(env, 'WIN-01', secret);
  const response = await env.api('/agent/credentials/WIN-01', { method: 'DELETE' });
  assert.equal(response.status, 204);
  assert.deepEqual(await agent.closed, { code: 4003, reason: 'Credential revoked' });
  assert.deepEqual(await listAgents(env), []);
  assert.equal((await env.api('/agent/credentials/WIN-01', { method: 'DELETE' })).status, 404);
  assert.equal((await connect(`ws://127.0.0.1:${env.agentPort}/`, agentHeaders('WIN-01', secret))).status, 401);
});

test('aynı kimlikle yeniden bağlanma eski oturumu 4001 ile değiştirir', async (t) => {
  const env = await startApp(t);
  const secret = await issue(env, 'WIN-01');
  const first = await openAgent(env, 'WIN-01', secret);
  const second = await openAgent(env, 'WIN-01', secret);
  assert.equal((await first.closed).code, 4001);
  assert.equal((await listAgents(env))[0].online, true);
  assert.equal((await env.api('/agent/send-app-update-command/WIN-01')).status, 200);
  await second.waitFor((m) => m.process === 'update');
});

test('bağlantısı kapanan agent listede çevrimdışı kalır', async (t) => {
  const env = await startApp(t);
  const secret = await issue(env, 'WIN-01');
  const agent = await openAgent(env, 'WIN-01', secret);
  agent.close(1000, 'restart');
  await waitUntil(async () => (await listAgents(env))[0].online === false);
  assert.equal((await env.api('/agent/run-deploy-command/WIN-01', { method: 'POST', body: { command: 'dir' } })).status, 404);
});

test('rate limit: başarısız denemeler 429 alır, geçerli kimlik engellenmez', async (t) => {
  const env = await startApp(t, { rateLimit: { limit: 3 } });
  const secret = await issue(env, 'WIN-01');
  const url = `ws://127.0.0.1:${env.agentPort}/`;
  for (let i = 0; i < 3; i += 1) assert.equal((await connect(url, agentHeaders('WIN-01', 'bad'))).status, 401);
  const limited = await connect(url, agentHeaders('WIN-01', 'bad'));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  await openAgent(env, 'WIN-01', secret);
});

test('hash\'i olmayan eski kayıt yüklenir ama kimlik verilene kadar bağlanamaz', async (t) => {
  const registryPath = tmpRegistry();
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify([{
    id: 'LEGACY-01', connectedAt: '2026-01-01T00:00:00.000Z', lastPing: null, details: { version: '1.0' }, online: true,
  }]));
  const env = await startApp(t, { registryPath });
  const [legacy] = await listAgents(env);
  assert.equal(legacy.id, 'LEGACY-01');
  assert.equal(legacy.online, false);
  assert.equal(legacy.credential_issued_at, null);
  assert.equal(legacy.details.version, '1.0');
  assert.equal((await connect(`ws://127.0.0.1:${env.agentPort}/`, agentHeaders('LEGACY-01', 'anything'))).status, 401);

  const secret = await issue(env, 'LEGACY-01');
  await openAgent(env, 'LEGACY-01', secret);
  assert.equal((await listAgents(env))[0].online, true);
});
