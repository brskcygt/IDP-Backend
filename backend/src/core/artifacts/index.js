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
const { createTargetService } = require('./targetService');
const { createArtifactDeployService } = require('./artifactDeployService');
const { createArtifactDownloadService } = require('./artifactDownloadService');

function getGateway() {
  try {
    return new AgentGatewayClient();
  } catch (err) {
    throw new UpstreamError(err.message);
  }
}

const getProject = (id) => projectService.getProject(id);
const resolveSecrets = (project) => resolveProjectSecrets(project, secretStore);
const tokens = createDownloadTokenService({ repository });

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
  isReleaseBusy: (releaseId) => artifactDeployService ? artifactDeployService.isReleaseBusy(releaseId) : false,
});
artifactDeployService = createArtifactDeployService({
  repository,
  deploymentManager,
  auditLogger,
  getProject,
  tokens,
  getGateway,
  refreshTargetStatus: (targetId) => targetService.refreshStatus(targetId),
});
targetService = createTargetService({
  repository,
  auditLogger,
  getProject,
  getGateway,
  isTargetBusy: (targetId) => artifactDeployService.isTargetBusy(targetId),
});

const downloadService = createArtifactDownloadService({ repository, tokens, getProject, resolveSecrets });

module.exports = {
  contracts,
  repository,
  tokens,
  releaseService,
  targetService,
  artifactDeployService,
  downloadService,
};
