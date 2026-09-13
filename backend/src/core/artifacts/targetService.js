'use strict';

/**
 * Deploy targets: one customer server = one agent = one target of one
 * project (docs/ARTIFACT-DEPLOY.md). CRUD plus `refreshStatus()`, which asks
 * the agent (`artifact_status`) what is currently deployed and stores it.
 *
 * Transport-agnostic: callers pass an `actor` string for the audit trail.
 */

const crypto = require('node:crypto');
const { NotFoundError, ValidationError, ConflictError, UpstreamError } = require('../errors');
const {
  validateTargetInput,
  normalizeArtifactDeployConfig,
  isPlainObject,
  sanitizeAgentText,
  sanitizeVersion,
  COMPONENT_NAME_PATTERN,
} = require('./contracts');
const { openAgentChannel, sendAgentCommand, listGatewayAgents } = require('./agentChannel');

const MAX_STATUS_COMPONENTS = 20;
const MAX_PREVIOUS_VERSIONS = 10;

/** Only well-formed values from an agent's artifact_status_result are kept. */
function sanitizeStatusResult(payload) {
  const components = {};
  const source = isPlainObject(payload.components) ? payload.components : {};
  for (const [name, entry] of Object.entries(source).slice(0, MAX_STATUS_COMPONENTS)) {
    if (!COMPONENT_NAME_PATTERN.test(name) || !isPlainObject(entry)) continue;
    components[name] = {
      version: sanitizeVersion(entry.version),
      deployedAt: sanitizeAgentText(entry.deployedAt, 64) || null,
      previousVersions: (Array.isArray(entry.previousVersions) ? entry.previousVersions : [])
        .map(sanitizeVersion)
        .filter(Boolean)
        .slice(0, MAX_PREVIOUS_VERSIONS),
    };
  }
  return { basePath: sanitizeAgentText(payload.basePath, 500) || null, components };
}

/**
 * @param {object} deps
 * @param {object} deps.repository - artifactDeployRepository.
 * @param {{ log: Function }} deps.auditLogger
 * @param {(id: string) => object} deps.getProject - throws NotFoundError.
 * @param {() => object} deps.getGateway - AgentGatewayClient factory.
 * @param {(targetId: string) => boolean} [deps.isTargetBusy]
 * @param {{ statusTimeoutMs?: number, channelTimeoutMs?: number }} [deps.timing]
 */
function createTargetService({ repository, auditLogger, getProject, getGateway, isTargetBusy = () => false, timing = {} }) {
  const statusTimeoutMs = timing.statusTimeoutMs ?? 15_000;
  const channelTimeoutMs = timing.channelTimeoutMs ?? 10_000;

  function requireTarget(id) {
    const target = repository.findTarget(id);
    if (!target) throw new NotFoundError('Deploy target not found');
    return target;
  }

  function componentErrors(project, components) {
    if (!Array.isArray(components) || components.length === 0) return [];
    const config = normalizeArtifactDeployConfig(project.config && project.config.artifactDeploy);
    const known = new Set(config ? config.components.map((component) => component.name) : []);
    return components
      .filter((entry) => isPlainObject(entry) && typeof entry.name === 'string' && !known.has(entry.name))
      .map((entry) => ({
        path: 'components',
        message: `Component '${entry.name}' is not defined in the project's artifactDeploy.components.`,
      }));
  }

  async function ensureAgentRegistered(agentId) {
    const agents = await listGatewayAgents(getGateway());
    if (!agents.some((agent) => agent && agent.id === agentId)) {
      throw new ValidationError(`Agent ${agentId} is not registered in the agent gateway — issue its credential first.`);
    }
  }

  function ensureAgentFree(agentId, exceptTargetId = null) {
    const existing = repository.findTargetByAgent(agentId);
    if (existing && existing.id !== exceptTargetId) {
      throw new ConflictError(`Agent ${agentId} already serves deploy target '${existing.name}'. One agent serves exactly one target.`);
    }
  }

  function withUniqueGuard(fn, agentId) {
    try {
      return fn();
    } catch (err) {
      if (/UNIQUE/i.test(String(err && err.message))) {
        throw new ConflictError(`Agent ${agentId} already serves another deploy target.`);
      }
      throw err;
    }
  }

  return {
    listTargets(projectId) {
      getProject(projectId);
      return repository.listTargets(projectId);
    },

    getTarget(id) {
      return requireTarget(id);
    },

    async createTarget(projectId, input, actor) {
      const project = getProject(projectId);
      const { errors, value } = validateTargetInput(input);
      errors.push(...componentErrors(project, value.components));
      if (errors.length > 0) throw new ValidationError('Invalid deploy target.', errors);

      ensureAgentFree(value.agentId);
      await ensureAgentRegistered(value.agentId);
      ensureAgentFree(value.agentId); // the gateway call awaited: re-check

      const target = withUniqueGuard(() => repository.createTarget({ projectId, ...value }), value.agentId);
      auditLogger.log(actor, 'DEPLOY_TARGET_CREATED', `Created deploy target '${target.name}' for project: ${project.name}`, {
        projectId,
        targetId: target.id,
        agentId: target.agentId,
      });
      return target;
    },

    async updateTarget(id, input, actor) {
      const target = requireTarget(id);
      const project = getProject(target.projectId);
      if (isTargetBusy(id)) throw new ConflictError('A deployment is running on this target.');

      const { errors, value } = validateTargetInput(input, { partial: true });
      errors.push(...componentErrors(project, value.components));
      if (errors.length > 0) throw new ValidationError('Invalid deploy target.', errors);

      const agentChanged = value.agentId !== undefined && value.agentId !== target.agentId;
      if (agentChanged) {
        ensureAgentFree(value.agentId, id);
        await ensureAgentRegistered(value.agentId);
        ensureAgentFree(value.agentId, id);
        // A different server: what we knew about the old one no longer applies.
        Object.assign(value, { currentReleaseId: null, currentVersions: null, basePath: value.basePath ?? null });
      }

      const updated = withUniqueGuard(() => repository.updateTarget(id, value), value.agentId);
      auditLogger.log(actor, 'DEPLOY_TARGET_UPDATED', `Updated deploy target '${updated.name}'`, {
        projectId: target.projectId,
        targetId: id,
        agentId: updated.agentId,
        fields: Object.keys(value),
      });
      return updated;
    },

    deleteTarget(id, actor) {
      const target = requireTarget(id);
      if (isTargetBusy(id)) throw new ConflictError('A deployment is running on this target.');
      repository.deleteTarget(id);
      auditLogger.log(actor, 'DEPLOY_TARGET_DELETED', `Deleted deploy target '${target.name}'`, {
        projectId: target.projectId,
        targetId: id,
        agentId: target.agentId,
      });
    },

    /**
     * Asks the target's agent what is deployed (`artifact_status`), stores
     * `current_versions_json` / `base_path`, and links `current_release_id`
     * when every component runs the same known release.
     */
    async refreshStatus(id) {
      const target = requireTarget(id);
      const gateway = getGateway();
      const requestId = `req_${crypto.randomBytes(12).toString('hex')}`;

      let deliver;
      const answer = new Promise((resolve) => {
        deliver = resolve;
      });
      const channel = await openAgentChannel(gateway, target.agentId, {
        timeoutMs: channelTimeoutMs,
        onMessage: (message) => {
          if (!message || message.process !== 'artifact_status_result' || message.agentId !== target.agentId) return;
          if (isPlainObject(message.payload) && message.payload.requestId === requestId) deliver(message.payload);
        },
      });

      let timer = null;
      try {
        await sendAgentCommand(gateway, target.agentId, 'artifact_status', { requestId });
        const payload = await Promise.race([
          answer,
          new Promise((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new UpstreamError(`Agent ${target.agentId} did not answer the status request within ${Math.round(statusTimeoutMs / 1000)}s.`)),
              statusTimeoutMs
            );
            timer.unref?.();
          }),
        ]);
        const status = sanitizeStatusResult(payload);
        const versions = [...new Set(Object.values(status.components).map((entry) => entry.version).filter(Boolean))];
        const release = versions.length === 1 ? repository.findReleaseByVersion(target.projectId, versions[0]) : null;
        return repository.updateTarget(id, {
          currentVersions: status.components,
          basePath: status.basePath ?? target.basePath,
          currentReleaseId: release ? release.id : null,
        });
      } finally {
        clearTimeout(timer);
        channel.close();
      }
    },
  };
}

module.exports = { createTargetService, sanitizeStatusResult };
