'use strict';

/**
 * Releases (docs/ARTIFACT-DEPLOY.md, F1).
 *
 *   createRelease()  row 'building' → build via the EXISTING adapters
 *                    (CiPipelineAdapter / JenkinsAdapter) as a DeploymentManager
 *                    session of kind 'build' (logs over the existing SSE) →
 *                    on success fetch + validate the manifest → artifact rows →
 *                    'ready'; otherwise 'failed'.
 *   importRelease()  manifest only (build.provider 'none', or a re-import).
 *
 * The version reaches the build SERVER-SIDE only: `{ [versionVariable]: version }`
 * via CiPipelineAdapter's `extraVariables` constructor option (pipeline) or
 * Jenkins build parameters. Nothing a caller sends besides the validated
 * version/ref is forwarded.
 */

const { NotFoundError, ValidationError, ConflictError } = require('../errors');
const {
  VERSION_PATTERN,
  GIT_REF_PATTERN,
  isPlainObject,
  normalizeArtifactDeployConfig,
  findMissingSourceFields,
  resolveSourceCredentials,
  validateManifest,
  manifestFileName,
} = require('./contracts');
const { mergeBuildParameters } = require('../deployment/buildParameters');

const MANIFEST_ATTEMPTS = 3;
/** Build parameter naming the subset being built (see createRelease). */
const COMPONENTS_VARIABLE = 'COMPONENTS';
/** Build parameter carrying the branch for providers without a ref concept. */
const BRANCH_VARIABLE = 'BRANCH';

/**
 * A version for a build nobody named: `0.0.0-<branch>.<utc timestamp>`.
 *
 * 0.0.0 keeps it visibly below any real version, the branch says where it came
 * from and the timestamp makes it unique — two test deploys a minute apart must
 * not collide on an immutable release row. Branch characters outside the
 * version pattern (slashes in `feature/x`) become dashes.
 */
function generateVersion(ref, now = new Date()) {
  const branch = String(ref).replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'branch';
  const stamp = now.toISOString().replace(/[-:T]/g, '').replace(/\..+$/, '');
  return `0.0.0-${branch}.${stamp}`;
}

/**
 * @param {string[]|undefined|null} requested
 * @param {{ name: string }[]} configured
 * @returns {string[]|null} null when the whole project is being built
 */
function normalizeRequestedComponents(requested, configured) {
  if (requested === undefined || requested === null) return null;
  if (!Array.isArray(requested) || requested.length === 0) return null;
  const known = new Set(configured.map((component) => component.name));
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown component(s): ${unknown.join(', ')}.`);
  }
  const unique = [...new Set(requested)];
  // Asking for all of them is the same as asking for nothing in particular —
  // keep the parameter out so the build log does not imply a narrowed run.
  return unique.length === known.size ? null : unique;
}

/**
 * `parameters` is the merged build-parameter map (global defaults + the
 * project's own, version last). It reaches the build as CI variables /
 * job parameters — see core/deployment/buildParameters.js for why secrets
 * must not travel this way.
 */
function defaultCreateBuildAdapter({ provider, config, version, versionVariable, ref, parameters = {} }) {
  // Required lazily: keeps this module (and its tests) free of adapter
  // dependencies until a real build runs.
  if (provider === 'pipeline') {
    const CiPipelineAdapter = require('../../adapters/CiPipelineAdapter');
    const ciConfig = isPlainObject(config.ciConfig) ? { ...config.ciConfig } : {};
    if (ref) ciConfig.ref = ref;
    try {
      const adapter = new CiPipelineAdapter({
        ciConfig,
        username: config.username,
        apiToken: config.apiToken,
        extraVariables: { ...parameters, [versionVariable]: version },
      });
      return { adapter, triggerParams: {} };
    } catch (err) {
      throw new ValidationError(err.message);
    }
  }
  if (provider === 'jenkins') {
    // Jenkins has no ref concept in buildWithParameters, so the branch travels as
    // a parameter the job checks out (see the BRANCH parameter in jetsrm's
    // Jenkinsfile). Empty means the job's own configured branch, as before.
    if (!config.url || !config.jobName) {
      throw new ValidationError("The Jenkins build provider needs the project's url and jobName.");
    }
    const JenkinsAdapter = require('../../adapters/JenkinsAdapter');
    const adapter = new JenkinsAdapter({
      url: config.url,
      username: config.username,
      apiToken: config.apiToken,
      jobName: config.jobName,
    });
    return { adapter, triggerParams: { ...parameters, ...(ref ? { [BRANCH_VARIABLE]: ref } : {}), [versionVariable]: version } };
  }
  throw new ValidationError(`Build provider '${provider}' does not build — import the release instead.`);
}

function defaultCreateSourceClient(source, credentials) {
  const { createArtifactSourceClient } = require('./artifactSourceClient');
  return createArtifactSourceClient(source, credentials);
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * @param {object} deps
 * @param {object} deps.repository - artifactDeployRepository.
 * @param {object} deps.deploymentManager
 * @param {{ log: Function }} deps.auditLogger
 * @param {(id: string) => object} deps.getProject - persisted project (throws NotFoundError).
 * @param {(project: object) => Promise<object>} deps.resolveSecrets - decrypts secret:// refs into a copy.
 * @param {Function} [deps.createBuildAdapter] - test seam: ({provider, config, version, versionVariable, ref}) → {adapter, triggerParams}.
 * @param {Function} [deps.createSourceClient] - test seam: (source, {token, username}) → source client.
 * @param {(releaseId: string) => boolean} [deps.isReleaseBusy] - true while an agent deploy uses the release.
 * @param {(projectId: string, version: string) => void} [deps.deleteLocalRelease]
 * @param {{ manifestRetryMs?: number }} [deps.timing]
 */
function createReleaseService({
  repository,
  deploymentManager,
  auditLogger,
  getProject,
  resolveSecrets,
  createBuildAdapter = defaultCreateBuildAdapter,
  // Defaults every project's build inherits (settings service). A function, not
  // a value: the settings can change between two builds of the same server.
  getGlobalBuildParameters = () => null,
  // Installs a finished release on a target. Injected rather than imported: the
  // deploy service is built in the same module and would otherwise be a cycle.
  deployRelease = null,
  createSourceClient = defaultCreateSourceClient,
  isReleaseBusy = () => false,
  deleteLocalRelease = null,
  timing = {},
}) {
  const manifestRetryMs = timing.manifestRetryMs ?? 5_000;
  /** `${projectId}:${version}` of builds running in this process. */
  const activeBuilds = new Set();
  /** releaseId → promise of the background build (test seam: waitForBuild). */
  const pending = new Map();

  function requireConfig(project) {
    const config = normalizeArtifactDeployConfig(project.config && project.config.artifactDeploy);
    if (!config) throw new ValidationError('Artifact deploy is not configured for this project (config.artifactDeploy).');
    return config;
  }

  function requireVersion(version) {
    if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
      throw new ValidationError('Invalid version: 1-64 characters, letters, digits, ".", "_" or "-", starting with a letter or digit.');
    }
  }

  /**
   * Fetches, validates and stores the manifest of `release`. Never throws
   * for a source problem without a scrubbed message.
   * @returns {Promise<object>} the updated release (status 'ready')
   */
  async function ingestManifest(release, runtimeProject, { attempts = 1, onRetry } = {}) {
    const config = requireConfig(runtimeProject);
    const credentials = resolveSourceCredentials(runtimeProject.config, config);
    const missing = findMissingSourceFields(config, credentials);
    if (missing.length > 0) {
      throw new ValidationError(`Artifact source configuration is incomplete — missing: ${missing.join(', ')}.`);
    }

    const client = createSourceClient(config.source, { token: credentials.token, username: credentials.username });
    try {
      let fetched;
      for (let attempt = 1; ; attempt += 1) {
        try {
          fetched = await client.fetchManifest({ artifactName: config.artifactName, version: release.version });
          break;
        } catch (err) {
          if (attempt >= attempts || !(err.notFound || err.transient)) throw err;
          if (onRetry) onRetry(err, attempt);
          await sleep(manifestRetryMs);
        }
      }

      const check = validateManifest(fetched.manifest, { project: config.artifactName, version: release.version });
      if (!check.valid) {
        throw new ValidationError(
          `Invalid manifest ${manifestFileName(config.artifactName, release.version)}: ${check.errors.join(' ')}`
        );
      }
      const resolved = await client.resolveArtifacts(check.manifest.artifacts, fetched.context);
      repository.replaceArtifacts(release.id, resolved);
      return repository.updateRelease(release.id, {
        status: 'ready',
        manifest: check.manifest,
        commitSha: check.manifest.commit,
        sourcePlatform: config.source.platform,
        sourceIdentity: {
          platform: config.source.platform,
          owner: config.source.owner,
          repo: config.source.repo,
          baseUrl: config.source.baseUrl,
        },
        error: null,
      });
    } finally {
      if (typeof client.releaseCredentials === 'function') client.releaseCredentials();
    }
  }

  /** Creates the row, or resets a failed one for a retry. */
  function claimReleaseRow(project, version, triggeredBy, { allowReady }) {
    const existing = repository.findReleaseByVersion(project.id, version);
    if (existing) {
      if (existing.status === 'building' || activeBuilds.has(`${project.id}:${version}`)) {
        throw new ConflictError(`Release ${version} is already being built.`);
      }
      if (existing.status === 'ready' && !allowReady) {
        throw new ConflictError(`Release ${version} already exists and is ready. Use import to re-read its manifest.`);
      }
      if (isReleaseBusy(existing.id)) {
        throw new ConflictError(`Release ${version} is being deployed and cannot be changed.`);
      }
      return repository.updateRelease(existing.id, { status: 'building', error: null, createdBy: triggeredBy || existing.createdBy });
    }
    try {
      return repository.createRelease({ projectId: project.id, version, status: 'building', createdBy: triggeredBy || null });
    } catch (err) {
      if (/UNIQUE/i.test(String(err && err.message))) throw new ConflictError(`Release ${version} already exists.`);
      throw err;
    }
  }

  function fail(release, err) {
    return repository.updateRelease(release.id, { status: 'failed', error: String(err && err.message ? err.message : err).slice(0, 2000) });
  }

  /**
   * Hands a freshly built release to the deploy service. Failures are logged
   * into the build's own stream and never re-thrown: the release IS ready at
   * this point, and marking the build failed because the install did not start
   * would misreport what happened.
   */
  async function deployAfterBuild({ release, deployTo, triggeredBy, log }) {
    if (!deployTo || typeof deployRelease !== 'function') return;
    try {
      log(`[Release] → Installing ${release.version} on target ${deployTo.targetId}...`);
      await deployRelease({
        targetId: deployTo.targetId,
        releaseId: release.id,
        components: deployTo.components,
        triggeredBy,
      });
    } catch (err) {
      log(`[Release] ✗ Release ${release.version} is ready but the deployment could not start: ${err.message}`);
    }
  }

  async function runBuild({ project, runtimeProject, release, adapter, triggerParams, deploymentId, triggeredBy, provider, deployTo }) {
    const startedAt = Date.now();
    const log = (line) => deploymentManager.pushLog(deploymentId, line);
    const throwIfAborted = () => {
      const session = deploymentManager.getSession(deploymentId);
      if (session && session.signal && session.signal.aborted) throw new Error('Release build aborted by user');
    };
    try {
      await adapter.connect();
      throwIfAborted();
      await adapter.trigger(triggerParams);
      await adapter.streamLogs(log);
      throwIfAborted();

      let ready = repository.findRelease(release.id);
      if (ready && ready.status === 'ready' && ready.sourcePlatform === 'local') {
        log('[Release] ✓ Build finished — CI already uploaded and finalized the local artifacts.');
      } else {
        log('[Release] ✓ Build finished — reading the manifest from the external artifact source...');
        ready = await ingestManifest(release, runtimeProject, {
          attempts: MANIFEST_ATTEMPTS,
          onRetry: (err, attempt) => log(`[Release] ⚠ ${err.message} Retrying (${attempt}/${MANIFEST_ATTEMPTS - 1})...`),
        });
      }
      const artifacts = repository.listArtifacts(release.id);
      for (const artifact of artifacts) {
        log(`[Release] ✓ ${artifact.component} (${artifact.os}) ${artifact.fileName} — ${artifact.size} bytes, sha256 ${artifact.sha256.slice(0, 12)}…`);
      }
      log(`[Release] ✓ Release ${ready.version} is ready (${artifacts.length} artifact(s)).`);
      deploymentManager.setStatus(deploymentId, 'succeeded');
      await deployAfterBuild({ release: ready, deployTo, triggeredBy, log });
      auditLogger.log(triggeredBy, 'RELEASE_BUILD_SUCCEEDED', `Release ${release.version} built for project: ${project.name}`, {
        projectId: project.id,
        releaseId: release.id,
        version: release.version,
        deploymentId,
        provider,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      const session = deploymentManager.getSession(deploymentId);
      const wasAborted = session && session.status === 'aborted';
      const finalized = repository.findRelease(release.id);
      if (finalized && finalized.status === 'ready' && finalized.sourcePlatform === 'local') {
        log(`[Release] ⚠ CI status polling failed after the immutable local artifacts were finalized: ${err.message}`);
        log(`[Release] ✓ Release ${finalized.version} remains ready; verified uploaded artifacts take precedence over the polling error.`);
        if (!wasAborted) deploymentManager.setStatus(deploymentId, 'succeeded');
        auditLogger.log(triggeredBy, 'RELEASE_BUILD_SUCCEEDED', `Release ${release.version} finalized for project: ${project.name}`, {
          projectId: project.id,
          releaseId: release.id,
          version: release.version,
          deploymentId,
          provider,
          durationMs: Date.now() - startedAt,
          pollingWarning: String(err.message || err).slice(0, 500),
          abortedAfterFinalize: Boolean(wasAborted),
        });
        return;
      }
      fail(release, wasAborted ? new Error('Build aborted by user.') : err);
      if (!wasAborted) {
        log(`[Release] ✗ Release ${release.version} failed: ${err.message}`);
        deploymentManager.setStatus(deploymentId, 'failed', err.message);
      }
      auditLogger.log(
        triggeredBy,
        'RELEASE_BUILD_FAILED',
        `Release ${release.version} build failed for project: ${project.name}`,
        { projectId: project.id, releaseId: release.id, version: release.version, deploymentId, error: err.message, aborted: Boolean(wasAborted) },
        { outcome: 'failure' }
      );
    } finally {
      activeBuilds.delete(`${project.id}:${release.version}`);
      if (typeof adapter.releaseCredentials === 'function') adapter.releaseCredentials();
      if (adapter.config) {
        adapter.config.apiToken = null;
        adapter.config.password = null;
      }
    }
  }

  return {
    listReleases(projectId) {
      getProject(projectId);
      return repository.listReleases(projectId);
    },

    /** @returns {object} release + its artifacts */
    getRelease(id) {
      const release = repository.findRelease(id);
      if (!release) throw new NotFoundError('Release not found');
      return { ...release, artifacts: repository.listArtifacts(id) };
    },

    /**
     * @param {{ projectId: string, version: string, ref?: string, triggeredBy?: string }} args
     * @returns {Promise<{ release: object, deploymentId: string }>}
     */
    async createRelease({ projectId, version, ref, components, deployTo, triggeredBy }) {
      const project = getProject(projectId);
      requireVersion(version);
      if (ref !== undefined && ref !== null && ref !== '') {
        if (typeof ref !== 'string' || !GIT_REF_PATTERN.test(ref) || ref.includes('..')) {
          throw new ValidationError('Invalid ref: a branch or tag name.');
        }
      }
      const config = requireConfig(project);
      const provider = config.build.provider;
      if (provider === 'none') {
        throw new ValidationError("This project's build provider is 'none' — upload the artifacts yourself and import the release.");
      }

      // Only the components this project declares may be asked for; an unknown
      // name would otherwise reach the build job as a silent no-op and produce a
      // release missing the very component the operator wanted.
      const requestedComponents = normalizeRequestedComponents(components, config.components);

      const runtimeProject = await resolveSecrets(project);
      const runtimeConfig = runtimeProject.config || {};
      const { adapter, triggerParams } = createBuildAdapter({
        provider,
        config: runtimeConfig,
        version,
        versionVariable: config.versionVariable,
        ref: ref || null,
        // Nothing the caller sent reaches the build: the parameters come from
        // the project's config (project:write) and the global defaults, which
        // is what keeps a deployer from injecting build inputs.
        parameters: {
          ...mergeBuildParameters(
            getGlobalBuildParameters(),
            config.build.parameters,
            config.versionVariable,
            version,
          ),
          // Comma-separated so a job can read it with a plain string split;
          // absent (not empty) when everything is being built, so an existing
          // job that ignores it keeps behaving exactly as before.
          ...(requestedComponents ? { [COMPONENTS_VARIABLE]: requestedComponents.join(',') } : {}),
        },
      });

      let release;
      try {
        release = claimReleaseRow(project, version, triggeredBy, { allowReady: false });
      } catch (err) {
        if (typeof adapter.releaseCredentials === 'function') adapter.releaseCredentials();
        throw err;
      }
      activeBuilds.add(`${project.id}:${version}`);
      repository.replaceArtifacts(release.id, []);

      const deploymentId = deploymentManager.createSession(project.id, adapter, {
        triggeredBy,
        kind: 'build',
        releaseId: release.id,
      });
      release = repository.updateRelease(release.id, { buildDeploymentId: deploymentId, manifest: null });

      auditLogger.log(triggeredBy, 'RELEASE_CREATED', `Release ${version} requested for project: ${project.name}`, {
        projectId: project.id,
        releaseId: release.id,
        version,
        deploymentId,
        provider,
        ...(ref ? { ref } : {}),
      });

      adapter.onLog((line) => deploymentManager.pushLog(deploymentId, line));
      deploymentManager.setStatus(deploymentId, 'running');
      deploymentManager.pushLog(
        deploymentId,
        `[Release] Building ${config.artifactName} ${version} via ${provider}${ref ? ` @ ${ref}` : ''} ` +
          `(the build receives ${config.versionVariable}=${version}).`
      );

      const promise = runBuild({ project, runtimeProject, release, adapter, triggerParams, deploymentId, triggeredBy, provider, deployTo })
        .finally(() => pending.delete(release.id));
      pending.set(release.id, promise);
      return { release, deploymentId };
    },

    /**
     * Test-server flow: rebuild the target's branch and install the result on
     * that target, without asking anyone to invent a version.
     *
     * A version is still cut — the deploy path, rollback and "what is installed
     * here" all key off a release row — but it is generated, and its shape says
     * plainly that it is not a hand-picked one: `0.0.0-<branch>.<timestamp>`.
     *
     * Production is excluded on purpose: there a version is the whole point.
     * You deploy something that was built, seen and named earlier, not whatever
     * the branch happens to hold right now.
     *
     * @param {{ targetId: string, components?: string[], triggeredBy?: string }} args
     */
    async buildAndDeploy({ targetId, components, triggeredBy }) {
      const target = repository.findTarget(targetId);
      if (!target) throw new NotFoundError('Deploy target not found');
      if (!target.ref) {
        throw new ValidationError("This target has no branch configured — set one, or pick a release from the Deploy screen.");
      }
      if (target.environment === 'Prod') {
        throw new ValidationError('A production target deploys a named release, not the current state of a branch.');
      }
      return this.createRelease({
        projectId: target.projectId,
        version: generateVersion(target.ref),
        ref: target.ref,
        components,
        deployTo: { targetId: target.id, components },
        triggeredBy,
      });
    },

    /**
     * Reads the manifest of an already-uploaded release (build provider
     * 'none', or a re-import of an existing version).
     */
    async importRelease({ projectId, version, triggeredBy }) {
      const project = getProject(projectId);
      requireVersion(version);
      requireConfig(project);
      const existing = repository.findReleaseByVersion(projectId, version);
      if (existing && existing.status === 'ready' && existing.sourcePlatform === 'local') {
        throw new ConflictError(`Release ${version} was uploaded locally and is immutable.`);
      }
      const runtimeProject = await resolveSecrets(project);

      const release = claimReleaseRow(project, version, triggeredBy, { allowReady: true });
      activeBuilds.add(`${project.id}:${version}`);
      try {
        const ready = await ingestManifest(release, runtimeProject);
        auditLogger.log(triggeredBy, 'RELEASE_IMPORTED', `Release ${version} imported for project: ${project.name}`, {
          projectId: project.id,
          releaseId: release.id,
          version,
          artifacts: repository.listArtifacts(release.id).length,
        });
        return { ...ready, artifacts: repository.listArtifacts(release.id) };
      } catch (err) {
        fail(release, err);
        auditLogger.log(
          triggeredBy,
          'RELEASE_IMPORT_FAILED',
          `Release ${version} import failed for project: ${project.name}`,
          { projectId: project.id, releaseId: release.id, version, error: err.message },
          { outcome: 'failure' }
        );
        throw err;
      } finally {
        activeBuilds.delete(`${project.id}:${version}`);
      }
    },

    /** Deletes DB rows; local binaries are removed by `deleteLocalRelease`. */
    deleteRelease(id, actor) {
      const release = repository.findRelease(id);
      if (!release) throw new NotFoundError('Release not found');
      if (release.status === 'building' || activeBuilds.has(`${release.projectId}:${release.version}`)) {
        throw new ConflictError('The release is still being built.');
      }
      if (isReleaseBusy(release.id)) {
        throw new ConflictError('The release is being deployed and cannot be deleted.');
      }
      if (repository.isReleaseCurrent(release.id)) {
        throw new ConflictError('The release is currently installed on a target and cannot be deleted.');
      }
      repository.deleteRelease(id);
      if (deleteLocalRelease) {
        try {
          deleteLocalRelease(release.projectId, release.version);
        } catch (err) {
          // The release is no longer deployable. Leaving orphaned bytes is
          // safer than leaving metadata that points at a partly deleted file.
          console.error(`[artifacts] Failed to remove deleted release ${release.id}: ${err.message}`);
        }
      }
      auditLogger.log(actor, 'RELEASE_DELETED', `Deleted release ${release.version}`, {
        projectId: release.projectId,
        releaseId: id,
        version: release.version,
      });
    },

    /** Test seam: resolves when the background build of `releaseId` settled. */
    waitForBuild(releaseId) {
      return pending.get(releaseId) || Promise.resolve();
    },
  };
}

module.exports = { createReleaseService, defaultCreateBuildAdapter };
