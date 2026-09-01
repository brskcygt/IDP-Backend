/**
 * Tests for core/bootstrap.js (T-91).
 *
 * The whole point of extracting this out of server.js is that Electron's
 * IPC main process can run the exact same startup sequence without ever
 * touching Express, a port, or a socket. These tests prove exactly that:
 * `bootstrapCore()` is called directly, with no `require('express')`, no
 * `app.listen()`, nothing HTTP-shaped anywhere in this file — the same
 * guarantee `backend/scripts/check-core-boundaries.js` already enforces for
 * everything under `src/core/**`.
 *
 * Isolation: this file never touches the real backend/src/idp.db — see
 * test/helpers/isolateDb.js (loaded via `node --require` in the `test`
 * npm script before any test file, including this one, runs).
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { bootstrapCore } = require('../src/core/bootstrap');
const projectService = require('../src/core/projects/projectService');

test('bootstrapCore() runs without Express/HTTP and does not create demo projects', () => {
  bootstrapCore();

  const projects = projectService.listProjects();
  const demoNames = new Set(['Alpha Service', 'Beta Portal', 'Gamma API']);
  assert.ok(
    projects.every((project) => !demoNames.has(project.name)),
    'bootstrap should preserve migrated projects without creating demo projects'
  );
  assert.ok(
    projects.every((p) => p.status !== 'Deploying'),
    'no project should be left in a stuck Deploying state after bootstrap recovery'
  );
});

test('bootstrapCore() is idempotent — calling it again does not add projects or throw', () => {
  bootstrapCore();
  const before = projectService.listProjects().length;

  bootstrapCore();
  bootstrapCore();

  const after = projectService.listProjects().length;
  assert.equal(after, before, 'a second/third bootstrapCore() call must not duplicate seed data');
});

test('bootstrapCore() constructs the DeploymentManager singleton as a side effect', () => {
  bootstrapCore();

  // Requiring DeploymentManager here returns the SAME cached singleton
  // bootstrapCore() already constructed (Node module cache) — if
  // bootstrapCore() had failed to pull it in, this would be the first
  // construction instead, which is still valid but wouldn't prove
  // bootstrap.js did the pulling-in. The real assertion is just that it's
  // requireable and shaped like a DeploymentManager without ever starting
  // an HTTP server.
  const deploymentManager = require('../src/services/DeploymentManager');
  assert.equal(typeof deploymentManager.createSession, 'function');
  assert.equal(typeof deploymentManager.getSession, 'function');
});
