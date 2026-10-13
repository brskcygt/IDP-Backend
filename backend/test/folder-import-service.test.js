'use strict';

/**
 * Releases from the build folder on the IDP server: listing, guessing, and
 * turning picked files into a ready local release that no longer depends on
 * the folder.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { openDatabase } = require('../src/store/db');
const { createArtifactDeployRepository } = require('../src/store/artifactDeployRepository');
const { createLocalArtifactStore } = require('../src/core/artifacts/localArtifactStore');
const { createArtifactUploadService } = require('../src/core/artifacts/artifactUploadService');
const { createFolderImportService, guessComponent, guessVersion } = require('../src/core/artifacts/folderImportService');
const { validateArtifactDeployConfig } = require('../src/core/artifacts/contracts');
const { ConflictError, NotFoundError, ValidationError } = require('../src/core/errors');

const HOUR = 60 * 60 * 1000;

function setup({ localFolder, components } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-folder-import-'));
  const buildFolder = path.join(dir, 'builds');
  fs.mkdirSync(buildFolder);
  const db = openDatabase(path.join(dir, 'test.db'));
  const repository = createArtifactDeployRepository(db);
  // No repository settings at all: a folder-only project must not need them.
  const project = {
    id: 'p1',
    name: 'JetSRM',
    config: {
      artifactDeploy: {
        artifactName: 'jetsrm',
        build: { provider: 'none' },
        localFolder: localFolder === undefined ? buildFolder : localFolder,
        components: components || [
          { name: 'backend', subdir: 'backend', os: 'win-x64', runtime: { type: 'windows-service', serviceName: 'jetsrm' } },
          { name: 'frontend', subdir: 'frontend', runtime: { type: 'iis-static' } },
        ],
      },
    },
  };
  const store = createLocalArtifactStore({ root: path.join(dir, 'artifacts'), maxArtifactBytes: 1024 * 1024 });
  const audit = [];
  const auditLogger = { log: (user, action, description, metadata) => audit.push({ user, action, metadata }) };
  const getProject = () => project;
  const uploadService = createArtifactUploadService({ repository, store, auditLogger, getProject });
  let clock = Date.now() + HOUR;
  const service = createFolderImportService({ repository, uploadService, auditLogger, getProject, now: () => clock });
  const write = (name, body, ageMs = HOUR) => {
    const file = path.join(buildFolder, name);
    fs.writeFileSync(file, body);
    const mtime = new Date(clock - ageMs);
    fs.utimesSync(file, mtime, mtime);
    return file;
  };
  return {
    dir, buildFolder, repository, project, store, service, audit, write,
    advance: (ms) => { clock += ms; },
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('guessComponent / guessVersion read what a CI usually puts in a file name', () => {
  const names = ['backend', 'frontend'];
  assert.equal(guessComponent('jetsrm-backend-1.4.2.tar.gz', names), 'backend');
  assert.equal(guessComponent('JetSRM_Frontend_1.4.2.tar.gz', names), 'frontend');
  assert.equal(guessComponent('jetsrm-1.4.2.tar.gz', names), null);
  assert.equal(guessComponent('backend-and-frontend.tar.gz', names), null, 'ambiguous names are left to the operator');
  assert.equal(guessComponent('admin-panel-2.0.tar.gz', ['admin-panel', 'api']), 'admin-panel');

  assert.equal(guessVersion('jetsrm-backend-1.4.2.tar.gz'), '1.4.2');
  assert.equal(guessVersion('jetsrm-frontend-1.4.2-rc1.tar.gz'), '1.4.2-rc1');
  assert.equal(guessVersion('jetsrm-backend-latest.tar.gz'), null);
});

test('localFolder: absolute paths only', () => {
  for (const folder of ['C:\\builds\\jetsrm', 'D:/out', '\\\\fileserver\\builds', '/srv/builds', '']) {
    assert.deepEqual(validateArtifactDeployConfig({ localFolder: folder }), [], folder);
  }
  for (const folder of ['builds', '..\\builds', 'C:', 42]) {
    assert.equal(validateArtifactDeployConfig({ localFolder: folder }).length, 1, String(folder));
  }
});

test('listFolder: .tar.gz files newest first, with guesses and flags', async () => {
  const ctx = setup();
  try {
    ctx.write('jetsrm-backend-1.4.1.tar.gz', 'old backend', 2 * HOUR);
    ctx.write('jetsrm-backend-1.4.2.tar.gz', 'backend');
    ctx.write('jetsrm-frontend-1.4.2.tar.gz', 'frontend', 5_000);
    ctx.write('notes.txt', 'ignored');
    ctx.write('bad name.tar.gz', 'x');
    fs.mkdirSync(path.join(ctx.buildFolder, 'folder.tar.gz'));

    const listing = await ctx.service.listFolder('p1');

    assert.equal(listing.folder, ctx.buildFolder);
    assert.deepEqual(listing.components, ['backend', 'frontend']);
    assert.deepEqual(
      listing.files.map((file) => file.name).sort(),
      ['bad name.tar.gz', 'jetsrm-backend-1.4.1.tar.gz', 'jetsrm-backend-1.4.2.tar.gz', 'jetsrm-frontend-1.4.2.tar.gz'],
      'only regular .tar.gz files'
    );
    const frontend = listing.files.find((file) => file.name === 'jetsrm-frontend-1.4.2.tar.gz');
    assert.equal(listing.files[0].name, 'jetsrm-frontend-1.4.2.tar.gz');
    assert.equal(frontend.component, 'frontend');
    assert.equal(frontend.version, '1.4.2');
    assert.equal(frontend.settling, true, 'written 5 s ago: may still be copying');
    assert.equal(listing.files.at(-1).name, 'jetsrm-backend-1.4.1.tar.gz');
    assert.match(listing.files.find((file) => file.name === 'bad name.tar.gz').problem, /letters, digits/);
    assert.equal(listing.files.find((file) => file.name === 'jetsrm-backend-1.4.2.tar.gz').problem, null);
  } finally {
    ctx.cleanup();
  }
});

test('listFolder: missing folder and missing setting are explained', async () => {
  const ctx = setup();
  try {
    fs.rmSync(ctx.buildFolder, { recursive: true });
    await assert.rejects(() => ctx.service.listFolder('p1'), (err) => err instanceof NotFoundError && /not found/.test(err.message));
    ctx.project.config.artifactDeploy.localFolder = '';
    await assert.rejects(() => ctx.service.listFolder('p1'), (err) => err instanceof ValidationError && /No build folder/.test(err.message));
  } finally {
    ctx.cleanup();
  }
});

test('importFromFolder: picked files become a ready release that survives the folder changing', async () => {
  const ctx = setup();
  try {
    const backendFile = ctx.write('jetsrm-backend-1.4.2.tar.gz', 'backend bytes');
    ctx.write('jetsrm-frontend-1.4.2.tar.gz', 'frontend bytes');

    const release = await ctx.service.importFromFolder({
      projectId: 'p1',
      version: '1.4.2',
      files: [
        { component: 'backend', file: 'jetsrm-backend-1.4.2.tar.gz' },
        { component: 'frontend', file: 'jetsrm-frontend-1.4.2.tar.gz' },
      ],
      triggeredBy: 'baris',
    });

    assert.equal(release.status, 'ready');
    assert.equal(release.sourcePlatform, 'local');
    assert.equal(release.createdBy, 'baris');
    assert.deepEqual(
      release.manifest.artifacts.map(({ component, os: artifactOs, file, size }) => ({ component, os: artifactOs, file, size })),
      [
        { component: 'backend', os: 'win-x64', file: 'jetsrm-backend-1.4.2.tar.gz', size: 13 },
        { component: 'frontend', os: 'any', file: 'jetsrm-frontend-1.4.2.tar.gz', size: 14 },
      ]
    );
    assert.equal(release.manifest.artifacts[0].sha256, crypto.createHash('sha256').update('backend bytes').digest('hex'));
    assert.equal(release.manifest.project, 'jetsrm');
    assert.ok(ctx.audit.some((entry) => entry.action === 'RELEASE_IMPORTED_FROM_FOLDER' && entry.user === 'baris'));

    // The CI overwrites the folder copy: the stored release is unaffected.
    fs.writeFileSync(backendFile, 'next build');
    const { stream } = await ctx.store.open({ artifact: { fileName: 'jetsrm-backend-1.4.2.tar.gz' }, release: { projectId: 'p1', version: '1.4.2' } });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'backend bytes');

    await assert.rejects(
      () => ctx.service.importFromFolder({ projectId: 'p1', version: '1.4.2', files: [{ component: 'frontend', file: 'jetsrm-frontend-1.4.2.tar.gz' }] }),
      (err) => err instanceof ConflictError && /already exists/.test(err.message)
    );
  } finally {
    ctx.cleanup();
  }
});

test('importFromFolder: one component alone is allowed', async () => {
  const ctx = setup();
  try {
    ctx.write('frontend-only.tar.gz', 'frontend bytes');
    const release = await ctx.service.importFromFolder({
      projectId: 'p1',
      version: '1.4.3',
      files: [{ component: 'frontend', file: 'frontend-only.tar.gz' }],
    });
    assert.deepEqual(release.manifest.artifacts.map((artifact) => artifact.component), ['frontend']);
    assert.equal(release.createdBy, 'build-folder');
  } finally {
    ctx.cleanup();
  }
});

test('importFromFolder: refuses files still being copied, missing, unknown or doubled picks', async () => {
  const ctx = setup();
  try {
    ctx.write('fresh-backend.tar.gz', 'half', 2_000);
    ctx.write('backend.tar.gz', 'b');
    const run = (files, version = '2.0.0') => ctx.service.importFromFolder({ projectId: 'p1', version, files });

    await assert.rejects(() => run([{ component: 'backend', file: 'fresh-backend.tar.gz' }]), (err) => err instanceof ConflictError && /may still be being copied/.test(err.message));
    await assert.rejects(() => run([{ component: 'backend', file: 'gone.tar.gz' }]), (err) => err instanceof NotFoundError);
    await assert.rejects(() => run([{ component: 'mobile', file: 'backend.tar.gz' }]), /Unknown component: mobile/);
    await assert.rejects(() => run([{ component: 'backend', file: '..\\secrets.tar.gz' }]), /Invalid file name/);
    await assert.rejects(
      () => run([{ component: 'backend', file: 'backend.tar.gz' }, { component: 'frontend', file: 'backend.tar.gz' }]),
      /picked for two components/
    );
    await assert.rejects(() => run([{ component: 'backend', file: 'backend.tar.gz' }], 'not a version!'), /Invalid version/);
    assert.equal(ctx.repository.findReleaseByVersion('p1', '2.0.0'), null, 'nothing was created');

    // Once the copy has settled the same file imports fine.
    ctx.advance(20_000);
    const release = await run([{ component: 'backend', file: 'fresh-backend.tar.gz' }]);
    assert.equal(release.status, 'ready');
  } finally {
    ctx.cleanup();
  }
});

test('build folders: listed next to archives, packed on import with their contents at the root', async (t) => {
  const { spawnSync } = require('node:child_process');
  if (spawnSync('tar', ['--version']).status !== 0) return t.skip('tar is not available');
  const ctx = setup();
  try {
    const frontend = path.join(ctx.buildFolder, 'front-build');
    fs.mkdirSync(path.join(frontend, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(frontend, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(frontend, 'assets', 'app.js'), 'console.log(1)');
    const backend = path.join(ctx.buildFolder, 'jetsrm-backend');
    fs.mkdirSync(path.join(backend, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(backend, 'package.json'), JSON.stringify({ name: 'jetsrm', version: '2.3.1' }));
    fs.writeFileSync(path.join(backend, 'dist', 'app.js'), 'module.exports = 1');
    fs.mkdirSync(path.join(ctx.buildFolder, '.git'));
    const old = new Date(Date.now() - HOUR);
    for (const file of [frontend, path.join(frontend, 'index.html'), path.join(frontend, 'assets'), path.join(frontend, 'assets', 'app.js'),
      backend, path.join(backend, 'package.json'), path.join(backend, 'dist'), path.join(backend, 'dist', 'app.js')]) {
      fs.utimesSync(file, old, old);
    }

    const listing = await ctx.service.listFolder('p1');
    const front = listing.files.find((file) => file.name === 'front-build');
    const back = listing.files.find((file) => file.name === 'jetsrm-backend');
    assert.deepEqual([front.kind, front.component, front.size, front.version], ['directory', 'frontend', null, null]);
    assert.deepEqual([back.kind, back.component, back.version], ['directory', 'backend', '2.3.1']);
    assert.ok(!listing.files.some((file) => file.name === '.git'), 'hidden folders stay out');

    const release = await ctx.service.importFromFolder({
      projectId: 'p1',
      version: '2.3.1',
      files: [{ component: 'backend', file: 'jetsrm-backend' }, { component: 'frontend', file: 'front-build' }],
      triggeredBy: 'baris',
    });
    assert.equal(release.status, 'ready');
    assert.deepEqual(release.manifest.artifacts.map((artifact) => artifact.file), ['jetsrm-backend-2.3.1.tar.gz', 'jetsrm-frontend-2.3.1.tar.gz']);

    // Contents at the archive root, like the CI's own `tar -C <dir> .`.
    const { stream } = await ctx.store.open({ artifact: { fileName: 'jetsrm-frontend-2.3.1.tar.gz' }, release: { projectId: 'p1', version: '2.3.1' } });
    const archive = path.join(ctx.dir, 'check.tar.gz');
    await require('node:stream/promises').pipeline(stream, fs.createWriteStream(archive));
    const entries = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' }).stdout.split('\n').map((line) => line.replace(/^\.\//, '')).filter(Boolean);
    assert.ok(entries.includes('index.html') && entries.includes('assets/app.js'), entries.join(','));

    // The CI overwrites the folder: the release keeps what was packed.
    fs.writeFileSync(path.join(frontend, 'index.html'), 'next build');
    assert.equal(ctx.repository.findReleaseByVersion('p1', '2.3.1').manifest.artifacts[1].size, release.manifest.artifacts[1].size);
    assert.ok(ctx.audit.some((entry) => entry.action === 'RELEASE_IMPORTED_FROM_FOLDER' && entry.metadata.files.includes('frontend:front-build')));
  } finally {
    ctx.cleanup();
  }
});

test('build folders: a folder with a file still being written is refused, and no path escapes the folder', async () => {
  const ctx = setup();
  try {
    const frontend = path.join(ctx.buildFolder, 'front-build');
    fs.mkdirSync(path.join(frontend, 'assets'), { recursive: true });
    const old = new Date(Date.now() - HOUR);
    fs.utimesSync(frontend, old, old);
    // Only a nested file is fresh: the folder's own mtime does not show it.
    fs.writeFileSync(path.join(frontend, 'assets', 'app.js'), 'half');
    const justNow = new Date(Date.now() + HOUR - 2_000); // the service clock runs an hour ahead
    fs.utimesSync(path.join(frontend, 'assets', 'app.js'), justNow, justNow);
    const run = (file) => ctx.service.importFromFolder({ projectId: 'p1', version: '3.0.0', files: [{ component: 'frontend', file }] });

    await assert.rejects(() => run('front-build'), (err) => err instanceof ConflictError && /may still be being copied/.test(err.message));
    await assert.rejects(() => run('..'), /Invalid file name/);
    await assert.rejects(() => run('a/b'), /Invalid file name/);
    await assert.rejects(() => run('a\\b'), /Invalid file name/);
  } finally {
    ctx.cleanup();
  }
});
