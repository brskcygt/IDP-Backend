'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { parseEntry, makeManifest, main } = require('../../scripts/make-manifest');

test('make-manifest streams files and writes the release manifest contract', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-manifest-'));
  try {
    fs.writeFileSync(path.join(dir, 'backend.tar.gz'), 'backend-content');
    fs.writeFileSync(path.join(dir, 'frontend.tar.gz'), 'frontend-content');
    const args = [
      'jetsrm', '2.5.0', 'abcdef123456',
      'backend:win-x64:backend.tar.gz',
      'frontend:any:frontend.tar.gz',
    ];
    const result = await makeManifest(args, dir);
    assert.equal(result.fileName, 'jetsrm-2.5.0-manifest.json');
    assert.deepEqual(result.manifest.artifacts.map((entry) => `${entry.component}/${entry.os}/${entry.file}`), [
      'backend/win-x64/backend.tar.gz', 'frontend/any/frontend.tar.gz',
    ]);
    assert.equal(result.manifest.artifacts[0].sha256,
      crypto.createHash('sha256').update('backend-content').digest('hex'));

    await main(args, dir);
    const written = JSON.parse(fs.readFileSync(path.join(dir, result.fileName), 'utf8'));
    assert.deepEqual(written.artifacts, result.manifest.artifacts);
    assert.equal(written.project, 'jetsrm');
    assert.equal(written.version, '2.5.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('make-manifest rejects malformed, duplicate and missing artifact inputs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-manifest-invalid-'));
  try {
    fs.writeFileSync(path.join(dir, 'one.tar.gz'), 'x');
    assert.throws(() => parseEntry('backend:darwin:one.tar.gz'), /artifact OS/);
    await assert.rejects(makeManifest(['bad/name', '1.0.0', 'abcdef1', 'backend:any:one.tar.gz'], dir), /artifactName/);
    await assert.rejects(makeManifest([
      'jetsrm', '1.0.0', 'abcdef1', 'backend:any:one.tar.gz', 'backend:any:one.tar.gz',
    ], dir), /Duplicate/);
    await assert.rejects(makeManifest(['jetsrm', '1.0.0', 'abcdef1', 'backend:any:missing.tar.gz'], dir), /ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('make-manifest: layer variants, one by one or every file of a `*` pattern', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-manifest-variants-'));
  try {
    fs.mkdirSync(path.join(dir, 'artifacts'));
    for (const name of ['srm-frontend-1.0.0.tar.gz', 'srm-brand-koksan-1.0.0.tar.gz', 'srm-brand-temsa-1.0.0.tar.gz', 'srm-brand-BAD!-1.0.0.tar.gz']) {
      fs.writeFileSync(path.join(dir, 'artifacts', name), name);
    }
    assert.deepEqual(parseEntry('brand@koksan:any:x.tar.gz'), { component: 'brand', variant: 'koksan', os: 'any', file: 'x.tar.gz' });
    assert.throws(() => parseEntry('brand@Koksan:any:x.tar.gz'), /variant/);
    assert.throws(() => parseEntry('brand@a@b:any:x.tar.gz'), /component/);

    const result = await makeManifest([
      'srm', '1.0.0', 'abcdef1',
      'frontend:any:artifacts/srm-frontend-1.0.0.tar.gz',
      'brand@*:any:artifacts/srm-brand-*-1.0.0.tar.gz',
    ], dir);
    assert.deepEqual(result.manifest.artifacts.map((a) => [a.component, a.variant ?? null, a.file]), [
      ['frontend', null, 'srm-frontend-1.0.0.tar.gz'],
      ['brand', 'koksan', 'srm-brand-koksan-1.0.0.tar.gz'],
      ['brand', 'temsa', 'srm-brand-temsa-1.0.0.tar.gz'],
    ]);
    assert.equal('variant' in result.manifest.artifacts[0], false);

    await assert.rejects(makeManifest(['srm', '1.0.0', 'abcdef1', 'brand@*:any:artifacts/none-*.tar.gz'], dir), /No file matches/);
    await assert.rejects(makeManifest(['srm', '1.0.0', 'abcdef1', 'brand@*:any:artifacts/*-*.tar.gz'], dir), /exactly one \*/);
    await assert.rejects(makeManifest([
      'srm', '1.0.0', 'abcdef1', 'brand@*:any:artifacts/srm-brand-*-1.0.0.tar.gz', 'brand@temsa:any:artifacts/srm-frontend-1.0.0.tar.gz',
    ], dir), /Duplicate/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
