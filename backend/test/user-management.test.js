/**
 * Regression tests for user-management operations on the user store
 * (T-52 / SEC-09): creating users, changing roles, resetting passwords,
 * deleting users, and — the one that actually prevents a self-inflicted
 * outage — refusing to remove or demote the last remaining admin.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createUserStore } = require('../src/auth/userStore');

/** Fresh temp users.json path, and a store bound to it (bootstrap admin included). */
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-usermgmt-test-'));
  const usersFile = path.join(dir, 'users.json');
  const previous = process.env.IDP_ADMIN_PASSWORD;
  process.env.IDP_ADMIN_PASSWORD = 'bootstrap-admin-password';
  const store = createUserStore(usersFile);
  if (previous === undefined) delete process.env.IDP_ADMIN_PASSWORD;
  else process.env.IDP_ADMIN_PASSWORD = previous;
  return { store, usersFile };
}

/** Asserts that no object in `values` (recursively for arrays) carries a passwordHash. */
function assertNoPasswordHash(values) {
  for (const value of values) {
    assert.ok(value && typeof value === 'object', 'expected an object');
    assert.ok(!('passwordHash' in value), 'passwordHash must never appear in a user-facing response');
  }
}

// ---------------------------------------------------------------------------
// Creating users
// ---------------------------------------------------------------------------

test('addUser() creates a new user and never returns a passwordHash', () => {
  const { store } = freshStore();
  const created = store.addUser({ username: 'alice', password: 'correct-horse-1', role: 'deployer' });

  assert.equal(created.username, 'alice');
  assert.equal(created.role, 'deployer');
  assert.ok(created.id);
  assert.ok(created.createdAt);
  assertNoPasswordHash([created]);

  const users = store.getUsers();
  assert.equal(users.length, 2); // bootstrap admin + alice
  assertNoPasswordHash(users);
});

test('addUser() persists the new user to disk, hashed', () => {
  const { store, usersFile } = freshStore();
  store.addUser({ username: 'bob', password: 'correct-horse-2', role: 'viewer' });

  const onDisk = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  const bob = onDisk.find((u) => u.username === 'bob');
  assert.ok(bob, 'expected bob to be persisted');
  assert.ok(bob.passwordHash, 'expected a stored passwordHash');
  assert.ok(!('password' in bob), 'plaintext password must never be persisted');
});

test('addUser() rejects a duplicate username', () => {
  const { store } = freshStore();
  store.addUser({ username: 'carol', password: 'correct-horse-3', role: 'viewer' });
  assert.throws(
    () => store.addUser({ username: 'carol', password: 'another-password', role: 'admin' }),
    /USERNAME_TAKEN|already taken/,
  );
});

test('addUser() rejects an invalid role', () => {
  const { store } = freshStore();
  assert.throws(() => store.addUser({ username: 'dave', password: 'correct-horse-4', role: 'superadmin' }));
});

test('addUser() rejects a too-short password', () => {
  const { store } = freshStore();
  assert.throws(() => store.addUser({ username: 'eve', password: 'short', role: 'viewer' }));
});

test('a newly created user can log in with the password it was given', () => {
  const { store } = freshStore();
  store.addUser({ username: 'frank', password: 'correct-horse-5', role: 'deployer' });

  const verified = store.verify('frank', 'correct-horse-5');
  assert.ok(verified);
  assert.equal(verified.role, 'deployer');
  assert.equal(store.verify('frank', 'wrong-password'), null);
});

// ---------------------------------------------------------------------------
// Changing roles
// ---------------------------------------------------------------------------

test('updateUserRole() changes a user\'s role and never returns a passwordHash', () => {
  const { store } = freshStore();
  const created = store.addUser({ username: 'grace', password: 'correct-horse-6', role: 'viewer' });

  const updated = store.updateUserRole(created.id, 'deployer');
  assert.equal(updated.role, 'deployer');
  assertNoPasswordHash([updated]);

  const verified = store.verify('grace', 'correct-horse-6');
  assert.equal(verified.role, 'deployer');
});

test('updateUserRole() rejects an invalid role', () => {
  const { store } = freshStore();
  const created = store.addUser({ username: 'henry', password: 'correct-horse-7', role: 'viewer' });
  assert.throws(() => store.updateUserRole(created.id, 'superadmin'));
});

test('updateUserRole() rejects an unknown user id', () => {
  const { store } = freshStore();
  assert.throws(() => store.updateUserRole('does-not-exist', 'admin'));
});

// ---------------------------------------------------------------------------
// Resetting passwords
// ---------------------------------------------------------------------------

test('updateUserPassword() resets a user\'s password and never returns a passwordHash', () => {
  const { store } = freshStore();
  const created = store.addUser({ username: 'iris', password: 'correct-horse-8', role: 'viewer' });

  const updated = store.updateUserPassword(created.id, 'new-correct-horse-8');
  assertNoPasswordHash([updated]);

  assert.equal(store.verify('iris', 'correct-horse-8'), null, 'old password must stop working');
  assert.ok(store.verify('iris', 'new-correct-horse-8'), 'new password must work');
});

test('updateUserPassword() rejects a too-short password', () => {
  const { store } = freshStore();
  const created = store.addUser({ username: 'jack', password: 'correct-horse-9', role: 'viewer' });
  assert.throws(() => store.updateUserPassword(created.id, 'short'));
});

// ---------------------------------------------------------------------------
// Deleting users
// ---------------------------------------------------------------------------

test('removeUser() deletes a non-admin user', () => {
  const { store } = freshStore();
  const created = store.addUser({ username: 'karen', password: 'correct-horse-10', role: 'viewer' });

  assert.equal(store.removeUser(created.id), true);
  assert.equal(store.findByUsername('karen'), null);
});

test('removeUser() rejects an unknown user id', () => {
  const { store } = freshStore();
  assert.throws(() => store.removeUser('does-not-exist'));
});

// ---------------------------------------------------------------------------
// Last-admin protection — the core safety property of this module
// ---------------------------------------------------------------------------

test('removeUser() refuses to delete the sole remaining admin', () => {
  const { store } = freshStore();
  // Bootstrap store starts with exactly one admin (the bootstrap admin).
  assert.equal(store.countAdmins(), 1);
  const [onlyAdmin] = store.getUsers().filter((u) => u.role === 'admin');

  assert.throws(() => store.removeUser(onlyAdmin.id), /LAST_ADMIN|last remaining admin/);
  // The admin must still be present and unaffected.
  assert.ok(store.findByUsername(onlyAdmin.username));
});

test('removeUser() allows deleting an admin when another admin still exists', () => {
  const { store } = freshStore();
  const [bootstrapAdmin] = store.getUsers().filter((u) => u.role === 'admin');
  const secondAdmin = store.addUser({ username: 'second-admin', password: 'correct-horse-11', role: 'admin' });

  assert.equal(store.countAdmins(), 2);
  assert.equal(store.removeUser(bootstrapAdmin.id), true);
  assert.equal(store.countAdmins(), 1);
  assert.ok(store.findByUsername(secondAdmin.username));
});

test('updateUserRole() refuses to demote the sole remaining admin', () => {
  const { store } = freshStore();
  const [onlyAdmin] = store.getUsers().filter((u) => u.role === 'admin');

  assert.throws(() => store.updateUserRole(onlyAdmin.id, 'viewer'), /LAST_ADMIN|last remaining admin/);
  assert.equal(store.getUserById(onlyAdmin.id).role, 'admin');
});

test('updateUserRole() allows demoting an admin when another admin still exists', () => {
  const { store } = freshStore();
  const [bootstrapAdmin] = store.getUsers().filter((u) => u.role === 'admin');
  store.addUser({ username: 'backup-admin', password: 'correct-horse-12', role: 'admin' });

  const demoted = store.updateUserRole(bootstrapAdmin.id, 'deployer');
  assert.equal(demoted.role, 'deployer');
  assert.equal(store.countAdmins(), 1);
});

test('deleting non-admin users never trips the last-admin guard', () => {
  const { store } = freshStore();
  const viewer = store.addUser({ username: 'lena', password: 'correct-horse-13', role: 'viewer' });
  const deployer = store.addUser({ username: 'mike', password: 'correct-horse-14', role: 'deployer' });

  assert.equal(store.removeUser(viewer.id), true);
  assert.equal(store.removeUser(deployer.id), true);
  // The lone admin is still there, untouched.
  assert.equal(store.countAdmins(), 1);
});

// ---------------------------------------------------------------------------
// getUsers()/getUserById() never leak passwordHash
// ---------------------------------------------------------------------------

test('getUsers() and getUserById() never expose passwordHash, across every mutation', () => {
  const { store } = freshStore();
  const created = store.addUser({ username: 'nina', password: 'correct-horse-15', role: 'viewer' });
  store.updateUserRole(created.id, 'deployer');
  store.updateUserPassword(created.id, 'rotated-correct-horse-15');

  assertNoPasswordHash(store.getUsers());
  assertNoPasswordHash([store.getUserById(created.id)]);
});
