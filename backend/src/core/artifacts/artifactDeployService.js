'use strict';

/**
 * Artifact deploy / rollback / cancel (docs/ARTIFACT-DEPLOY.md, F2).
 *
 * deploy(): release 'ready' → per-component artifact for the target OS →
 * per-target lock → DeploymentManager session (kind 'artifact_deploy', so the
 * existing SSE log stream and POST /api/deploy/:id/abort work unchanged) →
 * per-component download tokens → `artifact_deploy` payload via the gateway
 * control API → the agent's `deploy_event`s / single `deploy_result`.
 *
 * Correlation is STRICTLY by `payload.deployId` (plus the target's agent id):
 * the legacy `command_execution_result` and any other agent traffic is
 * ignored. The payload's only credential is each component's download token;
 * it is never logged, and all of a deployment's tokens are deleted the
 * moment it reaches a terminal state.
 */

const crypto = require('node:crypto');
const { NotFoundError, ValidationError, ConflictError } = require('../errors');
const {
  COMPONENT_NAME_PATTERN,
  DEPLOY_STAGES,
  DEPLOY_EVENT_STATUSES,
  isPlainObject,
  normalizeArtifactDeployConfig,
  resolveTargetComponents,
  selectArtifact,
  targetArtifactOs,
  buildDeployPayload,
  runtimeConfigForComponent,
  computeDeployTimeoutSec,
  sanitizeAgentText,
  sanitizeVersion,
} = require('./contracts');
const { openAgentChannel, sendAgentCommand, listGatewayAgents } = require('./agentChannel');

/** Extra wait on top of the agent-side `timeoutSec` before we give up on a result. */
const RESULT_GRACE_MS = 60_000;
const ROLLBACK_TIMEOUT_BASE_SEC = 900;
const CONFIG_APPLY_TIMEOUT_BASE_SEC = 300;
const MAX_EVENTS_PER_DEPLOYMENT = 2000;
const MAX_RESULT_COMPONENTS = 20;
const MAX_RECONNECT_DELAY_MS = 30_000;

const LABELS = { artifact_deploy: 'Deploy', artifact_rollback: 'Rollback', artifact_config_apply: 'Config apply' };
const AUDIT_PREFIX = {
  artifact_deploy: 'ARTIFACT_DEPLOY',
  artifact_rollback: 'ARTIFACT_ROLLBACK',
  artifact_config_apply: 'ARTIFACT_CONFIG_APPLY',
};
const EVENT_PROCESS = {
  artifact_deploy: 'deploy_event',
  artifact_rollback: 'deploy_event',
  artifact_config_apply: 'artifact_config_event',
};
const RESULT_PROCESS = {
  artifact_deploy: 'deploy_result',
  artifact_rollback: 'deploy_result',
  artifact_config_apply: 'artifact_config_result',
};
const SSE_EVENT = {
  artifact_deploy: 'artifact_deploy_event',
  artifact_rollback: 'artifact_deploy_event',
  artifact_config_apply: 'artifact_config_event',
};

function newDeployId() {
  return `dep_${crypto.randomBytes(12).toString('hex')}`;
}

function sanitizeStage(value) {
  if (DEPLOY_STAGES.includes(value)) return value;
  return typeof value === 'string' && /^[a-z_]{1,32}$/.test(value) ? value : 'unknown';
}

function requireComponentNames(components) {
  if (components === undefined || components === null) return null;
  if (!Array.isArray(components) || components.length > 10
    || components.some((name) => typeof name !== 'string' || !COMPONENT_NAME_PATTERN.test(name))) {
    throw new ValidationError('components must be an array of up to 10 component names.');
  }
  return components.length > 0 ? [...new Set(components)] : null;
}

function collectSensitiveValues(runtimeConfig, components = []) {
  const values = [];
  if (isPlainObject(runtimeConfig)) {
    for (const entry of Object.values(runtimeConfig)) {
      if (typeof entry === 'string') values.push(entry);
      else if (isPlainObject(entry) && isPlainObject(entry.values)) values.push(...Object.values(entry.values));
    }
  }
  for (const component of components) {
    for (const hook of (component.hooks && component.hooks.preStart) || []) {
      if (isPlainObject(hook.env)) values.push(...Object.values(hook.env));
    }
  }
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))]
    .sort((a, b) => b.length - a.length);
}

/**
 * @param {object} deps
 * @param {object} deps.repository - artifactDeployRepository.
 * @param {object} deps.deploymentManager
 * @param {{ log: Function }} deps.auditLogger
 * @param {(id: string) => object} deps.getProject
 * @param {object} deps.tokens - download token service.
 * @param {() => object} deps.getGateway - AgentGatewayClient factory.
 * @param {(targetId: string) => Promise<object>} [deps.refreshTargetStatus] - run after a successful rollback.
 * @param {(target: object) => Promise<object>} [deps.resolveTarget] - decrypts target runtime config into a copy.
 * @param {{ resultGraceMs?: number, resultTimeoutMs?: number, resubscribeDelayMs?: number, channelTimeoutMs?: number }} [deps.timing]
 */
function createArtifactDeployService({
  repository,
  deploymentManager,
  auditLogger,
  getProject,
  tokens,
  getGateway,
  refreshTargetStatus = null,
  resolveTarget = async (target) => target,
  timing = {},
}) {
  const resultGraceMs = timing.resultGraceMs ?? RESULT_GRACE_MS;
  const resubscribeDelayMs = timing.resubscribeDelayMs ?? 2_000;
  const channelTimeoutMs = timing.channelTimeoutMs ?? 10_000;
  /** targetId → run: the per-target lock. */
  const activeTargets = new Map();
  /** targetId → releaseId|null while online checks/secret resolution finish. */
  const preparingTargets = new Map();
  /** deploymentId → run */
  const runs = new Map();

  function log(run, line) {
    deploymentManager.pushLog(run.deploymentId, `[${LABELS[run.kind]}] ${line}`);
  }

  function cleanAgentText(run, value, max) {
    let text = value === undefined || value === null ? '' : String(value);
    for (const secret of run.sensitiveValues) text = text.split(secret).join('[REDACTED]');
    return sanitizeAgentText(text, max);
  }

  function auditMeta(run, extra = {}) {
    return {
      projectId: run.project.id,
      targetId: run.target.id,
      agentId: run.target.agentId,
      deploymentId: run.deploymentId,
      deployId: run.deployId,
      ...(run.release ? { releaseId: run.release.id, version: run.release.version } : {}),
      components: run.components,
      ...extra,
    };
  }

  async function requireTarget(id) {
    const target = repository.findTarget(id);
    if (!target) throw new NotFoundError('Deploy target not found');
    return resolveTarget(target);
  }

  function assertUnlocked(target) {
    if (activeTargets.has(target.id) || preparingTargets.has(target.id)) {
      throw new ConflictError(`A deployment is already running on target '${target.name}'.`);
    }
  }

  function reservePreparation(target, releaseId = null) {
    assertUnlocked(target);
    preparingTargets.set(target.id, releaseId);
  }

  function assertTargetUnchanged(target) {
    const fresh = repository.findTarget(target.id);
    if (!fresh || fresh.updatedAt !== target.updatedAt || fresh.agentId !== target.agentId) {
      throw new ConflictError(`Deploy target '${target.name}' changed while the deployment was being prepared. Retry.`);
    }
  }

  async function ensureAgentOnline(agentId) {
    const agents = await listGatewayAgents(getGateway());
    const agent = agents.find((item) => item && item.id === agentId);
    if (!agent) throw new ConflictError(`Agent ${agentId} is not registered in the agent gateway.`);
    if (agent.online !== true) throw new ConflictError(`Agent ${agentId} is offline.`);
  }

  // ------------------------------------------------------------ agent traffic

  function openChannel(run) {
    return openAgentChannel(getGateway(), run.target.agentId, {
      timeoutMs: channelTimeoutMs,
      onMessage: (message) => handleMessage(run, message),
      onClose: () => onChannelClosed(run),
    });
  }

  /** The backend↔gateway socket dropped mid-deploy: resubscribe with backoff until the run ends. */
  function onChannelClosed(run) {
    if (run.finished) return;
    run.reconnectAttempts += 1;
    const delay = Math.min(resubscribeDelayMs * 2 ** (run.reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
    if (run.reconnectAttempts <= 3 || run.reconnectAttempts % 10 === 0) {
      log(run, '⚠ Lost the agent gateway subscription — reconnecting...');
    }
    run.reconnectTimer = setTimeout(async () => {
      run.reconnectTimer = null;
      if (run.finished) return;
      try {
        const channel = await openChannel(run);
        if (run.finished) {
          channel.close();
          return;
        }
        run.channel = channel;
        run.reconnectAttempts = 0;
        log(run, 'Reconnected to the agent gateway. Stage events sent meanwhile are lost; the final result is still awaited.');
      } catch {
        onChannelClosed(run);
      }
    }, delay);
    run.reconnectTimer.unref?.();
  }

  /** Only messages from this target's agent carrying this run's deployId count. */
  function handleMessage(run, message) {
    if (run.finished || !isPlainObject(message)) return;
    if (message.type !== 'agent' || message.agentId !== run.target.agentId) return;
    const payload = message.payload;
    if (!isPlainObject(payload) || payload.deployId !== run.deployId) return;
    if (message.process === EVENT_PROCESS[run.kind]) handleEvent(run, payload);
    else if (message.process === RESULT_PROCESS[run.kind]) handleResult(run, payload);
  }

  function handleEvent(run, payload) {
    const stage = sanitizeStage(payload.stage);
    const status = DEPLOY_EVENT_STATUSES.includes(payload.status) ? payload.status : 'unknown';
    const component = typeof payload.component === 'string' && COMPONENT_NAME_PATTERN.test(payload.component) ? payload.component : null;
    const progress = typeof payload.progress === 'number' && Number.isFinite(payload.progress)
      ? Math.max(0, Math.min(100, Math.round(payload.progress * 10) / 10))
      : null;
    const message = cleanAgentText(run, payload.message, 300);

    // Progress events arrive up to once a second; keep one per 10% step.
    if (status === 'progress') {
      const key = `${component}|${stage}`;
      const bucket = progress === null ? -1 : Math.floor(progress / 10);
      if (run.progressBuckets.get(key) === bucket) return;
      run.progressBuckets.set(key, bucket);
    }

    log(run, `${component || '-'} · ${stage} ${status}${progress !== null ? ` ${progress}%` : ''}${message ? ` — ${message}` : ''}`);
    deploymentManager.pushEvent(run.deploymentId, SSE_EVENT[run.kind], { component, stage, status, progress, message });
    if (run.eventCount < MAX_EVENTS_PER_DEPLOYMENT) {
      run.eventCount += 1;
      try {
        repository.insertEvent({ deploymentId: run.deploymentId, component, stage, status, progress, message });
      } catch (err) {
        console.warn(`[artifacts] Could not store a deployment event for ${run.deploymentId}:`, err.message);
      }
    }
  }

  function handleResult(run, payload) {
    if (run.resultHandled) return;
    run.resultHandled = true;

    const components = (Array.isArray(payload.components) ? payload.components : [])
      .slice(0, MAX_RESULT_COMPONENTS)
      .filter(isPlainObject)
      .map((entry) => ({
        name: typeof entry.name === 'string' && COMPONENT_NAME_PATTERN.test(entry.name) ? entry.name : null,
        success: entry.success === true,
        rolledBack: entry.rolledBack === true,
        previousVersion: sanitizeVersion(entry.previousVersion),
        error: entry.error ? cleanAgentText(run, entry.error, 300) : null,
      }));
    for (const entry of components) {
      const rolled = entry.rolledBack ? ` rolled back${entry.previousVersion ? ` to ${entry.previousVersion}` : ''}` : '';
      log(run, `${entry.success ? '✓' : '✗'} ${entry.name || '?'}${rolled}${entry.error ? ` — ${entry.error}` : ''}`);
    }

    if (payload.success === true) {
      if (run.kind === 'artifact_deploy') recordDeployedVersions(run, components);
      finish(run, {
        success: true,
        message: run.kind === 'artifact_deploy'
          ? `✓ ${run.release.version} deployed to '${run.target.name}'.`
          : run.kind === 'artifact_rollback'
            ? `✓ Rolled back on '${run.target.name}'.`
            : `✓ Runtime config applied on '${run.target.name}'.`,
      });
      if (run.kind === 'artifact_rollback' && refreshTargetStatus) {
        Promise.resolve()
          .then(() => refreshTargetStatus(run.target.id))
          .catch((err) => console.warn(`[artifacts] Status refresh after rollback failed for target ${run.target.id}:`, err.message));
      }
      return;
    }

    let error = cleanAgentText(run, payload.error, 500) || 'The agent reported a failure.';
    if (error === 'busy') error = 'The agent is busy with another deployment (busy).';
    if (payload.rolledBack === true) {
      error = run.kind === 'artifact_config_apply'
        ? `${error.replace(/[.!?]+$/, '')}. The previous runtime config was restored.`
        : `${error.replace(/[.!?]+$/, '')}. Switched components were rolled back.`;
    }
    finish(run, { success: false, error });
  }

  function recordDeployedVersions(run, components) {
    const fresh = repository.findTarget(run.target.id);
    if (!fresh) return;
    const current = isPlainObject(fresh.currentVersions) ? { ...fresh.currentVersions } : {};
    const deployedAt = new Date().toISOString();
    for (const name of run.components) {
      const previous = isPlainObject(current[name]) ? current[name] : null;
      const reported = components.find((entry) => entry.name === name);
      const previousVersion = (reported && reported.previousVersion) || (previous && previous.version) || null;
      const history = [previousVersion, ...(previous && Array.isArray(previous.previousVersions) ? previous.previousVersions : [])]
        .filter((version) => version && version !== run.release.version);
      current[name] = { version: run.release.version, deployedAt, previousVersions: [...new Set(history)].slice(0, 10) };
    }
    repository.updateTarget(run.target.id, { currentReleaseId: run.release.id, currentVersions: current });
  }

  /** Terminal bookkeeping — exactly once per run. */
  function finish(run, outcome) {
    if (run.finished) return;
    run.finished = true;
    clearTimeout(run.timer);
    clearTimeout(run.reconnectTimer);
    if (run.channel) run.channel.close();
    if (activeTargets.get(run.target.id) === run) activeTargets.delete(run.target.id);
    runs.delete(run.deploymentId);
    try {
      if (tokens) tokens.revokeForDeployment(run.deploymentId);
    } catch (err) {
      console.warn(`[artifacts] Could not revoke download tokens of ${run.deploymentId}:`, err.message);
    }

    const session = deploymentManager.getSession(run.deploymentId);
    const wasAborted = Boolean(session && session.status === 'aborted');
    const prefix = AUDIT_PREFIX[run.kind];
    const meta = auditMeta(run, { durationMs: Date.now() - run.startedAt });

    if (outcome.success) {
      log(run, wasAborted ? `${outcome.message} It completed before the cancel request took effect.` : outcome.message);
      deploymentManager.setStatus(run.deploymentId, 'succeeded');
      auditLogger.log(run.triggeredBy, `${prefix}_SUCCEEDED`, `${LABELS[run.kind]} succeeded on target '${run.target.name}'`, meta);
    } else if (wasAborted) {
      log(run, `■ Cancelled${outcome.error ? `: ${outcome.error}` : '.'}`);
      auditLogger.log(run.triggeredBy, `${prefix}_CANCELLED`, `${LABELS[run.kind]} cancelled on target '${run.target.name}'`,
        { ...meta, error: outcome.error || null }, { outcome: 'failure' });
    } else {
      log(run, `✗ Failed: ${outcome.error}`);
      deploymentManager.setStatus(run.deploymentId, 'failed', outcome.error);
      auditLogger.log(run.triggeredBy, `${prefix}_FAILED`, `${LABELS[run.kind]} failed on target '${run.target.name}'`,
        { ...meta, error: outcome.error }, { outcome: 'failure' });
    }
  }

  function onTimeout(run, waitMs) {
    if (run.finished) return;
    const seconds = Math.round(waitMs / 1000);
    log(run, `⚠ No result from agent ${run.target.agentId} within ${seconds}s — asking it to cancel.`);
    sendAgentCommand(getGateway(), run.target.agentId, 'artifact_cancel', { deployId: run.deployId }).catch(() => {});
    finish(run, {
      success: false,
      error: `No ${RESULT_PROCESS[run.kind]} from the agent within ${seconds}s. The server state is unknown — refresh the target status.`,
    });
  }

  /** DeploymentManager.abort() → here (the existing POST /api/deploy/:id/abort path). */
  async function requestCancel(run) {
    if (run.finished || run.cancelRequested) return;
    run.cancelRequested = true;
    log(run, run.kind === 'artifact_config_apply'
      ? '■ Cancel requested — the agent stops and restores any changed runtime config.'
      : '■ Cancel requested — the agent stops and rolls back any switched component.');
    auditLogger.log(null, `${AUDIT_PREFIX[run.kind]}_CANCEL_REQUESTED`, `Cancel requested on target '${run.target.name}'`, auditMeta(run));
    try {
      await sendAgentCommand(getGateway(), run.target.agentId, 'artifact_cancel', { deployId: run.deployId });
    } catch (err) {
      log(run, `⚠ Could not deliver the cancel request: ${err.message}`);
    }
    // The run stays locked until the agent's terminal deploy_result (or the timeout).
  }

  async function startRun({ kind, target, project, release, triggeredBy, components, timeoutSec, buildPayload, description, sensitiveValues = [] }) {
    const run = {
      kind,
      deployId: newDeployId(),
      target,
      project,
      release: release || null,
      triggeredBy: triggeredBy || null,
      components,
      deploymentId: null,
      channel: null,
      timer: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      finished: false,
      resultHandled: false,
      cancelRequested: false,
      startedAt: Date.now(),
      progressBuckets: new Map(),
      eventCount: 0,
      sensitiveValues: [...new Set(sensitiveValues)].sort((a, b) => b.length - a.length),
    };
    activeTargets.set(target.id, run);

    // Stands in for an adapter so DeploymentManager.abort() reaches requestCancel().
    const controller = { abort: () => requestCancel(run) };
    try {
      run.deploymentId = deploymentManager.createSession(project.id, controller, {
        triggeredBy,
        environment: target.environment || null,
        kind,
        releaseId: release ? release.id : null,
        targetId: target.id,
      });
    } catch (err) {
      activeTargets.delete(target.id);
      throw err;
    }
    runs.set(run.deploymentId, run);
    deploymentManager.setStatus(run.deploymentId, 'running');
    auditLogger.log(triggeredBy, `${AUDIT_PREFIX[kind]}_TRIGGERED`, description, auditMeta(run));

    try {
      const payload = buildPayload(run);
      run.channel = await openChannel(run);
      await sendAgentCommand(getGateway(), target.agentId, kind, payload);
      log(run, `Command sent to agent ${target.agentId} (deployId ${run.deployId}); waiting for stage events...`);
      if (!run.finished) {
        const waitMs = timing.resultTimeoutMs ?? timeoutSec * 1000 + resultGraceMs;
        run.timer = setTimeout(() => onTimeout(run, waitMs), waitMs);
        run.timer.unref?.();
      }
    } catch (err) {
      finish(run, { success: false, error: err.message });
    }
    return { deploymentId: run.deploymentId, deployId: run.deployId };
  }

  return {
    isTargetBusy(targetId) {
      return activeTargets.has(targetId) || preparingTargets.has(targetId);
    },

    isReleaseBusy(releaseId) {
      for (const run of activeTargets.values()) {
        if (!run.finished && run.release && run.release.id === releaseId) return true;
      }
      return [...preparingTargets.values()].includes(releaseId);
    },

    /**
     * @param {{ targetId: string, releaseId: string, components?: string[], triggeredBy?: string, publicUrl: string }} args
     * @returns {Promise<{ deploymentId: string, deployId: string }>}
     */
    async deploy({ targetId, releaseId, components, triggeredBy, publicUrl }) {
      if (!publicUrl) throw new ValidationError('IDP_PUBLIC_URL is not configured — agents need it to download artifacts.');
      const requested = requireComponentNames(components);
      const target = await requireTarget(targetId);
      const release = repository.findRelease(releaseId);
      if (!release || release.projectId !== target.projectId) throw new NotFoundError("Release not found for this target's project");
      if (release.status !== 'ready') throw new ConflictError(`Release ${release.version} is not ready (status: ${release.status}).`);
      if (!isPlainObject(release.manifest) || !release.manifest.project) throw new ConflictError('The release has no manifest — re-import it.');

      const project = getProject(target.projectId);
      const config = normalizeArtifactDeployConfig(project.config && project.config.artifactDeploy);
      if (!config || config.components.length === 0) {
        throw new ValidationError('No artifactDeploy.components are configured for this project.');
      }
      const resolved = resolveTargetComponents(config.components, target.components, requested);
      if (resolved.errors.length > 0) throw new ValidationError(resolved.errors.join(' '));

      const artifacts = repository.listArtifacts(release.id);
      const selected = new Map();
      const missing = [];
      for (const component of resolved.components) {
        const artifact = selectArtifact(artifacts, component, target.os);
        if (artifact) selected.set(component.name, artifact);
        else missing.push(component.name);
      }
      if (missing.length > 0) {
        throw new ValidationError(`Release ${release.version} has no ${targetArtifactOs(target.os)} or 'any' artifact for: ${missing.join(', ')}.`);
      }

      reservePreparation(target, release.id);
      try {
        await ensureAgentOnline(target.agentId);
        assertTargetUnchanged(target);
        const freshRelease = repository.findRelease(release.id);
        if (!freshRelease || freshRelease.status !== 'ready') throw new ConflictError(`Release ${release.version} changed while deployment was being prepared.`);
        preparingTargets.delete(target.id);
        return await startRun({
        kind: 'artifact_deploy',
        target,
        project,
        release,
        triggeredBy,
        components: resolved.components.map((component) => component.name),
        timeoutSec: computeDeployTimeoutSec(resolved.components),
        sensitiveValues: collectSensitiveValues(target.runtimeConfig, resolved.components),
        description: `Artifact deploy of ${release.version} to target '${target.name}' (project: ${project.name})`,
        buildPayload: (run) => {
          const issued = new Map();
          for (const component of resolved.components) {
            issued.set(component.name, tokens.issue({
              artifactId: selected.get(component.name).id,
              agentId: target.agentId,
              deploymentId: run.deploymentId,
            }));
            const artifact = selected.get(component.name);
            const componentConfig = runtimeConfigForComponent(target.runtimeConfig, component);
            const extras = [
              component.hooks ? `preStart: ${component.hooks.preStart.map((hook) => hook.name).join(', ')}` : null,
              componentConfig
                ? `${componentConfig.format} keys: ${Object.keys(componentConfig.values).join(', ') || '(none)'}`
                : null,
            ].filter(Boolean);
            log(run, `${component.name}: ${artifact.fileName} (${artifact.os}, ${artifact.size} bytes) → ${component.subdir}/ via ${component.runtime.type}${extras.length ? `; ${extras.join('; ')}` : ''}`);
          }
          log(run, `${release.version} → target '${target.name}' (agent ${target.agentId}).`);
          return buildDeployPayload({
            deployId: run.deployId,
            release,
            components: resolved.components,
            artifacts: selected,
            tokens: issued,
            runtimeConfig: target.runtimeConfig,
            publicUrl,
          });
        },
        });
      } finally {
        preparingTargets.delete(target.id);
      }
    },

    /**
     * Swaps the latest previous release back for `components` (null = every
     * component that has one) on the agent.
     */
    async rollback({ targetId, components, triggeredBy }) {
      const requested = requireComponentNames(components);
      const target = await requireTarget(targetId);
      const project = getProject(target.projectId);
      const config = normalizeArtifactDeployConfig(project.config && project.config.artifactDeploy);
      const known = config ? config.components : [];
      if (requested && known.length > 0) {
        const unknown = requested.filter((name) => !known.some((component) => component.name === name));
        if (unknown.length > 0) throw new ValidationError(`Unknown component(s): ${unknown.join(', ')}.`);
      }

      reservePreparation(target);
      try {
        await ensureAgentOnline(target.agentId);
        assertTargetUnchanged(target);
        preparingTargets.delete(target.id);

        const relevant = requested ? known.filter((component) => requested.includes(component.name)) : known;
        const healthSec = relevant.reduce((sum, component) => sum + (component.health ? component.health.timeoutSec : 0), 0);
        return await startRun({
        kind: 'artifact_rollback',
        target,
        project,
        release: null,
        triggeredBy,
        components: requested || [],
        timeoutSec: ROLLBACK_TIMEOUT_BASE_SEC + healthSec,
        description: `Artifact rollback on target '${target.name}' (project: ${project.name})`,
        buildPayload: (run) => {
          log(run, `Rolling back ${requested ? requested.join(', ') : 'every component with a previous release'} on '${target.name}' (agent ${target.agentId}).`);
          return { deployId: run.deployId, components: requested };
        },
        });
      } finally {
        preparingTargets.delete(target.id);
      }
    },

    /** Applies the stored target config without changing the installed release. */
    async applyConfig({ targetId, triggeredBy }) {
      const target = await requireTarget(targetId);
      const project = getProject(target.projectId);
      const config = normalizeArtifactDeployConfig(project.config && project.config.artifactDeploy);
      if (!config || config.components.length === 0) {
        throw new ValidationError('No artifactDeploy.components are configured for this project.');
      }
      const resolved = resolveTargetComponents(config.components, target.components, null);
      if (resolved.errors.length > 0) throw new ValidationError(resolved.errors.join(' '));
      const configured = resolved.components
        .map((component) => ({ component, runtimeConfig: runtimeConfigForComponent(target.runtimeConfig, component) }))
        .filter((entry) => entry.runtimeConfig !== null);
      if (configured.length === 0) throw new ValidationError('This target has no runtime config to apply.');

      reservePreparation(target);
      try {
        await ensureAgentOnline(target.agentId);
        assertTargetUnchanged(target);
        preparingTargets.delete(target.id);

        const healthSec = configured.reduce(
          (sum, entry) => sum + (entry.component.health ? entry.component.health.timeoutSec : 0), 0
        );
        const timeoutSec = Math.min(3600, CONFIG_APPLY_TIMEOUT_BASE_SEC + healthSec);
        return await startRun({
        kind: 'artifact_config_apply',
        target,
        project,
        release: null,
        triggeredBy,
        components: configured.map((entry) => entry.component.name),
        timeoutSec,
        sensitiveValues: collectSensitiveValues(target.runtimeConfig, configured.map((entry) => entry.component)),
        description: `Runtime config apply on target '${target.name}' (project: ${project.name})`,
        buildPayload: (run) => {
          for (const entry of configured) {
            log(run, `${entry.component.name}: ${entry.runtimeConfig.format}; keys: ${Object.keys(entry.runtimeConfig.values).join(', ') || '(none)'}`);
          }
          log(run, `Applying stored runtime config on '${target.name}' (agent ${target.agentId}).`);
          return {
            deployId: run.deployId,
            timeoutSec,
            components: configured.map((entry) => ({
              name: entry.component.name,
              runtimeConfig: {
                format: entry.runtimeConfig.format,
                values: { ...entry.runtimeConfig.values },
              },
            })),
          };
        },
        });
      } finally {
        preparingTargets.delete(target.id);
      }
    },

    /** Cancels a running artifact deploy/rollback/config apply through DeploymentManager.abort(). */
    async cancel(deploymentId) {
      const run = runs.get(deploymentId);
      if (!run) throw new NotFoundError('No running artifact deployment with this id.');
      await deploymentManager.abort(deploymentId);
      return { deploymentId, deployId: run.deployId };
    },

    /** Stored stage events of a deployment (GET /api/deployments/:id/events). */
    listEvents(deploymentId) {
      if (!deploymentManager.getSession(deploymentId)) throw new NotFoundError('Deployment not found');
      return repository.listEvents(deploymentId);
    },
  };
}

module.exports = { createArtifactDeployService, RESULT_GRACE_MS };
