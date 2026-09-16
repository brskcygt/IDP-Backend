'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { test } = require('node:test');

const { readEnvExampleFromTarGz, parseEnvExample, buildConfigSchema, isEnvExamplePath } = require('../src/core/artifacts/envExample');
const { openDatabase } = require('../src/store/db');
const { createArtifactDeployRepository } = require('../src/store/artifactDeployRepository');
const { createLocalArtifactStore } = require('../src/core/artifacts/localArtifactStore');
const { createArtifactUploadService } = require('../src/core/artifacts/artifactUploadService');

/** Minimal ustar writer: entries are [name, content, type?]. */
function tarGz(entries) {
  const blocks = [];
  for (const [name, content, type = '0'] of entries) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write(type, 156);
    header.write('ustar\0', 257);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test('isEnvExamplePath accepts the archive root and one top-level folder only', () => {
  assert.equal(isEnvExamplePath('.env.example'), true);
  assert.equal(isEnvExamplePath('./.env.example'), true);
  assert.equal(isEnvExamplePath('backend/.env.example'), true);
  assert.equal(isEnvExamplePath('node_modules/pkg/.env.example'), false);
  assert.equal(isEnvExamplePath('.env'), false);
});

test('readEnvExampleFromTarGz finds the file after other entries and skips nested copies', async () => {
  const archive = tarGz([
    ['server.js', 'x'.repeat(1500)],
    ['node_modules/lib/.env.example', 'NESTED=1'],
    ['ops/', '', '5'],
    ['./.env.example', 'PORT=8085\n'],
  ]);
  assert.equal(await readEnvExampleFromTarGz(Readable.from(archive)), 'PORT=8085\n');
});

test('readEnvExampleFromTarGz honours GNU long names and returns null when absent or not a tarball', async () => {
  const longDir = 'd'.repeat(120);
  const withLongName = tarGz([['././@LongLink', 'app/.env.example', 'L'], ['app/.env.exam', 'A=1']]);
  assert.equal(await readEnvExampleFromTarGz(Readable.from(withLongName)), 'A=1');
  assert.equal(await readEnvExampleFromTarGz(Readable.from(tarGz([[`${longDir}/x.js`, 'x']]))), null);
  assert.equal(await readEnvExampleFromTarGz(Readable.from(Buffer.from('not gzip'))), null);
});

test('readEnvExampleFromTarGz reads archives produced by the system tar', async (t) => {
  const probe = spawnSync('tar', ['--version']);
  if (probe.status !== 0) return t.skip('tar is not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-env-example-'));
  try {
    fs.writeFileSync(path.join(dir, 'server.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, '.env.example'), '# Listen port\nPORT=8085\n');
    const archive = path.join(dir, 'out.tar.gz');
    const result = spawnSync('tar', ['-czf', archive, '-C', dir, 'server.js', '.env.example']);
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(await readEnvExampleFromTarGz(fs.createReadStream(archive)), '# Listen port\nPORT=8085\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseEnvExample keeps defaults, comment descriptions and commented-out optional keys', () => {
  const keys = parseEnvExample([
    '# Address the HTTP server binds to',
    'HOST=0.0.0.0',
    'PORT="8085"',
    '',
    '# unrelated section header',
    '',
    '# Allowed browser origin',
    '# CORS_ORIGIN=*',
    'export DEMO_MESSAGE=\'hello world\'',
    'lower_case=ignored',
    'PORT=duplicate',
    'not an assignment',
  ].join('\n'));
  assert.deepEqual(keys, [
    { key: 'HOST', defaultValue: '0.0.0.0', description: 'Address the HTTP server binds to', optional: false },
    { key: 'PORT', defaultValue: '8085', description: null, optional: false },
    { key: 'CORS_ORIGIN', defaultValue: '*', description: 'Allowed browser origin', optional: true },
    { key: 'DEMO_MESSAGE', defaultValue: 'hello world', description: null, optional: false },
  ]);
});

test('buildConfigSchema maps components and returns null when nothing is found', async () => {
  const files = {
    'b.tar.gz': tarGz([['.env.example', 'PORT=1']]),
    'f.tar.gz': tarGz([['index.html', '<html>']]),
  };
  const open = async (artifact) => Readable.from(files[artifact.file]);
  assert.deepEqual(await buildConfigSchema([
    { component: 'backend', file: 'b.tar.gz' },
    { component: 'frontend', file: 'f.tar.gz' },
  ], open), { backend: { source: '.env.example', keys: [{ key: 'PORT', defaultValue: '1', description: null, optional: false }] } });
  assert.equal(await buildConfigSchema([{ component: 'frontend', file: 'f.tar.gz' }], open), null);
  assert.equal(await buildConfigSchema([{ component: 'x', file: 'missing' }], async () => { throw new Error('gone'); }), null);
});

test('finalizeRelease stores the parsed .env.example keys on the ready release', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-env-example-finalize-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  try {
    const repository = createArtifactDeployRepository(db);
    const project = {
      id: 'p1',
      name: 'Demo',
      config: { artifactDeploy: { artifactName: 'demo', components: [{ name: 'backend', subdir: 'backend', runtime: { type: 'none' } }] } },
    };
    const service = createArtifactUploadService({
      repository,
      store: createLocalArtifactStore({ root: path.join(dir, 'artifacts'), maxArtifactBytes: 1024 * 1024 }),
      auditLogger: { log: () => {} },
      getProject: () => project,
    });
    const body = tarGz([['.env.example', '# Port\nPORT=8085\n']]);
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const file = 'demo-backend-1.0.0.tar.gz';
    await service.uploadArtifact({ projectId: 'p1', version: '1.0.0', fileName: file, stream: Readable.from(body), sha256, contentLength: body.length });
    const ready = await service.finalizeRelease({
      projectId: 'p1',
      version: '1.0.0',
      manifest: { schema: 1, project: 'demo', version: '1.0.0', commit: 'c', artifacts: [{ component: 'backend', os: 'any', file, sha256, size: body.length }] },
    });
    const expected = { backend: { source: '.env.example', keys: [{ key: 'PORT', defaultValue: '8085', description: 'Port', optional: false }] } };
    assert.equal(ready.status, 'ready');
    assert.deepEqual(ready.configSchema, expected);
    assert.deepEqual(repository.findRelease(ready.id).configSchema, expected);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
