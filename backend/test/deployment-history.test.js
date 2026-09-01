/**
 * Tests for deploymentRepository — persisted deployment history (T-54).
 *
 * Before this, DeploymentManager kept every deployment only in memory and
 * dropped it an hour after it finished: a closed SSE stream could never be
 * reopened, and a server restart lost the entire history. These tests
 * cover the SQLite-backed replacement in isolation from DeploymentManager
 * itself (which has its own tests in deployment-manager.test.js).
 *
 * Follows the same pattern as store.test.js: every test opens its own
 * throwaway database file under a fresh `fs.mkdtemp()` directory and tears
 * it down afterwards — none of this touches the real src/idp.db.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/store/db');
const { createDeploymentRepository, truncateLogText, MAX_LOG_LINES, MAX_LOG_BYTES } = require('../src/store/deploymentRepository');

/** Opens a fresh throwaway DB under its own temp dir; returns db + cleanup. */
function withTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-deploy-history-test-'));
  const dbPath = path.join(dir, 'test.db');
  const db = openDatabase(dbPath);
  return {
    dbPath,
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const sampleDeployment = (overrides = {}) => ({
  id: 'deploy-1',
  projectId: 'proj-1',
  status: 'running',
  startedAt: '2026-08-10T12:00:00.000Z',
  triggeredBy: 'alice',
  environment: 'Production',
  ...overrides,
});

// ---------------------------------------------------------------------------
// create -> finish -> findById round-trip
// ---------------------------------------------------------------------------

test('deploymentRepository: create -> finish -> findById round-trip', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repo = createDeploymentRepository(db);

    assert.equal(repo.findById('deploy-1'), null);

    const created = repo.create(sampleDeployment());
    assert.equal(created.id, 'deploy-1');
    assert.equal(created.projectId, 'proj-1');
    assert.equal(created.status, 'running');
    assert.equal(created.triggeredBy, 'alice');
    assert.equal(created.environment, 'Production');
    assert.equal(created.finishedAt, null);
    assert.equal(created.durationMs, null);
    assert.equal(created.error, null);
    assert.equal(created.logText, null);

    const finished = repo.finish('deploy-1', {
      status: 'succeeded',
      finishedAt: '2026-08-10T12:05:00.000Z',
      durationMs: 300000,
      error: null,
    });

    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.finishedAt, '2026-08-10T12:05:00.000Z');
    assert.equal(finished.durationMs, 300000);

    const fetched = repo.findById('deploy-1');
    assert.deepEqual(fetched, finished);

    assert.equal(repo.finish('does-not-exist', { status: 'failed' }), null, 'finish() on an unknown id returns null');
  } finally {
    cleanup();
  }
});

test('deploymentRepository: no method mutates its input object', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repo = createDeploymentRepository(db);
    const input = sampleDeployment();
    const inputSnapshot = JSON.stringify(input);

    repo.create(input);
    assert.equal(JSON.stringify(input), inputSnapshot, 'create() must not mutate its argument');

    const patch = { status: 'failed', error: 'boom' };
    const patchSnapshot = JSON.stringify(patch);
    repo.finish('deploy-1', patch);
    assert.equal(JSON.stringify(patch), patchSnapshot, 'finish() must not mutate its patch argument');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// listRecent ordering + limit
// ---------------------------------------------------------------------------

test('deploymentRepository.listRecent: newest first, respects limit', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repo = createDeploymentRepository(db);

    repo.create(sampleDeployment({ id: 'd-1', startedAt: '2026-08-10T10:00:00.000Z' }));
    repo.create(sampleDeployment({ id: 'd-2', startedAt: '2026-08-10T12:00:00.000Z' }));
    repo.create(sampleDeployment({ id: 'd-3', startedAt: '2026-08-10T11:00:00.000Z' }));

    const all = repo.listRecent(50);
    assert.deepEqual(all.map((d) => d.id), ['d-2', 'd-3', 'd-1'], 'newest startedAt first');

    const limited = repo.listRecent(2);
    assert.deepEqual(limited.map((d) => d.id), ['d-2', 'd-3']);

    // Summary rows must not carry the (potentially large) log body.
    assert.equal('logText' in all[0], false);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// listByProject filtering
// ---------------------------------------------------------------------------

test('deploymentRepository.listByProject: filters to one project, newest first', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repo = createDeploymentRepository(db);

    repo.create(sampleDeployment({ id: 'd-1', projectId: 'proj-a', startedAt: '2026-08-10T10:00:00.000Z' }));
    repo.create(sampleDeployment({ id: 'd-2', projectId: 'proj-b', startedAt: '2026-08-10T11:00:00.000Z' }));
    repo.create(sampleDeployment({ id: 'd-3', projectId: 'proj-a', startedAt: '2026-08-10T12:00:00.000Z' }));

    const projectA = repo.listByProject('proj-a', 50);
    assert.deepEqual(projectA.map((d) => d.id), ['d-3', 'd-1']);

    const projectC = repo.listByProject('proj-c', 50);
    assert.deepEqual(projectC, [], 'a project with no deployments returns an empty list');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Log truncation
// ---------------------------------------------------------------------------

test('truncateLogText: caps a 6000-line body down to the last 5000 lines with a marker', () => {
  const lines = Array.from({ length: 6000 }, (_, i) => `line-${i}`);
  const { text, truncated } = truncateLogText(lines.join('\n'));

  assert.equal(truncated, true);
  assert.ok(text.startsWith('[truncated'), 'marker is prepended');

  const bodyLines = text.split('\n');
  // First line is the marker, the rest is the kept log body.
  assert.equal(bodyLines.length - 1, MAX_LOG_LINES);
  // The kept lines are the *last* 5000 — the most recent output.
  assert.equal(bodyLines[1], 'line-1000');
  assert.equal(bodyLines[bodyLines.length - 1], 'line-5999');
});

test('truncateLogText: leaves a short body untouched, no marker', () => {
  const { text, truncated } = truncateLogText('one\ntwo\nthree');
  assert.equal(truncated, false);
  assert.equal(text, 'one\ntwo\nthree');
});

test('truncateLogText: also enforces the 1 MiB byte cap', () => {
  // 2000 lines of 1000 bytes each = ~2 MiB, well under the 5000-line cap
  // but over the byte cap.
  const bigLine = 'x'.repeat(1000);
  const lines = Array.from({ length: 2000 }, (_, i) => `${bigLine}-${i}`);
  const { text, truncated } = truncateLogText(lines.join('\n'));

  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_LOG_BYTES + 200, 'stays close to the byte budget (plus marker overhead)');
  assert.ok(text.endsWith(`-1999`), 'keeps the tail (most recent) content');
});

test('deploymentRepository.appendLogs: stores the truncated body and round-trips via findById', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repo = createDeploymentRepository(db);
    repo.create(sampleDeployment());

    const lines = Array.from({ length: 6000 }, (_, i) => `line-${i}`);
    const updated = repo.appendLogs('deploy-1', lines.join('\n'));

    assert.ok(updated.logText.startsWith('[truncated: showing last 5000 lines]'));
    assert.equal(repo.findById('deploy-1').logText, updated.logText);

    assert.equal(repo.appendLogs('does-not-exist', 'x'), null, 'appendLogs() on an unknown id returns null');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// A deployment that never finished still shows up as "running"
// ---------------------------------------------------------------------------

test('a deployment with no finish() call shows up as "running" in listRecent', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repo = createDeploymentRepository(db);
    repo.create(sampleDeployment({ id: 'still-going', status: 'running' }));

    const [entry] = repo.listRecent(50);
    assert.equal(entry.id, 'still-going');
    assert.equal(entry.status, 'running');
    assert.equal(entry.finishedAt, null);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Survives a "server restart" — read via a brand new repository instance
// against the same database file.
// ---------------------------------------------------------------------------

test('a finished deployment is readable after a simulated restart (new repository, same file)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-deploy-history-restart-'));
  const dbPath = path.join(dir, 'test.db');

  try {
    const db = openDatabase(dbPath);
    const repo = createDeploymentRepository(db);
    repo.create(sampleDeployment({ id: 'survives-restart' }));
    repo.finish('survives-restart', {
      status: 'succeeded',
      finishedAt: '2026-08-10T12:05:00.000Z',
      durationMs: 300000,
      error: null,
    });
    repo.appendLogs('survives-restart', 'deploy started\ndeploy finished');
    db.close();

    // Simulate a fresh process: reopen the same file, build a brand new
    // repository bound to a brand new DatabaseSync instance.
    const restartedDb = openDatabase(dbPath);
    const restartedRepo = createDeploymentRepository(restartedDb);

    const found = restartedRepo.findById('survives-restart');
    assert.equal(found.status, 'succeeded');
    assert.equal(found.logText, 'deploy started\ndeploy finished');

    restartedDb.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
