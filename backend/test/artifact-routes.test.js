/**
 * Artifact deploy HTTP routes (routes/artifacts.js):
 *  - RBAC on every route (no session → 401, role too low → 403),
 *  - Prod target confirmation, IDP_PUBLIC_URL 503, body validation, error mapping,
 *  - GET /api/artifacts/:id/download with REAL token + download services and
 *    the real source client over a fake fetch (Bitbucket and GitHub 302 →
 *    storage): token-only auth (no session), streaming, headers, audit
 *    without the token.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { createArtifactRoutes } = require('../src/routes/artifacts');
const { openDatabase } = require('../src/store/db');
const { createArtifactDeployRepository } = require('../src/store/artifactDeployRepository');
const { createDownloadTokenService } = require('../src/core/artifacts/downloadTokens');
const { createArtifactDownloadService } = require('../src/core/artifacts/artifactDownloadService');
const { createArtifactSourceClient } = require('../src/core/artifacts/artifactSourceClient');
const { deriveArtifactUploadToken } = require('../src/auth/artifactUploadToken');
const { ConflictError, UpstreamError, NotFoundError } = require('../src/core/errors');

const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

function fakeSession(req, _res, next) {
  const role = req.get('x-test-role');
  req.session = role ? { user: { username: `user-${role}`, role } } : {};
  next();
}

function fakeAudit() {
  const entries = [];
  return { entries, log: (user, action, description, metadata, options) => entries.push({ user, action, description, metadata, options }) };
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

// --------------------------------------------------------------- API routes

const TARGETS = {
  tgt_dev: { id: 'tgt_dev', projectId: 'p1', name: 'temsa-test', environment: 'Dev' },
  tgt_prod: { id: 'tgt_prod', projectId: 'p1', name: 'temsa', environment: 'Prod' },
};

function fakeServices() {
  const calls = [];
  const record = (name, value) => (...args) => {
    calls.push({ name, args });
    return typeof value === 'function' ? value(...args) : value;
  };
  return {
    calls,
    releaseService: {
      listReleases: record('listReleases', []),
      createRelease: record('createRelease', async () => ({ release: { id: 'rel_1' }, deploymentId: 'deploy_b' })),
      importRelease: record('importRelease', async () => ({ id: 'rel_1', status: 'ready' })),
      getRelease: record('getRelease', { id: 'rel_1' }),
      deleteRelease: record('deleteRelease', undefined),
    },
    targetService: {
      listTargets: record('listTargets', []),
      getTarget: record('getTarget', (id) => {
        if (!TARGETS[id]) throw new NotFoundError('Deploy target not found');
        return TARGETS[id];
      }),
      createTarget: record('createTarget', async () => ({ id: 'tgt_new' })),
      updateTarget: record('updateTarget', async () => ({ id: 'tgt_dev' })),
      deleteTarget: record('deleteTarget', undefined),
      refreshStatus: record('refreshStatus', async () => ({ id: 'tgt_dev' })),
    },
    artifactDeployService: {
      deploy: record('deploy', async () => ({ deploymentId: 'deploy_d', deployId: 'dep_1' })),
      rollback: record('rollback', async () => ({ deploymentId: 'deploy_r', deployId: 'dep_2' })),
      applyConfig: record('applyConfig', async () => ({ deploymentId: 'deploy_c', deployId: 'dep_3' })),
      listEvents: record('listEvents', []),
    },
    uploadService: {
      uploadArtifact: record('uploadArtifact', async ({ fileName, sha256, contentLength, stream }) => {
        for await (const _chunk of stream) { /* drain the raw upload */ }
        return { fileName, sha256, size: contentLength, staged: true, idempotent: false };
      }),
      finalizeRelease: record('finalizeRelease', async ({ version, manifest }) => ({
        id: 'rel_upload', version, manifest, status: 'ready', artifacts: manifest.artifacts, idempotent: false, pruned: [],
      })),
    },
    downloadService: { authorize: () => null, open: async () => { throw new Error('unused'); } },
  };
}

async function startApi({
  services = fakeServices(),
  publicUrl = 'https://idp.example',
  audit = fakeAudit(),
  upload = { token: 'U'.repeat(32), maxArtifactBytes: 1024 },
} = {}) {
  const routes = createArtifactRoutes({
    services,
    getProject: () => ({ id: 'p1', name: 'JetSRM', environment: 'Dev' }),
    auditLogger: audit,
    publicUrl,
    publicUrlError: publicUrl ? null : 'IDP_PUBLIC_URL tanımlı değil.',
    upload,
  });
  const app = express();
  app.use(express.json());
  app.use(fakeSession);
  app.use(routes.downloadRouter);
  app.use(routes.uploadRouter);
  app.use(routes.apiRouter);
  return { base: await listen(app), services, audit };
}

function call(base, method, pathname, { role, body, headers = {} } = {}) {
  return fetch(`${base}${pathname}`, {
    method,
    headers: { ...(role ? { 'x-test-role': role } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const ROLE_ORDER = ['viewer', 'deployer', 'admin'];
const MATRIX = [
  ['GET', '/api/projects/p1/releases', null, 'viewer', 200],
  ['POST', '/api/projects/p1/releases', { version: '2.5.0' }, 'deployer', 202],
  ['POST', '/api/projects/p1/releases/import', { version: '2.5.0' }, 'deployer', 200],
  ['GET', '/api/releases/rel_1', null, 'viewer', 200],
  ['DELETE', '/api/releases/rel_1', null, 'admin', 204],
  ['GET', '/api/projects/p1/targets', null, 'viewer', 200],
  ['POST', '/api/projects/p1/targets', { name: 'x', agentId: 'WIN-01', os: 'windows' }, 'admin', 201],
  ['PUT', '/api/targets/tgt_dev', { name: 'y' }, 'admin', 200],
  ['DELETE', '/api/targets/tgt_dev', null, 'admin', 204],
  ['POST', '/api/targets/tgt_dev/refresh-status', null, 'deployer', 200],
  ['POST', '/api/targets/tgt_dev/deploy', { releaseId: 'rel_1' }, 'deployer', 202],
  ['POST', '/api/targets/tgt_dev/rollback', {}, 'deployer', 202],
  ['POST', '/api/targets/tgt_dev/apply-config', {}, 'deployer', 202],
  ['GET', '/api/deployments/deploy_d/events', null, 'viewer', 200],
];

test('RBAC: every artifact route enforces its minimum role', async () => {
  const { base } = await startApi();
  for (const [method, pathname, body, minRole, okStatus] of MATRIX) {
    const label = `${method} ${pathname}`;
    assert.equal((await call(base, method, pathname, { body })).status, 401, `${label} without session`);
    for (const role of ROLE_ORDER) {
      const allowed = ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(minRole);
      const response = await call(base, method, pathname, { role, body });
      assert.equal(response.status, allowed ? okStatus : 403, `${label} as ${role}`);
    }
  }
});

test('target runtime config is cache-disabled and only resolved for admins', async () => {
  const services = fakeServices();
  const { base } = await startApi({ services });

  for (const [role, includeRuntimeConfig] of [['viewer', false], ['deployer', false], ['admin', true]]) {
    const response = await call(base, 'GET', '/api/projects/p1/targets', { role });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const invocation = services.calls.filter((entry) => entry.name === 'listTargets').at(-1);
    assert.deepEqual(invocation.args, ['p1', { includeRuntimeConfig }]);
  }

  const created = await call(base, 'POST', '/api/projects/p1/targets', {
    role: 'admin', body: { name: 'x', agentId: 'WIN-01', os: 'windows' },
  });
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const updated = await call(base, 'PUT', '/api/targets/tgt_dev', { role: 'admin', body: { name: 'y' } });
  assert.equal(updated.headers.get('cache-control'), 'no-store');
});

test('deploy/rollback: Prod targets require the target name; triggeredBy and publicUrl come from the server', async () => {
  const { base, services } = await startApi();
  const denied = await call(base, 'POST', '/api/targets/tgt_prod/deploy', { role: 'deployer', body: { releaseId: 'rel_1' } });
  assert.equal(denied.status, 400);
  assert.deepEqual(await denied.json(), {
    error: 'Production targets require typing the target name to confirm.', code: 'CONFIRMATION_REQUIRED', expected: 'temsa',
  });
  assert.equal((await call(base, 'POST', '/api/targets/tgt_prod/rollback', { role: 'deployer', body: {} })).status, 400);
  assert.equal((await call(base, 'POST', '/api/targets/tgt_prod/apply-config', { role: 'deployer', body: {} })).status, 400);
  assert.ok(!services.calls.some((c) => ['deploy', 'rollback', 'applyConfig'].includes(c.name)));

  const ok = await call(base, 'POST', '/api/targets/tgt_prod/deploy', {
    role: 'deployer', body: { releaseId: 'rel_1', components: ['backend'], confirmation: 'temsa' },
  });
  assert.equal(ok.status, 202);
  assert.deepEqual(await ok.json(), {
    deploymentId: 'deploy_d', deployId: 'dep_1', sseUrl: '/api/deploy/logs/deploy_d', eventsUrl: '/api/deployments/deploy_d/events',
  });
  const deployCall = services.calls.find((c) => c.name === 'deploy');
  assert.deepEqual(deployCall.args[0], {
    targetId: 'tgt_prod', releaseId: 'rel_1', components: ['backend'], triggeredBy: 'user-deployer', publicUrl: 'https://idp.example',
  });
  const config = await call(base, 'POST', '/api/targets/tgt_prod/apply-config', {
    role: 'deployer', body: { confirmation: 'temsa' },
  });
  assert.equal(config.status, 202);
  assert.deepEqual(await config.json(), {
    deploymentId: 'deploy_c', deployId: 'dep_3', sseUrl: '/api/deploy/logs/deploy_c', eventsUrl: '/api/deployments/deploy_c/events',
  });
  assert.deepEqual(services.calls.find((c) => c.name === 'applyConfig').args[0], {
    targetId: 'tgt_prod', triggeredBy: 'user-deployer',
  });
});

test('deploy: 503 without IDP_PUBLIC_URL; body validation; error mapping', async () => {
  const disabled = await startApi({ publicUrl: null });
  const response = await call(disabled.base, 'POST', '/api/targets/tgt_dev/deploy', { role: 'deployer', body: { releaseId: 'rel_1' } });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /IDP_PUBLIC_URL/);

  const services = fakeServices();
  const { base } = await startApi({ services });
  const bad = [
    ['POST', '/api/targets/tgt_dev/deploy', { releaseId: 'rel_1', hooks: { preStart: [] } }],
    ['POST', '/api/targets/tgt_dev/deploy', { releaseId: 'rel_1', components: ['../x'] }],
    ['POST', '/api/targets/tgt_dev/deploy', {}],
    ['POST', '/api/targets/tgt_dev/rollback', { components: 'backend' }],
    ['POST', '/api/targets/tgt_dev/apply-config', { components: ['backend'] }],
    ['POST', '/api/projects/p1/releases', { version: '../2.5.0' }],
    ['POST', '/api/projects/p1/releases', { version: '2.5.0', variables: { VERSION: 'x' } }],
    ['POST', '/api/projects/p1/releases/import', { version: '' }],
  ];
  for (const [method, pathname, body] of bad) {
    assert.equal((await call(base, method, pathname, { role: 'admin', body })).status, 400, `${pathname} ${JSON.stringify(body)}`);
  }
  assert.equal((await call(base, 'POST', '/api/targets/tgt_missing/deploy', { role: 'deployer', body: { releaseId: 'rel_1' } })).status, 404);

  services.artifactDeployService.deploy = async () => { throw new ConflictError('A deployment is already running on target.'); };
  assert.equal((await call(base, 'POST', '/api/targets/tgt_dev/deploy', { role: 'deployer', body: { releaseId: 'rel_1' } })).status, 409);
  services.targetService.refreshStatus = async () => { throw new UpstreamError('gateway down'); };
  assert.equal((await call(base, 'POST', '/api/targets/tgt_dev/refresh-status', { role: 'deployer' })).status, 502);
});

// ----------------------------------------------------------- CI upload route

test('CI upload is bearer-only, streams raw artifacts and finalizes a manifest', async () => {
  const services = fakeServices();
  const masterToken = 'U'.repeat(32);
  const token = deriveArtifactUploadToken(masterToken, 'p1');
  const { base } = await startApi({ services, upload: { token: masterToken, maxArtifactBytes: 1024 } });
  const body = Buffer.from('artifact');
  const sha256 = require('node:crypto').createHash('sha256').update(body).digest('hex');
  const url = `${base}/api/artifact-uploads/p1/2.5.0/jetsrm-frontend-2.5.0.tar.gz`;

  assert.equal((await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/gzip', 'x-artifact-sha256': sha256 }, body })).status, 401);
  assert.equal((await fetch(url, {
    method: 'PUT',
    headers: { authorization: 'Bearer wrong', 'content-type': 'application/gzip', 'x-artifact-sha256': sha256 },
    body,
  })).status, 401);
  assert.equal((await fetch(url, {
    method: 'PUT',
    headers: { authorization: `Bearer ${deriveArtifactUploadToken(masterToken, 'p2')}`, 'content-type': 'application/gzip', 'x-artifact-sha256': sha256 },
    body,
  })).status, 401);
  const uploaded = await fetch(url, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/gzip', 'x-artifact-sha256': sha256 },
    body,
  });
  assert.equal(uploaded.status, 201);
  assert.equal((await uploaded.json()).fileName, 'jetsrm-frontend-2.5.0.tar.gz');

  const manifest = {
    schema: 1, project: 'jetsrm', version: '2.5.0',
    artifacts: [{ component: 'frontend', os: 'any', file: 'jetsrm-frontend-2.5.0.tar.gz', sha256, size: body.length }],
  };
  const finalized = await fetch(`${base}/api/artifact-uploads/p1/2.5.0/finalize`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(finalized.status, 201);
  assert.equal((await finalized.json()).status, 'ready');
  assert.ok(services.calls.some((call) => call.name === 'uploadArtifact'));
  assert.ok(services.calls.some((call) => call.name === 'finalizeRelease'));
});

test('CI upload fails closed when disabled and rejects media type / declared oversize', async () => {
  const disabled = await startApi({ upload: { token: null, maxArtifactBytes: 4 } });
  const url = `${disabled.base}/api/artifact-uploads/p1/1.0.0/a.tar.gz`;
  assert.equal((await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/gzip' }, body: 'x' })).status, 503);

  const masterToken = 'U'.repeat(32);
  const enabled = await startApi({ upload: { token: masterToken, maxArtifactBytes: 4 } });
  const headers = { authorization: `Bearer ${deriveArtifactUploadToken(masterToken, 'p1')}`, 'x-artifact-sha256': 'a'.repeat(64) };
  assert.equal((await fetch(`${enabled.base}/api/artifact-uploads/p1/1.0.0/a.tar.gz`, {
    method: 'PUT', headers: { ...headers, 'content-type': 'text/plain' }, body: 'x',
  })).status, 415);
  assert.equal((await fetch(`${enabled.base}/api/artifact-uploads/p1/1.0.0/a.tar.gz`, {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/gzip' }, body: '12345',
  })).status, 413);
});

// ---------------------------------------------------------- download route

const SHA = 'e'.repeat(64);
const BODY = 'hello artifact';
const REPO_TOKEN = 'REPO-TOKEN-0123456789';

function sourceFetch(platform, { contentLength = String(Buffer.byteLength(BODY)), status = 200 } = {}) {
  const calls = [];
  const api = platform === 'bitbucket'
    ? 'https://api.bitbucket.org/2.0/repositories/mdp/jetsrm/downloads/jetsrm-backend-2.5.0-win-x64.tar.gz'
    : 'https://api.github.com/repos/mdp/jetsrm/releases/assets/4242';
  const storage = platform === 'bitbucket'
    ? 'https://bbuseruploads.s3.amazonaws.com/obj?Signature=signed'
    : 'https://objects.githubusercontent.com/obj?sig=signed';
  const impl = async (url, init = {}) => {
    calls.push({ url, authorization: init.headers && init.headers.Authorization });
    if (url === api) return new Response(null, { status: 302, headers: { location: storage } });
    if (url === storage) {
      if (status !== 200) return new Response('gone', { status });
      const chunks = [BODY.slice(0, 5), BODY.slice(5)];
      let i = 0;
      const stream = new ReadableStream({
        pull(controller) {
          if (i < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[i++]));
          else controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: contentLength ? { 'content-length': contentLength } : {} });
    }
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

async function startDownload(platform, fetchOptions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-download-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  cleanups.push(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const repository = createArtifactDeployRepository(db);
  const tokens = createDownloadTokenService({ repository });
  const project = {
    id: 'p1',
    name: 'JetSRM',
    config: { artifactDeploy: { source: { platform, owner: 'mdp', repo: 'jetsrm', token: REPO_TOKEN } } },
  };
  const release = repository.createRelease({
    projectId: 'p1', version: '2.5.0', status: 'ready', sourcePlatform: platform,
    manifest: { schema: 1, project: 'jetsrm', version: '2.5.0', artifacts: [] },
  });
  const [artifact, other] = repository.replaceArtifacts(release.id, [
    {
      component: 'backend', os: 'win-x64', file: 'jetsrm-backend-2.5.0-win-x64.tar.gz', sha256: SHA,
      size: Buffer.byteLength(BODY), sourceRef: platform === 'bitbucket' ? 'jetsrm-backend-2.5.0-win-x64.tar.gz' : '4242',
    },
    { component: 'frontend', os: 'any', file: 'jetsrm-frontend-2.5.0.tar.gz', sha256: SHA, size: 3, sourceRef: 'f' },
  ]);
  const fetchImpl = sourceFetch(platform, fetchOptions);
  const downloadService = createArtifactDownloadService({
    repository,
    tokens,
    getProject: () => project,
    resolveSecrets: async (p) => p,
    createSourceClient: (source, credentials) => createArtifactSourceClient(source, { ...credentials, fetchImpl }),
  });
  const audit = fakeAudit();
  const routes = createArtifactRoutes({
    services: { ...fakeServices(), downloadService },
    getProject: () => project,
    auditLogger: audit,
    publicUrl: 'https://idp.example',
  });
  // Deliberately NO session middleware: the route must work on the token alone.
  const app = express();
  app.use(routes.downloadRouter);
  const base = await listen(app);
  const token = tokens.issue({ artifactId: artifact.id, agentId: 'WIN-01', deploymentId: 'deploy_x' });
  return { base, artifact, other, token, tokens, audit, fetchImpl };
}

for (const platform of ['bitbucket', 'github']) {
  test(`download (${platform}): token-only auth, streamed body through the storage redirect, headers, audit`, async () => {
    const env = await startDownload(platform);
    const response = await fetch(`${env.base}/api/artifacts/${env.artifact.id}/download`, {
      headers: { authorization: `Bearer ${env.token}`, 'x-idp-agent-id': 'WIN-01' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/gzip');
    assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(BODY)));
    assert.equal(response.headers.get('x-artifact-sha256'), SHA);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), BODY);

    // The repository token went only to the API host, never to storage.
    assert.equal(env.fetchImpl.calls.length, 2);
    assert.match(String(env.fetchImpl.calls[0].authorization), /REPO-TOKEN/);
    assert.equal(env.fetchImpl.calls[1].authorization, undefined);

    const downloaded = env.audit.entries.find((e) => e.action === 'ARTIFACT_DOWNLOADED');
    assert.equal(downloaded.metadata.artifactId, env.artifact.id);
    assert.equal(downloaded.metadata.agentId, 'WIN-01');
    assert.equal(downloaded.metadata.deploymentId, 'deploy_x');
    assert.ok(!JSON.stringify(env.audit.entries).includes(env.token), 'the download token is never audited');
    assert.ok(!JSON.stringify(env.audit.entries).includes(REPO_TOKEN));
  });
}

test('download: missing/invalid/misbound/expired tokens are a bare 401', async () => {
  const env = await startDownload('bitbucket');
  const url = `${env.base}/api/artifacts/${env.artifact.id}/download`;
  const cases = [
    [url, {}],
    [`${url}?token=${env.token}`, {}],
    [url, { authorization: `Basic ${env.token}` }],
    [url, { authorization: 'Bearer wrong' }],
    [url, { authorization: `Bearer ${env.token}`, 'x-idp-agent-id': 'WIN-99' }],
    [`${env.base}/api/artifacts/${env.other.id}/download`, { authorization: `Bearer ${env.token}` }],
    [`${env.base}/api/artifacts/not-an-id/download`, { authorization: `Bearer ${env.token}` }],
  ];
  for (const [target, headers] of cases) {
    const response = await fetch(target, { headers });
    assert.equal(response.status, 401, `${target} ${JSON.stringify(headers)}`);
    assert.deepEqual(await response.json(), { error: 'Unauthorized' });
  }
  assert.equal(env.fetchImpl.calls.length, 0, 'the source is never contacted without a valid token');
  assert.ok(env.audit.entries.every((e) => e.action === 'ARTIFACT_DOWNLOAD_REJECTED'));
  assert.ok(!JSON.stringify(env.audit.entries).includes(env.token));

  env.tokens.revokeForDeployment('deploy_x');
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${env.token}` } })).status, 401);
});

test('download: source failure or size mismatch → 502, never a wrong body', async () => {
  const mismatch = await startDownload('bitbucket', { contentLength: '999' });
  const response = await fetch(`${mismatch.base}/api/artifacts/${mismatch.artifact.id}/download`, {
    headers: { authorization: `Bearer ${mismatch.token}` },
  });
  assert.equal(response.status, 502);
  assert.ok(mismatch.audit.entries.some((e) => e.action === 'ARTIFACT_DOWNLOAD_FAILED'));

  const gone = await startDownload('github', { status: 404 });
  const goneResponse = await fetch(`${gone.base}/api/artifacts/${gone.artifact.id}/download`, {
    headers: { authorization: `Bearer ${gone.token}` },
  });
  assert.equal(goneResponse.status, 502);
  assert.deepEqual(await goneResponse.json(), { error: 'The artifact source is unavailable.' });
});
