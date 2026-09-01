/**
 * Regression tests for role-based authorization (T-52 / SEC-09).
 *
 * Covers: the full can() matrix (every role × every action), the role
 * hierarchy (admin > deployer > viewer), fail-closed behavior for unknown
 * roles/actions, and the requireRole()/requirePermission() Express
 * middleware factories (401 for no session, 403 for wrong role, next()
 * called when allowed).
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { ROLES, can, requireRole, requirePermission } = require('../src/auth/permissions');

const ALL_ACTIONS = [
  'project:read',
  'project:write',
  'project:delete',
  'deploy:trigger',
  'deploy:abort',
  'vpn:manage',
  'audit:read',
  'user:manage',
];

const VIEWER_ALLOWED = new Set(['project:read', 'audit:read']);
const DEPLOYER_ALLOWED = new Set([...VIEWER_ALLOWED, 'deploy:trigger', 'deploy:abort']);
const ADMIN_ALLOWED = new Set(ALL_ACTIONS);

// ---------------------------------------------------------------------------
// can() matrix
// ---------------------------------------------------------------------------

test('can(): viewer may only read projects and the audit trail', () => {
  for (const action of ALL_ACTIONS) {
    assert.equal(can('viewer', action), VIEWER_ALLOWED.has(action), `viewer × ${action}`);
  }
});

test('can(): deployer may read + trigger/abort deploys, nothing admin-only', () => {
  for (const action of ALL_ACTIONS) {
    assert.equal(can('deployer', action), DEPLOYER_ALLOWED.has(action), `deployer × ${action}`);
  }
});

test('can(): admin may do everything', () => {
  for (const action of ALL_ACTIONS) {
    assert.equal(can('admin', action), ADMIN_ALLOWED.has(action), `admin × ${action}`);
  }
});

test('can(): hierarchy is strictly admin > deployer > viewer', () => {
  // Every action a viewer can do, a deployer can also do.
  for (const action of ALL_ACTIONS) {
    if (can('viewer', action)) assert.equal(can('deployer', action), true, action);
  }
  // Every action a deployer can do, an admin can also do.
  for (const action of ALL_ACTIONS) {
    if (can('deployer', action)) assert.equal(can('admin', action), true, action);
  }
});

test('can(): fails closed for an unknown role', () => {
  for (const action of ALL_ACTIONS) {
    assert.equal(can('superadmin', action), false, action);
    assert.equal(can('', action), false, action);
    assert.equal(can(undefined, action), false, action);
    assert.equal(can(null, action), false, action);
  }
});

test('can(): fails closed for an unknown action', () => {
  for (const role of ['viewer', 'deployer', 'admin']) {
    assert.equal(can(role, 'project:nuke'), false, role);
    assert.equal(can(role, ''), false, role);
    assert.equal(can(role, undefined), false, role);
  }
});

test('ROLES exposes the three canonical role identifiers', () => {
  assert.deepEqual(new Set(Object.values(ROLES)), new Set(['admin', 'deployer', 'viewer']));
});

// ---------------------------------------------------------------------------
// requireRole() middleware
// ---------------------------------------------------------------------------

/** Minimal fake Express req/res/next trio. */
function makeReqRes(user) {
  const req = { session: user ? { user } : {} };
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  return { req, res, next: next, wasNextCalled: () => nextCalled };
}

test('requireRole() throws for an unknown minRole at setup time', () => {
  assert.throws(() => requireRole('superadmin'));
});

test('requireRole(): no session user → 401, next() not called', () => {
  const { req, res, next, wasNextCalled } = makeReqRes(null);
  requireRole('viewer')(req, res, next);
  assert.equal(res.statusCode, 401);
  assert.equal(wasNextCalled(), false);
});

test('requireRole(): session user below minRole → 403, next() not called', () => {
  const { req, res, next, wasNextCalled } = makeReqRes({ username: 'v', role: 'viewer' });
  requireRole('admin')(req, res, next);
  assert.equal(res.statusCode, 403);
  assert.equal(wasNextCalled(), false);
  assert.ok(res.body && res.body.error, 'expected an explanatory error message');
});

test('requireRole(): session user meets minRole exactly → next() called', () => {
  const { req, res, next, wasNextCalled } = makeReqRes({ username: 'd', role: 'deployer' });
  requireRole('deployer')(req, res, next);
  assert.equal(wasNextCalled(), true);
  assert.equal(res.statusCode, null);
});

test('requireRole(): session user above minRole → next() called', () => {
  const { req, res, next, wasNextCalled } = makeReqRes({ username: 'a', role: 'admin' });
  requireRole('viewer')(req, res, next);
  assert.equal(wasNextCalled(), true);
});

test('requireRole(): an unrecognized session role never passes → 403', () => {
  const { req, res, next, wasNextCalled } = makeReqRes({ username: 'x', role: 'superadmin' });
  requireRole('viewer')(req, res, next);
  assert.equal(res.statusCode, 403);
  assert.equal(wasNextCalled(), false);
});

// ---------------------------------------------------------------------------
// requirePermission() middleware
// ---------------------------------------------------------------------------

test('requirePermission() throws for an unknown action at setup time', () => {
  assert.throws(() => requirePermission('project:nuke'));
});

test('requirePermission(): no session user → 401 (not 403)', () => {
  const { req, res, next, wasNextCalled } = makeReqRes(null);
  requirePermission('project:read')(req, res, next);
  assert.equal(res.statusCode, 401);
  assert.equal(wasNextCalled(), false);
});

test('requirePermission(): authenticated but insufficient role → 403 (not 401)', () => {
  const { req, res, next, wasNextCalled } = makeReqRes({ username: 'v', role: 'viewer' });
  requirePermission('deploy:trigger')(req, res, next);
  assert.equal(res.statusCode, 403);
  assert.equal(wasNextCalled(), false);
  assert.ok(res.body && res.body.error);
});

test('requirePermission(): sufficient role → next() called, no status set', () => {
  const { req, res, next, wasNextCalled } = makeReqRes({ username: 'd', role: 'deployer' });
  requirePermission('deploy:trigger')(req, res, next);
  assert.equal(wasNextCalled(), true);
  assert.equal(res.statusCode, null);
});

test('requirePermission(): admin passes every action', () => {
  for (const action of ALL_ACTIONS) {
    const { req, res, next, wasNextCalled } = makeReqRes({ username: 'a', role: 'admin' });
    requirePermission(action)(req, res, next);
    assert.equal(wasNextCalled(), true, action);
  }
});
