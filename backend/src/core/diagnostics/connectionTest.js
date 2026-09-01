'use strict';

/**
 * T-73: "Test Connection" diagnostics — verifies a project's deploy target
 * is reachable and its credentials are valid WITHOUT running a deploy.
 *
 * Transport-agnostic (see backend/scripts/check-core-boundaries.js): takes
 * a plain project object and returns a plain result — no Express, no
 * req/res. The HTTP layer (src/server.js) is the only thing that knows this
 * is reachable over `POST /api/projects/:id/test-connection`.
 *
 * The actual per-provider protocol work lives in ./checks/ (one file per
 * provider family, plus shared.js for the bits they all need — makeCheck,
 * withTimeout, tcpProbe). This file is only the entry point: resolve
 * secrets, resolve the requested environment's overrides, route to the
 * right check(s), and enforce the overall time budget.
 *
 * Design notes:
 *  - Every network probe here is READ-ONLY. Nothing in this file ever
 *    triggers a Jenkins build, runs a deploy script, or writes to a target
 *    server — that is the whole point of a "test connection" feature.
 *  - VPN tunnels are deliberately never established here: bringing one up
 *    is exactly as expensive and side-effecting as a real deploy. When a
 *    project has `vpnEnabled`, the result includes an informational
 *    `{ ok: null }` line instead of dialing anything.
 *  - `ok: null` (as opposed to `true`/`false`) means "not tested" — either
 *    because an earlier check in the same chain failed first (e.g. no point
 *    testing SSH auth when TCP couldn't even connect) or because testing it
 *    for real would require a live credential fetch this feature
 *    deliberately avoids (e.g. a PMP-vault-authenticated SSH/WinRM project:
 *    the real password is only ever fetched fresh at deploy time — see
 *    core/deployment/deploymentService.js — not for a lightweight test
 *    click). `testProjectConnection().ok` (the top-level flag) only turns
 *    false when at least one check explicitly failed; `null` checks don't
 *    drag it down.
 *  - Every network-touching check is individually capped at
 *    `checkTimeoutMs` (default 10s); the whole provider-specific chain is
 *    additionally capped at `MAX_TOTAL_BUDGET_MS` (30s) so a hung socket in
 *    one check can't make the overall test run away.
 *  - Dependencies (the adapter classes, PmpService, node-ssh, the host key
 *    verifier, the secret store, `net.connect`) are all injectable via the
 *    `deps` argument, defaulting to the real implementations — this is what
 *    lets the test suite exercise every branch with fake adapters/services
 *    instead of touching a real network. See test/connection-test.test.js.
 */

const net = require('node:net');
const { fetch: undiciFetch } = require('undici');
const { NodeSSH } = require('node-ssh');

const JenkinsAdapterDefault = require('../../adapters/JenkinsAdapter');
const PmpServiceDefault = require('../../services/vault/PmpService');
const {
  createHostVerifier: createHostVerifierDefault,
  DEFAULT_POLICY: DEFAULT_HOST_KEY_POLICY,
} = require('../../services/ssh/hostKeyVerifier');
const { resolveProjectSecrets: resolveProjectSecretsDefault } = require('../../secrets/projectSecrets');
const { resolveEnvironmentConfig } = require('../../utils/environmentConfig');
const { isServerProvider } = require('../../utils/providerUtils');
const secretStoreDefault = require('../secrets/secretStoreInstance');

const { makeCheck, withTimeout } = require('./checks/shared');
const { testJenkins } = require('./checks/jenkins');
const { testPmpVault } = require('./checks/pmp');
const { testSsh } = require('./checks/ssh');
const { testWinRm } = require('./checks/winrm');

/** Per-check network timeout. */
const DEFAULT_CHECK_TIMEOUT_MS = 10_000;
/** Hard ceiling on the whole provider-specific check chain. */
const MAX_TOTAL_BUDGET_MS = 30_000;

/**
 * Runs `fn()` (a provider-specific check chain) under a hard ceiling so a
 * hung socket in one check can never make the overall test run away past
 * `MAX_TOTAL_BUDGET_MS`.
 */
async function runWithOverallBudget(fn) {
  try {
    return await withTimeout(fn(), MAX_TOTAL_BUDGET_MS, 'Connection test');
  } catch (err) {
    if (err && err.message === `Connection test timed out after ${MAX_TOTAL_BUDGET_MS}ms`) {
      return [
        makeCheck(
          'Connection Test',
          false,
          `The overall connection test exceeded ${MAX_TOTAL_BUDGET_MS / 1000}s and was aborted.`
        ),
      ];
    }
    throw err;
  }
}

/**
 * @param {object} args
 * @param {object} args.project - a raw (unredacted) project — same shape as
 *   `projectService.getProject(id)` returns, i.e. `config` may still hold
 *   `secret://` references, which this function resolves itself.
 * @param {object} [args.appConfig] - loaded app config (env-var fallbacks),
 *   forwarded the same way `deploymentService.createAdapter()` uses it.
 * @param {string} [args.environment] - optional environment name (T-50) to
 *   resolve overrides for before testing, mirroring what an actual deploy
 *   to that environment would connect to.
 * @param {object} [args.deps] - dependency overrides, all optional. Real
 *   implementations are used for anything not supplied — tests substitute
 *   fakes here instead of touching a real network.
 * @returns {Promise<{ ok: boolean, checks: { name: string, ok: boolean|null, detail: string }[] }>}
 */
async function testProjectConnection({ project, appConfig, environment, deps = {} } = {}) {
  if (!project) {
    throw new Error('testProjectConnection requires a project.');
  }

  const {
    JenkinsAdapter = JenkinsAdapterDefault,
    PmpService = PmpServiceDefault,
    createHostVerifier = createHostVerifierDefault,
    resolveSecrets = resolveProjectSecretsDefault,
    store = secretStoreDefault,
    netConnect = net.connect,
    NodeSSHImpl = NodeSSH,
    fetchImpl = undiciFetch,
    checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
  } = deps;

  let runtimeProject;
  try {
    // Never resolves onto the persisted project — same throwaway-copy rule
    // deploymentService.executeDeploy() follows, so a test click can never
    // leak plaintext back into what gets written to disk.
    runtimeProject = await resolveSecrets(project, store);
  } catch (err) {
    return {
      ok: false,
      checks: [makeCheck('Credentials', false, `Could not read stored credentials: ${err.message}`)],
    };
  }

  const envResolution = resolveEnvironmentConfig(runtimeProject.config, environment);
  const config = envResolution.config || {};

  let checks;
  if (project.provider === 'Jenkins') {
    checks = await runWithOverallBudget(() => testJenkins({ config, appConfig, JenkinsAdapter, timeoutMs: checkTimeoutMs }));
  } else if (project.provider === 'PMP') {
    checks = await runWithOverallBudget(async () => [await testPmpVault({ pmpConfig: config.pmpConfig, PmpService })]);
  } else if (isServerProvider(project.provider)) {
    const isWindows = (config.targetOS || (project.provider === 'WinRM' ? 'windows' : 'linux')) === 'windows';
    checks = await runWithOverallBudget(async () => {
      const targetChecks = isWindows
        ? await testWinRm({ config, timeoutMs: checkTimeoutMs, fetchImpl })
        : await testSsh({
            config,
            netConnect,
            createHostVerifier,
            timeoutMs: checkTimeoutMs,
            NodeSSHImpl,
            defaultHostKeyPolicy: DEFAULT_HOST_KEY_POLICY,
          });

      // A Server/SSH/WinRM project can ALSO be PMP-vault-authenticated
      // (config.authType === 'pmp') — surface the vault's own reachability
      // alongside the target host, since a broken vault is just as much a
      // reason a real deploy would fail as a broken SSH/WinRM target. Kept
      // inside the same overall-budget wrapper as the host check above so
      // the two together still respect the single 30s ceiling.
      if (config.authType === 'pmp' && config.pmpConfig) {
        return [...targetChecks, await testPmpVault({ pmpConfig: config.pmpConfig, PmpService })];
      }
      return targetChecks;
    });
  } else {
    checks = [makeCheck('Provider', false, `Unknown provider '${project.provider}'.`)];
  }

  // VPN is deliberately never dialed for a test click — see module header.
  if (config.vpnEnabled && config.vpnConfig) {
    checks = [
      ...checks,
      makeCheck('VPN', null, 'Not tested — the tunnel is only established during a deployment'),
    ];
  }

  const ok = checks.every((check) => check.ok !== false);
  return { ok, checks };
}

module.exports = {
  testProjectConnection,
  // Exported for tests / introspection — not part of the public core API.
  DEFAULT_CHECK_TIMEOUT_MS,
  MAX_TOTAL_BUDGET_MS,
};
