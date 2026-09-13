'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { parseArgs, normalizeBaseUrl, loadAndVerifyManifest, uploadRelease } = require('./upload-artifacts');
const { parseEntry, makeManifest } = require('./make-manifest');

const TOKEN = 'test-token-that-is-longer-than-thirty-two-characters';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-upload-cli-'));
  const entries = [
    ['backend', 'win-x64', 'jetsrm-backend-2.5.0-win-x64.tar.gz', 'windows'],
    ['backend', 'linux-x64', 'jetsrm-backend-2.5.0-linux-x64.tar.gz', 'linux'],
    ['frontend', 'any', 'jetsrm-frontend-2.5.0.tar.gz', 'frontend'],
  ];
  const artifacts = entries.map(([component, targetOs, file, body]) => {
    fs.writeFileSync(path.join(directory, file), body);
    return { component, os: targetOs, file, size: Buffer.byteLength(body), sha256: crypto.createHash('sha256').update(body).digest('hex') };
  });
  const manifest = { schema: 1, project: 'jetsrm', version: '2.5.0', commit: 'abcdef1', artifacts };
  const manifestPath = path.join(directory, 'jetsrm-2.5.0-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { directory, manifest, manifestPath };
}

async function readBody(body) {
  if (typeof body === 'string') return body;
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

function response(status = 201, body = '{}') {
  return { ok: status >= 200 && status < 300, status, statusText: status === 201 ? 'Created' : 'Error', text: async () => body, json: async () => JSON.parse(body) };
}

test('argument and URL parsing keeps the token out of command-line options', () => {
  assert.deepEqual(parseArgs(['--project-id', 'p1', '--version', '2.5.0', '--manifest', 'manifest.json']), {
    allowHttp: false, projectId: 'p1', version: '2.5.0', manifestPath: 'manifest.json',
  });
  assert.throws(() => parseArgs(['--token', TOKEN]), /Unknown argument/);
  assert.equal(normalizeBaseUrl('https://idp.example/root/'), 'https://idp.example/root');
  assert.throws(() => normalizeBaseUrl('http://192.168.0.242:3001'), /Plain HTTP/);
  assert.equal(normalizeBaseUrl('http://127.0.0.1:3001'), 'http://127.0.0.1:3001');
});

test('manifest helper matches backend component, count and unique-file limits', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-manifest-contract-'));
  try {
    fs.writeFileSync(path.join(directory, 'one.tar.gz'), 'content');
    assert.throws(() => parseEntry('Backend:any:one.tar.gz'), /Invalid component/);
    await assert.rejects(makeManifest([
      'jetsrm', '2.5.0', 'abcdef1',
      'backend:any:one.tar.gz',
      'frontend:any:one.tar.gz',
    ], directory), /Duplicate artifact file/);
    await assert.rejects(makeManifest([
      'jetsrm', '2.5.0', 'abcdef1',
      ...Array.from({ length: 41 }, (_, index) => `component-${index}:any:one.tar.gz`),
    ], directory), /between 1 and 40/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('manifest files are checked locally before network access', async () => {
  const env = fixture();
  try {
    const verified = await loadAndVerifyManifest(env.manifestPath, '2.5.0');
    assert.equal(verified.files.length, 3);
    fs.writeFileSync(path.join(env.directory, env.manifest.artifacts[0].file), 'changed');
    await assert.rejects(loadAndVerifyManifest(env.manifestPath, '2.5.0'), /does not match manifest/);
  } finally {
    fs.rmSync(env.directory, { recursive: true, force: true });
  }
});

test('uploads every artifact in manifest order and finalizes once', async () => {
  const env = fixture();
  const calls = [];
  try {
    const fetchImpl = async (url, options) => {
      calls.push({ url, options, body: await readBody(options.body) });
      return response(201, '{}');
    };
    await uploadRelease({ projectId: 'project:1', version: '2.5.0', manifestPath: env.manifestPath, baseUrl: 'https://idp.example', token: TOKEN }, { fetchImpl });
    assert.equal(calls.length, 4);
    assert.ok(calls.slice(0, 3).every((call) => call.options.method === 'PUT'));
    assert.match(calls[0].url, /project%3A1\/2\.5\.0\/jetsrm-backend/);
    assert.equal(calls[0].options.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].options.headers['x-artifact-sha256'], env.manifest.artifacts[0].sha256);
    assert.equal(calls[3].options.method, 'POST');
    assert.match(calls[3].url, /\/finalize$/);
    assert.deepEqual(JSON.parse(calls[3].body), env.manifest);
  } finally {
    fs.rmSync(env.directory, { recursive: true, force: true });
  }
});

test('fails fast and never finalizes after an upload error', async () => {
  const env = fixture();
  const calls = [];
  try {
    const fetchImpl = async (url, options) => {
      calls.push({ url, method: options.method });
      await readBody(options.body);
      return response(500, `storage unavailable for ${TOKEN}`);
    };
    await assert.rejects(
      uploadRelease({ projectId: 'p1', version: '2.5.0', manifestPath: env.manifestPath, baseUrl: 'https://idp.example', token: TOKEN }, { fetchImpl }),
      (err) => /Upload failed/.test(err.message) && /\[REDACTED\]/.test(err.message) && !err.message.includes(TOKEN),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PUT');
  } finally {
    fs.rmSync(env.directory, { recursive: true, force: true });
  }
});

test('streams raw files and manifest to the real HTTP contract', async () => {
  const env = fixture();
  const calls = [];
  const server = http.createServer(async (request, reply) => {
    const body = await readBody(request);
    calls.push({ method: request.method, url: request.url, headers: request.headers, body });
    reply.writeHead(201, { 'content-type': 'application/json' });
    reply.end('{}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    await uploadRelease({
      projectId: 'p1',
      version: '2.5.0',
      manifestPath: env.manifestPath,
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: TOKEN,
    });
    assert.equal(calls.length, 4);
    assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].headers['content-type'], 'application/gzip');
    assert.equal(calls[0].body, 'windows');
    assert.match(calls[3].url, /\/finalize$/);
    assert.deepEqual(JSON.parse(calls[3].body), env.manifest);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(env.directory, { recursive: true, force: true });
  }
});
