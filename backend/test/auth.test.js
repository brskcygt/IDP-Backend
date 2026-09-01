/**
 * Regression tests for the user store / password hashing (T-11 / SEC-04).
 *
 * Covers: hash/verify round-trip, wrong-password rejection, salt
 * randomness (same password hashes differently each time), tolerance of
 * malformed stored hashes, and the first-run bootstrap-admin flow.
 *
 * Run with: npm test
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { hashPassword, verifyPassword, createUserStore } = require('../src/auth/userStore');

test('hashPassword/verifyPassword round-trip succeeds for the correct password', () => {
  const hash = hashPassword('correct-horse-battery-staple');
  assert.equal(verifyPassword('correct-horse-battery-staple', hash), true);
});

test('verifyPassword rejects an incorrect password', () => {
  const hash = hashPassword('correct-horse-battery-staple');
  assert.equal(verifyPassword('wrong-password', hash), false);
});

test('hashing the same password twice yields different output (salt randomness)', () => {
  const hashA = hashPassword('same-password');
  const hashB = hashPassword('same-password');
  assert.notEqual(hashA, hashB);
  // Both must still independently verify against the same plaintext.
  assert.equal(verifyPassword('same-password', hashA), true);
  assert.equal(verifyPassword('same-password', hashB), true);
});

test('verifyPassword does not throw on a malformed stored hash and returns false', () => {
  assert.equal(verifyPassword('anything', 'not-a-valid-hash-format'), false);
  assert.equal(verifyPassword('anything', ''), false);
  assert.equal(verifyPassword('anything', ':'), false);
  assert.equal(verifyPassword('anything', 'onlysalt:'), false);
  assert.equal(verifyPassword('anything', undefined), false);
  assert.equal(verifyPassword('anything', null), false);
});

test('verifyPassword does not throw when the plaintext password is missing/non-string', () => {
  const hash = hashPassword('some-password');
  assert.equal(verifyPassword(undefined, hash), false);
  assert.equal(verifyPassword(null, hash), false);
  assert.equal(verifyPassword(123, hash), false);
});

// --- Bootstrap / first-run admin creation -----------------------------

/** Creates a fresh temp directory and returns the users.json path inside it. */
function tempUsersFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-auth-test-'));
  return path.join(dir, 'users.json');
}

test('creates a bootstrap admin user when users.json does not exist', () => {
  const usersFile = tempUsersFile();
  assert.equal(fs.existsSync(usersFile), false);

  const store = createUserStore(usersFile);

  assert.equal(fs.existsSync(usersFile), true);
  const users = store.getUsers();
  assert.equal(users.length, 1);
  assert.equal(users[0].username, 'admin');
  assert.equal(users[0].role, 'admin');
  assert.ok(users[0].id);
  assert.ok(users[0].createdAt);

  // The file on disk must never contain a plaintext password field.
  const onDisk = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  assert.equal(onDisk.length, 1);
  assert.ok(onDisk[0].passwordHash, 'expected a stored passwordHash');
  assert.ok(!('password' in onDisk[0]), 'plaintext password must never be persisted');
});

test('bootstrap admin uses IDP_ADMIN_PASSWORD when set', () => {
  const usersFile = tempUsersFile();
  const previous = process.env.IDP_ADMIN_PASSWORD;
  process.env.IDP_ADMIN_PASSWORD = 'test-fixed-admin-password';
  try {
    const store = createUserStore(usersFile);
    assert.equal(store.verify('admin', 'test-fixed-admin-password') !== null, true);
    assert.equal(store.verify('admin', 'wrong-password'), null);
  } finally {
    if (previous === undefined) delete process.env.IDP_ADMIN_PASSWORD;
    else process.env.IDP_ADMIN_PASSWORD = previous;
  }
});

test('does not re-bootstrap when users.json already exists', () => {
  const usersFile = tempUsersFile();
  const storeA = createUserStore(usersFile);
  const firstUsers = storeA.getUsers();

  const storeB = createUserStore(usersFile);
  const secondUsers = storeB.getUsers();

  assert.deepEqual(firstUsers, secondUsers, 'a second store instance must load, not recreate, the admin user');
});

test('verify() returns null for both an unknown username and a wrong password', () => {
  const usersFile = tempUsersFile();
  process.env.IDP_ADMIN_PASSWORD = 'known-good-password';
  const store = createUserStore(usersFile);
  delete process.env.IDP_ADMIN_PASSWORD;

  assert.equal(store.verify('nonexistent-user', 'anything'), null);
  assert.equal(store.verify('admin', 'wrong-password'), null);
  const ok = store.verify('admin', 'known-good-password');
  assert.equal(ok.username, 'admin');
  assert.equal(ok.role, 'admin');
  assert.ok(!('passwordHash' in ok), 'verify() must not leak the password hash into the session-ready user');
});

test('getUsers() never exposes passwordHash', () => {
  const usersFile = tempUsersFile();
  const store = createUserStore(usersFile);
  for (const user of store.getUsers()) {
    assert.ok(!('passwordHash' in user));
  }
});
