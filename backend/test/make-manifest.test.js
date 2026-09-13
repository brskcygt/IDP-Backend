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
