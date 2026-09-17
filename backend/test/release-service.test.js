/**
 * Releases (core/artifacts/releaseService.js): create → build (fake adapter,
 * DeploymentManager session kind 'build') → manifest ingest → ready; build and
 * manifest failures; conflicts; import / re-import; delete; and the
 * server-side-only version injection into CiPipelineAdapter (`extraVariables`).
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/store/db');
const { createArtifactDeployRepository } = require('../src/store/artifactDeployRepository');
const deploymentManager = require('../src/services/DeploymentManager');
const deploymentRepository = require('../src/store/deploymentRepository');
const { createReleaseService, defaultCreateBuildAdapter } = require('../src/core/artifacts/releaseService');
const CiPipelineAdapter = require('../src/adapters/CiPipelineAdapter');
const JenkinsAdapter = require('../src/adapters/JenkinsAdapter');
const { NotFoundError, ValidationError, ConflictError } = require('../src/core/errors');

const SHA = 'c'.repeat(64);

function makeManifest(version, overrides = {}) {
  return {
    schema: 1,
    project: 'jetsrm',
    version,
    commit: 'abc123',
    artifacts: [
      { component: 'backend', os: 'win-x64', file: `jetsrm-backend-${version}-win-x64.tar.gz`, sha256: SHA, size: 10 },
      { component: 'frontend', os: 'any', file: `jetsrm-frontend-${version}.tar.gz`, sha256: SHA, size: 20 },
    ],
    ...overrides,
  };
}

function makeProject(provider = 'pipeline') {
  return {
    id: 'p1',
    name: 'JetSRM',
    environment: 'Dev',
    config: {
      apiToken: 'CI-TOKEN',
      username: '',
      url: 'https://jenkins.example',
      jobName: 'jetsrm-release',
      ciConfig: { platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm', ref: 'master', pipeline: 'release' },
      artifactDeploy: {
        source: { platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm', token: 'SRC-TOKEN' },
        build: { provider },
        versionVariable: 'RELEASE_VERSION',
        components: [
          { name: 'backend', subdir: 'backend', runtime: { type: 'nssm', serviceName: 'jetsrm-backend' } },
          { name: 'frontend', subdir: 'frontend', runtime: { type: 'iis-static' }, writeRuntimeConfig: true },
        ],
      },
    },
  };
}

class FakeBuildAdapter {
  constructor({ fail = false, gate = null } = {}) {
    this.fail = fail;
    this.gate = gate;
    this.calls = [];
    this.released = false;
    this.config = { apiToken: 'CI-TOKEN' };
  }
  onLog(cb) { this.cb = cb; }
  async connect() { this.calls.push('connect'); this.cb('[CI] connected'); }
  async trigger(params) { this.calls.push(['trigger', params]); }
  async streamLogs(cb) {
    cb('[CI] building...');
    if (this.gate) await this.gate;
    if (this.fail) throw new Error('Pipeline #7 finished with status: FAILED');
  }
  async abort() { this.aborted = true; }
  releaseCredentials() { this.released = true; }
}

function fakeSourceClient(manifestFor) {
  const client = {
    released: false,
    asked: [],
    async fetchManifest({ artifactName, version }) {
      client.asked.push({ artifactName, version });
      return { manifest: manifestFor(version), context: {} };
    },
    async resolveArtifacts(artifacts) {
      return artifacts.map((artifact) => ({ ...artifact, sourceRef: artifact.file }));
    },
    releaseCredentials() { client.released = true; },
  };
  return client;
}

function setup({
  provider = 'pipeline',
  adapter = new FakeBuildAdapter(),
  manifestFor = (v) => makeManifest(v),
  isReleaseBusy = () => false,
  deleteLocalRelease = null,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-release-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  const repository = createArtifactDeployRepository(db);
  const project = makeProject(provider);
  const audit = [];
  const buildArgs = [];
  const sourceArgs = [];
  const client = fakeSourceClient(manifestFor);
  const service = createReleaseService({
    repository,
    deploymentManager,
    auditLogger: { log: (user, action, description, metadata) => audit.push({ user, action, metadata }) },
    getProject: (id) => {
      if (id !== project.id) throw new NotFoundError('Project not found');
      return project;
    },
    resolveSecrets: async (p) => p,
    createBuildAdapter: (args) => {
      buildArgs.push(args);
      return { adapter, triggerParams: { [args.versionVariable]: args.version } };
    },
    createSourceClient: (source, credentials) => {
      sourceArgs.push({ source, credentials });
      return client;
    },
    isReleaseBusy,
    deleteLocalRelease,
    timing: { manifestRetryMs: 1 },
  });
  return {
    service, repository, project, audit, buildArgs, sourceArgs, client, adapter,
    cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('createRelease: build succeeds → manifest ingested → release ready', async () => {
  const env = setup();
  try {
    const { release, deploymentId } = await env.service.createRelease({ projectId: 'p1', version: '2.5.0', triggeredBy: 'alice' });
    assert.equal(release.status, 'building');
    assert.equal(release.buildDeploymentId, deploymentId);
    await env.service.waitForBuild(release.id);

    const ready = env.service.getRelease(release.id);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.commitSha, 'abc123');
    assert.equal(ready.sourcePlatform, 'bitbucket');
    assert.deepEqual(ready.sourceIdentity, {
      platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm', baseUrl: 'https://api.bitbucket.org/2.0',
    });
    assert.equal(ready.manifest.project, 'jetsrm');
    assert.deepEqual(ready.artifacts.map((a) => `${a.component}/${a.os}/${a.sourceRef}`), [
      'backend/win-x64/jetsrm-backend-2.5.0-win-x64.tar.gz',
      'frontend/any/jetsrm-frontend-2.5.0.tar.gz',
    ]);

    // The version reaches the build server-side, under the configured variable
    // name, alongside the merged build parameters (none configured here).
    assert.deepEqual(env.buildArgs, [{
      provider: 'pipeline', config: env.project.config, version: '2.5.0', versionVariable: 'RELEASE_VERSION', ref: null,
      parameters: { RELEASE_VERSION: '2.5.0' },
    }]);
    assert.deepEqual(env.adapter.calls, ['connect', ['trigger', { RELEASE_VERSION: '2.5.0' }]]);
    assert.deepEqual(env.client.asked, [{ artifactName: 'jetsrm', version: '2.5.0' }]);
    assert.equal(env.sourceArgs[0].credentials.token, 'SRC-TOKEN');
    assert.equal(env.adapter.released, true);
    assert.equal(env.client.released, true);

    const session = deploymentManager.getSession(deploymentId);
    assert.equal(session.status, 'succeeded');
    assert.equal(session.kind, 'build');
    assert.equal(session.releaseId, release.id);
    assert.ok(session.logs.some((line) => line.includes('[CI] building...')));
    assert.ok(session.logs.some((line) => line.includes('Release 2.5.0 is ready')));
    const persisted = deploymentRepository.findById(deploymentId);
    assert.equal(persisted.kind, 'build');
    assert.equal(persisted.releaseId, release.id);

    assert.deepEqual(env.audit.map((e) => e.action), ['RELEASE_CREATED', 'RELEASE_BUILD_SUCCEEDED']);
    assert.ok(!JSON.stringify(env.audit).includes('SRC-TOKEN'));
    assert.ok(!JSON.stringify(env.audit).includes('CI-TOKEN'));
  } finally {
    env.cleanup();
  }
});

test('createRelease: a failed build marks the release failed', async () => {
  const env = setup({ adapter: new FakeBuildAdapter({ fail: true }) });
  try {
    const { release, deploymentId } = await env.service.createRelease({ projectId: 'p1', version: '2.5.0' });
    await env.service.waitForBuild(release.id);
    const failed = env.service.getRelease(release.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /FAILED/);
    assert.equal(failed.artifacts.length, 0);
    assert.equal(deploymentManager.getSession(deploymentId).status, 'failed');
    assert.equal(env.client.asked.length, 0, 'no manifest read after a failed build');
    assert.equal(env.audit.at(-1).action, 'RELEASE_BUILD_FAILED');
    assert.equal(env.adapter.released, true);
  } finally {
    env.cleanup();
  }
});

test('createRelease accepts CI-finalized local artifacts and skips external import', async () => {
  let finishBuild;
  const gate = new Promise((resolve) => { finishBuild = resolve; });
  const env = setup({ adapter: new FakeBuildAdapter({ gate }) });
  try {
    const { release } = await env.service.createRelease({ projectId: 'p1', version: '2.5.0' });
    env.repository.replaceArtifacts(release.id, makeManifest('2.5.0').artifacts.map((artifact) => ({
      ...artifact, sourceRef: artifact.file,
    })));
    env.repository.updateRelease(release.id, {
      status: 'ready',
      sourcePlatform: 'local',
      sourceIdentity: { storage: 'local', projectId: 'p1', version: '2.5.0' },
      manifest: makeManifest('2.5.0'),
    });
    finishBuild();
    await env.service.waitForBuild(release.id);
    assert.equal(env.service.getRelease(release.id).status, 'ready');
    assert.equal(env.client.asked.length, 0);
    assert.ok(deploymentManager.getSession(release.buildDeploymentId).logs.some((line) => line.includes('already uploaded')));
  } finally {
    finishBuild();
    env.cleanup();
  }
});

test('a polling failure cannot downgrade an immutable CI-finalized local release', async () => {
  let finishBuild;
  const gate = new Promise((resolve) => { finishBuild = resolve; });
  const env = setup({ adapter: new FakeBuildAdapter({ gate, fail: true }) });
  try {
    const { release, deploymentId } = await env.service.createRelease({ projectId: 'p1', version: '2.5.0' });
    env.repository.replaceArtifacts(release.id, makeManifest('2.5.0').artifacts.map((artifact) => ({
      ...artifact, sourceRef: artifact.file,
    })));
    env.repository.updateRelease(release.id, {
      status: 'ready',
      sourcePlatform: 'local',
      sourceIdentity: { storage: 'local', projectId: 'p1', version: '2.5.0' },
      manifest: makeManifest('2.5.0'),
    });
    finishBuild();
    await env.service.waitForBuild(release.id);
    assert.equal(env.service.getRelease(release.id).status, 'ready');
    assert.equal(deploymentManager.getSession(deploymentId).status, 'succeeded');
    assert.equal(env.audit.at(-1).action, 'RELEASE_BUILD_SUCCEEDED');
    assert.ok(deploymentManager.getSession(deploymentId).logs.some((line) => line.includes('polling failed')));
  } finally {
    finishBuild();
    env.cleanup();
  }
});

test('createRelease: an invalid manifest fails the release', async () => {
  const env = setup({ manifestFor: () => makeManifest('9.9.9') });
  try {
    const { release } = await env.service.createRelease({ projectId: 'p1', version: '2.5.0' });
    await env.service.waitForBuild(release.id);
    const failed = env.service.getRelease(release.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /Invalid manifest jetsrm-2\.5\.0-manifest\.json: version is '9\.9\.9'/);
  } finally {
    env.cleanup();
  }
});

test('createRelease: conflicts while building / once ready; a failed release can be retried', async () => {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const env = setup({ adapter: new FakeBuildAdapter({ gate }) });
  try {
    const { release } = await env.service.createRelease({ projectId: 'p1', version: '2.5.0' });
    await assert.rejects(env.service.createRelease({ projectId: 'p1', version: '2.5.0' }), ConflictError);
    await assert.rejects(env.service.importRelease({ projectId: 'p1', version: '2.5.0' }), ConflictError);
    assert.throws(() => env.service.deleteRelease(release.id, 'admin'), ConflictError);
    open();
    await env.service.waitForBuild(release.id);
    assert.equal(env.service.getRelease(release.id).status, 'ready');
    await assert.rejects(env.service.createRelease({ projectId: 'p1', version: '2.5.0' }), ConflictError);

    env.repository.updateRelease(release.id, { status: 'failed', error: 'boom' });
    const retry = await env.service.createRelease({ projectId: 'p1', version: '2.5.0' });
    assert.equal(retry.release.id, release.id);
    assert.equal(retry.release.status, 'building');
    await env.service.waitForBuild(release.id);
    assert.equal(env.service.getRelease(release.id).status, 'ready');
  } finally {
    open();
    env.cleanup();
  }
});

test('createRelease: input validation', async () => {
  const env = setup();
  try {
    await assert.rejects(env.service.createRelease({ projectId: 'nope', version: '2.5.0' }), NotFoundError);
    for (const version of ['', '../2', '2 5', '-2.5', 'x'.repeat(65)]) {
      await assert.rejects(env.service.createRelease({ projectId: 'p1', version }), ValidationError, version);
    }
    for (const ref of ['a..b', '-x', 'a b', '/abs']) {
      await assert.rejects(env.service.createRelease({ projectId: 'p1', version: '2.5.0', ref }), ValidationError, ref);
    }
    delete env.project.config.artifactDeploy;
    await assert.rejects(env.service.createRelease({ projectId: 'p1', version: '2.5.0' }), /not configured/);
  } finally {
    env.cleanup();
  }
});

test("build provider 'none': create is refused, import reads the manifest; re-import keeps artifact ids", async () => {
  const env = setup({ provider: 'none' });
  try {
    await assert.rejects(env.service.createRelease({ projectId: 'p1', version: '2.5.0' }), /import the release/);
    const imported = await env.service.importRelease({ projectId: 'p1', version: '2.5.0', triggeredBy: 'alice' });
    assert.equal(imported.status, 'ready');
    assert.equal(imported.artifacts.length, 2);
    assert.equal(env.audit.at(-1).action, 'RELEASE_IMPORTED');

    const again = await env.service.importRelease({ projectId: 'p1', version: '2.5.0' });
    assert.deepEqual(again.artifacts.map((a) => a.id), imported.artifacts.map((a) => a.id));
    assert.deepEqual(env.service.listReleases('p1').map((r) => r.version), ['2.5.0']);
  } finally {
    env.cleanup();
  }
});

test('importRelease: a source failure marks the release failed and is audited', async () => {
  const env = setup({ provider: 'none', manifestFor: () => { throw Object.assign(new Error('manifest missing'), { notFound: true }); } });
  try {
    await assert.rejects(env.service.importRelease({ projectId: 'p1', version: '3.0.0' }), /manifest missing/);
    assert.equal(env.service.listReleases('p1')[0].status, 'failed');
    assert.equal(env.audit.at(-1).action, 'RELEASE_IMPORT_FAILED');
  } finally {
    env.cleanup();
  }
});

test('deleteRelease removes the DB rows only', async () => {
  const env = setup({ provider: 'none' });
  try {
    const imported = await env.service.importRelease({ projectId: 'p1', version: '2.5.0' });
    env.service.deleteRelease(imported.id, 'admin');
    assert.throws(() => env.service.getRelease(imported.id), NotFoundError);
    assert.deepEqual(env.repository.listArtifacts(imported.id), []);
    assert.equal(env.audit.at(-1).action, 'RELEASE_DELETED');
    assert.throws(() => env.service.deleteRelease(imported.id, 'admin'), NotFoundError);
  } finally {
    env.cleanup();
  }
});

test('startup recovery marks interrupted building releases failed so they can be retried', async () => {
  const env = setup({ provider: 'none' });
  try {
    const release = env.repository.createRelease({ projectId: 'p1', version: '4.0.0', status: 'building' });
    assert.equal(env.repository.recoverInterruptedReleases(), 1);
    const recovered = env.repository.findRelease(release.id);
    assert.equal(recovered.status, 'failed');
    assert.match(recovered.error, /server restart/);

    const imported = await env.service.importRelease({ projectId: 'p1', version: '4.0.0' });
    assert.equal(imported.id, release.id);
    assert.equal(imported.status, 'ready');
  } finally {
    env.cleanup();
  }
});

test('a release used by an active deploy cannot be re-imported or deleted', async () => {
  let busyReleaseId = null;
  const env = setup({ provider: 'none', isReleaseBusy: (id) => id === busyReleaseId });
  try {
    const release = await env.service.importRelease({ projectId: 'p1', version: '2.5.0' });
    busyReleaseId = release.id;
    await assert.rejects(
      env.service.importRelease({ projectId: 'p1', version: '2.5.0' }),
      (err) => err instanceof ConflictError && /being deployed/.test(err.message)
    );
    assert.throws(
      () => env.service.deleteRelease(release.id, 'admin'),
      (err) => err instanceof ConflictError && /being deployed/.test(err.message)
    );
    assert.equal(env.service.getRelease(release.id).status, 'ready');
  } finally {
    env.cleanup();
  }
});

test('an installed release cannot be deleted; deleting a local release removes its binary first', () => {
  const removed = [];
  const env = setup({
    provider: 'none',
    deleteLocalRelease: (projectId, version) => removed.push({ projectId, version }),
  });
  try {
    const installed = env.repository.createRelease({
      projectId: 'p1', version: '1.0.0', status: 'ready', sourcePlatform: 'local',
    });
    env.repository.createTarget({
      projectId: 'p1', name: 'customer-a', agentId: 'WIN-01', os: 'windows',
      components: [], runtimeConfig: {}, currentReleaseId: installed.id,
    });
    assert.throws(
      () => env.service.deleteRelease(installed.id, 'admin'),
      (err) => err instanceof ConflictError && /currently installed/.test(err.message)
    );
    assert.deepEqual(removed, []);

    const unused = env.repository.createRelease({
      projectId: 'p1', version: '2.0.0', status: 'ready', sourcePlatform: 'local',
    });
    env.service.deleteRelease(unused.id, 'admin');
    assert.deepEqual(removed, [{ projectId: 'p1', version: '2.0.0' }]);
    assert.equal(env.repository.findRelease(unused.id), null);
  } finally {
    env.cleanup();
  }
});

// ------------------------------------------------ server-side version injection

function bitbucketTriggerFetch(bodies) {
  return async (url, init = {}) => {
    if (init.method === 'POST' && url.endsWith('/pipelines/')) {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ uuid: '{run-1}', build_number: 7 }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  };
}

const CI_CONFIG = {
  platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm', ref: 'master', pipeline: 'release',
  variables: { CUSTOMER: 'temsa', VERSION: 'stale' },
};

test('CiPipelineAdapter: extraVariables are injected server-side; trigger params stay ignored', async () => {
  const bodies = [];
  const adapter = new CiPipelineAdapter({
    ciConfig: CI_CONFIG, apiToken: 'CI-TOKEN', extraVariables: { VERSION: '2.5.0' }, fetchImpl: bitbucketTriggerFetch(bodies),
  });
  const lines = [];
  adapter.onLog((line) => lines.push(line));
  await adapter.trigger({ variables: { EVIL: 'x' }, VERSION: '6.6.6', environment: 'Prod' });
  const sent = Object.fromEntries(bodies[0].variables.map((v) => [v.key, v.value]));
  assert.deepEqual(sent, { CUSTOMER: 'temsa', VERSION: '2.5.0' });
  assert.ok(lines.some((line) => line.includes('with variables: CUSTOMER, VERSION')));
  assert.ok(!lines.join('\n').includes('2.5.0 '), 'variable values are never logged');

  // Without extraVariables (the regular deploy path) nothing changes.
  const plainBodies = [];
  const plain = new CiPipelineAdapter({ ciConfig: CI_CONFIG, apiToken: 'CI-TOKEN', fetchImpl: bitbucketTriggerFetch(plainBodies) });
  plain.onLog(() => {});
  await plain.trigger({ VERSION: '6.6.6' });
  assert.deepEqual(Object.fromEntries(plainBodies[0].variables.map((v) => [v.key, v.value])), { CUSTOMER: 'temsa', VERSION: 'stale' });
});

test('defaultCreateBuildAdapter: pipeline gets extraVariables + ref, jenkins gets build parameters', () => {
  const config = makeProject().config;
  const pipeline = defaultCreateBuildAdapter({ provider: 'pipeline', config, version: '2.5.0', versionVariable: 'VERSION', ref: 'release/2.5' });
  assert.ok(pipeline.adapter instanceof CiPipelineAdapter);
  assert.deepEqual(pipeline.adapter._extraVariables, { VERSION: '2.5.0' });
  assert.equal(pipeline.adapter.ciConfig.ref, 'release/2.5');
  assert.deepEqual(pipeline.triggerParams, {});
  assert.equal(config.ciConfig.ref, 'master', 'the project config is not mutated');

  const jenkins = defaultCreateBuildAdapter({ provider: 'jenkins', config, version: '2.5.0', versionVariable: 'VERSION', ref: null });
  assert.ok(jenkins.adapter instanceof JenkinsAdapter);
  assert.deepEqual(jenkins.triggerParams, { VERSION: '2.5.0' });

  assert.throws(() => defaultCreateBuildAdapter({ provider: 'jenkins', config, version: '2.5.0', versionVariable: 'VERSION', ref: 'x' }), ValidationError);
  assert.throws(() => defaultCreateBuildAdapter({ provider: 'none', config, version: '2.5.0', versionVariable: 'VERSION' }), ValidationError);
  assert.throws(
    () => defaultCreateBuildAdapter({ provider: 'pipeline', config: { ciConfig: {} }, version: '2.5.0', versionVariable: 'VERSION' }),
    (err) => err instanceof ValidationError && /incomplete/.test(err.message)
  );
});
