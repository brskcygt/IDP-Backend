'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { test } = require('node:test');

const { createLocalArtifactStore, projectKey } = require('../src/core/artifacts/localArtifactStore');
const { ConflictError, ValidationError } = require('../src/core/errors');

function digest(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function fixture(maxArtifactBytes = 1024) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-artifact-store-'));
  const store = createLocalArtifactStore({ root, maxArtifactBytes });
  return { root, store, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function manifest(version, file, body) {
  return {
    schema: 1,
    project: 'jetsrm',
    version,
    commit: 'abc123',
    createdAt: '2026-09-13T00:00:00.000Z',
    artifacts: [{ component: 'frontend', os: 'any', file, sha256: digest(body), size: body.length }],
  };
}

test('local store streams to staging, verifies manifest, atomically publishes and opens', async () => {
  const env = fixture();
  try {
    const body = Buffer.from('immutable artifact');
    const fileName = 'jetsrm-frontend-1.0.0.tar.gz';
    const uploaded = await env.store.upload({
      projectId: '../../project',
      version: '1.0.0',
      fileName,
      stream: Readable.from(body),
      expectedSha256: digest(body),
      contentLength: body.length,
    });
    assert.equal(uploaded.idempotent, false);
    assert.equal(fs.existsSync(path.join(env.root, '.staging', projectKey('../../project'), '1.0.0', fileName)), true);

    const finalized = await env.store.finalize({
      projectId: '../../project',
      version: '1.0.0',
      manifest: manifest('1.0.0', fileName, body),
    });
    assert.equal(finalized.idempotent, false);
    assert.equal(fs.existsSync(path.join(env.root, '.staging', projectKey('../../project'), '1.0.0')), false);
    assert.equal(fs.existsSync(path.join(env.root, 'releases', projectKey('../../project'), '1.0.0', fileName)), true);

    const opened = await env.store.open({
      release: { projectId: '../../project', version: '1.0.0' },
      artifact: { fileName },
    });
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), body.toString());
    assert.equal(opened.contentLength, body.length);
  } finally {
    env.cleanup();
  }
});

test('local store rejects unsafe names, oversized bodies and hash/manifest mismatches without publishing', async () => {
  const env = fixture(8);
  try {
    const body = Buffer.from('123456789');
    await assert.rejects(env.store.upload({
      projectId: 'p1', version: '1.0.0', fileName: '../evil.tar.gz',
      stream: Readable.from(body), expectedSha256: digest(body), contentLength: body.length,
    }), ValidationError);
    await assert.rejects(env.store.upload({
      projectId: 'p1', version: '1.0.0', fileName: 'safe.tar.gz',
      stream: Readable.from(body), expectedSha256: digest(body), contentLength: null,
    }), (err) => err instanceof ValidationError && err.code === 'ARTIFACT_TOO_LARGE');

    const short = Buffer.from('ok');
    await assert.rejects(env.store.upload({
      projectId: 'p1', version: '1.0.1', fileName: 'safe.tar.gz',
      stream: Readable.from(short), expectedSha256: '0'.repeat(64), contentLength: short.length,
    }), /SHA-256/);
    assert.equal(fs.existsSync(path.join(env.root, 'releases')), false);
  } finally {
    env.cleanup();
  }
});

test('local store upload/finalize are idempotent but immutable for different bytes or manifests', async () => {
  const env = fixture();
  try {
    const body = Buffer.from('same');
    const fileName = 'same.tar.gz';
    const args = {
      projectId: 'p1', version: '1.0.0', fileName,
      expectedSha256: digest(body), contentLength: body.length,
    };
    await env.store.upload({ ...args, stream: Readable.from(body) });
    assert.equal((await env.store.upload({ ...args, stream: Readable.from(body) })).idempotent, true);
    await assert.rejects(env.store.upload({
      ...args, stream: Readable.from('else'), expectedSha256: digest('else'), contentLength: 4,
    }), ConflictError);

    const good = manifest('1.0.0', fileName, body);
    await env.store.finalize({ projectId: 'p1', version: '1.0.0', manifest: good });
    assert.equal((await env.store.finalize({ projectId: 'p1', version: '1.0.0', manifest: good })).idempotent, true);
    const changed = { ...good, commit: 'different' };
    await assert.rejects(env.store.finalize({ projectId: 'p1', version: '1.0.0', manifest: changed }), ConflictError);
  } finally {
    env.cleanup();
  }
});

test('concurrent uploads cannot overwrite an artifact and identical retries are idempotent', async () => {
  const env = fixture();
  try {
    const body = Buffer.from('concurrent immutable artifact');
    const args = {
      projectId: 'p1', version: '2.0.0', fileName: 'same.tar.gz',
      expectedSha256: digest(body), contentLength: body.length,
    };
    const results = await Promise.all([
      env.store.upload({ ...args, stream: Readable.from(body) }),
      env.store.upload({ ...args, stream: Readable.from(body) }),
    ]);
    assert.deepEqual(results.map((entry) => entry.idempotent).sort(), [false, true]);
    const stored = fs.readFileSync(path.join(env.root, '.staging', projectKey('p1'), '2.0.0', 'same.tar.gz'));
    assert.deepEqual(stored, body);
  } finally {
    env.cleanup();
  }
});

test('startup cleanup removes abandoned staging versions but preserves fresh uploads', () => {
  const env = fixture();
  try {
    const projectDir = path.join(env.root, '.staging', projectKey('p1'));
    const oldDir = path.join(projectDir, '1.0.0');
    const freshDir = path.join(projectDir, '2.0.0');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(freshDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'old.tar.gz'), 'old');
    fs.writeFileSync(path.join(freshDir, 'fresh.tar.gz'), 'fresh');
    const now = Date.now();
    fs.utimesSync(oldDir, new Date(now - 2000), new Date(now - 2000));
    fs.utimesSync(freshDir, new Date(now), new Date(now));
    assert.equal(env.store.cleanupStagingSync(1000, now), 1);
    assert.equal(fs.existsSync(oldDir), false);
    assert.equal(fs.existsSync(freshDir), true);
  } finally {
    env.cleanup();
  }
});
