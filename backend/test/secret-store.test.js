/**
 * Tests for the SecretStore module (T-10 / SEC-01).
 *
 * Covers the AES-256-GCM FileSecretStore implementation, key management,
 * and the secret-ref helpers that will replace plaintext values in
 * projects.json config once the lead integrates this module.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const FileSecretStore = require('../src/secrets/FileSecretStore');
const keyManager = require('../src/secrets/keyManager');
const secretRef = require('../src/secrets/secretRef');

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idp-secret-store-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeKey() {
  return crypto.randomBytes(32);
}

test('set/get round-trip returns the original secret', async () => {
  await withTempDir(async (dir) => {
    const store = new FileSecretStore({ key: makeKey(), filePath: path.join(dir, 'secrets.enc.json') });
    await store.set('db.password', 'hunter2');
    assert.equal(await store.get('db.password'), 'hunter2');
  });
});

test('get on an unknown key resolves to null and never throws', async () => {
  await withTempDir(async (dir) => {
    const store = new FileSecretStore({ key: makeKey(), filePath: path.join(dir, 'secrets.enc.json') });
    await assert.doesNotReject(async () => {
      assert.equal(await store.get('nope'), null);
    });
  });
});

test('delete returns true when a secret existed, false otherwise', async () => {
  await withTempDir(async (dir) => {
    const store = new FileSecretStore({ key: makeKey(), filePath: path.join(dir, 'secrets.enc.json') });
    await store.set('k', 'v');
    assert.equal(await store.delete('k'), true);
    assert.equal(await store.delete('k'), false);
    assert.equal(await store.get('k'), null);
  });
});

test('has reflects presence without decrypting', async () => {
  await withTempDir(async (dir) => {
    const store = new FileSecretStore({ key: makeKey(), filePath: path.join(dir, 'secrets.enc.json') });
    assert.equal(await store.has('k'), false);
    await store.set('k', 'v');
    assert.equal(await store.has('k'), true);
  });
});

test('listKeys returns key names only, never secret values', async () => {
  await withTempDir(async (dir) => {
    const store = new FileSecretStore({ key: makeKey(), filePath: path.join(dir, 'secrets.enc.json') });
    await store.set('alpha', 'super-secret-alpha');
    await store.set('beta', 'super-secret-beta');

    const keys = await store.listKeys();
    assert.deepEqual(keys.sort(), ['alpha', 'beta']);

    const serialized = JSON.stringify(keys);
    assert.ok(!serialized.includes('super-secret-alpha'));
    assert.ok(!serialized.includes('super-secret-beta'));
  });
});

test('the same value set twice produces different ciphertext (IV randomness)', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'secrets.enc.json');
    const store = new FileSecretStore({ key: makeKey(), filePath });

    await store.set('k', 'same-value');
    const first = JSON.parse(await fs.readFile(filePath, 'utf8')).k;

    await store.set('k', 'same-value');
    const second = JSON.parse(await fs.readFile(filePath, 'utf8')).k;

    assert.notEqual(first.iv, second.iv);
    assert.notEqual(first.ciphertext, second.ciphertext);
  });
});

test('reading a record with a tampered authTag throws a clear error', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'secrets.enc.json');
    const key = makeKey();
    const store = new FileSecretStore({ key, filePath });
    await store.set('k', 'value');

    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const tagBuf = Buffer.from(onDisk.k.authTag, 'base64');
    tagBuf[0] ^= 0xff; // flip bits to simulate tampering, same length/shape
    onDisk.k.authTag = tagBuf.toString('base64');
    await fs.writeFile(filePath, JSON.stringify(onDisk));

    const reopened = new FileSecretStore({ key, filePath });
    await assert.rejects(() => reopened.get('k'), /tampered|decrypt/i);
  });
});

test('a structurally corrupt record is skipped without affecting other records', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'secrets.enc.json');
    const key = makeKey();
    const store = new FileSecretStore({ key, filePath });
    await store.set('good', 'good-value');
    await store.set('bad', 'irrelevant');

    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
    onDisk.bad = { iv: 'not-a-valid-record' }; // missing authTag/ciphertext entirely
    await fs.writeFile(filePath, JSON.stringify(onDisk));

    const reopened = new FileSecretStore({ key, filePath });
    assert.equal(await reopened.get('good'), 'good-value');
    // Skipped at load time -> behaves like a missing key, not a thrown error.
    assert.equal(await reopened.get('bad'), null);
    assert.ok(!(await reopened.listKeys()).includes('bad'));
  });
});

test('the encrypted file on disk never contains the plaintext secret', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'secrets.enc.json');
    const store = new FileSecretStore({ key: makeKey(), filePath });
    const plaintext = 'CorrectHorseBatteryStaple-VPN-Password';
    await store.set('vpn.password', plaintext);

    const raw = await fs.readFile(filePath, 'utf8');
    assert.ok(!raw.includes(plaintext));
  });
});

test('a store opened with the wrong key cannot decrypt existing values', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'secrets.enc.json');
    const storeA = new FileSecretStore({ key: makeKey(), filePath });
    await storeA.set('k', 'value');

    const storeB = new FileSecretStore({ key: makeKey(), filePath });
    await assert.rejects(() => storeB.get('k'));
  });
});

test('the secrets file is written with 0600 permissions', { skip: process.platform === 'win32' }, async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'secrets.enc.json');
    const store = new FileSecretStore({ key: makeKey(), filePath });
    await store.set('k', 'v');
    const stat = await fs.stat(filePath);
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

test('secretRef helpers round-trip project id and field path', () => {
  const ref = secretRef.makeRef('123', 'config.password');
  assert.equal(ref, 'secret://123/config.password');
  assert.equal(secretRef.isRef(ref), true);
  assert.deepEqual(secretRef.parseRef(ref), { projectId: '123', fieldPath: 'config.password' });
});

test('secretRef.isRef rejects plain strings and non-strings', () => {
  assert.equal(secretRef.isRef('plain-text-password'), false);
  assert.equal(secretRef.isRef(null), false);
  assert.equal(secretRef.isRef(42), false);
  assert.equal(secretRef.parseRef('not-a-ref'), null);
});

test('keyManager.resolveKey returns null when IDP_SECRET_KEY is unset', () => {
  const original = process.env.IDP_SECRET_KEY;
  delete process.env.IDP_SECRET_KEY;
  try {
    assert.equal(keyManager.resolveKey(), null);
  } finally {
    if (original === undefined) delete process.env.IDP_SECRET_KEY;
    else process.env.IDP_SECRET_KEY = original;
  }
});

test('keyManager.resolveKey throws a descriptive error for the wrong key length', () => {
  const original = process.env.IDP_SECRET_KEY;
  process.env.IDP_SECRET_KEY = Buffer.from('too-short').toString('base64');
  try {
    assert.throws(() => keyManager.resolveKey(), /32/);
  } finally {
    if (original === undefined) delete process.env.IDP_SECRET_KEY;
    else process.env.IDP_SECRET_KEY = original;
  }
});

test('keyManager.describeKeyStatus never exposes the key value', () => {
  const original = process.env.IDP_SECRET_KEY;
  const key = keyManager.generateKey();
  process.env.IDP_SECRET_KEY = key;
  try {
    const status = keyManager.describeKeyStatus();
    assert.equal(status.configured, true);
    assert.ok(!status.message.includes(key));
  } finally {
    if (original === undefined) delete process.env.IDP_SECRET_KEY;
    else process.env.IDP_SECRET_KEY = original;
  }
});
