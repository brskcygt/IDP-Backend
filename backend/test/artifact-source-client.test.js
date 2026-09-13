/**
 * Artifact source clients (core/artifacts/artifactSourceClient.js):
 * Bitbucket Downloads + GitHub Release assets behind a fake fetch.
 * Redirects must be followed by hand, the repository token must reach ONLY
 * the API host, bodies must stream, and errors must never carry the token.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createArtifactSourceClient, ArtifactSourceError } = require('../src/core/artifacts/artifactSourceClient');
const { mapErrorToResponse } = require('../src/http/errorMapper');

const TOKEN = 'repo-token-0123456789abcdef';
const BB = 'https://api.bitbucket.org/2.0/repositories/mdp/jetsrm';
const GH = 'https://api.github.com/repos/mdp/jetsrm';
const STORAGE = 'https://bbuseruploads.s3.amazonaws.com';
const GH_STORAGE = 'https://objects.githubusercontent.com';

test('artifact source failures map to HTTP 502', () => {
  const mapped = mapErrorToResponse(new ArtifactSourceError('source unavailable', { transient: true }));
  assert.deepEqual(mapped, { status: 502, body: { error: 'source unavailable' } });
});

const manifest = {
  schema: 1,
  project: 'jetsrm',
  version: '2.5.0',
  artifacts: [
    { component: 'backend', os: 'win-x64', file: 'jetsrm-backend-2.5.0-win-x64.tar.gz', sha256: 'a'.repeat(64), size: 11 },
    { component: 'frontend', os: 'any', file: 'jetsrm-frontend-2.5.0.tar.gz', sha256: 'b'.repeat(64), size: 5 },
  ],
};

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function redirect(location, status = 302) {
  return new Response(null, { status, headers: { location } });
}

/** A body delivered in several chunks, so streaming (not buffering) is observable. */
function chunkedBody(chunks) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++]));
      else controller.close();
    },
  });
}

/** Routes `METHOD url` → handler; records every call with its headers. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, headers, redirect: init.redirect });
    const route = routes[url];
    if (!route) return json(404, { error: { message: 'not found' } });
    return typeof route === 'function' ? route(url, init) : route;
  };
  impl.calls = calls;
  return impl;
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function assertTokenOnlyOnApi(calls, apiOrigin) {
  for (const call of calls) {
    const toApi = new URL(call.url).origin === apiOrigin;
    if (toApi) assert.match(String(call.headers.authorization), new RegExp(TOKEN), call.url);
    else assert.equal(call.headers.authorization, undefined, `token leaked to ${call.url}`);
    assert.equal(call.redirect, 'manual');
  }
}

// ----------------------------------------------------------------- Bitbucket

test('bitbucket: manifest via 302 to storage; token only sent to api.bitbucket.org', async () => {
  const fetchImpl = fakeFetch({
    [`${BB}/downloads/jetsrm-2.5.0-manifest.json`]: redirect(`${STORAGE}/m.json?Signature=abc`),
    [`${STORAGE}/m.json?Signature=abc`]: json(200, manifest),
  });
  const client = createArtifactSourceClient({ platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm' }, { token: TOKEN, fetchImpl });
  const result = await client.fetchManifest({ artifactName: 'jetsrm', version: '2.5.0' });
  assert.deepEqual(result.manifest, manifest);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assertTokenOnlyOnApi(fetchImpl.calls, 'https://api.bitbucket.org');
});

test('bitbucket: basic auth uses email:token', async () => {
  const fetchImpl = fakeFetch({ [`${BB}/downloads/jetsrm-2.5.0-manifest.json`]: json(200, manifest) });
  const client = createArtifactSourceClient(
    { platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm', authType: 'basic' },
    { token: TOKEN, username: 'dev@mdp.com', fetchImpl }
  );
  await client.fetchManifest({ artifactName: 'jetsrm', version: '2.5.0' });
  assert.equal(fetchImpl.calls[0].headers.authorization, `Basic ${Buffer.from(`dev@mdp.com:${TOKEN}`).toString('base64')}`);
});

test('bitbucket: resolveArtifacts pages the downloads list (same-origin next only) and checks sizes', async () => {
  const fetchImpl = fakeFetch({
    [`${BB}/downloads?pagelen=100`]: json(200, {
      values: [{ name: 'jetsrm-backend-2.5.0-win-x64.tar.gz', size: 11 }, { name: 'other.tar.gz', size: 1 }],
      next: `${BB}/downloads?pagelen=100&page=2`,
    }),
    [`${BB}/downloads?pagelen=100&page=2`]: json(200, {
      values: [{ name: 'jetsrm-frontend-2.5.0.tar.gz', size: 5 }],
      next: 'https://evil.example/steal',
    }),
  });
  const client = createArtifactSourceClient({ platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm' }, { token: TOKEN, fetchImpl });
  const resolved = await client.resolveArtifacts(manifest.artifacts, {});
  assert.deepEqual(resolved.map((a) => a.sourceRef), ['jetsrm-backend-2.5.0-win-x64.tar.gz', 'jetsrm-frontend-2.5.0.tar.gz']);
  assert.ok(fetchImpl.calls.every((c) => !c.url.includes('evil.example')));

  const wrongSize = fakeFetch({
    [`${BB}/downloads?pagelen=100`]: json(200, {
      values: [{ name: 'jetsrm-backend-2.5.0-win-x64.tar.gz', size: 99 }, { name: 'jetsrm-frontend-2.5.0.tar.gz', size: 5 }],
    }),
  });
  const sizeClient = createArtifactSourceClient({ platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm' }, { token: TOKEN, fetchImpl: wrongSize });
  await assert.rejects(sizeClient.resolveArtifacts(manifest.artifacts, {}), /size differs/);

  const missing = fakeFetch({ [`${BB}/downloads?pagelen=100`]: json(200, { values: [] }) });
  const missingClient = createArtifactSourceClient({ platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm' }, { token: TOKEN, fetchImpl: missing });
  await assert.rejects(missingClient.resolveArtifacts(manifest.artifacts, {}), /missing from Bitbucket Downloads/);
});

test('bitbucket: artifact body streams through a redirect without the token', async () => {
  const fetchImpl = fakeFetch({
    [`${BB}/downloads/jetsrm-backend-2.5.0-win-x64.tar.gz`]: redirect(`${STORAGE}/b.tgz?Expires=1&Signature=s`, 307),
    [`${STORAGE}/b.tgz?Expires=1&Signature=s`]: () => new Response(chunkedBody(['hello', ' ', 'world']), {
      status: 200,
      headers: { 'content-length': '11' },
    }),
  });
  const client = createArtifactSourceClient({ platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm' }, { token: TOKEN, fetchImpl });
  const { stream, contentLength } = await client.openArtifactStream('jetsrm-backend-2.5.0-win-x64.tar.gz');
  assert.equal(contentLength, 11);
  assert.equal(await readAll(stream), 'hello world');
  assertTokenOnlyOnApi(fetchImpl.calls, 'https://api.bitbucket.org');
});

test('bitbucket: missing file → notFound; non-https redirect and redirect loops are refused', async () => {
  const client = (routes) => createArtifactSourceClient(
    { platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm' },
    { token: TOKEN, fetchImpl: fakeFetch(routes) }
  );
  await assert.rejects(
    client({}).fetchManifest({ artifactName: 'jetsrm', version: '9.9.9' }),
    (err) => err.notFound === true && /jetsrm-9\.9\.9-manifest\.json was not found/.test(err.message)
  );
  await assert.rejects(client({}).openArtifactStream('x.tar.gz'), (err) => err.notFound === true);
  await assert.rejects(
    client({ [`${BB}/downloads/x.tar.gz`]: redirect('http://plain.example/x') }).openArtifactStream('x.tar.gz'),
    /only https/
  );
  const loop = { [`${BB}/downloads/x.tar.gz`]: redirect(`${BB}/downloads/x.tar.gz`) };
  await assert.rejects(client(loop).openArtifactStream('x.tar.gz'), /too many redirects/);
  assert.throws(() => client({}).openArtifactStream('../etc/passwd'), /Invalid Bitbucket download reference/);
});

test('errors never contain the token or a signed URL', async () => {
  const fetchImpl = fakeFetch({
    [`${BB}/downloads/jetsrm-2.5.0-manifest.json`]: json(403, { error: { message: `denied for token ${TOKEN}` } }),
    [`${BB}/downloads/x.tar.gz`]: redirect(`${STORAGE}/x?Signature=SIGNED-SECRET`),
    [`${STORAGE}/x?Signature=SIGNED-SECRET`]: json(500, { message: 'storage down' }),
  });
  const client = createArtifactSourceClient({ platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm' }, { token: TOKEN, fetchImpl });
  await assert.rejects(client.fetchManifest({ artifactName: 'jetsrm', version: '2.5.0' }), (err) => {
    assert.ok(!err.message.includes(TOKEN), err.message);
    assert.match(err.message, /HTTP 403/);
    return true;
  });
  await assert.rejects(client.openArtifactStream('x.tar.gz'), (err) => {
    assert.ok(!err.message.includes('SIGNED-SECRET'), err.message);
    return true;
  });
});

test('refuses a non-https API base URL and a missing token', () => {
  assert.throws(
    () => createArtifactSourceClient({ platform: 'bitbucket', owner: 'o', repo: 'r', baseUrl: 'http://bitbucket.local' }, { token: TOKEN }),
    /https/
  );
  assert.throws(() => createArtifactSourceClient({ platform: 'github', owner: 'o', repo: 'r' }, { token: '' }), /token/);
  assert.throws(() => createArtifactSourceClient({ platform: 'gitlab', owner: 'o', repo: 'r' }, { token: TOKEN }), /Unsupported/);
});

// ------------------------------------------------------------------- GitHub

function githubRoutes() {
  return {
    [`${GH}/releases/tags/v2.5.0`]: json(404, { message: 'Not Found' }),
    [`${GH}/releases/tags/2.5.0`]: json(200, {
      id: 77,
      tag_name: '2.5.0',
      assets: [
        { id: 1001, name: 'jetsrm-2.5.0-manifest.json', size: 400 },
        { id: 1002, name: 'jetsrm-backend-2.5.0-win-x64.tar.gz', size: 11 },
        { id: 1003, name: 'jetsrm-frontend-2.5.0.tar.gz', size: 5 },
      ],
    }),
    [`${GH}/releases/assets/1001`]: (_url, init) => (init.headers.Accept === 'application/octet-stream'
      ? redirect(`${GH_STORAGE}/manifest?sig=1`)
      : json(200, { id: 1001, name: 'metadata-not-content' })),
    [`${GH_STORAGE}/manifest?sig=1`]: json(200, manifest),
    [`${GH}/releases/assets/1002`]: redirect(`${GH_STORAGE}/backend?sig=2`),
    [`${GH_STORAGE}/backend?sig=2`]: () => new Response(chunkedBody(['hello', ' world']), { status: 200 }),
  };
}

test('github: release by tag (v-prefix, then plain), manifest asset via octet-stream redirect', async () => {
  const fetchImpl = fakeFetch(githubRoutes());
  const client = createArtifactSourceClient({ platform: 'github', owner: 'mdp', repo: 'jetsrm' }, { token: TOKEN, fetchImpl });
  const result = await client.fetchManifest({ artifactName: 'jetsrm', version: '2.5.0' });
  assert.deepEqual(result.manifest, manifest);
  assert.equal(result.manifestRef, '1001');
  assert.deepEqual(fetchImpl.calls.map((c) => c.url), [
    `${GH}/releases/tags/v2.5.0`,
    `${GH}/releases/tags/2.5.0`,
    `${GH}/releases/assets/1001`,
    `${GH_STORAGE}/manifest?sig=1`,
  ]);
  assertTokenOnlyOnApi(fetchImpl.calls, 'https://api.github.com');

  const resolved = await client.resolveArtifacts(manifest.artifacts, result.context);
  assert.deepEqual(resolved.map((a) => a.sourceRef), ['1002', '1003']);
});

test('github: artifact asset streams through the storage redirect without the token', async () => {
  const fetchImpl = fakeFetch(githubRoutes());
  const client = createArtifactSourceClient({ platform: 'github', owner: 'mdp', repo: 'jetsrm' }, { token: TOKEN, fetchImpl });
  const { stream, contentLength } = await client.openArtifactStream('1002');
  assert.equal(contentLength, null);
  assert.equal(await readAll(stream), 'hello world');
  assert.equal(fetchImpl.calls[0].headers.accept, 'application/octet-stream');
  assertTokenOnlyOnApi(fetchImpl.calls, 'https://api.github.com');
  assert.throws(() => client.openArtifactStream('../1'), /Invalid GitHub asset reference/);
});

test('github: missing release or manifest asset is reported as notFound', async () => {
  const noRelease = createArtifactSourceClient({ platform: 'github', owner: 'mdp', repo: 'jetsrm' }, { token: TOKEN, fetchImpl: fakeFetch({}) });
  await assert.rejects(noRelease.fetchManifest({ artifactName: 'jetsrm', version: '3.0.0' }),
    (err) => err.notFound && /No GitHub release tagged 'v3\.0\.0' or '3\.0\.0'/.test(err.message));

  const routes = githubRoutes();
  routes[`${GH}/releases/tags/v2.5.0`] = json(200, { id: 1, assets: [] });
  const noAsset = createArtifactSourceClient({ platform: 'github', owner: 'mdp', repo: 'jetsrm' }, { token: TOKEN, fetchImpl: fakeFetch(routes) });
  await assert.rejects(noAsset.fetchManifest({ artifactName: 'jetsrm', version: '2.5.0' }), (err) => err.notFound === true);
});
