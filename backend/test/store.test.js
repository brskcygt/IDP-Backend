/**
 * Tests for the SQLite-backed store (T-53).
 *
 * Covers projectRepository, auditRepository, and the one-time JSON->SQLite
 * migration. Every test opens its own throwaway database file under a
 * fresh `fs.mkdtemp()` directory and tears it down afterwards — none of
 * this touches the real src/idp.db (or, other than reading them for the
 * migration test, the real projects.json / audit_logs.json).
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DatabaseSync } = require('node:sqlite');

const { openDatabase } = require('../src/store/db');
const { createProjectRepository } = require('../src/store/projectRepository');
const { createAuditRepository } = require('../src/store/auditRepository');
const { runMigration } = require('../src/store/migrate');

/** Opens a fresh throwaway DB under its own temp dir; returns db + cleanup. */
function withTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-store-test-'));
  const dbPath = path.join(dir, 'test.db');
  const db = openDatabase(dbPath);
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const sampleProject = (overrides = {}) => ({
  id: 'proj-1',
  name: 'Example Project',
  tenant: 'Tenant A',
  environment: 'Dev',
  provider: 'Server',
  status: 'Idle',
  lastDeploy: '2026-01-01T00:00:00.000Z',
  config: {
    host: '10.0.0.5',
    username: 'deployer',
    password: 'secret://proj-1/password',
    targetOS: 'linux',
  },
  ...overrides,
});

// ---------------------------------------------------------------------------
// projectRepository
// ---------------------------------------------------------------------------

test('projectRepository: create -> findAll -> findById -> update -> remove', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repo = createProjectRepository(db);

    assert.deepEqual(repo.findAll(), []);
    assert.equal(repo.findById('proj-1'), null);

    const created = repo.create(sampleProject());
    assert.equal(created.id, 'proj-1');
    assert.equal(created.name, 'Example Project');
    assert.equal(created.status, 'Idle');

    assert.equal(repo.findAll().length, 1);
    assert.deepEqual(repo.findById('proj-1'), created);

    const updated = repo.update('proj-1', { status: 'Succeeded', name: 'Renamed Project' });
    assert.equal(updated.status, 'Succeeded');
    assert.equal(updated.name, 'Renamed Project');
    // Fields not present in the patch are untouched.
    assert.equal(updated.tenant, 'Tenant A');
    assert.equal(updated.config.host, '10.0.0.5');

    assert.equal(repo.update('does-not-exist', { status: 'Idle' }), null);

    assert.equal(repo.remove('proj-1'), true);
    assert.equal(repo.findById('proj-1'), null);
    assert.equal(repo.remove('proj-1'), false, 'removing an already-removed id returns false');
  } finally {
    cleanup();
  }
});

test('projectRepository: no method mutates its input object', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repo = createProjectRepository(db);
    const input = sampleProject();
    const inputSnapshot = JSON.stringify(input);

    repo.create(input);
    assert.equal(JSON.stringify(input), inputSnapshot, 'create() must not mutate its argument');

    const patch = { status: 'Failed' };
    const patchSnapshot = JSON.stringify(patch);
    repo.update('proj-1', patch);
    assert.equal(JSON.stringify(patch), patchSnapshot, 'update() must not mutate its patch argument');
  } finally {
    cleanup();
  }
});

test('projectRepository: config round-trips as JSON, secret:// references intact', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repo = createProjectRepository(db);
    const project = sampleProject({
      config: {
        host: '10.0.0.5',
        username: 'deployer',
        password: 'secret://proj-1/password',
        pmpConfig: { baseUrl: 'https://pmp.example.com', authToken: 'secret://proj-1/pmpConfig.authToken' },
        vpnConfig: {
          type: 'fortinet',
          password: 'secret://proj-1/vpnConfig.password',
          mfaConfig: { type: 'totp', secret: 'secret://proj-1/vpnConfig.mfaConfig.secret' },
        },
      },
    });

    repo.create(project);
    const fetched = repo.findById('proj-1');

    assert.deepEqual(fetched.config, project.config);
    assert.equal(fetched.config.password, 'secret://proj-1/password');
    assert.equal(fetched.config.pmpConfig.authToken, 'secret://proj-1/pmpConfig.authToken');
    assert.equal(fetched.config.vpnConfig.mfaConfig.secret, 'secret://proj-1/vpnConfig.mfaConfig.secret');

    // Round-trip through update() too, patching an unrelated field.
    const afterUpdate = repo.update('proj-1', { status: 'Succeeded' });
    assert.deepEqual(afterUpdate.config, project.config);
  } finally {
    cleanup();
  }
});

test('projectRepository.updateStatus only changes status/lastDeploy, never config', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repo = createProjectRepository(db);
    repo.create(sampleProject());

    const updated = repo.updateStatus('proj-1', 'Deploying', '2026-02-02T00:00:00.000Z');
    assert.equal(updated.status, 'Deploying');
    assert.equal(updated.lastDeploy, '2026-02-02T00:00:00.000Z');
    // Everything else, including config (and its secret:// reference), is untouched.
    assert.equal(updated.name, 'Example Project');
    assert.equal(updated.config.password, 'secret://proj-1/password');

    assert.equal(repo.updateStatus('missing-id', 'Idle', 'x'), null);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// auditRepository
// ---------------------------------------------------------------------------

const sampleEntry = (overrides = {}) => ({
  id: `entry-${Math.random().toString(36).slice(2)}`,
  timestamp: new Date().toISOString(),
  user: 'admin',
  action: 'LOGIN',
  description: 'User logged in successfully',
  metadata: { ip: '127.0.0.1' },
  ...overrides,
});

test('auditRepository: append -> list, newest first, limit respected', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repo = createAuditRepository(db);

    const base = Date.parse('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 5; i++) {
      repo.append(sampleEntry({
        id: `e${i}`,
        timestamp: new Date(base + i * 1000).toISOString(),
        action: `ACTION_${i}`,
      }));
    }

    const all = repo.list(100);
    assert.equal(all.length, 5);
    // Newest timestamp first.
    assert.deepEqual(all.map((e) => e.action), ['ACTION_4', 'ACTION_3', 'ACTION_2', 'ACTION_1', 'ACTION_0']);

    const limited = repo.list(2);
    assert.equal(limited.length, 2);
    assert.deepEqual(limited.map((e) => e.action), ['ACTION_4', 'ACTION_3']);

    assert.deepEqual(all[0].metadata, { ip: '127.0.0.1' });
  } finally {
    cleanup();
  }
});

test('auditRepository.listByProject filters by metadata.projectId', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repo = createAuditRepository(db);
    repo.append(sampleEntry({ id: 'a', action: 'DEPLOY_TRIGGERED', metadata: { projectId: 'p1' } }));
    repo.append(sampleEntry({ id: 'b', action: 'DEPLOY_SUCCEEDED', metadata: { projectId: 'p1' } }));
    repo.append(sampleEntry({ id: 'c', action: 'DEPLOY_TRIGGERED', metadata: { projectId: 'p2' } }));

    const forP1 = repo.listByProject('p1', 100);
    assert.equal(forP1.length, 2);
    assert.ok(forP1.every((e) => e.metadata.projectId === 'p1'));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// T-55 / SEC-12: ip / requestId / outcome / durationMs columns
// ---------------------------------------------------------------------------

test('auditRepository.append() persists ip/requestId/outcome/durationMs and list() returns them', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repo = createAuditRepository(db);
    repo.append(sampleEntry({
      id: 'with-context',
      action: 'DEPLOY_FAILED',
      ip: '10.0.0.7',
      requestId: 'req-abc-123',
      outcome: 'failure',
      durationMs: 4200,
    }));

    const [entry] = repo.list(1);
    assert.equal(entry.ip, '10.0.0.7');
    assert.equal(entry.requestId, 'req-abc-123');
    assert.equal(entry.outcome, 'failure');
    assert.equal(entry.durationMs, 4200);
  } finally {
    cleanup();
  }
});

test('auditRepository.append() stores null for ip/requestId/outcome/durationMs when omitted', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repo = createAuditRepository(db);
    repo.append(sampleEntry({ id: 'no-context' }));

    const [entry] = repo.list(1);
    assert.equal(entry.ip, null);
    assert.equal(entry.requestId, null);
    assert.equal(entry.durationMs, null);
    // outcome still gets a value in production (AuditLogger infers it before
    // calling append()) — at the repository layer with no value supplied it
    // is simply not set, i.e. null.
    assert.equal(entry.outcome, null);
  } finally {
    cleanup();
  }
});

test('opening a pre-existing (old-schema) audit_logs table adds the new columns without touching existing rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-store-migration-test-'));
  const dbPath = path.join(dir, 'legacy.db');
  try {
    // Simulate a database created before T-55: only the original 6 columns,
    // populated with rows (standing in for the real ~350-entry audit trail).
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        user TEXT,
        action TEXT,
        description TEXT,
        metadata TEXT
      )
    `);
    const insert = legacyDb.prepare(`
      INSERT INTO audit_logs (id, timestamp, user, action, description, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < 20; i++) {
      insert.run(`legacy-${i}`, `2025-01-0${(i % 9) + 1}T00:00:00.000Z`, 'admin', 'LOGIN', 'legacy row', '{}');
    }
    legacyDb.close();

    // Reopening through openDatabase() runs ensureAuditLogColumns() — this
    // is the exact upgrade path the real src/idp.db goes through on boot.
    const upgradedDb = openDatabase(dbPath);
    try {
      const { count } = upgradedDb.prepare('SELECT COUNT(*) AS count FROM audit_logs').get();
      assert.equal(count, 20, 'no existing row was dropped by the ALTER TABLE');

      const columns = new Set(upgradedDb.prepare('PRAGMA table_info(audit_logs)').all().map((c) => c.name));
      for (const col of ['ip', 'request_id', 'outcome', 'duration_ms']) {
        assert.ok(columns.has(col), `expected column ${col} to have been added`);
      }

      const repo = createAuditRepository(upgradedDb);
      const migrated = repo.list(100).find((e) => e.id === 'legacy-0');
      assert.ok(migrated, 'a pre-existing row must still be readable through the repository');
      assert.equal(migrated.user, 'admin');
      assert.equal(migrated.action, 'LOGIN');
      // New columns on a row that predates them read back as null, not a
      // fabricated value.
      assert.equal(migrated.ip, null);
      assert.equal(migrated.requestId, null);
      assert.equal(migrated.outcome, null);
      assert.equal(migrated.durationMs, null);

      // The upgrade must also be idempotent: opening it again must not
      // error or duplicate columns.
      assert.doesNotThrow(() => openDatabase(dbPath));
    } finally {
      upgradedDb.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Concurrent writes: the whole point of T-53
// ---------------------------------------------------------------------------

test('auditRepository survives 50 back-to-back concurrent appends without losing any', async () => {
  const { db, cleanup } = withTempDb();
  try {
    const repo = createAuditRepository(db);

    // Fire all 50 append() calls from resolved-promise callbacks so they're
    // scheduled on the event loop before any of them run, simulating 50
    // concurrent requests (e.g. 50 audit-worthy actions racing through
    // Express handlers) hitting the logger at once.
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => Promise.resolve().then(() => {
        repo.append(sampleEntry({ id: `race-${i}`, action: 'RACE_TEST', metadata: { i } }));
      }))
    );

    const raceEntries = repo.list(1000).filter((e) => e.action === 'RACE_TEST');
    assert.equal(raceEntries.length, 50, 'all 50 concurrent audit entries must be persisted, none lost');

    // Why the OLD JSON-file AuditLogger would fail this exact test:
    // its saveLogs() did `fs.writeFileSync(LOGS_FILE, JSON.stringify(this.logs))`
    // — a full-file rewrite — on every single log() call, and outside of a
    // single-process singleton (e.g. a PM2/cluster deployment, or the
    // persistent deployment history T-54 needs, which will run its own
    // writer alongside this one) each writer holds its own in-memory copy
    // loaded from disk. Writer B can read the file, then writer A writes,
    // then writer B — still holding its now-stale in-memory copy — writes
    // its own full array back out, silently erasing A's entry. It's a
    // classic read-modify-write race: last writer wins, everyone else's
    // write vanishes with no error raised anywhere. Each append() here is
    // a single atomic SQLite INSERT instead, so there is no read-modify-write
    // window for another writer to land in.
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

test('migration from JSON files is idempotent (second run migrates nothing)', () => {
  const { db, cleanup } = withTempDb();
  try {
    const projectRepo = createProjectRepository(db);
    const auditRepo = createAuditRepository(db);

    const first = runMigration(db);
    const projectsAfterFirst = projectRepo.findAll().length;
    const auditAfterFirst = auditRepo.list(1_000_000).length;

    assert.equal(projectsAfterFirst, first.projectsMigrated);
    assert.equal(auditAfterFirst, first.auditLogsMigrated);

    const second = runMigration(db);
    assert.equal(second.projectsMigrated, 0, 'second run must not re-migrate projects');
    assert.equal(second.auditLogsMigrated, 0, 'second run must not re-migrate audit logs');

    // Row counts are unchanged — nothing was duplicated.
    assert.equal(projectRepo.findAll().length, projectsAfterFirst);
    assert.equal(auditRepo.list(1_000_000).length, auditAfterFirst);
  } finally {
    cleanup();
  }
});

test('migration is a no-op against an already-populated table', () => {
  const { db, cleanup } = withTempDb();
  try {
    const projectRepo = createProjectRepository(db);
    projectRepo.create(sampleProject({ id: 'pre-existing' }));

    const result = runMigration(db);
    assert.equal(result.projectsMigrated, 0, 'a non-empty projects table must be left alone');

    const all = projectRepo.findAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, 'pre-existing');
  } finally {
    cleanup();
  }
});
