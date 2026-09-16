/**
 * Tests for core/diagnostics/connectionTest.js (T-73).
 *
 * Every dependency `testProjectConnection()` touches externally (the adapter
 * classes, PmpService, the SSH host-key verifier, node-ssh, undici's fetch,
 * `net.connect`, secret resolution) is injected via the `deps` argument here
 * with a fake — this file NEVER opens a real socket, dials a real Jenkins/
 * SSH/WinRM/PMP target, or touches the on-disk host key repository. That is
 * the whole point of the dependency-injection seam in connectionTest.js.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');

const {
  testProjectConnection,
  DEFAULT_CHECK_TIMEOUT_MS,
  MAX_TOTAL_BUDGET_MS,
} = require('../src/core/diagnostics/connectionTest');

const ACTOR_PROJECT_ID = 'proj-1';

/** Pass-through — most tests don't exercise real secret-store resolution. */
const passThroughResolveSecrets = async (project) => project;

function baseProject(overrides = {}) {
  return {
    id: ACTOR_PROJECT_ID,
    name: 'Test Project',
    provider: 'Server',
    config: {},
    ...overrides,
  };
}

// ── Jenkins ──────────────────────────────────────────────────────────────

function fakeJenkinsAdapterClass({ connectBehavior = 'ok', jobLookup = 'ok' } = {}) {
  return class FakeJenkinsAdapter {
    constructor(config) {
      this.config = config;
      this._log = () => {};
      this.client = {
        get: async (urlPath) => {
          if (jobLookup === 'ok') return { data: { name: config.jobName } };
          if (jobLookup === '404') {
            throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
          }
          if (jobLookup === '401') {
            throw Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
          }
          throw new Error('boom');
        },
      };
    }

    onLog(cb) {
      this._log = cb;
    }

    async connect() {
      if (connectBehavior === 'ok') {
        this._log('✓ Connected to Jenkins v2.401');
        return;
      }
      if (connectBehavior === 'warn') {
        this._log('⚠ Could not verify Jenkins API (404). Proceeding anyway.');
        return;
      }
      if (connectBehavior === 'refused') {
        throw new Error('Cannot reach Jenkins at http://jenkins.local. Is it running?');
      }
      if (connectBehavior === 'auth-fail') {
        throw new Error('Jenkins authentication failed. Check username/apiToken.');
      }
      throw new Error('unexpected connect behavior in test double');
    }
  };
}

test('Jenkins: API reachable + job exists -> both checks ok:true', async () => {
  const project = baseProject({
    provider: 'Jenkins',
    config: { url: 'http://jenkins.local', jobName: 'deploy-job', username: 'admin', apiToken: 'tok' },
  });

  const result = await testProjectConnection({
    project,
    deps: {
      JenkinsAdapter: fakeJenkinsAdapterClass({ connectBehavior: 'ok', jobLookup: 'ok' }),
      resolveSecrets: passThroughResolveSecrets,
    },
  });

  assert.equal(result.ok, true);
  const api = result.checks.find((c) => c.name === 'Jenkins API');
  const job = result.checks.find((c) => c.name === 'Jenkins Job');
  assert.equal(api.ok, true);
  assert.equal(job.ok, true);
  assert.match(job.detail, /deploy-job/);
});

test('Jenkins: connection refused -> Jenkins API fails with an actionable message, job not tested', async () => {
  const project = baseProject({
    provider: 'Jenkins',
    config: { url: 'http://jenkins.local', jobName: 'deploy-job' },
  });

  const result = await testProjectConnection({
    project,
    deps: {
      JenkinsAdapter: fakeJenkinsAdapterClass({ connectBehavior: 'refused' }),
      resolveSecrets: passThroughResolveSecrets,
    },
  });

  assert.equal(result.ok, false);
  const api = result.checks.find((c) => c.name === 'Jenkins API');
  const job = result.checks.find((c) => c.name === 'Jenkins Job');
  assert.equal(api.ok, false);
  assert.match(api.detail, /Cannot reach Jenkins/);
  assert.equal(job.ok, null);
});

test('Jenkins: 401/403 on connect -> actionable authentication message, no raw stack', async () => {
  const project = baseProject({
    provider: 'Jenkins',
    config: { url: 'http://jenkins.local', jobName: 'deploy-job' },
  });

  const result = await testProjectConnection({
    project,
    deps: {
      JenkinsAdapter: fakeJenkinsAdapterClass({ connectBehavior: 'auth-fail' }),
      resolveSecrets: passThroughResolveSecrets,
    },
  });

  const api = result.checks.find((c) => c.name === 'Jenkins API');
  assert.equal(api.ok, false);
  assert.match(api.detail, /Authentication failed — check the username or the credential in project settings\./);
  assert.doesNotMatch(api.detail, /at Object|\.js:\d+/, 'must never leak a raw stack trace');
});

test('Jenkins: ambiguous connect (adapter warns but does not throw) is surfaced as a failure, not silently ok', async () => {
  const project = baseProject({
    provider: 'Jenkins',
    config: { url: 'http://jenkins.local' },
  });

  const result = await testProjectConnection({
    project,
    deps: {
      JenkinsAdapter: fakeJenkinsAdapterClass({ connectBehavior: 'warn' }),
      resolveSecrets: passThroughResolveSecrets,
    },
  });

  const api = result.checks.find((c) => c.name === 'Jenkins API');
  assert.equal(api.ok, false);
});

test('Jenkins: job not found (404) reports a specific, actionable message', async () => {
  const project = baseProject({
    provider: 'Jenkins',
    config: { url: 'http://jenkins.local', jobName: 'ghost-job' },
  });

  const result = await testProjectConnection({
    project,
    deps: {
      JenkinsAdapter: fakeJenkinsAdapterClass({ connectBehavior: 'ok', jobLookup: '404' }),
      resolveSecrets: passThroughResolveSecrets,
    },
  });

  const job = result.checks.find((c) => c.name === 'Jenkins Job');
  assert.equal(job.ok, false);
  assert.match(job.detail, /ghost-job.*not found/);
});

test('Jenkins: no job name configured -> Jenkins Job is ok:null, not a failure', async () => {
  const project = baseProject({
    provider: 'Jenkins',
    config: { url: 'http://jenkins.local' },
  });

  const result = await testProjectConnection({
    project,
    deps: {
      JenkinsAdapter: fakeJenkinsAdapterClass({ connectBehavior: 'ok' }),
      resolveSecrets: passThroughResolveSecrets,
    },
  });

  const job = result.checks.find((c) => c.name === 'Jenkins Job');
  assert.equal(job.ok, null);
  // A null check must not drag the overall result down.
  assert.equal(result.ok, true);
});

// ── PMP (provider) ───────────────────────────────────────────────────────

test('PMP provider: vault configured and reachable -> ok:true', async () => {
  const project = baseProject({
    provider: 'PMP',
    config: { pmpConfig: { baseUrl: 'https://pmp.local', authToken: 'tok', resourceName: 'r', accountName: 'a' } },
  });

  const result = await testProjectConnection({
    project,
    deps: {
      PmpService: { testConnection: async () => ({ success: true, message: 'Connection verified successfully.' }) },
      resolveSecrets: passThroughResolveSecrets,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].name, 'PMP Vault');
  assert.equal(result.checks[0].ok, true);
});

test('PMP provider: vault rejects credentials -> ok:false with the vault message', async () => {
  const project = baseProject({
    provider: 'PMP',
    config: { pmpConfig: { baseUrl: 'https://pmp.local', authToken: 'bad', resourceName: 'r', accountName: 'a' } },
  });

  const result = await testProjectConnection({
    project,
    deps: {
      PmpService: { testConnection: async () => ({ success: false, message: 'Failed: HTTP 401' }) },
      resolveSecrets: passThroughResolveSecrets,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks[0].ok, false);
  assert.match(result.checks[0].detail, /401/);
});

test('PMP provider: vault not configured -> ok:null, does not fail the whole test', async () => {
  const project = baseProject({ provider: 'PMP', config: {} });

  const result = await testProjectConnection({
    project,
    deps: {
      PmpService: { testConnection: async () => { throw new Error('must not be called'); } },
      resolveSecrets: passThroughResolveSecrets,
    },
  });

  assert.equal(result.checks[0].ok, null);
  assert.equal(result.ok, true);
});

// ── Server/SSH (linux) ───────────────────────────────────────────────────

/** Fake `net.connect` — resolves connect/error/timeout on the next tick, per scenario. */
function fakeNetConnect(scenario) {
  return function connect() {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    setImmediate(() => {
      if (scenario === 'connect') socket.emit('connect');
      else if (scenario === 'refused') socket.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      else if (scenario === 'timeout-event') socket.emit('timeout');
      // 'hang': never emits anything — exercises connectionTest's own timeout.
    });
    return socket;
  };
}

/** Fake host key verifier factory — lets a test dictate TOFU/mismatch outcomes without touching the real repository. */
function fakeCreateHostVerifier(outcome, logLine) {
  return ({ onLog }) => (_keyBuffer) => {
    if (logLine) onLog(logLine);
    return outcome;
  };
}

function fakeNodeSSHClass({ connectBehavior = 'success', invokeHostVerifier = true } = {}) {
  return class FakeNodeSSH {
    async connect(config) {
      if (invokeHostVerifier && typeof config.hostVerifier === 'function') {
        const permitted = config.hostVerifier(Buffer.from('fake-ssh-key'));
        if (permitted === false) {
          throw new Error('Host key verification failed for the target host.');
        }
      }
      if (connectBehavior === 'success') return;
      if (connectBehavior === 'auth-fail') throw new Error('All configured authentication methods failed');
      if (connectBehavior === 'refused') throw new Error('connect ECONNREFUSED 10.0.0.5:22');
      if (connectBehavior === 'hang') return new Promise(() => {});
      throw new Error('unexpected connect behavior in test double');
    }

    dispose() {}
  };
}

test('Server/SSH: TCP unreachable -> only TCP fails, everything downstream is ok:null (not tested)', async () => {
  const project = baseProject({
    provider: 'Server',
    config: { targetOS: 'linux', host: '10.0.0.5', username: 'deployer', password: 'super-secret-ssh' },
  });

  const result = await testProjectConnection({
    project,
    deps: {
      netConnect: fakeNetConnect('refused'),
      NodeSSHImpl: fakeNodeSSHClass({ connectBehavior: 'success' }),
      createHostVerifier: fakeCreateHostVerifier(true),
      resolveSecrets: passThroughResolveSecrets,
    },
  });

  assert.equal(result.ok, false);
  const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
  assert.equal(byName['TCP Reachability'].ok, false);
  assert.equal(byName['SSH Handshake'].ok, null);
  assert.equal(byName['Host Key Policy'].ok, null);
  assert.equal(byName['Authentication'].ok, null);
});

test('Server/SSH: full success -> TCP, handshake, host key, and auth all ok:true', async () => {
  const project = baseProject({
    provider: 'Server',
    config: { targetOS: 'linux', host: '10.0.0.5', username: 'deployer', password: 'super-secret-ssh' },
  });

  const result = await testProjectConnection({
    project,
    deps: {
      netConnect: fakeNetConnect('connect'),
      NodeSSHImpl: fakeNodeSSHClass({ connectBehavior: 'success' }),
      createHostVerifier: fakeCreateHostVerifier(true, '[SSH] Host key for 10.0.0.5:22 not previously known. Trusting on first use (TOFU) and pinning fingerprint SHA256:abc (ssh-ed25519).'),
      resolveSecrets: passThroughResolveSecrets,
    },
  });

  assert.equal(result.ok, true);
  const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
  assert.equal(byName['TCP Reachability'].ok, true);
  assert.equal(byName['SSH Handshake'].ok, true);
  assert.equal(byName['Host Key Policy'].ok, true);
  assert.match(byName['Host Key Policy'].detail, /TOFU/);
  assert.equal(byName['Authentication'].ok, true);
});

test('Server/SSH: host key rejected -> Host Key Policy fails, auth is not tested', async () => {
  const project = baseProject({
    provider: 'Server',
    config: { targetOS: 'linux', host: '10.0.0.5', username: 'deployer', password: 'super-secret-ssh', hostKeyPolicy: 'strict' },
  });

  const result = await testProjectConnection({
    project,
    deps: {
      netConnect: fakeNetConnect('connect'),
      NodeSSHImpl: fakeNodeSSHClass({ connectBehavior: 'success' }),
      createHostVerifier: fakeCreateHostVerifier(false, "[SSH] ✗ Host key verification FAILED for 10.0.0.5:22: no key pinned yet and policy is 'strict'."),
      resolveSecrets: passThroughResolveSecrets,
    },
  });

  assert.equal(result.ok, false);
  const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
  assert.equal(byName['Host Key Policy'].ok, false);
  assert.equal(byName['Authentication'].ok, null);
});

test('Server/SSH: wrong password -> Authentication fails with an actionable message', async () => {
  const project = baseProject({
    provider: 'Server',
    config: { targetOS: 'linux', host: '10.0.0.5', username: 'deployer', password: 'wrong-password' },
  });

  const result = await testProjectConnection({
    project,
    deps: {
      netConnect: fakeNetConnect('connect'),
      NodeSSHImpl: fakeNodeSSHClass({ connectBehavior: 'auth-fail' }),
      createHostVerifier: fakeCreateHostVerifier(true),
      resolveSecrets: passThroughResolveSecrets,
    },
  });

  const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
  assert.equal(byName['SSH Handshake'].ok, true, 'handshake completed before auth was rejected');
  assert.equal(byName['Authentication'].ok, false);
  assert.equal(
    byName['Authentication'].detail,
    'Authentication failed — check the username or the credential in project settings.'
  );
});

test('Server/SSH: PMP-vault-authenticated project with no fetched password -> Authentication is ok:null, not a false failure', async () => {
  const project = baseProject({
    provider: 'Server',
    config: {
      targetOS: 'linux',
      host: '10.0.0.5',
      username: 'vault-account',
      authType: 'pmp',
      pmpConfig: { baseUrl: 'https://pmp.local', authToken: 'tok', resourceName: 'r', accountName: 'vault-account' },
      // no password field — the real one is only fetched at deploy time.
    },
  });

  const result = await testProjectConnection({
    project,
    deps: {
      netConnect: fakeNetConnect('connect'),
      NodeSSHImpl: fakeNodeSSHClass({ connectBehavior: 'auth-fail' }),
      createHostVerifier: fakeCreateHostVerifier(true),
      PmpService: { testConnection: async () => ({ success: true, message: 'Connection and credentials verified successfully.' }) },
      resolveSecrets: passThroughResolveSecrets,
    },
  });

  const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
  assert.equal(byName['Authentication'].ok, null);
  assert.match(byName['Authentication'].detail, /no password or private key configured/);
  assert.ok(byName['PMP Vault'], 'PMP-authed Server project must also surface a PMP Vault check');
  assert.equal(byName['PMP Vault'].ok, true);
  // A PMP Vault failure + auth null (not false) still lets the overall result be true here.
  assert.equal(result.ok, true);
});

test('Server/SSH: SSH connect timeout is classified as a handshake failure with a friendly message', async () => {
  const project = baseProject({
    provider: 'Server',
    config: { targetOS: 'linux', host: '10.0.0.5', username: 'deployer', password: 'super-secret-ssh' },
  });

  const start = Date.now();
  const result = await testProjectConnection({
    project,
    deps: {
      netConnect: fakeNetConnect('connect'),
      NodeSSHImpl: fakeNodeSSHClass({ connectBehavior: 'hang' }),
      createHostVerifier: fakeCreateHostVerifier(true),
      resolveSecrets: passThroughResolveSecrets,
      checkTimeoutMs: 30, // keep the test fast
    },
  });
  const elapsedMs = Date.now() - start;

  const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
  assert.equal(byName['SSH Handshake'].ok, false);
  assert.match(byName['SSH Handshake'].detail, /timed out/);
  assert.ok(elapsedMs < 5000, 'must not wait anywhere near the real 10s default timeout');
});

test('Server/SSH: never leaks the plaintext password in any check detail', async () => {
  const SECRET = 'literally-the-plaintext-ssh-password-42';
  const project = baseProject({
    provider: 'Server',
    config: { targetOS: 'linux', host: '10.0.0.5', username: 'deployer', password: SECRET },
  });

  const result = await testProjectConnection({
    project,
    deps: {
      netConnect: fakeNetConnect('connect'),
      NodeSSHImpl: fakeNodeSSHClass({ connectBehavior: 'success' }),
      createHostVerifier: fakeCreateHostVerifier(true, '[SSH] Host key trusted on first use.'),
      resolveSecrets: passThroughResolveSecrets,
    },
  });

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, new RegExp(SECRET));
});

// ── Server/WinRM (windows) ───────────────────────────────────────────────

function fakeFetchImpl(scenario) {
  return async function fetchImpl() {
    if (scenario === 'ok') return { ok: true, status: 200 };
    if (scenario === '401') return { ok: false, status: 401 };
    if (scenario === 'refused') {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    }
    if (scenario === 'hang') return new Promise(() => {});
    throw new Error('unexpected fetch scenario in test double');
  };
}

test('Server/WinRM: identify + auth succeed -> both checks ok:true', async () => {
  const project = baseProject({
    provider: 'Server',
    config: { targetOS: 'windows', host: '10.0.0.9', port: '5985', username: 'winuser', password: 'super-secret-winrm' },
  });

  const result = await testProjectConnection({
    project,
    deps: { fetchImpl: fakeFetchImpl('ok'), resolveSecrets: passThroughResolveSecrets },
  });

  assert.equal(result.ok, true);
  const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
  assert.equal(byName['WS-Man Identify'].ok, true);
  assert.equal(byName['Authentication'].ok, true);
});

test('Server/WinRM: 401 response -> endpoint is reachable but auth fails, with an actionable message', async () => {
  const project = baseProject({
    provider: 'Server',
    config: { targetOS: 'windows', host: '10.0.0.9', port: '5985', username: 'winuser', password: 'wrong' },
  });

  const result = await testProjectConnection({
    project,
    deps: { fetchImpl: fakeFetchImpl('401'), resolveSecrets: passThroughResolveSecrets },
  });

  const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
  assert.equal(byName['WS-Man Identify'].ok, true, 'a 401 still proves the WS-Man endpoint responded');
  assert.equal(byName['Authentication'].ok, false);
  assert.equal(
    byName['Authentication'].detail,
    'Authentication failed — check the username or the credential in project settings.'
  );
  assert.equal(result.ok, false);
});

test('Server/WinRM: network unreachable -> both checks fail with an actionable message, no raw stack', async () => {
  const project = baseProject({
    provider: 'Server',
    config: { targetOS: 'windows', host: '10.0.0.9', username: 'winuser', password: 'x' },
  });

  const result = await testProjectConnection({
    project,
    deps: { fetchImpl: fakeFetchImpl('refused'), resolveSecrets: passThroughResolveSecrets },
  });

  const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
  assert.equal(byName['WS-Man Identify'].ok, false);
  assert.match(byName['WS-Man Identify'].detail, /refused/);
  assert.equal(byName['Authentication'].ok, null);
});

test('Server/WinRM: PMP-vault-authenticated project with no fetched password -> auth is ok:null, not a false failure', async () => {
  const project = baseProject({
    provider: 'Server',
    config: {
      targetOS: 'windows',
      host: '10.0.0.9',
      username: 'vault-account',
      authType: 'pmp',
      pmpConfig: { baseUrl: 'https://pmp.local', authToken: 'tok', resourceName: 'r', accountName: 'vault-account' },
    },
  });

  const result = await testProjectConnection({
    project,
    deps: {
      fetchImpl: fakeFetchImpl('401'), // no credentials sent -> server challenges with 401
      PmpService: { testConnection: async () => ({ success: true, message: 'ok' }) },
      resolveSecrets: passThroughResolveSecrets,
    },
  });

  const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
  assert.equal(byName['WS-Man Identify'].ok, true);
  assert.equal(byName['Authentication'].ok, null);
  assert.ok(byName['PMP Vault']);
});

// ── Credential resolution failure ───────────────────────────────────────

test('a secret-store resolution failure is reported as a single Credentials check, not thrown', async () => {
  const project = baseProject({ provider: 'Jenkins', config: { url: 'http://jenkins.local' } });

  const result = await testProjectConnection({
    project,
    deps: {
      resolveSecrets: async () => {
        throw new Error('Stored credential missing for "apiToken" on project proj-1.');
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].name, 'Credentials');
  assert.match(result.checks[0].detail, /Stored credential missing/);
});

// ── Timeouts (documented budget) ─────────────────────────────────────────

test('documented timeout budget: 10s per check, 30s overall ceiling', () => {
  assert.equal(DEFAULT_CHECK_TIMEOUT_MS, 10_000);
  assert.equal(MAX_TOTAL_BUDGET_MS, 30_000);
});

// ── CI Pipeline ──────────────────────────────────────────────────────────

const CI_TOKEN = 'ci-secret-token-value-123';

function pipelineProject(configOverrides = {}) {
  return baseProject({
    provider: 'Pipeline',
    config: {
      ciConfig: { platform: 'bitbucket', owner: 'acme', repo: 'web', ref: 'master', pipeline: 'deploy-customer' },
      apiToken: CI_TOKEN,
      ...configOverrides,
    },
  });
}

/** Fake `createCiClient` — records what it was built with, returns a client whose verify() is scripted. */
function fakeCiClientFactory(verify) {
  const calls = [];
  const factory = (ciConfig, options) => {
    calls.push({ ciConfig, options });
    return { verify };
  };
  factory.calls = calls;
  return factory;
}

test('Pipeline: verify() checks are passed through; ok when none failed', async () => {
  const createCiClient = fakeCiClientFactory(async () => ({
    checks: [
      { name: 'Bitbucket Repository', ok: true, detail: 'Access to acme/web confirmed.' },
      { name: 'Bitbucket Pipelines', ok: true, detail: 'The token can read pipelines.' },
      { name: 'Pipeline Definition', ok: null, detail: 'Could not read bitbucket-pipelines.yml — not verified.' },
    ],
  }));

  const result = await testProjectConnection({
    project: pipelineProject(),
    deps: { createCiClient, resolveSecrets: passThroughResolveSecrets },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((c) => c.ok), [true, true, null]);
  assert.equal(createCiClient.calls.length, 1);
  assert.equal(createCiClient.calls[0].options.token, CI_TOKEN);
  assert.equal(createCiClient.calls[0].options.requestTimeoutMs, DEFAULT_CHECK_TIMEOUT_MS);
  assert.equal(createCiClient.calls[0].ciConfig.baseUrl, 'https://api.bitbucket.org/2.0', 'defaults are applied');
});

test('Pipeline: an auth failure is a failed check, and the token never leaks into the result', async () => {
  const createCiClient = fakeCiClientFactory(async () => ({
    checks: [
      { name: 'Bitbucket Repository', ok: false, detail: `Authentication failed (HTTP 401) for token ${CI_TOKEN}` },
      { name: 'Bitbucket Pipelines', ok: null, detail: 'Not tested — the repository check above failed.' },
    ],
  }));

  const result = await testProjectConnection({
    project: pipelineProject(),
    deps: { createCiClient, resolveSecrets: passThroughResolveSecrets },
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks[0].ok, false);
  assert.match(result.checks[0].detail, /Authentication failed \(HTTP 401\)/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(CI_TOKEN));
});

test('Pipeline: missing settings -> a single failed Configuration check, no client is built', async () => {
  const createCiClient = fakeCiClientFactory(async () => {
    throw new Error('must not be called');
  });

  const result = await testProjectConnection({
    project: baseProject({ provider: 'Pipeline', config: { ciConfig: { platform: 'github', owner: 'acme' } } }),
    deps: { createCiClient, resolveSecrets: passThroughResolveSecrets },
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].name, 'Configuration');
  assert.match(result.checks[0].detail, /missing: repo, ref, pipeline, apiToken/);
  assert.equal(createCiClient.calls.length, 0);
});

test('Pipeline: a verify() that throws is reported as a failed check, not thrown', async () => {
  const createCiClient = fakeCiClientFactory(async () => {
    throw new Error(`socket hang up (${CI_TOKEN})`);
  });

  const result = await testProjectConnection({
    project: pipelineProject(),
    deps: { createCiClient, resolveSecrets: passThroughResolveSecrets },
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks[0].name, 'CI Pipeline API');
  assert.match(result.checks[0].detail, /socket hang up/);
  assert.doesNotMatch(result.checks[0].detail, new RegExp(CI_TOKEN));
});

// ── Unknown provider ─────────────────────────────────────────────────────

test('unknown provider reports a single failing check instead of throwing', async () => {
  const project = baseProject({ provider: 'SomethingElse', config: {} });

  const result = await testProjectConnection({
    project,
    deps: { resolveSecrets: passThroughResolveSecrets },
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks[0].name, 'Provider');
});
