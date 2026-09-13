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
const { createLocalArtifactStore, projectKey } = require('../src/core/artifacts/localArtifactStore');
const { createArtifactUploadService } = require('../src/core/artifacts/artifactUploadService');
const { ConflictError, ValidationError } = require('../src/core/errors');

function sha(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-upload-service-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  const repository = createArtifactDeployRepository(db);
  const project = {
    id: 'p1',
    name: 'JetSRM',
    config: {
      artifactDeploy: {
        artifactName: 'jetsrm',
        source: { platform: 'github', owner: 'mdp', repo: 'jetsrm' },
        build: { provider: 'none' },
        components: [{ name: 'frontend', subdir: 'frontend', runtime: { type: 'iis-static' } }],
      },
    },
  };
  const store = createLocalArtifactStore({ root: path.join(dir, 'artifacts'), maxArtifactBytes: 1024 });
  const audit = [];
  let busyReleaseId = null;
  const service = createArtifactUploadService({
    repository,
    store,
    auditLogger: { log: (user, action, description, metadata) => audit.push({ user, action, description, metadata }) },
    getProject: (id) => {
      if (id !== project.id) throw new Error('Project not found');
      return project;
    },
    isReleaseBusy: (id) => id === busyReleaseId,
  });
  return {
    dir, db, repository, project, store, service, audit,
    setBusy: (id) => { busyReleaseId = id; },
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function releaseManifest(version, body) {
  return {
    schema: 1,
    project: 'jetsrm',
    version,
    commit: `commit-${version}`,
    artifacts: [{
      component: 'frontend',
      os: 'any',
      file: `jetsrm-frontend-${version}.tar.gz`,
      sha256: sha(body),
      size: body.length,
    }],
  };
}

async function stageAndFinalize(env, version) {
  const body = Buffer.from(`artifact-${version}`);
  const manifest = releaseManifest(version, body);
  await env.service.uploadArtifact({
    projectId: 'p1',
    version,
    fileName: manifest.artifacts[0].file,
    stream: Readable.from(body),
    sha256: manifest.artifacts[0].sha256,
    contentLength: body.length,
  });
  return env.service.finalizeRelease({ projectId: 'p1', version, manifest });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('CI upload finalizes an existing build row as an immutable local release', async () => {
  const env = setup();
  try {
    const building = env.repository.createRelease({ projectId: 'p1', version: '1.0.0', status: 'building' });
    const ready = await stageAndFinalize(env, '1.0.0');
    assert.equal(ready.id, building.id);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.sourcePlatform, 'local');
    assert.equal(ready.artifacts[0].sourceRef, ready.artifacts[0].fileName);
    assert.equal(ready.idempotent, false);
    assert.deepEqual((await env.service.finalizeRelease({
      projectId: 'p1', version: '1.0.0', manifest: ready.manifest,
    })).idempotent, true);
    await assert.rejects(stageAndFinalize(env, '1.0.0'), ConflictError);
    assert.ok(env.audit.some((entry) => entry.action === 'RELEASE_UPLOADED'));
  } finally {
    env.cleanup();
  }
});

test('finalize validates project/version and all manifest hashes before ready', async () => {
  const env = setup();
  try {
    const body = Buffer.from('artifact');
    await env.service.uploadArtifact({
      projectId: 'p1', version: '1.0.0', fileName: 'jetsrm-frontend-1.0.0.tar.gz',
      stream: Readable.from(body), sha256: sha(body), contentLength: body.length,
    });
    const bad = releaseManifest('1.0.0', Buffer.from('different'));
    await assert.rejects(env.service.finalizeRelease({ projectId: 'p1', version: '1.0.0', manifest: bad }), ValidationError);
    assert.equal(env.repository.findReleaseByVersion('p1', '1.0.0').status, 'failed');
    assert.ok(env.audit.some((entry) => entry.action === 'RELEASE_UPLOAD_FAILED'));
  } finally {
    env.cleanup();
  }
});

test('an idempotent finalize quarantines a ready release whose published bytes are corrupted', async () => {
  const env = setup();
  try {
    const ready = await stageAndFinalize(env, '1.1.0');
    const fileName = ready.manifest.artifacts[0].file;
    fs.writeFileSync(
      path.join(env.dir, 'artifacts', 'releases', projectKey('p1'), '1.1.0', fileName),
      'corrupted',
    );
    await assert.rejects(
      env.service.finalizeRelease({ projectId: 'p1', version: '1.1.0', manifest: ready.manifest }),
      ValidationError,
    );
    const quarantined = env.repository.findRelease(ready.id);
    assert.equal(quarantined.status, 'failed');
    assert.match(quarantined.error, /integrity check failed/);
  } finally {
    env.cleanup();
  }
});

test('a transient store I/O failure does not downgrade a verified ready release', async () => {
  const env = setup();
  try {
    const ready = await stageAndFinalize(env, '1.2.0');
    const realFinalize = env.store.finalize;
    env.store.finalize = async () => { throw new Error('temporary disk unavailable'); };
    await assert.rejects(
      env.service.finalizeRelease({ projectId: 'p1', version: '1.2.0', manifest: ready.manifest }),
      /temporary disk unavailable/,
    );
    assert.equal(env.repository.findRelease(ready.id).status, 'ready');
    env.store.finalize = realFinalize;
  } finally {
    env.cleanup();
  }
});

test('upload and finalize are mutually exclusive for the same release', async () => {
  const env = setup();
  try {
    const version = '1.5.0';
    const body = Buffer.from('serialized upload');
    const manifest = releaseManifest(version, body);
    const uploadStarted = deferred();
    const releaseUpload = deferred();
    const stream = Readable.from((async function* delayedBody() {
      uploadStarted.resolve();
      await releaseUpload.promise;
      yield body;
    }()));
    const upload = env.service.uploadArtifact({
      projectId: 'p1', version, fileName: manifest.artifacts[0].file,
      stream, sha256: manifest.artifacts[0].sha256, contentLength: body.length,
    });
    await uploadStarted.promise;
    await assert.rejects(
      env.service.finalizeRelease({ projectId: 'p1', version, manifest }),
      ConflictError,
    );
    releaseUpload.resolve();
    await upload;

    const realFinalize = env.store.finalize;
    const finalizeStarted = deferred();
    const releaseFinalize = deferred();
    env.store.finalize = async (args) => {
      finalizeStarted.resolve();
      await releaseFinalize.promise;
      return realFinalize(args);
    };
    const finalizing = env.service.finalizeRelease({ projectId: 'p1', version, manifest });
    await finalizeStarted.promise;
    await assert.rejects(env.service.uploadArtifact({
      projectId: 'p1', version, fileName: manifest.artifacts[0].file,
      stream: Readable.from(body), sha256: manifest.artifacts[0].sha256, contentLength: body.length,
    }), ConflictError);
    releaseFinalize.resolve();
    assert.equal((await finalizing).status, 'ready');
  } finally {
    env.cleanup();
  }
});

test('retention keeps newest three local releases plus installed/busy releases and ignores external releases', async () => {
  const env = setup();
  try {
    const v0 = await stageAndFinalize(env, '0.9.0');
    const v1 = await stageAndFinalize(env, '1.0.0');
    const target = env.repository.createTarget({
      projectId: 'p1', name: 'customer-a', agentId: 'WIN-01', os: 'windows',
      components: [], runtimeConfig: {}, currentReleaseId: v1.id,
    });
    const v2 = await stageAndFinalize(env, '2.0.0');
    const v3 = await stageAndFinalize(env, '3.0.0');
    assert.equal(env.repository.findRelease(v0.id), null, 'old unprotected release is pruned');
    env.repository.updateTarget(target.id, {
      currentReleaseId: null,
      currentVersions: { backend: { version: '1.0.0' }, frontend: { version: '2.0.0' } },
    });
    await stageAndFinalize(env, '4.0.0');
    assert.ok(env.repository.findRelease(v1.id), 'installed oldest release is protected');
    await stageAndFinalize(env, '5.0.0');
    assert.ok(env.repository.findRelease(v2.id), 'component-installed release is protected when currentReleaseId is null');

    env.setBusy(v3.id);
    await stageAndFinalize(env, '6.0.0');
    assert.ok(env.repository.findRelease(v3.id), 'actively deployed release is protected');
    const external = env.repository.createRelease({
      projectId: 'p1', version: 'external', status: 'ready', sourcePlatform: 'github',
    });
    env.service.prune('p1');
    assert.ok(env.repository.findRelease(external.id), 'external metadata is outside local binary retention');

    const versions = env.repository.listReadyLocalReleases('p1').map((release) => release.version);
    assert.deepEqual(versions, ['6.0.0', '5.0.0', '4.0.0', '3.0.0', '2.0.0', '1.0.0']);
    assert.equal(fs.existsSync(path.join(env.dir, 'artifacts', 'releases', projectKey('p1'), '0.9.0')), false);
    assert.ok(env.audit.some((entry) => entry.action === 'RELEASE_PRUNED' && entry.metadata.version === '0.9.0'));
  } finally {
    env.cleanup();
  }
});

test('retention follows successful finalization order, not the age of a pre-created build row', async () => {
  const env = setup();
  try {
    env.repository.createRelease({ projectId: 'p1', version: '1.0.0', status: 'building' });
    await stageAndFinalize(env, '2.0.0');
    await stageAndFinalize(env, '3.0.0');
    await stageAndFinalize(env, '4.0.0');
    await stageAndFinalize(env, '1.0.0');

    assert.deepEqual(
      env.repository.listReadyLocalReleases('p1').map((release) => release.version),
      ['1.0.0', '4.0.0', '3.0.0'],
    );
    assert.equal(env.repository.findReleaseByVersion('p1', '2.0.0'), null);
  } finally {
    env.cleanup();
  }
});
