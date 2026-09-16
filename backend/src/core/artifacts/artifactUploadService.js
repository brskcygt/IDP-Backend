'use strict';

/** CI upload/finalize orchestration and local-release retention. */
const { validateManifest, normalizeArtifactDeployConfig, VERSION_PATTERN } = require('./contracts');
const { ValidationError, ConflictError, NotFoundError } = require('../errors');
const { buildConfigSchema } = require('./envExample');

function createArtifactUploadService({
  repository,
  store,
  auditLogger,
  getProject,
  isReleaseBusy = () => false,
  retention = 3,
}) {
  const activeFinalizations = new Set();
  const activeUploads = new Set();

  function requireVersion(version) {
    if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) throw new ValidationError('Invalid artifact version.');
  }

  function requireProject(projectId) {
    return getProject(projectId);
  }

  function artifactName(project) {
    const config = normalizeArtifactDeployConfig(project.config && project.config.artifactDeploy);
    if (!config || !config.artifactName) {
      throw new ValidationError('Artifact deploy and artifactName must be configured for this project.');
    }
    return config.artifactName;
  }

  function protectedRelease(release) {
    return repository.isReleaseCurrent(release.id) || isReleaseBusy(release.id);
  }

  function prune(projectId) {
    const releases = repository.listReadyLocalReleases(projectId);
    const keep = new Set(releases.slice(0, retention).map((release) => release.id));
    const pruned = [];
    for (const release of releases.slice(retention)) {
      if (keep.has(release.id) || protectedRelease(release)) continue;
      // Remove the row first. A concurrent deploy can no longer claim it;
      // failure to delete the now-orphaned directory is reported but cannot
      // make the release deployable without its metadata.
      repository.deleteRelease(release.id);
      try {
        store.removeReleaseSync(release.projectId, release.version);
      } catch (err) {
        console.error(`[artifacts] Failed to remove pruned release ${release.id}: ${err.message}`);
      }
      pruned.push(release);
      auditLogger.log(null, 'RELEASE_PRUNED', `Pruned local release ${release.version}`, {
        projectId: release.projectId,
        releaseId: release.id,
        version: release.version,
        retention,
      });
    }
    return pruned;
  }

  return {
    isFinalizing(projectId, version) {
      return activeFinalizations.has(`${projectId}:${version}`);
    },

    async uploadArtifact({ projectId, version, fileName, stream, sha256, contentLength }) {
      requireProject(projectId);
      requireVersion(version);
      const key = `${projectId}:${version}`;
      if (activeFinalizations.has(key)) throw new ConflictError(`Release ${version} is being finalized.`);
      const uploadKey = `${key}:${fileName}`;
      if (activeUploads.has(uploadKey)) throw new ConflictError(`Artifact ${fileName} is already being uploaded.`);
      const existing = repository.findReleaseByVersion(projectId, version);
      if (existing && existing.status === 'ready') throw new ConflictError(`Release ${version} is already immutable and ready.`);
      if (existing && protectedRelease(existing)) throw new ConflictError(`Release ${version} is active on a target and cannot be replaced.`);
      activeUploads.add(uploadKey);
      try {
        const result = await store.upload({ projectId, version, fileName, stream, expectedSha256: sha256, contentLength });
        auditLogger.log(null, 'ARTIFACT_UPLOAD_STAGED', `Staged artifact upload: ${fileName}`, {
          projectId, version, fileName, size: result.size, sha256: result.sha256, idempotent: result.idempotent,
        });
        return result;
      } finally {
        activeUploads.delete(uploadKey);
      }
    },

    async finalizeRelease({ projectId, version, manifest }) {
      const project = requireProject(projectId);
      requireVersion(version);
      const check = validateManifest(manifest, { project: artifactName(project), version });
      if (!check.valid) throw new ValidationError(`Invalid upload manifest: ${check.errors.join(' ')}`);

      const key = `${projectId}:${version}`;
      if (activeFinalizations.has(key)) throw new ConflictError(`Release ${version} is already being finalized.`);
      if ([...activeUploads].some((uploadKey) => uploadKey.startsWith(`${key}:`))) {
        throw new ConflictError(`Release ${version} still has an active artifact upload.`);
      }
      activeFinalizations.add(key);
      let release = repository.findReleaseByVersion(projectId, version);
      try {
        if (release && release.status === 'ready') {
          if (release.sourcePlatform === 'local' && JSON.stringify(release.manifest) === JSON.stringify(check.manifest)) {
            try {
              await store.finalize({ projectId, version, manifest: check.manifest });
            } catch (err) {
              if (err instanceof ValidationError || err instanceof NotFoundError || err instanceof ConflictError) {
                repository.updateRelease(release.id, {
                  status: 'failed',
                  error: `Published artifact integrity check failed: ${String(err.message || err).slice(0, 1900)}`,
                });
              }
              throw err;
            }
            return { ...release, artifacts: repository.listArtifacts(release.id), idempotent: true, pruned: [] };
          }
          throw new ConflictError(`Release ${version} is already immutable and ready.`);
        }
        if (release && protectedRelease(release)) throw new ConflictError(`Release ${version} is active on a target and cannot be replaced.`);
        if (!release) {
          release = repository.createRelease({ projectId, version, status: 'building', createdBy: 'ci-upload' });
        } else if (release.status !== 'building') {
          release = repository.updateRelease(release.id, { status: 'building', error: null, createdBy: release.createdBy || 'ci-upload' });
        }

        await store.finalize({ projectId, version, manifest: check.manifest });
        const artifacts = check.manifest.artifacts.map((artifact) => ({ ...artifact, sourceRef: artifact.file }));
        repository.replaceArtifacts(release.id, artifacts);
        repository.markReleaseFinalized(release.id, projectId);
        const configSchema = await buildConfigSchema(check.manifest.artifacts, async (artifact) => (
          (await store.open({ artifact: { fileName: artifact.file }, release: { projectId, version } })).stream
        ));
        release = repository.updateRelease(release.id, {
          status: 'ready',
          manifest: check.manifest,
          configSchema,
          commitSha: check.manifest.commit,
          sourcePlatform: 'local',
          sourceIdentity: { storage: 'local', projectId, version },
          error: null,
        });
        auditLogger.log(null, 'RELEASE_UPLOADED', `Local release ${version} finalized for project: ${project.name}`, {
          projectId, releaseId: release.id, version, artifacts: artifacts.length,
        });
        const pruned = prune(projectId);
        return { ...release, artifacts: repository.listArtifacts(release.id), idempotent: false, pruned: pruned.map((item) => item.version) };
      } catch (err) {
        if (release && repository.findRelease(release.id)?.status === 'building') {
          repository.updateRelease(release.id, { status: 'failed', error: String(err.message || err).slice(0, 2000) });
        }
        auditLogger.log(null, 'RELEASE_UPLOAD_FAILED', `Local release ${version} finalization failed`, {
          projectId, releaseId: release?.id || null, version, error: err.message,
        }, { outcome: 'failure' });
        throw err;
      } finally {
        activeFinalizations.delete(key);
      }
    },

    prune,
  };
}

module.exports = { createArtifactUploadService };
