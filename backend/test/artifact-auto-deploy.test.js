'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { test } = require('node:test');

const { openDatabase } = require('../src/store/db');
const { createArtifactDeployRepository } = require('../src/store/artifactDeployRepository');
const { createLocalArtifactStore } = require('../src/core/artifacts/localArtifactStore');
const { createArtifactUploadService } = require('../src/core/artifacts/artifactUploadService');
const { createAutoDeployService, AUTO_DEPLOY_USER } = require('../src/core/artifacts/autoDeployService');
const { validateManifest, validateTargetInput, targetAutoDeployErrors } = require('../src/core/artifacts/contracts');

const sha = (body) => crypto.createHash('sha256').update(body).digest('hex');
const nextTick = () => new Promise((resolve) => setImmediate(resolve));

function manifestFor(version, body, extra = {}) {
  return {
    schema: 1,
    project: 'mdp-srm',
    version,
    commit: 'abc123',
    ...extra,
    artifacts: [{ component: 'frontend', os: 'any', file: `mdp-srm-frontend-${version}.tar.gz`, sha256: sha(body), size: body.length }],
  };
}

function setup({ deployRelease = async () => ({ deploymentId: 'dep_1' }), environment = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-auto-deploy-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  const repository = createArtifactDeployRepository(db);
  const project = {
    id: 'p1',
    name: 'mdp-srm',
    environment,
    config: {
      artifactDeploy: {
        artifactName: 'mdp-srm',
        build: { provider: 'none' },
        components: [
          { name: 'frontend', subdir: 'frontend', runtime: { type: 'iis-static' } },
          { name: 'backend', subdir: 'backend', runtime: { type: 'none' } },
        ],
      },
    },
  };
  const audit = [];
  const auditLogger = { log: (user, action, description, metadata) => audit.push({ user, action, description, metadata }) };
  const getProject = () => project;
  const deploys = [];
  const autoDeploy = createAutoDeployService({
    repository,
    auditLogger,
    getProject,
    deployRelease: async (args) => { deploys.push(args); return deployRelease(args); },
  });
  const calls = [];
  const service = createArtifactUploadService({
    repository,
    store: createLocalArtifactStore({ root: path.join(dir, 'artifacts'), maxArtifactBytes: 1024 }),
    auditLogger,
    getProject,
    onCiReleaseReady: async (args) => { calls.push(args); return autoDeploy.onCiReleaseReady(args); },
  });
  const addTarget = (fields) => repository.createTarget({
    projectId: 'p1', os: 'windows', agentId: `agent-${fields.name}`, components: null, runtimeConfig: null, ...fields,
  });
  return {
    repository, service, audit, deploys, calls, addTarget, project,
    cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

async function upload(env, version, extra) {
  const body = Buffer.from(`artifact-${version}`);
  const manifest = manifestFor(version, body, extra);
  await env.service.uploadArtifact({
    projectId: 'p1', version, fileName: manifest.artifacts[0].file, stream: Readable.from(body),
    sha256: manifest.artifacts[0].sha256, contentLength: body.length,
  });
  const ready = await env.service.finalizeRelease({ projectId: 'p1', version, manifest });
  await nextTick();
  await nextTick();
  return ready;
}

test('manifest ref is optional, validated, and kept only when given', () => {
  const body = Buffer.from('x');
  const plain = validateManifest(manifestFor('1.0.0', body));
  assert.equal(plain.valid, true);
  assert.equal('ref' in plain.manifest, false);

  const withRef = validateManifest(manifestFor('1.0.0', body, { ref: 'test' }));
  assert.equal(withRef.manifest.ref, 'test');

  for (const ref of ['../etc', 'a..b', 'with space', 7]) {
    assert.equal(validateManifest(manifestFor('1.0.0', body, { ref })).valid, false, String(ref));
  }
});

test('target autoDeploy is a boolean and needs a branch on a non-production target', () => {
  assert.deepEqual(validateTargetInput({ autoDeploy: true }, { partial: true }).value, { autoDeploy: true });
  assert.equal(validateTargetInput({ autoDeploy: 'yes' }, { partial: true }).errors.length, 1);

  const project = { environment: null };
  assert.deepEqual(targetAutoDeployErrors({ autoDeploy: false, environment: 'Prod' }, project), []);
  assert.deepEqual(targetAutoDeployErrors({ autoDeploy: true, ref: 'test', environment: 'Dev', name: 'Test' }, project), []);
  assert.equal(targetAutoDeployErrors({ autoDeploy: true, ref: null, name: 'Test' }, project).length, 1);
  assert.equal(targetAutoDeployErrors({ autoDeploy: true, ref: 'test', environment: 'Prod', name: 'Canlı' }, project).length, 1);
  assert.equal(targetAutoDeployErrors({ autoDeploy: true, ref: 'test', name: 'musteri-prod' }, project).length, 1);
});

test('autoDeploy round-trips through the target repository', () => {
  const env = setup();
  try {
    const target = env.addTarget({ name: 'test-sunucu', ref: 'test', autoDeploy: true });
    assert.equal(env.repository.findTarget(target.id).autoDeploy, true);
    const updated = env.repository.updateTarget(target.id, { autoDeploy: false });
    assert.equal(updated.autoDeploy, false);
  } finally {
    env.cleanup();
  }
});

test('a CI-started upload of a branch installs on the opted-in targets of that branch only', async () => {
  const env = setup();
  try {
    const onTest = env.addTarget({ name: 'test-sunucu', ref: 'test', autoDeploy: true });
    env.addTarget({ name: 'test-manual', ref: 'test', autoDeploy: false });
    env.addTarget({ name: 'dev-auto', ref: 'dev', autoDeploy: true });

    const ready = await upload(env, '0.0.0-test.20261019120000', { ref: 'test' });

    assert.equal(ready.ref, 'test');
    assert.equal(ready.refType, 'branch');
    assert.deepEqual(env.deploys, [{
      targetId: onTest.id, releaseId: ready.id, components: ['frontend'], triggeredBy: AUTO_DEPLOY_USER,
    }]);
    assert.ok(env.audit.some((entry) => entry.action === 'RELEASE_AUTO_DEPLOY_STARTED'
      && entry.metadata.deploymentId === 'dep_1' && entry.metadata.targetName === 'test-sunucu'));
    const uploaded = env.audit.find((entry) => entry.action === 'RELEASE_UPLOADED');
    assert.equal(uploaded.metadata.ciInitiated, true);
    assert.equal(uploaded.metadata.ref, 'test');
  } finally {
    env.cleanup();
  }
});

test('no install for uploads without a ref or for builds IDP started', async () => {
  const env = setup();
  try {
    env.addTarget({ name: 'test-sunucu', ref: 'test', autoDeploy: true });

    await upload(env, '1.0.0');
    // IDP started this build: its row exists before CI finalizes it.
    env.repository.createRelease({ projectId: 'p1', version: '1.0.1', status: 'building', ref: 'test', refType: 'branch' });
    await upload(env, '1.0.1', { ref: 'test' });

    assert.equal(env.calls.length, 0);
    assert.equal(env.deploys.length, 0);
  } finally {
    env.cleanup();
  }
});

test('production targets are skipped even if they were saved with autoDeploy', async () => {
  const env = setup({ environment: 'Prod' });
  try {
    env.addTarget({ name: 'musteri', ref: 'test', autoDeploy: true });
    await upload(env, '0.0.0-test.1', { ref: 'test' });
    assert.equal(env.deploys.length, 0);
    assert.ok(env.audit.some((entry) => entry.action === 'RELEASE_AUTO_DEPLOY_SKIPPED'));
  } finally {
    env.cleanup();
  }
});

test('only the components the target runs and the upload built are installed', async () => {
  const env = setup();
  try {
    env.addTarget({ name: 'api-only', ref: 'test', autoDeploy: true, components: [{ name: 'backend' }] });
    await upload(env, '0.0.0-test.2', { ref: 'test' });
    assert.equal(env.deploys.length, 0);
    assert.ok(env.audit.some((entry) => entry.action === 'RELEASE_AUTO_DEPLOY_SKIPPED'
      && /no component/.test(entry.description)));
  } finally {
    env.cleanup();
  }
});

test('a deploy that cannot start is audited and does not fail the upload', async () => {
  const env = setup({ deployRelease: async () => { throw new Error("A deployment is already running on target 'test-sunucu'."); } });
  try {
    env.addTarget({ name: 'test-sunucu', ref: 'test', autoDeploy: true });
    const ready = await upload(env, '0.0.0-test.3', { ref: 'test' });
    assert.equal(ready.status, 'ready');
    const failed = env.audit.find((entry) => entry.action === 'RELEASE_AUTO_DEPLOY_FAILED');
    assert.match(failed.metadata.error, /already running/);
  } finally {
    env.cleanup();
  }
});
