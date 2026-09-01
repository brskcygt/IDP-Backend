/**
 * Tests for VpnSupervisor (T-56) — the single-active-tunnel choke point in
 * front of VpnManager.connect()/disconnect().
 *
 * These never establish a real VPN: setTunnelDriver() injects fake
 * connect/disconnect functions, so every assertion here is about
 * sharing/queueing/linger bookkeeping, not about any actual VPN binary.
 */
'use strict';

const assert = require('node:assert/strict');
const { test, beforeEach, afterEach } = require('node:test');

const { VpnSupervisor, setTunnelDriver } = require('../src/services/vpn/VpnSupervisor');

let connectCalls;
let disconnectCalls;
let fakeDriver;

function makeFakeDriver() {
  connectCalls = [];
  disconnectCalls = [];
  let nextId = 1;
  return {
    connect: async (vpnConfig, onLog, projectId, deploymentId) => {
      const session = { vpnId: `fake-${nextId++}`, type: vpnConfig.type, rawConfig: vpnConfig };
      connectCalls.push({ vpnConfig, projectId, deploymentId, session });
      onLog(`[fake] connected ${vpnConfig.host}`);
      return session;
    },
    disconnect: async (session, onLog) => {
      disconnectCalls.push({ session });
      onLog(`[fake] disconnected ${session?.rawConfig?.host}`);
    },
  };
}

beforeEach(() => {
  VpnSupervisor._resetForTests();
  VpnSupervisor.setLingerMs(20); // fast for tests; real default is 30000
  fakeDriver = makeFakeDriver();
  setTunnelDriver(fakeDriver);
});

afterEach(() => {
  setTunnelDriver(null);
  VpnSupervisor._resetForTests();
});

function config(overrides = {}) {
  return { type: 'fortinet', host: 'vpn.example.com', username: 'operator', password: 'secret', ...overrides };
}

function collectLogs() {
  const lines = [];
  const onLog = (line) => lines.push(line);
  return { lines, onLog };
}

test('a second request for the same config shares the tunnel: refCount 2, exactly one connect() call', async () => {
  const a = collectLogs();
  const b = collectLogs();

  const handleA = await VpnSupervisor.acquire(config(), { onLog: a.onLog, deploymentId: 'dep-a' });
  const handleB = await VpnSupervisor.acquire(config(), { onLog: b.onLog, deploymentId: 'dep-b' });

  assert.equal(connectCalls.length, 1, 'expected exactly one real connect() call for the shared config');
  assert.equal(VpnSupervisor.listState().refCount, 2);
  assert.equal(VpnSupervisor.listState().active.host, 'vpn.example.com');
  assert.ok(b.lines.some((l) => l.includes('Sharing already-active tunnel')));

  // Same underlying session for both handles (they share the one tunnel).
  assert.equal(handleA.vpnId, handleB.vpnId);
});

test('a request for a different config queues, and takes over once the first is fully released', async () => {
  const a = collectLogs();
  const b = collectLogs();

  const handleA = await VpnSupervisor.acquire(config({ host: 'vpn-a.example.com' }), { onLog: a.onLog, deploymentId: 'dep-a' });

  let resolvedB = false;
  const acquireB = VpnSupervisor.acquire(config({ host: 'vpn-b.example.com' }), { onLog: b.onLog, deploymentId: 'dep-b' })
    .then((h) => { resolvedB = true; return h; });

  // Give the microtask queue a tick — acquireB must still be queued, not resolved.
  await new Promise((r) => setImmediate(r));
  assert.equal(resolvedB, false, 'the different-config request must not resolve before the first tunnel is released');
  assert.equal(VpnSupervisor.listState().queued, 1);
  assert.ok(b.lines.some((l) => /Waiting for the active tunnel/.test(l)));

  await handleA.__release();

  const handleB = await acquireB;
  assert.equal(resolvedB, true);
  assert.equal(handleB.rawConfig.host, 'vpn-b.example.com');
  assert.equal(connectCalls.length, 2, 'expected a real connect() call for each distinct config');
  assert.equal(disconnectCalls.length, 1, 'expected the first tunnel to have been torn down before the handover');
  assert.equal(VpnSupervisor.listState().queued, 0);
});

test('the last release does not disconnect immediately — it disconnects after the linger period', async () => {
  const { onLog } = collectLogs();
  const handle = await VpnSupervisor.acquire(config(), { onLog, deploymentId: 'dep-a' });

  await handle.__release();
  assert.equal(disconnectCalls.length, 0, 'must not disconnect synchronously on release');

  await new Promise((r) => setTimeout(r, VpnSupervisor.lingerMs + 30));
  assert.equal(disconnectCalls.length, 1, 'expected disconnect after the linger period elapsed');
});

test('a new request for the same config during the linger window cancels the pending disconnect and reuses the tunnel', async () => {
  const a = collectLogs();
  const b = collectLogs();

  const handleA = await VpnSupervisor.acquire(config(), { onLog: a.onLog, deploymentId: 'dep-a' });
  await handleA.__release();

  // Re-acquire immediately, well inside the linger window.
  const handleB = await VpnSupervisor.acquire(config(), { onLog: b.onLog, deploymentId: 'dep-b' });

  await new Promise((r) => setTimeout(r, VpnSupervisor.lingerMs + 30));

  assert.equal(connectCalls.length, 1, 'must not have reconnected — the tunnel was reused during linger');
  assert.equal(disconnectCalls.length, 0, 'the pending linger-disconnect must have been cancelled');
  assert.equal(handleB.vpnId, handleA.vpnId);
});

test('calling release() twice does not corrupt refCount or double-disconnect', async () => {
  const a = collectLogs();
  const b = collectLogs();

  const handleA = await VpnSupervisor.acquire(config(), { onLog: a.onLog, deploymentId: 'dep-a' });
  const handleB = await VpnSupervisor.acquire(config(), { onLog: b.onLog, deploymentId: 'dep-b' });

  assert.equal(VpnSupervisor.listState().refCount, 2);

  await handleA.__release();
  await handleA.__release(); // double release — must be a no-op
  assert.equal(VpnSupervisor.listState().refCount, 1, 'double release must not double-decrement');

  await handleB.__release();
  await new Promise((r) => setTimeout(r, VpnSupervisor.lingerMs + 30));
  assert.equal(disconnectCalls.length, 1, 'expected exactly one real disconnect despite the earlier double release');
});

test('cancelQueued() removes a still-queued request and rejects its acquire() promise', async () => {
  const a = collectLogs();
  const b = collectLogs();

  await VpnSupervisor.acquire(config({ host: 'vpn-a.example.com' }), { onLog: a.onLog, deploymentId: 'dep-a' });

  const acquireB = VpnSupervisor.acquire(config({ host: 'vpn-b.example.com' }), { onLog: b.onLog, deploymentId: 'dep-b' });
  await new Promise((r) => setImmediate(r));
  assert.equal(VpnSupervisor.listState().queued, 1);

  const removed = VpnSupervisor.cancelQueued('dep-b');
  assert.equal(removed, true);
  assert.equal(VpnSupervisor.listState().queued, 0);

  await assert.rejects(() => acquireB, /cancelled/i);

  // A no-op cancel for a deploymentId that isn't queued returns false.
  assert.equal(VpnSupervisor.cancelQueued('dep-does-not-exist'), false);
});

test('listState() reports active/queued/refCount accurately through a share + queue scenario', async () => {
  assert.deepEqual(VpnSupervisor.listState(), { active: null, queued: 0, refCount: 0 });

  const handleA = await VpnSupervisor.acquire(config({ host: 'vpn-a.example.com' }), { onLog: () => {}, deploymentId: 'dep-a' });
  await VpnSupervisor.acquire(config({ host: 'vpn-a.example.com' }), { onLog: () => {}, deploymentId: 'dep-a2' });

  let state = VpnSupervisor.listState();
  assert.equal(state.refCount, 2);
  assert.equal(state.active.host, 'vpn-a.example.com');
  assert.equal(state.queued, 0);

  const queuedAcquire = VpnSupervisor.acquire(config({ host: 'vpn-b.example.com' }), { onLog: () => {}, deploymentId: 'dep-b' });
  // afterEach's _resetForTests() rejects any still-queued request; swallow
  // that expected rejection here so it doesn't surface as an unhandled one.
  queuedAcquire.catch(() => {});
  await new Promise((r) => setImmediate(r));
  state = VpnSupervisor.listState();
  assert.equal(state.queued, 1);

  void handleA; // silence unused warning in strict linting setups
});
