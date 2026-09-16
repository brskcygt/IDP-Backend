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

test('kontrol listener loopback dışına açılamaz', () => {
  assert.throws(
    () => createGatewayApp({ token: TOKEN, agentPort: 0, controlHost: '0.0.0.0', controlPort: 0 }),
    /loopback/
  );
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
    ['GET', '/agent/allowlist'],
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
    assert.equal((await env.api('/agent/allowlist', { token })).status, 401);
    assert.equal((await env.api('/agent/allowlist', { method: 'POST', token, body: { entry: '203.0.113.4' } })).status, 401);
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

// ------------------------------------------------------------ artifact deploy

test('artifact-command: izinli komutlar agent\'a gider, yanıt 200 {sent:true}', async (t) => {
  const env = await startApp(t);
  const secret = await issue(env, 'WIN-01');
  const agent = await openAgent(env, 'WIN-01', secret);

  const payloads = {
    artifact_deploy: { deployId: 'dep_1', project: 'jetsrm', version: '2.5.0', timeoutSec: 1800, components: [] },
    artifact_rollback: { deployId: 'dep_2', components: null },
    artifact_config_apply: { deployId: 'dep_3', timeoutSec: 300, components: [{ name: 'backend', runtimeConfig: { format: 'env-file', values: { PORT: '3000' } } }] },
    artifact_cancel: { deployId: 'dep_1' },
    artifact_status: { requestId: 'req_1' },
  };
  for (const [process, payload] of Object.entries(payloads)) {
    const response = await env.api('/agent/artifact-command/WIN-01', { method: 'POST', body: { process, payload } });
    assert.equal(response.status, 200, process);
    assert.deepEqual(await response.json(), { type: true, sent: true });
    const command = await agent.waitFor((m) => m.process === process);
    assert.equal(command.type, 'server');
    assert.equal(command.agentId, 'WIN-01');
    assert.deepEqual(command.payload, payload);
  }
});

test('artifact-command: izin listesi, payload tipi, ID, 256 KB sınırı ve metot doğrulanır', async (t) => {
  const env = await startApp(t);
  const secret = await issue(env, 'WIN-01');
  const agent = await openAgent(env, 'WIN-01', secret);
  const post = (body, id = 'WIN-01') => env.api(`/agent/artifact-command/${id}`, { method: 'POST', body });

  for (const process of ['run_deploy', 'update', 'handshake', '', undefined]) {
    assert.equal((await post({ process, payload: { deployId: 'dep_1' } })).status, 400, String(process));
  }
  for (const payload of ['text', [1, 2], null, undefined, 42]) {
    assert.equal((await post({ process: 'artifact_deploy', payload })).status, 400, JSON.stringify(payload));
  }
  assert.equal((await post({ process: 'artifact_cancel', payload: { deployId: 'dep_1' } }, '-bad')).status, 400);
  assert.equal((await post({ process: 'artifact_deploy', payload: { blob: 'x'.repeat(300 * 1024) } })).status, 413);
  assert.equal((await env.api('/agent/artifact-command/WIN-01')).status, 405);

  const invalidJson = await fetch(`${env.controlUrl}/agent/artifact-command/WIN-01`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(invalidJson.status, 400);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!agent.messages.some((m) => String(m.process).startsWith('artifact_') || m.process === 'run_deploy'));
});

test('artifact-command: çevrimdışı agent 404, kontrol token zorunlu, agent portunda yok', async (t) => {
  const env = await startApp(t);
  await issue(env, 'WIN-01');
  const body = { process: 'artifact_status', payload: { requestId: 'req_1' } };
  assert.equal((await env.api('/agent/artifact-command/WIN-01', { method: 'POST', body })).status, 404);
  assert.equal((await env.api('/agent/artifact-command/WIN-99', { method: 'POST', body })).status, 404);
  for (const token of ['', 'wrong-token']) {
    assert.equal((await env.api('/agent/artifact-command/WIN-01', { method: 'POST', body, token })).status, 401);
  }
  assert.equal((await env.api('/agent/artifact-command/WIN-01', { method: 'POST', body, base: env.agentUrl })).status, 404);
});

test('artifact deploy/config event, result ve status mesajları aboneye akar', async (t) => {
  const env = await startApp(t);
  const secret = await issue(env, 'WIN-01');
  const agent = await openAgent(env, 'WIN-01', secret);
  const web = await openWeb(env);
  web.send(agentMessage('idp-listener-1', 'subscribe', { targetAgentId: 'WIN-01' }, 'web'));
  await waitUntil(() => [...env.app.gateway.webConnections].some((c) => c.subscriptions.has('WIN-01')));

  const messages = {
    deploy_event: { deployId: 'dep_1', component: 'backend', stage: 'downloading', status: 'progress', progress: 40, message: '' },
    deploy_result: { deployId: 'dep_1', success: true, version: '2.5.0', rolledBack: false, durationMs: 10, components: [], error: null },
    artifact_config_event: { deployId: 'dep_3', component: 'backend', stage: 'configuring', status: 'done', message: '.env written' },
    artifact_config_result: { deployId: 'dep_3', success: true, version: '2.5.0', components: [] },
    artifact_status_result: { requestId: 'req_1', basePath: 'C:/inetpub/wwwroot/jetsrm', components: {} },
  };
  agent.send(agentMessage('WIN-01', 'not_forwarded', { secret: 'x' }));
  for (const [process, payload] of Object.entries(messages)) {
    agent.send(agentMessage('WIN-01', process, payload));
    const forwarded = await web.waitFor((m) => m.process === process);
    assert.equal(forwarded.type, 'agent');
    assert.equal(forwarded.agentId, 'WIN-01');
    assert.deepEqual(forwarded.payload, payload);
  }
  assert.ok(!web.messages.some((m) => m.process === 'not_forwarded'));
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

// ------------------------------------------------------- source IP allowlist

function tmpAllowlist() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idp-gw-al-')), 'data', 'agent-allowlist.json');
}

test('allowlist boşken her kaynak kabul edilir ve enforcing false döner', async (t) => {
  const env = await startApp(t, { allowlistPath: tmpAllowlist() });
  const body = await (await env.api('/agent/allowlist')).json();
  assert.deepEqual(body.data, { enforcing: false, entries: [] });

  const secret = await issue(env, 'WIN-01');
  const ws = await openAgent(env, 'WIN-01', secret);
  assert.equal(ws.readyState, WebSocket.OPEN);
});

test('allowlist doluyken izinli kaynak bağlanır, izinsiz kaynak 403 alır', async (t) => {
  const env = await startApp(t, { allowlistPath: tmpAllowlist() });
  const secret = await issue(env, 'WIN-01');

  // Testler 127.0.0.1 üzerinden bağlanıyor; listeye başka bir adres koymak
  // yerel bağlantıyı dışarıda bırakır.
  const added = await env.api('/agent/allowlist', { method: 'POST', body: { entry: '203.0.113.0/24', note: 'ofis' } });
  assert.equal(added.status, 201);
  assert.equal((await added.json()).data.enforcing, true);

  const blocked = await connect(`ws://127.0.0.1:${env.agentPort}/`, agentHeaders('WIN-01', secret));
  assert.equal(blocked.status, 403);

  // Loopback eklenince aynı agent geçer.
  assert.equal((await env.api('/agent/allowlist', { method: 'POST', body: { entry: '127.0.0.1' } })).status, 201);
  const ws = await openAgent(env, 'WIN-01', secret);
  assert.equal(ws.readyState, WebSocket.OPEN);
});

test('allowlist reddi kimlik doğrulamasından ÖNCE olur: geçersiz secret de 403 alır', async (t) => {
  const env = await startApp(t, { allowlistPath: tmpAllowlist() });
  await issue(env, 'WIN-01');
  assert.equal((await env.api('/agent/allowlist', { method: 'POST', body: { entry: '203.0.113.0/24' } })).status, 201);

  // 401 dönseydi, izinsiz bir kaynak agent id/secret denemesi yapabildiğini
  // anlardı; 403 hiçbir kimlik bilgisi sızdırmaz.
  const { status } = await connect(`ws://127.0.0.1:${env.agentPort}/`, agentHeaders('WIN-01', 'yanlis-secret'));
  assert.equal(status, 403);
});

test('güvenilir proxy tanımlı değilken CF-Connecting-IP yok sayılır (spoof edilemez)', async (t) => {
  const env = await startApp(t, { allowlistPath: tmpAllowlist() });
  const secret = await issue(env, 'WIN-01');
  assert.equal((await env.api('/agent/allowlist', { method: 'POST', body: { entry: '203.0.113.4' } })).status, 201);

  const { status } = await connect(`ws://127.0.0.1:${env.agentPort}/`, {
    ...agentHeaders('WIN-01', secret),
    'cf-connecting-ip': '203.0.113.4',
    'x-forwarded-for': '203.0.113.4',
  });
  assert.equal(status, 403);
});

test('güvenilir proxy arkasında CF-Connecting-IP allowlist kararına girer', async (t) => {
  const env = await startApp(t, { allowlistPath: tmpAllowlist(), trustedProxies: ['127.0.0.1'] });
  const secret = await issue(env, 'WIN-01');
  assert.equal((await env.api('/agent/allowlist', { method: 'POST', body: { entry: '203.0.113.4' } })).status, 201);

  const blocked = await connect(`ws://127.0.0.1:${env.agentPort}/`, agentHeaders('WIN-01', secret));
  assert.equal(blocked.status, 403, 'header yokken peer adresi bakılır ve listede değil');

  const ws = await connect(`ws://127.0.0.1:${env.agentPort}/`, { ...agentHeaders('WIN-01', secret), 'cf-connecting-ip': '203.0.113.4' });
  assert.equal(ws.status, 101);
  ws.ws.close();
});

test('allowlist girdileri doğrulanır, tekrar eklenemez ve silinebilir', async (t) => {
  const env = await startApp(t, { allowlistPath: tmpAllowlist() });

  for (const entry of ['', 'not-an-ip', '203.0.113.0/33', '203.0.113.4/abc']) {
    const response = await env.api('/agent/allowlist', { method: 'POST', body: { entry } });
    assert.equal(response.status, 400, entry);
  }

  assert.equal((await env.api('/agent/allowlist', { method: 'POST', body: { entry: '203.0.113.4' } })).status, 201);
  assert.equal((await env.api('/agent/allowlist', { method: 'POST', body: { entry: '203.0.113.4' } })).status, 400, 'tekrar');

  // IPv4-mapped IPv6 aynı girdi sayılır.
  assert.equal((await env.api('/agent/allowlist', { method: 'POST', body: { entry: '::ffff:203.0.113.4' } })).status, 400);

  assert.equal((await env.api('/agent/allowlist', { method: 'DELETE', body: { entry: '198.51.100.1' } })).status, 404);
  const removed = await env.api('/agent/allowlist', { method: 'DELETE', body: { entry: '203.0.113.4' } });
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).data, { enforcing: false, entries: [] });
});

test('allowlist yeniden başlatmaya dayanır', async (t) => {
  const allowlistPath = tmpAllowlist();
  const env = await startApp(t, { allowlistPath });
  assert.equal((await env.api('/agent/allowlist', { method: 'POST', body: { entry: '203.0.113.0/24', note: 'ofis' } })).status, 201);
  await env.app.close();

  const again = await startApp(t, { allowlistPath });
  const body = await (await again.api('/agent/allowlist')).json();
  assert.equal(body.data.enforcing, true);
  assert.equal(body.data.entries.length, 1);
  assert.equal(body.data.entries[0].entry, '203.0.113.0/24');
  assert.equal(body.data.entries[0].note, 'ofis');
});
