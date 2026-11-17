'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { spawnSync } = require('node:child_process');

const { createVariantReleaseService, parseVariants, isSafeRelativePath } = require('../src/core/artifacts/variantReleaseService');
const { validateManifest } = require('../src/core/artifacts/contracts');
const { tarCommand } = require('../src/core/artifacts/folderImportService');

const DERIVES = ['frontend-evyap', 'frontend-koksan'];

describe('variant release', () => {
  let work;
  beforeEach(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-variant-test-')); });
  afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

  /** A build package: both brands' chunks, a shared file, and the variants list. */
  function makeBuild(variants) {
    const dir = path.join(work, 'src');
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(dir, 'brand-config.js'), 'window.__BRAND__ = {};');
    fs.writeFileSync(path.join(dir, 'assets', 'brand-evyap-AAAAAAAA.js'), 'evyap');
    fs.writeFileSync(path.join(dir, 'assets', 'brand-koksan-BBBBBBBB.js'), 'koksan');
    fs.writeFileSync(path.join(dir, 'idp-variants.json'), JSON.stringify({ schema: 1, variants }));
    const archive = path.join(work, 'build.tar.gz');
    const packed = spawnSync(tarCommand(), ['-czf', archive, '-C', dir, '.']);
    assert.equal(packed.status, 0);
    return archive;
  }

  function service(archive, { derives = DERIVES, existing = null } = {}) {
    const body = fs.readFileSync(archive);
    const uploads = {};
    const finalized = [];
    const build = {
      id: 'b1', projectId: 'p1', version: '161120261419-mdp-srm-frontend', status: 'ready', commitSha: 'abcdef1234567',
      manifest: { artifacts: [{ component: 'frontend-build', os: 'any', file: 'x.tar.gz', sha256: crypto.createHash('sha256').update(body).digest('hex'), size: body.length, derives }] },
    };
    const svc = createVariantReleaseService({
      repository: { findRelease: () => build, findReleaseByVersion: () => existing },
      uploadService: {
        async uploadArtifact({ fileName, stream }) {
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          uploads[fileName] = Buffer.concat(chunks);
        },
        async finalizeRelease(args) { finalized.push(args); return { id: 'r1', version: args.version }; },
      },
      openArtifact: async () => ({ stream: fs.createReadStream(archive) }),
      auditLogger: { log() {} },
      getProject: () => ({ config: { artifactDeploy: { artifactName: 'mdp-srm', components: [{ name: 'frontend-koksan', subdir: 'frontend', runtime: { type: 'iis-static' } }] } } }),
    });
    return { svc, uploads, finalized };
  }

  const entries = (buffer, name) => {
    const file = path.join(work, name);
    fs.writeFileSync(file, buffer);
    return spawnSync(tarCommand(), ['-tzf', file], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  };

  it('makes one package per component, each without the other brand\'s files', async () => {
    const archive = makeBuild([
      { component: 'frontend-evyap', remove: ['assets/brand-koksan-BBBBBBBB.js'], write: { 'brand-config.js': 'evyap-config' } },
      { component: 'frontend-koksan', remove: ['assets/brand-evyap-AAAAAAAA.js'], write: { 'brand-config.js': 'koksan-config' } },
    ]);
    const { svc, uploads, finalized } = service(archive);
    await svc.createFromBuild({ projectId: 'p1', buildReleaseId: 'b1', version: '1.0.0', triggeredBy: 'test' });

    assert.deepEqual(Object.keys(uploads).sort(), ['mdp-srm-frontend-evyap-1.0.0.tar.gz', 'mdp-srm-frontend-koksan-1.0.0.tar.gz']);
    const koksan = entries(uploads['mdp-srm-frontend-koksan-1.0.0.tar.gz'], 'k.tar.gz');
    assert.ok(koksan.some((name) => name.includes('brand-koksan-')));
    assert.ok(!koksan.some((name) => name.includes('brand-evyap-')));
    assert.ok(!koksan.some((name) => name.includes('idp-variants.json')));
    assert.equal(finalized[0].manifest.artifacts.length, 2);
    assert.equal(finalized[0].manifest.commit, 'abcdef1234567');
    assert.equal(validateManifest(finalized[0].manifest).valid, true);
  });

  it('reports rising progress that ends below 100 and names each package', async () => {
    const archive = makeBuild([
      { component: 'frontend-evyap', remove: [], write: {} },
      { component: 'frontend-koksan', remove: [], write: {} },
    ]);
    const states = [];
    await service(archive).svc.createFromBuild({ projectId: 'p1', buildReleaseId: 'b1', version: '1.0.0', onProgress: (state) => states.push(state) });
    const percents = states.map((state) => state.percent);
    assert.deepEqual(percents, [...percents].sort((a, b) => a - b));
    assert.ok(percents[percents.length - 1] < 100, 'the route reports 100 once the release exists');
    assert.deepEqual([...new Set(states.filter((state) => state.phase === 'package').map((state) => state.component))], ['frontend-evyap', 'frontend-koksan']);
    assert.equal(states.at(-1).phase, 'finalizing');
  });

  it('refuses a variants file that names a component the build does not derive', async () => {
    const archive = makeBuild([{ component: 'frontend-temsa', remove: [], write: {} }]);
    await assert.rejects(service(archive).svc.createFromBuild({ projectId: 'p1', buildReleaseId: 'b1', version: '1.0.0' }), /not among the components/);
  });

  it('refuses a version that already exists and a build that derives nothing', async () => {
    const archive = makeBuild([{ component: 'frontend-koksan', remove: [], write: {} }]);
    await assert.rejects(service(archive, { existing: { status: 'ready' } }).svc.createFromBuild({ projectId: 'p1', buildReleaseId: 'b1', version: '1.0.0' }), /already exists/);
    await assert.rejects(service(archive, { derives: [] }).svc.createFromBuild({ projectId: 'p1', buildReleaseId: 'b1', version: '1.0.0' }), /derive/);
  });

  it('only accepts paths inside the package', () => {
    assert.equal(isSafeRelativePath('assets/a.js'), true);
    for (const bad of ['../x', '/etc/passwd', 'a/../../b', 'C:/x', 'a\\b', '', 'a//b']) assert.equal(isSafeRelativePath(bad), false, bad);
    assert.throws(() => parseVariants(JSON.stringify({ schema: 1, variants: [{ component: 'frontend-koksan', remove: ['../x'] }] }), new Set(DERIVES)), /relative paths/);
  });

  it('keeps `derives` in a manifest and rejects a malformed one', () => {
    const artifact = { component: 'frontend-build', os: 'any', file: 'a.tar.gz', sha256: 'a'.repeat(64), size: 5 };
    const manifest = (extra) => ({ schema: 1, project: 'mdp-srm', version: '1', artifacts: [{ ...artifact, ...extra }] });
    assert.deepEqual(validateManifest(manifest({ derives: DERIVES })).manifest.artifacts[0].derives, DERIVES);
    assert.equal(validateManifest(manifest({ derives: ['Bad Name'] })).valid, false);
    assert.equal(validateManifest(manifest({})).manifest.artifacts[0].derives, undefined);
  });
});
