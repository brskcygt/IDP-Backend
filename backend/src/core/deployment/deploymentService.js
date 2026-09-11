'use strict';

/**
 * Deployment orchestration — extracted from server.js's `createAdapter()` /
 * `executeDeploy()` (T-58).
 *
 * The only thing that changed on `executeDeploy` is its signature: it used
 * to take the raw Express `req` purely to read `req.session?.user?.username`.
 * It now takes a plain `triggeredBy` string instead, so this module never
 * touches Express, cookies, or sessions — a requirement for the eventual
 * Electron migration, where deploys will be triggered over IPC instead of
 * HTTP. Every other line of logic — secret resolution, environment merging,
 * the PMP vault call, VPN setup/teardown, the `throwIfAborted` checkpoints,
 * status updates, audit entries, and the `activeDeployments` concurrency
 * lock — is unchanged.
 */
const JenkinsAdapter = require('../../adapters/JenkinsAdapter');
const PmpWebAdapter = require('../../adapters/PmpWebAdapter');
const SshServerAdapter = require('../../adapters/SshServerAdapter');
const WindowsAdapter = require('../../adapters/WindowsAdapter');
// Legacy Cloudflare runner is intentionally retained in the repository for a
// possible rollback, but it is no longer selected by the active product flow.
// const CloudflareRunnerAdapter = require('../../adapters/CloudflareRunnerAdapter');
const IdpAgentAdapter = require('../../adapters/IdpAgentAdapter');
const CiPipelineAdapter = require('../../adapters/CiPipelineAdapter');
const VpnManager = require('../../services/vpn/VpnManager');
const deploymentManager = require('../../services/DeploymentManager');
const auditLogger = require('../../services/AuditLogger');
const PmpService = require('../../services/vault/PmpService');
const projectRepository = require('../../store/projectRepository');
const { isServerProvider } = require('../../utils/providerUtils');
const { resolveProjectSecrets } = require('../../secrets/projectSecrets');
const { resolveEnvironmentConfig } = require('../../utils/environmentConfig');
const secretStore = require('../secrets/secretStoreInstance');

// In-memory set of projectIds with a deployment currently in flight.
// Backs the concurrency lock in /api/deploy/trigger: project.status is
// persisted to disk and could still read 'Deploying' after a crash, so
// this in-memory set is the source of truth for "is this actually running
// right now" within the lifetime of this process.
const activeDeployments = new Set();

/** @returns {boolean} whether a deployment for `projectId` is currently in flight in this process. */
function isProjectDeploying(projectId) {
  return activeDeployments.has(projectId);
}

/**
 * Create an adapter instance for a project, merging per-project UI config
 * with global env config.
 *
 * @param {object} project
 * @param {object} appConfig - the loaded app config (was a closure over
 *   server.js's module-level `appConfig` from `loadConfig()`; now passed
 *   explicitly so this module has no server.js dependency).
 */
function createAdapter(project, appConfig) {
  const pCfg = project.config || {};

  if (project.provider === 'Jenkins') {
    return new JenkinsAdapter({
      url: pCfg.url || appConfig.jenkins.url,
      username: pCfg.username || appConfig.jenkins.user,
      apiToken: pCfg.apiToken || appConfig.jenkins.apiToken,
      jobName: pCfg.jobName || project.name,
    });
  } else if (project.provider === 'PMP') {
    return new PmpWebAdapter({
      ...pCfg,
      url: pCfg.url || appConfig.pmp.url,
      username: pCfg.username || appConfig.pmp.user,
      password: pCfg.password || appConfig.pmp.password,
      timeoutMs: pCfg.timeoutMs || appConfig.pmp.timeoutMs,
    });
  } else if (project.provider === 'Pipeline') {
    // CI Pipeline provider: IDP triggers a Bitbucket/GitHub pipeline instead
    // of dialing the target. Throws listing missing settings when incomplete.
    return new CiPipelineAdapter({
      ciConfig: pCfg.ciConfig,
      username: pCfg.username,
      apiToken: pCfg.apiToken,
    });
  } else if (isServerProvider(project.provider)) {
    const isWindows = (pCfg.targetOS || (project.provider === 'WinRM' ? 'windows' : 'linux')) === 'windows';
    if (isWindows) {
      if (pCfg.windowsTransport === 'idp-agent') {
        return new IdpAgentAdapter({
          ...pCfg,
          agentApiBaseUrl: process.env.IDP_AGENT_API_URL,
          agentApiToken: process.env.IDP_AGENT_API_TOKEN,
        });
      }
      return new WindowsAdapter({
        ...pCfg,
        host: pCfg.host,
        port: pCfg.port || 5985,
        username: pCfg.username,
        password: pCfg.password,
        scriptContent: pCfg.scriptContent,
      });
    } else {
      return new SshServerAdapter({
        ...pCfg,
        host: pCfg.host || (appConfig.ssh && appConfig.ssh.host),
        port: pCfg.port || (appConfig.ssh && appConfig.ssh.port) || 22,
        username: pCfg.username || (appConfig.ssh && appConfig.ssh.user),
        password: pCfg.password || (appConfig.ssh && appConfig.ssh.password),
        privateKeyPath: pCfg.privateKeyPath || (appConfig.ssh && appConfig.ssh.privateKeyPath),
        scriptContent: pCfg.scriptContent,
      });
    }
  }

  throw new Error(`Unknown provider: ${project.provider}`);
}

/**
 * Human-readable deploy target for the "[System] Environment ..." line — a
 * host for direct providers, the repository/ref for the CI Pipeline provider.
 * Never includes credentials.
 */
function describeDeployTarget(provider, config) {
  if (provider === 'Pipeline') {
    const ci = (config && config.ciConfig) || {};
    return `CI pipeline ${ci.owner || '?'}/${ci.repo || '?'} @ ${ci.ref || '?'}`;
  }
  return `host ${config.host || config.url || 'unknown'}`;
}

/**
 * Throws if the given deployment's session has been aborted (T-33).
 * Called between phases of the background deploy IIFE below so an
 * abort() call actually stops the work in progress instead of letting it
 * run to completion while status merely reads 'aborted'. The thrown error
 * is caught by the IIFE's existing catch/finally chain, which already
 * tears down the VPN session and clears credentials — that behavior is
 * unchanged, this just makes sure it triggers promptly instead of only
 * after the current phase happens to finish on its own.
 */
function throwIfAborted(deploymentId) {
  const session = deploymentManager.getSession(deploymentId);
  if (session?.signal?.aborted) {
    throw new Error('Deployment aborted by user');
  }
}

/**
 * Core deployment execution logic for the REST/SSE trigger flow.
 * Returns the deploymentId so the caller can track it.
 *
 * @param {object} args
 * @param {object} args.project - the persisted project (with `secret://`
 *   references, not plaintext) — the SAME object instance held in
 *   projectService's in-memory cache; this function mutates its
 *   `status`/`lastDeploy` fields in place, exactly as server.js used to.
 * @param {object} args.parameters - deploy trigger parameters (environment, etc).
 * @param {string} [args.triggeredBy] - username that triggered this deploy.
 * @param {object} args.appConfig - loaded app config, forwarded to createAdapter().
 * @returns {Promise<string>} deploymentId
 */
async function executeDeploy({ project, parameters, triggeredBy, appConfig }) {
  // Captured now — this function's background IIFE keeps running long
  // after the request that called it has completed.
  const username = triggeredBy;

  // Decrypt `secret://` references into a SEPARATE object. `project` — the one
  // held in projectService's cache, and written back via projectRepository — must
  // keep its references, or the very next write would persist plaintext
  // credentials back to SQLite and undo the whole point of the secret store.
  //
  // Everything that needs real credentials (the adapter, the VPN tunnel) reads
  // from `runtimeProject`; everything that mutates persisted state (status,
  // lastDeploy) keeps using `project`.
  let runtimeProject = await resolveProjectSecrets(project, secretStore);

  // T-50: resolve the requested environment's overrides (host, credentials,
  // etc.) on top of the shared base config. `project` — the persisted object
  // — is never touched here; `resolveEnvironmentConfig` returns a brand new
  // config object, and it's assigned onto the throwaway `runtimeProject`
  // only, mirroring the resolveProjectSecrets()/project split above.
  const envResolution = resolveEnvironmentConfig(runtimeProject.config, parameters.environment);
  runtimeProject = { ...runtimeProject, config: envResolution.config };

  // Legacy Cloudflare runner secret resolution intentionally disabled. The
  // files and encrypted secret remain untouched, but the transport is no
  // longer reachable from active project configuration.

  const adapter = createAdapter(runtimeProject, appConfig);
  // Persisted alongside the deployment row so the history shows who triggered
  // it and which environment it targeted, not just a bare id (T-54).
  const deploymentId = deploymentManager.createSession(project.id, adapter, {
    triggeredBy: username,
    environment: parameters.environment,
  });
  const startedAt = Date.now();

  auditLogger.log(
    username,
    'DEPLOY_TRIGGERED',
    `Triggered deployment for project: ${project.name} (${parameters.environment || 'default'})`,
    {
      projectId: project.id,
      deploymentId,
      environment: parameters.environment,
      // T-51: reaching this point for a Prod deploy means the caller
      // (POST /api/deploy/trigger) already verified parameters.confirmation
      // matched the project's name — record that on the audit trail itself.
      ...(parameters.environment === 'Prod' ? { confirmed: true } : {}),
    }
  );

  // Tell the operator up front which real host this environment resolved
  // to — never the credentials — so "deploy to Prod" can be visually
  // verified against where it's actually going instead of taken on faith.
  if (parameters.environment) {
    const resolvedTarget = describeDeployTarget(project.provider, envResolution.config);
    deploymentManager.pushLog(
      deploymentId,
      envResolution.matched
        ? `[System] Environment '${parameters.environment}' → ${resolvedTarget}`
        : `[System] Environment '${parameters.environment}' has no override configured — using the shared base config (${resolvedTarget}).`
    );
  }

  // Wire adapter logs → DeploymentManager → all subscribers
  adapter.onLog((line) => {
    deploymentManager.pushLog(deploymentId, line);
  });

  deploymentManager.setStatus(deploymentId, 'running');

  // Mark the project as busy immediately (synchronously, before any await)
  // so the concurrency lock in POST /api/deploy/trigger sees it right away.
  project.status = 'Deploying';
  projectRepository.updateStatus(project.id, project.status, project.lastDeploy);
  activeDeployments.add(project.id);

  // Run deployment in background (don't await — return deploymentId immediately)
  (async () => {
    let vpnSession = null;
    try {
      // 0. Resolve Dynamic Credentials via PMP Vault API
      if (runtimeProject.config.authType === 'pmp' && runtimeProject.config.pmpConfig) {
        deploymentManager.pushLog(deploymentId, `[PMP] Resolving credentials for Resource: '${runtimeProject.config.pmpConfig.resourceName}', Account: '${runtimeProject.config.pmpConfig.accountName}' from PMP...`);
        try {
          const targetPassword = await PmpService.fetchPassword(runtimeProject.config.pmpConfig, {
            projectId: project.id,
            deployId: deploymentId
          });
          adapter.password = targetPassword;
          adapter.config.password = targetPassword;

          // Ensure the target server connection uses the exact account name fetched from PMP
          adapter.username = runtimeProject.config.pmpConfig.accountName;
          adapter.config.username = runtimeProject.config.pmpConfig.accountName;

          deploymentManager.pushLog(deploymentId, '[PMP] ✓ Credentials successfully resolved from Vault.');
        } catch (err) {
          deploymentManager.pushLog(deploymentId, `[PMP] ✗ Failed to fetch password from PMP: ${err.message}`);
          throw new Error(`PMP Credential Resolution Failed: ${err.message}`);
        }
      }

      throwIfAborted(deploymentId); // checkpoint: after PMP credential resolution

      // 1. Establish VPN/PAM Tunnel if enabled
      if (runtimeProject.config.vpnEnabled && runtimeProject.config.vpnConfig) {
        vpnSession = await VpnManager.connect(
          runtimeProject.config.vpnConfig,
          (line) => deploymentManager.pushLog(deploymentId, line),
          project.id,
          deploymentId
        );
      }

      throwIfAborted(deploymentId); // checkpoint: after VPN connection

      // 2. Connect & Execute Target Deploy
      await adapter.connect();

      // checkpoint: after adapter.connect() / before adapter.trigger() —
      // nothing async happens between these two phases today, so one check
      // covers both; keep it here (rather than only earlier) so a future
      // change that adds work between connect() and trigger() still gets
      // covered by this checkpoint.
      throwIfAborted(deploymentId);

      await adapter.trigger(parameters);
      await adapter.streamLogs((line) => {
        deploymentManager.pushLog(deploymentId, line);
      });

      deploymentManager.setStatus(deploymentId, 'succeeded');
      deploymentManager.pushLog(deploymentId, '[System] ✓ Deployment completed successfully.');

      project.status = 'Succeeded';
      project.lastDeploy = new Date().toISOString();
      projectRepository.updateStatus(project.id, project.status, project.lastDeploy);

      auditLogger.log(
        username,
        'DEPLOY_SUCCEEDED',
        `Deployment succeeded for project: ${project.name}`,
        { deploymentId, projectId: project.id, durationMs: Date.now() - startedAt }
      );
    } catch (err) {
      // deploymentManager.abort() (triggered via POST /api/deploy/:id/abort)
      // already flips the session status to 'aborted' and pushes its own
      // log line before the adapter's in-flight call rejects and lands us
      // here — don't stomp that with 'failed', and don't double-log an
      // audit entry for what the abort route already recorded.
      const session = deploymentManager.getSession(deploymentId);
      const wasAborted = session?.status === 'aborted';

      if (!wasAborted) {
        deploymentManager.setStatus(deploymentId, 'failed', err.message);
        deploymentManager.pushLog(deploymentId, `[System] ✗ Deployment failed: ${err.message}`);
      }

      project.status = wasAborted ? 'Idle' : 'Failed';
      project.lastDeploy = new Date().toISOString();
      projectRepository.updateStatus(project.id, project.status, project.lastDeploy);

      if (!wasAborted) {
        auditLogger.log(
          username,
          'DEPLOY_FAILED',
          `Deployment failed for project: ${project.name}`,
          { deploymentId, projectId: project.id, durationMs: Date.now() - startedAt, error: err.message }
        );
      }
    } finally {
      activeDeployments.delete(project.id);

      // 3. Always teardown VPN regardless of success/failure
      if (vpnSession) {
        try {
          await VpnManager.disconnect(vpnSession, (line) => {
            deploymentManager.pushLog(deploymentId, line);
          });
        } catch (teardownErr) {
          deploymentManager.pushLog(deploymentId, `[System] ⚠ VPN Teardown warning: ${teardownErr.message}`);
        }
      }

      // 4. Clean up sensitive credential variable from runtime memory
      adapter.password = null;
      if (adapter.config) adapter.config.password = null;
      if (adapter.config) adapter.config.apiToken = null;
      // Adapters whose HTTP client captured the token at construction time
      // (CiPipelineAdapter) drop it here too.
      if (typeof adapter.releaseCredentials === 'function') adapter.releaseCredentials();
      if (Object.prototype.hasOwnProperty.call(adapter, 'adminApiKey')) adapter.adminApiKey = null;
      if (adapter.config) adapter.config.runnerAdminApiKey = null;
    }
  })();

  return deploymentId;
}

module.exports = {
  createAdapter,
  executeDeploy,
  throwIfAborted,
  isProjectDeploying,
};
