'use strict';

/**
 * Release composer (docs/ARTIFACT-DEPLOY.md, "Release composer").
 *
 *   listRefs()   branches + tags of the project's artifact source repository.
 *   compose()    base (branch|tag) + N feature branches → a throwaway
 *                `preview/…` branch on Bitbucket with each feature merged in
 *                through a pull request → the EXISTING release build with
 *                ref = that branch. The merge steps run inside the build's
 *                DeploymentManager session (releaseService `prepare`), so they
 *                stream to the same SSE log; a refused merge declines its PR,
 *                deletes the branch and fails the release without building.
 *                The branch is deleted once the build is terminal; the merged
 *                PRs stay as history.
 *   createTag()  a tag on a branch head or commit, named like a release
 *                version so it can be built with the regular create-release.
 *
 * A composed release carries `composition` and can never be deployed to a
 * production target (artifactDeployService enforces it too).
 */

const { NotFoundError, ValidationError, ConflictError, UpstreamError } = require('../errors');
const {
  VERSION_PATTERN,
  isPlainObject,
  normalizeArtifactDeployConfig,
  resolveSourceCredentials,
  isProdTarget,
  PREVIEW_NOT_ALLOWED_ON_PROD,
} = require('./contracts');

const MAX_BRANCHES = 10;
const BASE_TYPES = ['branch', 'tag'];
const TAG_FROM_TYPES = ['branch', 'commit'];
const COMPOSE_PREFIX = 'preview/';
const MAX_SLUG_LENGTH = 40;
/**
 * Names the user picks from the ref list. They only travel in JSON bodies and
 * URL-encoded path segments, so this is git's own rule set rather than the
 * stricter build-ref pattern: no whitespace/control characters, none of
 * `~^:?*[\`, no `..`, `@{` or `//`, not starting with `-` or `/`.
 */
const REF_NAME_PATTERN = /^(?![-/])[^\s~^:?*[\\\x00-\x1f\x7f]{1,255}$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;
const MAX_QUERY_LENGTH = 100;
const MAX_TAG_MESSAGE_LENGTH = 1000;

function isRefName(name) {
  return typeof name === 'string'
    && REF_NAME_PATTERN.test(name)
    && !name.includes('..')
    && !name.includes('@{')
    && !name.includes('//')
    && !name.endsWith('/')
    && !name.endsWith('.')
    && !name.endsWith('.lock');
}

/** `yyyymmddHHMMss` in UTC. */
function utcStamp(date) {
  return date.toISOString().replace(/[-:T]/g, '').replace(/\..+$/, '');
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
}

/** `preview/<first two features, slugified, joined by '+', ≤40>-<stamp>`. */
function composeBranchName(branches, date) {
  const slug = branches.slice(0, 2).map(slugify).filter(Boolean).join('+')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/[-.+_]+$/, '');
  return `${COMPOSE_PREFIX}${slug || 'compose'}-${utcStamp(date)}`;
}

function previewVersion(date) {
  return `0.0.0-preview.${utcStamp(date)}`;
}

function previewOnProdError(target) {
  return new ValidationError(
    `Target '${target.name}' is a production target — a composed preview may only be deployed to non-production targets.`,
    undefined,
    PREVIEW_NOT_ALLOWED_ON_PROD,
  );
}

/** Upstream (Bitbucket) failure → 502, message already scrubbed by the client. */
function upstream(err) {
  if (err instanceof NotFoundError || err instanceof ValidationError || err instanceof ConflictError || err instanceof UpstreamError) {
    return err;
  }
  return new UpstreamError(String((err && err.message) || err));
}

function defaultCreateRepoClient(source, credentials) {
  const { createRepoClient } = require('../../adapters/ci');
  return createRepoClient(source, credentials);
}

/**
 * @param {object} deps
 * @param {object} deps.repository - artifactDeployRepository (targets).
 * @param {object} deps.releaseService - createRelease({..., composition, prepare, afterBuild}).
 * @param {{ log: Function }} deps.auditLogger
 * @param {(id: string) => object} deps.getProject
 * @param {(project: object) => Promise<object>} deps.resolveSecrets
 * @param {Function} [deps.createRepoClient] - test seam: (source, {token, username}) → BitbucketRepoClient.
 * @param {() => Date} [deps.now]
 */
function createComposeService({
  repository,
  releaseService,
  auditLogger,
  getProject,
  resolveSecrets,
  createRepoClient = defaultCreateRepoClient,
  now = () => new Date(),
}) {
  /** The Bitbucket source + credentials of a project, or a 400 saying what is missing. */
  async function requireRepo(project) {
    const config = normalizeArtifactDeployConfig(project.config && project.config.artifactDeploy);
    if (!config || !config.source.platform) {
      throw new ValidationError('No repository is configured for this project (config.artifactDeploy.source).');
    }
    if (config.source.platform !== 'bitbucket') {
      throw new ValidationError(`Repository operations are only supported for Bitbucket sources (this project uses ${config.source.platform}).`);
    }
    const runtimeProject = await resolveSecrets(project);
    const credentials = resolveSourceCredentials(runtimeProject.config, config);
    const missing = [];
    if (!config.source.owner) missing.push('artifactDeploy.source.owner');
    if (!config.source.repo) missing.push('artifactDeploy.source.repo');
    if (!credentials.token) missing.push('artifactDeploy.source.token');
    if (config.source.authType === 'basic' && !credentials.username) missing.push('artifactDeploy.source.username');
    if (missing.length > 0) {
      throw new ValidationError(`Repository configuration is incomplete — missing: ${missing.join(', ')}.`);
    }
    return { config, credentials, repoName: `${config.source.owner}/${config.source.repo}` };
  }

  function openClient({ config, credentials }) {
    try {
      return createRepoClient(config.source, { token: credentials.token, username: credentials.username });
    } catch (err) {
      throw new ValidationError(err.message);
    }
  }

  /** Runs `fn(client)` and always drops the client's credential. */
  async function withClient(repo, fn) {
    const client = openClient(repo);
    try {
      return await fn(client);
    } catch (err) {
      throw upstream(err);
    } finally {
      client.releaseCredentials();
    }
  }

  function validateComposeInput({ base, branches, version }) {
    if (!isPlainObject(base) || !BASE_TYPES.includes(base.type) || !isRefName(base.name)) {
      throw new ValidationError("Invalid base: { type: 'branch'|'tag', name }.");
    }
    if (!Array.isArray(branches) || branches.length < 1 || branches.length > MAX_BRANCHES) {
      throw new ValidationError(`Pick between 1 and ${MAX_BRANCHES} branches to compose.`);
    }
    const invalid = branches.filter((name) => !isRefName(name));
    if (invalid.length > 0) throw new ValidationError('Invalid branch name(s) in branches.');
    if (new Set(branches).size !== branches.length) throw new ValidationError('A branch is listed more than once.');
    if (branches.includes(base.name)) {
      throw new ValidationError(`'${base.name}' is the base — it cannot also be a branch to merge.`);
    }
    if (branches.some((name) => name.startsWith(COMPOSE_PREFIX))) {
      throw new ValidationError(`Branches under '${COMPOSE_PREFIX}' are composer output and cannot be composed again.`);
    }
    if (version !== undefined && version !== null && (typeof version !== 'string' || !VERSION_PATTERN.test(version))) {
      throw new ValidationError('Invalid version: 1-64 characters, letters, digits, ".", "_" or "-", starting with a letter or digit.');
    }
  }

  function requireNonProdTarget(project, deployTo) {
    if (deployTo === undefined || deployTo === null) return null;
    if (!isPlainObject(deployTo) || typeof deployTo.targetId !== 'string' || deployTo.targetId === '') {
      throw new ValidationError('Invalid deployTo: { targetId, components? }.');
    }
    const target = repository.findTarget(deployTo.targetId);
    if (!target || target.projectId !== project.id) {
      throw new ValidationError("deployTo.targetId is not a deploy target of this project.");
    }
    if (isProdTarget(target, project)) throw previewOnProdError(target);
    return { targetId: target.id, ...(deployTo.components ? { components: deployTo.components } : {}) };
  }

  /**
   * The composer's half of the build session: everything between "release
   * row created" and "CI triggered", plus the branch cleanup afterwards.
   */
  function createComposition({ repo, base, branches, composeBranch, composition }) {
    const state = { client: null, branchCreated: false, branchDeleted: false };
    const short = (sha) => String(sha || '').slice(0, 12);

    async function deleteBranch(log) {
      if (!state.client || !state.branchCreated || state.branchDeleted) return;
      try {
        await state.client.deleteBranch(composeBranch);
        state.branchDeleted = true;
        log(`[Compose] ✓ Deleted preview branch ${composeBranch}.`);
      } catch (err) {
        log(`[Compose] ⚠ Could not delete preview branch ${composeBranch}: ${err.message} — delete it by hand.`);
      }
    }

    async function mergeFeature({ client, feature, log }) {
      let pr;
      try {
        pr = await client.createPullRequest({
          title: `IDP compose: ${feature.name} → ${composeBranch}`,
          description: `Opened by IDP's release composer (base ${base.type} ${base.name}).`,
          source: feature.name,
          destination: composeBranch,
        });
      } catch (err) {
        // Bitbucket refuses a PR with nothing to merge: the feature is already
        // part of the base (or of an earlier feature). Not an error.
        if (err.status === 400 && /no changes/i.test(err.providerMessage || err.message)) {
          log(`[Compose] • ${feature.name} has no changes against ${composeBranch} — already included, skipped.`);
          return;
        }
        throw err;
      }
      log(`[Compose] Pull request #${pr.id}: ${feature.name} → ${composeBranch}; merging...`);
      try {
        const merged = await client.mergePullRequest(pr.id, {
          message: `IDP compose: merge ${feature.name} into ${composeBranch} (base ${base.name})`,
        });
        log(`[Compose] ✓ Merged ${feature.name}${merged.mergeCommit ? ` (${short(merged.mergeCommit)})` : ''}.`);
      } catch (err) {
        const reason = err.providerMessage || err.message;
        log(`[Compose] ✗ ${feature.name} could not be merged: ${reason}`);
        try {
          await client.declinePullRequest(pr.id);
          log(`[Compose] Declined pull request #${pr.id}.`);
        } catch (declineErr) {
          log(`[Compose] ⚠ Could not decline pull request #${pr.id}: ${declineErr.message}`);
        }
        const conflict = err.status === 409 || /conflict/i.test(String(reason));
        const failure = new Error(conflict ? `Merge conflict: ${feature.name} → ${base.name}` : `Merging ${feature.name} failed: ${reason}`);
        failure.composeFailure = true;
        throw failure;
      }
    }

    async function prepare({ log, release, throwIfAborted }) {
      const persist = () => repository.updateRelease(release.id, { composition });
      state.client = openClient(repo);
      const client = state.client;
      try {
        log(`[Compose] Composing ${branches.length} branch(es) onto ${base.type} ${base.name} in ${repo.repoName}.`);
        const baseRef = base.type === 'tag' ? await client.getTag(base.name) : await client.getBranch(base.name);
        if (!baseRef) throw new Error(`Base ${base.type} '${base.name}' was not found in ${repo.repoName}.`);
        composition.baseSha = baseRef.sha;
        for (const feature of composition.branches) {
          const ref = await client.getBranch(feature.name);
          if (!ref) throw new Error(`Branch '${feature.name}' was not found in ${repo.repoName}.`);
          feature.sha = ref.sha;
          log(`[Compose] • ${feature.name} @ ${short(ref.sha)}`);
        }
        persist();
        throwIfAborted();

        await client.createBranch(composeBranch, composition.baseSha);
        state.branchCreated = true;
        log(`[Compose] ✓ Created ${composeBranch} from ${base.name} @ ${short(composition.baseSha)}.`);

        for (const feature of composition.branches) {
          throwIfAborted();
          await mergeFeature({ client, feature, log });
        }

        const head = await client.getBranch(composeBranch);
        composition.headSha = head ? head.sha : null;
        persist();
        log(`[Compose] ✓ ${composeBranch} is ready${head ? ` @ ${short(head.sha)}` : ''}; starting the build.`);
      } catch (err) {
        persist();
        await deleteBranch(log);
        throw err;
      }
    }

    async function afterBuild({ log }) {
      try {
        await deleteBranch(log);
      } finally {
        if (state.client) state.client.releaseCredentials();
      }
    }

    return { prepare, afterBuild };
  }

  return {
    /**
     * @param {{ projectId: string, q?: string, hidePreview?: boolean }} args
     * @returns {Promise<{ platform: 'bitbucket', defaultBranch: string|null, branches: object[], tags: object[] }>}
     */
    async listRefs({ projectId, q, hidePreview = false }) {
      const project = getProject(projectId);
      if (q !== undefined && q !== null && (typeof q !== 'string' || q.length > MAX_QUERY_LENGTH)) {
        throw new ValidationError(`q must be a string of at most ${MAX_QUERY_LENGTH} characters.`);
      }
      const repo = await requireRepo(project);
      return withClient(repo, async (client) => {
        const query = q ? q.trim() : '';
        const [info, branches, tags] = await Promise.all([
          client.getRepository(),
          client.listBranches({ q: query || undefined }),
          client.listTags({ q: query || undefined }),
        ]);
        return {
          platform: 'bitbucket',
          defaultBranch: info.defaultBranch,
          branches: hidePreview ? branches.filter((ref) => !ref.name.startsWith(COMPOSE_PREFIX)) : branches,
          tags,
        };
      });
    },

    /**
     * @param {{ projectId: string, base: { type: 'branch'|'tag', name: string }, branches: string[], version?: string,
     *   components?: string[], deployTo?: { targetId: string, components?: string[] }, triggeredBy?: string }} args
     * @returns {Promise<{ release: object, deploymentId: string }>}
     */
    async compose({ projectId, base, branches, version, components, deployTo, triggeredBy }) {
      const project = getProject(projectId);
      validateComposeInput({ base, branches, version });
      const target = requireNonProdTarget(project, deployTo);
      const repo = await requireRepo(project);

      const startedAt = now();
      const composeBranch = composeBranchName(branches, startedAt);
      const composition = {
        baseType: base.type,
        baseRef: base.name,
        baseSha: '',
        branches: branches.map((name) => ({ name, sha: '' })),
        composeBranch,
        headSha: null,
      };
      const { prepare, afterBuild } = createComposition({ repo, base, branches, composeBranch, composition });

      const result = await releaseService.createRelease({
        projectId: project.id,
        version: version || previewVersion(startedAt),
        ref: composeBranch,
        refType: 'branch',
        components,
        deployTo: target,
        triggeredBy,
        composition,
        prepare,
        afterBuild,
      });
      auditLogger.log(triggeredBy, 'RELEASE_COMPOSED', `Release ${result.release.version} composed for project: ${project.name}`, {
        projectId: project.id,
        releaseId: result.release.id,
        version: result.release.version,
        deploymentId: result.deploymentId,
        base: { type: base.type, name: base.name },
        branches: [...branches],
        composeBranch,
        ...(target ? { targetId: target.targetId } : {}),
      });
      return result;
    },

    /**
     * @param {{ projectId: string, name: string, from: { type: 'branch'|'commit', name: string }, message?: string, triggeredBy?: string }} args
     * @returns {Promise<{ tag: object }>}
     */
    async createTag({ projectId, name, from, message, triggeredBy }) {
      const project = getProject(projectId);
      if (typeof name !== 'string' || !VERSION_PATTERN.test(name) || !isRefName(name)) {
        throw new ValidationError('Invalid tag name: it must be a valid git tag and a release version (letters, digits, ".", "_", "-").');
      }
      if (!isPlainObject(from) || !TAG_FROM_TYPES.includes(from.type)) {
        throw new ValidationError("Invalid from: { type: 'branch'|'commit', name }.");
      }
      if (from.type === 'branch' ? !isRefName(from.name) : !(typeof from.name === 'string' && COMMIT_PATTERN.test(from.name))) {
        throw new ValidationError(from.type === 'branch' ? 'Invalid branch name.' : 'Invalid commit: 7-40 hexadecimal characters.');
      }
      if (message !== undefined && message !== null && (typeof message !== 'string' || message.length > MAX_TAG_MESSAGE_LENGTH)) {
        throw new ValidationError(`message must be a string of at most ${MAX_TAG_MESSAGE_LENGTH} characters.`);
      }
      const repo = await requireRepo(project);
      const tag = await withClient(repo, async (client) => {
        if (await client.getTag(name)) throw new ConflictError(`Tag ${name} already exists in ${repo.repoName}.`);
        let hash;
        if (from.type === 'branch') {
          const ref = await client.getBranch(from.name);
          if (!ref) throw new ValidationError(`Branch '${from.name}' was not found in ${repo.repoName}.`);
          hash = ref.sha;
        } else {
          hash = await client.getCommit(from.name);
          if (!hash) throw new ValidationError(`Commit ${from.name} was not found in ${repo.repoName}.`);
        }
        try {
          return await client.createTag({ name, hash, message: message || undefined });
        } catch (err) {
          // Lost a race with someone else tagging the same name.
          if (err.status === 400 && /already exists/i.test(err.providerMessage || err.message)) {
            throw new ConflictError(`Tag ${name} already exists in ${repo.repoName}.`);
          }
          throw err;
        }
      });
      auditLogger.log(triggeredBy, 'RELEASE_TAG_CREATED', `Tag ${name} created for project: ${project.name}`, {
        projectId: project.id,
        tag: name,
        sha: tag.sha,
        from: { type: from.type, name: from.name },
      });
      return { tag };
    },
  };
}

module.exports = {
  createComposeService,
  composeBranchName,
  previewVersion,
  isRefName,
  COMPOSE_PREFIX,
  MAX_BRANCHES,
};
