/**
 * Regression tests for the DeploymentAdapter contract (T-57).
 *
 * Background: the four adapters (SshServerAdapter, PmpWebAdapter,
 * WindowsAdapter, JenkinsAdapter) all extend DeploymentAdapter but used to
 * disagree on basic behavior:
 *   - streamLogs() was a meaningless no-op in three adapters, either
 *     printing a noise line to the user (SSH/PMP) or silently doing
 *     nothing (WinRM) — only JenkinsAdapter streamed anything real.
 *   - The "trigger() must throw on failure, never return a failure status"
 *     contract documented in DeploymentAdapter's JSDoc had nothing
 *     enforcing it.
 *   - abort() was async in some adapters and sync in others.
 *   - Each adapter hand-wrote its own log prefix at every call site.
 *
 * This file guards the fix for all four:
 *   1. supportsLogStreaming defaults to false; only JenkinsAdapter and
 *      CiPipelineAdapter (CI Pipeline provider) opt in.
 *      The base streamLogs() is a silent no-op — no fake log lines.
 *   2. assertTriggerResult() throws when a trigger() return value reports
 *      failure/abort via its `status` field, instead of letting it flow
 *      back as a false "success".
 *   3. abort() is async and idempotent (a second call never throws) on
 *      every adapter.
 *   4. log() auto-applies each adapter's `logPrefix`, and does NOT
 *      double-prefix a message that already carries its own bracket tag
 *      (e.g. `[SSH:Bash]`, `[WinRM ERROR]`, `[WINRM:PowerShell]`) — those
 *      exact strings are parsed by frontend/src/lib/logParser.ts for
 *      terminal coloring/filtering, so they must stay byte-identical.
 *
 * No real SSH/WinRM/Playwright connection is ever established here:
 * constructing an adapter with `{}` config and calling log()/abort()/the
 * base streamLogs() touches no network and no browser — the adapters only
 * dial out from connect()/trigger(), which this file never calls on real
 * adapters. A couple of tests also exercise a small fake adapter
 * (extending DeploymentAdapter directly) to test the generic contract in
 * isolation from any one adapter's specifics.
 *
 * Run with: npm test
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');

const DeploymentAdapter = require('../src/adapters/DeploymentAdapter');
const { assertTriggerResult } = DeploymentAdapter;
const SshServerAdapter = require('../src/adapters/SshServerAdapter');
const PmpWebAdapter = require('../src/adapters/PmpWebAdapter');
const WindowsAdapter = require('../src/adapters/WindowsAdapter');
const JenkinsAdapter = require('../src/adapters/JenkinsAdapter');
const CiPipelineAdapter = require('../src/adapters/CiPipelineAdapter');

/**
 * CiPipelineAdapter validates its config on construction (it throws listing
 * missing settings), so unlike the others it can't be built from `{}`. This
 * minimal valid config never touches the network: nothing below calls
 * connect()/trigger().
 */
function createCiAdapter() {
  return new CiPipelineAdapter({
    ciConfig: { platform: 'github', owner: 'acme', repo: 'web', ref: 'main', pipeline: 'deploy.yml' },
    apiToken: 'contract-test-token',
  });
}

/** [name, factory] for every real adapter — used by the abort() contract loops. */
const ADAPTER_FACTORIES = [
  ['SshServerAdapter', () => new SshServerAdapter({})],
  ['PmpWebAdapter', () => new PmpWebAdapter({})],
  ['WindowsAdapter', () => new WindowsAdapter({})],
  ['JenkinsAdapter', () => new JenkinsAdapter({})],
  ['CiPipelineAdapter', createCiAdapter],
];

/** Minimal fake adapter used to test generic base-class behavior in isolation. */
class FakeAdapter extends DeploymentAdapter {}

// ── assertTriggerResult() ───────────────────────────────────────────────────

test('assertTriggerResult throws on a { status: "Failed" } return value', () => {
  assert.throws(
    () => assertTriggerResult({ status: 'Failed' }, 'FakeAdapter'),
    /reported failure via return value/
  );
});

test('assertTriggerResult throws on a { status: "Aborted" } return value', () => {
  assert.throws(
    () => assertTriggerResult({ status: 'Aborted' }, 'FakeAdapter'),
    /reported failure via return value/
  );
});

test('assertTriggerResult error message names the offending adapter', () => {
  assert.throws(
    () => assertTriggerResult({ status: 'Failed' }, 'MyAdapter'),
    /MyAdapter/
  );
});

test('assertTriggerResult does not throw on a successful return value', () => {
  assert.doesNotThrow(() => assertTriggerResult({ status: 'Succeeded' }, 'FakeAdapter'));
});

test('assertTriggerResult returns the value unchanged on success', () => {
  const result = { status: 'Succeeded', code: 0, extra: 'kept' };
  assert.equal(assertTriggerResult(result, 'FakeAdapter'), result);
});

test('assertTriggerResult tolerates return values without a recognized failure status', () => {
  assert.doesNotThrow(() => assertTriggerResult({ status: 'started', buildNumber: 42 }, 'JenkinsAdapter'));
  assert.doesNotThrow(() => assertTriggerResult(undefined, 'FakeAdapter'));
  assert.doesNotThrow(() => assertTriggerResult(null, 'FakeAdapter'));
});

// ── streamLogs() optionality (supportsLogStreaming) ─────────────────────────

test('DeploymentAdapter base class defaults supportsLogStreaming to false', () => {
  const adapter = new FakeAdapter({});
  assert.equal(adapter.supportsLogStreaming, false);
});

test('the base streamLogs() is a silent no-op — it never calls the callback', async () => {
  const adapter = new FakeAdapter({});
  let called = false;
  await adapter.streamLogs(() => { called = true; });
  assert.equal(called, false);
});

test('only JenkinsAdapter and CiPipelineAdapter set supportsLogStreaming to true', () => {
  assert.equal(new SshServerAdapter({}).supportsLogStreaming, false);
  assert.equal(new PmpWebAdapter({}).supportsLogStreaming, false);
  assert.equal(new WindowsAdapter({}).supportsLogStreaming, false);
  assert.equal(new JenkinsAdapter({}).supportsLogStreaming, true);
  assert.equal(createCiAdapter().supportsLogStreaming, true);
});

test('SshServerAdapter, PmpWebAdapter, and WindowsAdapter no longer override streamLogs() — they inherit the base no-op', () => {
  assert.equal(SshServerAdapter.prototype.streamLogs, DeploymentAdapter.prototype.streamLogs);
  assert.equal(PmpWebAdapter.prototype.streamLogs, DeploymentAdapter.prototype.streamLogs);
  assert.equal(WindowsAdapter.prototype.streamLogs, DeploymentAdapter.prototype.streamLogs);
});

test('JenkinsAdapter still overrides streamLogs() with real progressive-log streaming', () => {
  assert.notEqual(JenkinsAdapter.prototype.streamLogs, DeploymentAdapter.prototype.streamLogs);
});

test('CiPipelineAdapter overrides streamLogs() with real pipeline polling', () => {
  assert.notEqual(CiPipelineAdapter.prototype.streamLogs, DeploymentAdapter.prototype.streamLogs);
});

test('streamLogs() on an adapter with supportsLogStreaming=false produces no log lines at all', async () => {
  for (const Adapter of [SshServerAdapter, PmpWebAdapter, WindowsAdapter]) {
    const adapter = new Adapter({});
    const lines = [];
    adapter.onLog((line) => lines.push(line));
    let callbackCalled = false;
    await adapter.streamLogs(() => { callbackCalled = true; });
    assert.equal(callbackCalled, false, `${Adapter.name}.streamLogs() should not invoke its callback`);
    assert.deepEqual(lines, [], `${Adapter.name}.streamLogs() should not push any log() lines either`);
  }
});

// ── abort() consistency: async + idempotent on every adapter ────────────────

test('abort() is an async function (returns a Promise) on every adapter', () => {
  for (const [name, create] of ADAPTER_FACTORIES) {
    const adapter = create();
    const result = adapter.abort();
    assert.ok(result instanceof Promise, `${name}.abort() should return a Promise`);
    // Prevent an unhandled-rejection warning if something unexpected rejects.
    result.catch(() => {});
  }
});

test('abort() is idempotent — calling it twice never throws, on every adapter', async () => {
  for (const [name, create] of ADAPTER_FACTORIES) {
    const adapter = create();
    await assert.doesNotReject(adapter.abort(), `${name}: first abort() call`);
    await assert.doesNotReject(adapter.abort(), `${name}: second abort() call`);
    assert.equal(adapter.aborted, true);
  }
});

// ── log() / logPrefix ────────────────────────────────────────────────────────

test('log() auto-applies logPrefix to a plain message', () => {
  const adapter = new FakeAdapter({});
  adapter.logPrefix = '[FAKE]';
  const lines = [];
  adapter.onLog((line) => lines.push(line));

  adapter.log('hello world');

  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith('[FAKE] hello world'), lines[0]);
});

test('log() does NOT double-prefix a message that already starts with its own bracket tag', () => {
  const adapter = new FakeAdapter({});
  adapter.logPrefix = '[FAKE]';
  const lines = [];
  adapter.onLog((line) => lines.push(line));

  adapter.log('[Custom:Tag] already tagged');

  assert.ok(lines[0].endsWith('[Custom:Tag] already tagged'), lines[0]);
  assert.ok(!lines[0].includes('[FAKE]'), lines[0]);
});

test('log() applies no prefix at all when logPrefix is unset', () => {
  const adapter = new FakeAdapter({});
  const lines = [];
  adapter.onLog((line) => lines.push(line));

  adapter.log('plain line');

  assert.ok(lines[0].endsWith('plain line'), lines[0]);
});

// The exact bracket text below is load-bearing: frontend/src/lib/logParser.ts
// extracts whatever sits in the first `[...]` after the timestamp as the
// line's `source` for terminal coloring/filtering. If any of these literals
// drift, this test breaks — which is the point (T-57 constraint: the
// refactor to a shared logPrefix must not change what's actually emitted).
test('each real adapter emits its documented, byte-identical log prefix', () => {
  const cases = [
    { Adapter: SshServerAdapter, prefix: '[SSH]' },
    { Adapter: PmpWebAdapter, prefix: '[PMP]' },
    { Adapter: WindowsAdapter, prefix: '[WinRM]' },
    { Adapter: JenkinsAdapter, prefix: '[Jenkins]' },
    { Adapter: CiPipelineAdapter, prefix: '[CI]', create: createCiAdapter },
  ];

  for (const { Adapter, prefix, create } of cases) {
    const adapter = create ? create() : new Adapter({});
    assert.equal(adapter.logPrefix, prefix, `${Adapter.name}.logPrefix`);

    const lines = [];
    adapter.onLog((line) => lines.push(line));
    adapter.log('some message');

    assert.equal(lines.length, 1);
    assert.ok(
      lines[0].endsWith(`${prefix} some message`),
      `${Adapter.name}: expected line to end with "${prefix} some message", got "${lines[0]}"`
    );
    // The timestamp prefix format log() always adds, verified once here.
    assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]\s/);
  }
});

test('SshServerAdapter keeps [SSH:Bash] / [SSH:Bash:stderr] as their own distinct, un-double-prefixed tags', () => {
  const adapter = new SshServerAdapter({});
  const lines = [];
  adapter.onLog((line) => lines.push(line));

  adapter.log('[SSH:Bash] npm install');
  adapter.log('[SSH:Bash:stderr] warning: deprecated');

  assert.ok(lines[0].endsWith('[SSH:Bash] npm install'), lines[0]);
  assert.ok(lines[1].endsWith('[SSH:Bash:stderr] warning: deprecated'), lines[1]);
  assert.ok(!lines[0].includes('[SSH] ['), lines[0]);
  assert.ok(!lines[1].includes('[SSH] ['), lines[1]);
});

test('WindowsAdapter keeps [WINRM:PowerShell] / [WinRM ERROR] as their own distinct, un-double-prefixed tags', () => {
  const adapter = new WindowsAdapter({});
  const lines = [];
  adapter.onLog((line) => lines.push(line));

  adapter.log('[WINRM:PowerShell] Restarting service...');
  adapter.log('[WinRM ERROR] Sunucuya ulasilamadi.');

  assert.ok(lines[0].endsWith('[WINRM:PowerShell] Restarting service...'), lines[0]);
  assert.ok(lines[1].endsWith('[WinRM ERROR] Sunucuya ulasilamadi.'), lines[1]);
  assert.ok(!lines[0].includes('[WinRM] ['), lines[0]);
  assert.ok(!lines[1].includes('[WinRM] ['), lines[1]);
});
