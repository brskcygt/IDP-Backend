'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { describe, it, beforeEach, afterEach } = require('node:test');

const { createProjectFolders, cleanName } = require('../src/core/artifacts/projectFolders');
const { createLocalArtifactStore, projectKey } = require('../src/core/artifacts/localArtifactStore');

describe('artifact project folders', () => {
  let root;
  let names;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-folders-'));
    names = { p1: 'JETSRM', p2: 'JETSRM', p3: 'CON', p4: 'a/b:c*', p5: '...gizli', p6: 'releases' };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const folders = () => createProjectFolders({ root, getProjectName: (id) => names[id] ?? null });

  it('names the folder after the project and keeps it across renames and restarts', () => {
    const folderOf = folders();
    assert.equal(folderOf('p1'), 'JETSRM');
    names.p1 = 'Yeni Ad';
    assert.equal(folderOf('p1'), 'JETSRM');
    assert.equal(folders()('p1'), 'JETSRM');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.project-folders.json'), 'utf8')), { p1: 'JETSRM' });
  });

  it('never gives two projects the same folder, whatever the case', () => {
    const folderOf = folders();
    names.p2 = 'jetsrm';
    assert.equal(folderOf('p1'), 'JETSRM');
    assert.equal(folderOf('p2'), 'jetsrm-p2');
  });

  it('cleans names Windows cannot use and keeps clear of the store\'s own folders', () => {
    const folderOf = folders();
    assert.equal(folderOf('p3'), 'CON-p3');
    assert.equal(folderOf('p4'), 'a-b-c-');
    assert.equal(folderOf('p5'), 'gizli');
    assert.equal(folderOf('p6'), 'releases-p6');
    assert.equal(folderOf('unknown'), 'unknown');
    assert.equal(cleanName('  x.  '), 'x');
  });

  it('stores a release under <root>/<project>/<version> and still finds one stored by id hash', async () => {
    const store = createLocalArtifactStore({ root, maxArtifactBytes: 1024, projectFolder: folders() });
    const body = Buffer.from('paket');
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    await store.upload({ projectId: 'p1', version: '1.0.0', fileName: 'a.tar.gz', stream: Readable.from([body]), expectedSha256: sha256, contentLength: body.length });
    const manifest = { artifacts: [{ file: 'a.tar.gz', sha256, size: body.length }] };
    const { directory } = await store.finalize({ projectId: 'p1', version: '1.0.0', manifest });
    assert.equal(directory, path.join(root, 'JETSRM', '1.0.0'));
    assert.equal(fs.existsSync(path.join(root, 'JETSRM', '1.0.0', 'a.tar.gz')), true);

    const legacy = path.join(root, 'releases', projectKey('p1'), '0.9.0');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'old.tar.gz'), 'eski');
    const opened = await store.open({ artifact: { fileName: 'old.tar.gz' }, release: { projectId: 'p1', version: '0.9.0' } });
    assert.equal(opened.contentLength, 4);
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'eski');
  });
});
