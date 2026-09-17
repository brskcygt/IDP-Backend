'use strict';

/**
 * Artifact deploy — wired service instances (docs/ARTIFACT-DEPLOY.md).
 *
 * Every service is a factory in its own module (injectable for tests); this
 * file binds them to the real repository, DeploymentManager, audit logger,
 * project cache, secret store and agent gateway client. Deliberately NOT
 * re-exported from core/index.js: only the HTTP shell (server.js) loads it,
 * so the desktop IPC shell is unaffected (artifact deploy needs the public
 * backend — see the docs).
 */

const repository = require('../../store/artifactDeployRepository');
const deploymentManager = require('../../services/DeploymentManager');
const auditLogger = require('../../services/AuditLogger');
const AgentGatewayClient = require('../../services/agent/AgentGatewayClient');
const { resolveProjectSecrets } = require('../../secrets/projectSecrets');
const projectService = require('../projects/projectService');
const secretStore = require('../secrets/secretStoreInstance');
const { UpstreamError } = require('../errors');
const contracts = require('./contracts');
const { createDownloadTokenService } = require('./downloadTokens');
const { createReleaseService } = require('./releaseService');
const { settingsService } = require('../settings');
const { createTargetService } = require('./targetService');
const { createArtifactDeployService } = require('./artifactDeployService');
const { createArtifactDownloadService } = require('./artifactDownloadService');
const { createArtifactUploadService } = require('./artifactUploadService');
const { createLocalArtifactStore } = require('./localArtifactStore');
const { validateArtifactStorageEnv } = require('../../config');
const {
  persistTargetRuntimeConfig,
  resolveTargetSecrets,
  discardCreatedTargetSecrets,
  deleteReplacedTargetSecrets,
  deleteTargetSecrets,
  redactTargetRuntimeConfig,
} = require('./targetSecrets');

function getGateway() {
  try {
    return new AgentGatewayClient();
  } catch (err) {
    throw new UpstreamError(err.message);
  }
}

const getProject = (id) => projectService.getProject(id);
const resolveSecrets = (project) => resolveProjectSecrets(project, secretStore);
const targetSecretOptions = { requireEncryption: process.env.NODE_ENV === 'production' };
const tokens = createDownloadTokenService({ repository });
const storageConfig = validateArtifactStorageEnv(process.env);
if (storageConfig.errors.length > 0) throw new Error(storageConfig.errors.join(' '));
const localStore = createLocalArtifactStore({
  root: storageConfig.storageRoot,
  maxArtifactBytes: storageConfig.maxArtifactBytes,
});
const abandonedStaging = localStore.cleanupStagingSync();
if (abandonedStaging > 0) console.log(`Removed ${abandonedStaging} abandoned artifact staging directorie(s).`);

// A process restart cannot resume a CI adapter. Reconcile the release rows
// alongside DeploymentManager's interrupted-deployment recovery.
const recoveredReleases = repository.recoverInterruptedReleases();
if (recoveredReleases > 0) {
  console.log(`Recovered ${recoveredReleases} release(s) stuck in 'building' state from a previous run.`);
}

// These services reference each other (release mutation guard, target busy
// check and status refresh), so bind the dependencies lazily through closures.
let targetService = null;
let artifactDeployService = null;
const releaseService = createReleaseService({
  repository,
  deploymentManager,
  auditLogger,
  getProject,
  resolveSecrets,
  getGlobalBuildParameters: () => settingsService.readBuildParametersForBuild(),
  isReleaseBusy: (releaseId) => artifactDeployService ? artifactDeployService.isReleaseBusy(releaseId) : false,
  deleteLocalRelease: (projectId, version) => localStore.removeReleaseSync(projectId, version),
});
artifactDeployService = createArtifactDeployService({
  repository,
  deploymentManager,
  auditLogger,
  getProject,
  tokens,
  getGateway,
  refreshTargetStatus: (targetId) => targetService.refreshStatus(targetId),
  resolveTarget: (target) => resolveTargetSecrets(target, secretStore, targetSecretOptions),
});
targetService = createTargetService({
  repository,
  auditLogger,
  getProject,
  getGateway,
  isTargetBusy: (targetId) => artifactDeployService.isTargetBusy(targetId),
  targetSecrets: {
    persist: (targetId, runtimeConfig) => persistTargetRuntimeConfig(targetId, runtimeConfig, secretStore, {
      requireEncryption: process.env.NODE_ENV === 'production',
    }),
    resolve: (target) => resolveTargetSecrets(target, secretStore, targetSecretOptions),
    redact: (target) => ({ ...target, runtimeConfig: redactTargetRuntimeConfig(target.runtimeConfig) }),
    discardCreated: (refs) => discardCreatedTargetSecrets(refs, secretStore),
    deleteReplaced: (previous, next) => deleteReplacedTargetSecrets(previous, next, secretStore),
    deleteAll: (runtimeConfig) => deleteTargetSecrets(runtimeConfig, secretStore),
  },
});

const uploadService = createArtifactUploadService({
  repository,
  store: localStore,
  auditLogger,
  getProject,
  getGlobalBuildParameters: () => settingsService.readBuildParametersForBuild(),
  isReleaseBusy: (releaseId) => artifactDeployService ? artifactDeployService.isReleaseBusy(releaseId) : false,
});
const downloadService = createArtifactDownloadService({ repository, tokens, getProject, resolveSecrets, localStore });

module.exports = {
  contracts,
  repository,
  tokens,
  releaseService,
  targetService,
  artifactDeployService,
  uploadService,
  downloadService,
  localStore,
};
