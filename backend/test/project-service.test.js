/**
 * Tests for core/projects/projectService.js (T-58).
 *
 * The point of extracting this module out of server.js was to make project
 * CRUD callable without Express in the picture at all — these tests prove
 * exactly that: every call here goes straight into projectService, no HTTP
 * request/response objects anywhere.
 *
 * Isolation: this file never touches the real backend/src/idp.db. The
 * `IDP_DB_PATH` override is set once per test process by
 * `test/helpers/isolateDb.js` (loaded via `node --require` in the `test`
 * npm script, before any test file — including this one — runs), and
 * `store/projectRepository.js`'s module-level singleton binds to it lazily
 * on first use. No per-test setup is needed here beyond that.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const projectService = require('../src/core/projects/projectService');
const { NotFoundError } = require('../src/core/errors');
const artifactRepository = require('../src/store/artifactDeployRepository');
const { getDb } = require('../src/store/db');

const ACTOR = 'test-actor';

/** @returns {{name: string, tenant: string, environment: string, provider: string}} */
function sampleInput(overrides = {}) {
  return {
    name: `Test Project ${Date.now()}-${Math.random().toString(36).slice(2)}`,
    tenant: 'Tenant QA',
    environment: 'Dev',
    provider: 'Server',
    ...overrides,
  };
}

/**
 * createProject() ids are `Date.now().toString()` — unchanged core
 * behavior this suite must not paper over. In production, real HTTP
 * round-trips space consecutive creates apart by more than a millisecond;
 * a tight test loop can call createProject() twice within the same
 * millisecond and collide on `projects.id`. Busy-wait to the next
 * millisecond boundary so every project this suite creates gets a
 * distinct id, without changing (or mocking) projectService's id scheme.
 */
function waitForNextMillisecond() {
  const start = Date.now();
  while (Date.now() === start) {
    // intentionally empty — sub-millisecond busy-wait
  }
}

function createTestProject(overrides = {}) {
  waitForNextMillisecond();
  return projectService.createProject(sampleInput(overrides), ACTOR);
}

test('createProject creates a project and returns it redacted (no secrets, an id, Idle status)', () => {
  const input = sampleInput();
  const created = createTestProject(input);

  assert.equal(created.name, input.name);
  assert.equal(created.tenant, input.tenant);
  assert.equal(created.environment, input.environment);
  assert.equal(created.provider, input.provider);
  assert.equal(created.status, 'Idle');
  assert.ok(created.id, 'created project must have an id');
  assert.deepEqual(created.config, { hasPassword: false, hasApiToken: false });
});

test('listProjects includes a newly created project, redacted', () => {
  const created = createTestProject();

  const list = projectService.listProjects();
  const found = list.find((p) => p.id === created.id);

  assert.ok(found, 'newly created project must appear in listProjects()');
  assert.equal(found.name, created.name);
});

test('getProject returns the raw project by id', () => {
  const created = createTestProject();

  const fetched = projectService.getProject(created.id);
  assert.equal(fetched.id, created.id);
  assert.equal(fetched.name, created.name);
});

test('getProject throws NotFoundError for an unknown id', () => {
  assert.throws(
    () => projectService.getProject('does-not-exist'),
    (err) => err instanceof NotFoundError && err.message === 'Project not found'
  );
});

test('findProjectById returns null (not a throw) for an unknown id', () => {
  assert.equal(projectService.findProjectById('does-not-exist'), null);
});

test('updateProjectConfig merges settings and redacts the response', async () => {
  const created = createTestProject();

  const updated = await projectService.updateProjectConfig(
    created.id,
    { host: '10.0.0.5', username: 'deployer', password: 'super-secret-1' },
    ACTOR
  );

  assert.equal(updated.config.host, '10.0.0.5');
  assert.equal(updated.config.username, 'deployer');
  assert.equal(updated.config.password, undefined, 'redacted response must never carry the plaintext secret');
  assert.equal(updated.config.hasPassword, true, 'redacted response must flag that a secret is stored');
});

test('updateProjectConfig preserves a stored secret when the client resubmits it blank', async () => {
  const created = createTestProject();

  await projectService.updateProjectConfig(
    created.id,
    { host: '10.0.0.5', username: 'deployer', password: 'super-secret-2' },
    ACTOR
  );

  // Simulates the real client flow: the UI never receives the plaintext
  // password back (only hasPassword: true), so a save that doesn't touch
  // the credential resubmits an empty string for it.
  const secondUpdate = await projectService.updateProjectConfig(
    created.id,
    { host: '10.0.0.6', username: 'deployer', password: '' },
    ACTOR
  );

  assert.equal(secondUpdate.config.host, '10.0.0.6', 'unrelated field must still update');
  assert.equal(secondUpdate.config.hasPassword, true, 'blank resubmission must not clear the stored secret');

  // Verify against the raw (unredacted) project that the actual stored
  // value is still the original secret, not overwritten with ''.
  const raw = projectService.getProject(created.id);
  assert.notEqual(raw.config.password, '', 'the underlying stored credential must not have been blanked out');
  assert.ok(raw.config.password, 'the underlying stored credential must still be present');
});

test('updateProjectConfig throws NotFoundError for an unknown project id', async () => {
  await assert.rejects(
    () => projectService.updateProjectConfig('does-not-exist', { host: 'x' }, ACTOR),
    (err) => err instanceof NotFoundError && err.message === 'Project not found'
  );
});

test('getProjectEnvironments reports no configured overrides for a project with a bare config', () => {
  const created = createTestProject();

  const envs = projectService.getProjectEnvironments(created.id);
  assert.deepEqual(envs, { configured: [], hasOverrides: false });
});

test('getProjectEnvironments throws NotFoundError for an unknown project id', () => {
  assert.throws(
    () => projectService.getProjectEnvironments('does-not-exist'),
    (err) => err instanceof NotFoundError
  );
});

test('deleteProject removes the project from listProjects() and getProject()', async () => {
  const created = createTestProject();

  await projectService.deleteProject(created.id, ACTOR);

  assert.equal(projectService.findProjectById(created.id), null);
  assert.equal(
    projectService.listProjects().some((p) => p.id === created.id),
    false,
    'deleted project must not appear in listProjects()'
  );
  assert.throws(() => projectService.getProject(created.id), NotFoundError);
});

test('deleteProject removes artifact releases, targets, artifacts and download tokens', async () => {
  const created = createTestProject();
  const release = artifactRepository.createRelease({
    projectId: created.id,
    version: '1.0.0',
    status: 'ready',
  });
  const [artifact] = artifactRepository.replaceArtifacts(release.id, [{
    component: 'backend',
    os: 'win-x64',
    file: 'backend.tar.gz',
    sha256: 'a'.repeat(64),
    size: 10,
    sourceRef: 'backend.tar.gz',
  }]);
  const agentId = `AGENT-${created.id}`;
  artifactRepository.createTarget({
    projectId: created.id,
    name: 'test-target',
    agentId,
    os: 'windows',
  });
  artifactRepository.insertToken({
    tokenHash: 'b'.repeat(64),
    artifactId: artifact.id,
    agentId,
    deploymentId: 'dep-delete-project',
    expiresAt: Date.now() + 60_000,
    maxUses: 5,
  });

  await projectService.deleteProject(created.id, ACTOR);

  assert.equal(artifactRepository.findRelease(release.id), null);
  assert.equal(artifactRepository.findArtifact(artifact.id), null);
  assert.equal(artifactRepository.findTargetByAgent(agentId), null);
  const db = getDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM artifact_download_tokens WHERE artifact_id = ?').get(artifact.id).count, 0);
});

test('deleteProject throws NotFoundError for an unknown project id', async () => {
  await assert.rejects(
    () => projectService.deleteProject('does-not-exist', ACTOR),
    (err) => err instanceof NotFoundError && err.message === 'Project not found'
  );
});
