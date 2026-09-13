'use strict';

/**
 * Backend side of GET /api/artifacts/:artifactId/download (contract 1.3):
 * token check + opening the source stream. The HTTP route only pipes.
 *
 * The agent never sees the repository token: it presents its per-deploy
 * download token here. Locally uploaded releases stream from the IDP artifact
 * store; legacy imports still proxy Bitbucket/GitHub without exposing the
 * repository token.
 */

const {
  normalizeArtifactDeployConfig,
  findMissingSourceFields,
  resolveSourceCredentials,
} = require('./contracts');

function defaultCreateSourceClient(source, credentials) {
  const { createArtifactSourceClient } = require('./artifactSourceClient');
  return createArtifactSourceClient(source, credentials);
}

/**
 * @param {object} deps
 * @param {object} deps.repository - artifactDeployRepository.
 * @param {object} deps.tokens - download token service.
 * @param {(id: string) => object} deps.getProject
 * @param {(project: object) => Promise<object>} deps.resolveSecrets
 * @param {object} [deps.localStore]
 * @param {Function} [deps.createSourceClient]
 */
function createArtifactDownloadService({ repository, tokens, getProject, resolveSecrets, localStore = null, createSourceClient = defaultCreateSourceClient }) {
  return {
    /**
     * Consumes one use of `token` for `artifactId`.
     * @returns {{ artifact: object, release: object, binding: object }|null} null → 401, no detail.
     */
    authorize({ artifactId, token, agentId }) {
      const binding = tokens.consume(token, artifactId, { agentId });
      if (!binding) return null;
      const artifact = repository.findArtifact(artifactId);
      if (!artifact) return null;
      const release = repository.findRelease(artifact.releaseId);
      if (!release || release.status !== 'ready') return null;
      return { artifact, release, binding };
    },

    /**
     * Opens the artifact stream at the source.
     * @returns {Promise<{ stream: import('node:stream').Readable, contentLength: number|null }>}
     */
    async open({ artifact, release }, { signal } = {}) {
      if (release.sourcePlatform === 'local') {
        if (!localStore) throw new Error('Local artifact storage is unavailable.');
        return localStore.open({ artifact, release }, { signal });
      }
      const project = getProject(release.projectId);
      const runtimeProject = await resolveSecrets(project);
      const config = normalizeArtifactDeployConfig(runtimeProject.config && runtimeProject.config.artifactDeploy);
      const credentials = resolveSourceCredentials(runtimeProject.config, config);
      const missing = findMissingSourceFields(config, credentials);
      if (missing.length > 0) throw new Error(`Artifact source configuration is incomplete — missing: ${missing.join(', ')}.`);
      if (release.sourcePlatform && release.sourcePlatform !== config.source.platform) {
        throw new Error('The project artifact source changed platform since this release was created; re-import it.');
      }
      if (release.sourceIdentity) {
        const currentIdentity = {
          platform: config.source.platform,
          owner: config.source.owner,
          repo: config.source.repo,
          baseUrl: config.source.baseUrl,
        };
        if (JSON.stringify(release.sourceIdentity) !== JSON.stringify(currentIdentity)) {
          throw new Error('The project artifact source changed since this release was created; re-import it.');
        }
      }
      const client = createSourceClient(config.source, { token: credentials.token, username: credentials.username });
      try {
        return await client.openArtifactStream(artifact.sourceRef, { signal });
      } finally {
        // The stream is already open; the storage hop never needs the token.
        if (typeof client.releaseCredentials === 'function') client.releaseCredentials();
      }
    },
  };
}

module.exports = { createArtifactDownloadService };
