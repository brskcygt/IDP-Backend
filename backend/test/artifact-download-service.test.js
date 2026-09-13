'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createArtifactDownloadService } = require('../src/core/artifacts/artifactDownloadService');

function makeService(project, onClient = () => {}) {
  return createArtifactDownloadService({
    repository: {},
    tokens: {},
    getProject: () => project,
    resolveSecrets: async (value) => value,
    createSourceClient: (source) => {
      onClient(source);
      return {
        openArtifactStream: async () => ({ stream: null, contentLength: 10 }),
        releaseCredentials() {},
      };
    },
  });
}

test('download opens only from the release source identity', async () => {
  const source = { platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm', token: 'TOKEN' };
  const project = { id: 'p1', config: { artifactDeploy: { source }, apiToken: 'CI' } };
  let opened = 0;
  const service = makeService(project, () => { opened += 1; });
  const release = {
    projectId: 'p1',
    sourcePlatform: 'bitbucket',
    sourceIdentity: {
      platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm', baseUrl: 'https://api.bitbucket.org/2.0',
    },
  };

  await service.open({ artifact: { sourceRef: 'backend.tar.gz' }, release });
  assert.equal(opened, 1);

  project.config.artifactDeploy.source.repo = 'other-repo';
  await assert.rejects(
    service.open({ artifact: { sourceRef: 'backend.tar.gz' }, release }),
    /artifact source changed/
  );
  assert.equal(opened, 1, 'a changed source is rejected before credentials are sent');
});
