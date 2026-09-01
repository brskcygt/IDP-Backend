/**
 * Tests for T-18b: server telemetry (CPU/RAM polling) is opt-in per project,
 * defaulting to false.
 *
 * Before T-18b, every Server/WinRM project polled a real SSH/WinRM session
 * every 5 minutes whether anyone asked for it or not. The fix is a
 * short-circuit in `core/projects/projectService.js#getProjectTelemetry`
 * (and, independently, in `services/TelemetryService.js#getTelemetry`
 * itself) that returns `{ status: 'disabled' }` before ANY secret is
 * resolved or any socket opened.
 *
 * These tests prove that by mocking `TelemetryService.getTelemetry` (the
 * one place that would open a real SSH/WinRM connection) via `node:test`'s
 * built-in `t.mock` and asserting it is never even called while telemetry
 * is disabled — the strongest guarantee available without touching a real
 * network, and the actual contract T-73's sibling ticket cares about.
 *
 * Isolation: this file never touches the real backend/src/idp.db — see
 * test/helpers/isolateDb.js (loaded once for the whole `npm test` run).
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const projectService = require('../src/core/projects/projectService');
const TelemetryService = require('../src/services/TelemetryService');

const ACTOR = 'test-actor';

function waitForNextMillisecond() {
  const start = Date.now();
  while (Date.now() === start) {
    // intentionally empty — sub-millisecond busy-wait, see project-service.test.js
  }
}

function createTestServerProject(overrides = {}) {
  waitForNextMillisecond();
  return projectService.createProject(
    {
      name: `Telemetry Test ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      tenant: 'Tenant QA',
      environment: 'Dev',
      provider: 'Server',
      ...overrides,
    },
    ACTOR
  );
}

test('getProjectTelemetry returns { status: "disabled" } when telemetryEnabled is unset (default off), and never calls TelemetryService', async (t) => {
  const created = createTestServerProject();
  await projectService.updateProjectConfig(created.id, { host: '10.0.0.5', username: 'deployer' }, ACTOR);

  const spy = t.mock.method(TelemetryService, 'getTelemetry', async () => {
    throw new Error('TelemetryService.getTelemetry must not be called while telemetry is disabled');
  });

  const result = await projectService.getProjectTelemetry(created.id);

  assert.deepEqual(result, { status: 'disabled' });
  assert.equal(spy.mock.callCount(), 0, 'TelemetryService.getTelemetry (which opens the real SSH/WinRM session) must never be invoked');
});

test('getProjectTelemetry returns { status: "disabled" } when telemetryEnabled is explicitly false', async (t) => {
  const created = createTestServerProject();
  await projectService.updateProjectConfig(
    created.id,
    { host: '10.0.0.5', username: 'deployer', telemetryEnabled: false },
    ACTOR
  );

  const spy = t.mock.method(TelemetryService, 'getTelemetry', async () => {
    throw new Error('must not be called');
  });

  const result = await projectService.getProjectTelemetry(created.id);

  assert.deepEqual(result, { status: 'disabled' });
  assert.equal(spy.mock.callCount(), 0);
});

test('getProjectTelemetry calls through to TelemetryService once telemetryEnabled is true', async (t) => {
  const created = createTestServerProject();
  await projectService.updateProjectConfig(
    created.id,
    { host: '10.0.0.5', username: 'deployer', telemetryEnabled: true },
    ACTOR
  );

  const spy = t.mock.method(TelemetryService, 'getTelemetry', async () => ({ status: 'online', cpu: 12, ramUsed: 100, ramTotal: 200, ramPercent: 50 }));

  const result = await projectService.getProjectTelemetry(created.id);

  assert.equal(spy.mock.callCount(), 1, 'TelemetryService.getTelemetry must be called once telemetry is explicitly enabled');
  assert.equal(result.status, 'online');
  // The project handed to TelemetryService must have real config, not a bare shell.
  const [passedProject] = spy.mock.calls[0].arguments;
  assert.equal(passedProject.config.host, '10.0.0.5');
  assert.equal(passedProject.config.telemetryEnabled, true);
});

test('TelemetryService.getTelemetry itself short-circuits to disabled (defense in depth) without opening a connection', async () => {
  const result = await TelemetryService.getTelemetry({
    provider: 'Server',
    config: { host: '10.0.0.5', username: 'deployer', password: 'whatever', targetOS: 'linux' },
  });

  assert.deepEqual(result, { status: 'disabled' });
});

test('TelemetryService.getTelemetry proceeds to the real probe once telemetryEnabled is true (still provider-gated for non-server projects)', async () => {
  // Non-server provider: telemetryEnabled is irrelevant, always 'unknown'.
  const result = await TelemetryService.getTelemetry({
    provider: 'Jenkins',
    config: { telemetryEnabled: true },
  });

  assert.deepEqual(result, { status: 'unknown' });
});

test('a non-server project (Jenkins/PMP) is never reported "disabled" — it has no telemetry to opt into', async () => {
  const created = createTestServerProject({ provider: 'Jenkins' });
  await projectService.updateProjectConfig(created.id, { url: 'http://jenkins.local' }, ACTOR);

  const result = await projectService.getProjectTelemetry(created.id);

  assert.equal(result.status, 'unknown');
});
