/**
 * Tests for DeploymentManager's log buffer and subscriber contract (T-34b).
 *
 * The index passed to subscribers is what the SSE layer emits as the event id,
 * and what a reconnecting browser sends back as `Last-Event-ID`. If it ever
 * drifts from the buffer position, clients silently replay or skip log lines.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');

const deploymentManager = require('../src/services/DeploymentManager');

/** Minimal adapter stand-in — createSession only stores it. */
const fakeAdapter = () => ({ abort: async () => {} });

test('subscribers receive the buffer index alongside each line', () => {
  const id = deploymentManager.createSession('p-index', fakeAdapter());
  const received = [];
  const unsubscribe = deploymentManager.subscribe(id, (line, index) => received.push({ line, index }));

  deploymentManager.pushLog(id, 'first');
  deploymentManager.pushLog(id, 'second');
  deploymentManager.pushLog(id, 'third');
  unsubscribe();

  assert.deepEqual(received, [
    { line: 'first', index: 0 },
    { line: 'second', index: 1 },
    { line: 'third', index: 2 },
  ]);
});

test('index continues from the existing buffer for a late subscriber', () => {
  const id = deploymentManager.createSession('p-late', fakeAdapter());
  deploymentManager.pushLog(id, 'before-1');
  deploymentManager.pushLog(id, 'before-2');

  const received = [];
  const unsubscribe = deploymentManager.subscribe(id, (line, index) => received.push(index));
  deploymentManager.pushLog(id, 'after');
  unsubscribe();

  // A client that replayed indices 0..1 must see the next line as 2 — no gap,
  // no repeat.
  assert.deepEqual(received, [2]);
  assert.equal(deploymentManager.getSession(id).logs.length, 3);
});

test('the emitted index always matches the line position in the buffer', () => {
  const id = deploymentManager.createSession('p-match', fakeAdapter());
  const unsubscribe = deploymentManager.subscribe(id, (line, index) => {
    assert.equal(deploymentManager.getSession(id).logs[index], line);
  });

  for (let i = 0; i < 25; i++) deploymentManager.pushLog(id, `line-${i}`);
  unsubscribe();
});

test('a throwing subscriber is dropped without affecting the others', () => {
  const id = deploymentManager.createSession('p-throw', fakeAdapter());
  const good = [];

  deploymentManager.subscribe(id, () => { throw new Error('client went away'); });
  const unsubscribeGood = deploymentManager.subscribe(id, (line, index) => good.push(index));

  deploymentManager.pushLog(id, 'one');
  deploymentManager.pushLog(id, 'two');
  unsubscribeGood();

  assert.deepEqual(good, [0, 1], 'the healthy subscriber keeps receiving lines');
  assert.equal(deploymentManager.getSession(id).subscribers.size, 0);
});

test('pushing to an unknown deployment is a no-op, not a crash', () => {
  assert.doesNotThrow(() => deploymentManager.pushLog('does-not-exist', 'x'));
});

test('unsubscribe stops delivery', () => {
  const id = deploymentManager.createSession('p-unsub', fakeAdapter());
  const received = [];
  const unsubscribe = deploymentManager.subscribe(id, (line) => received.push(line));

  deploymentManager.pushLog(id, 'delivered');
  unsubscribe();
  deploymentManager.pushLog(id, 'not delivered');

  assert.deepEqual(received, ['delivered']);
});

test('abort flips status and signals the AbortController', async () => {
  const id = deploymentManager.createSession('p-abort', fakeAdapter());
  const session = deploymentManager.getSession(id);

  assert.equal(session.signal?.aborted, false, 'a fresh session is not aborted');
  await deploymentManager.abort(id);

  assert.equal(deploymentManager.getSession(id).status, 'aborted');
  assert.equal(deploymentManager.getSession(id).signal.aborted, true);
});
