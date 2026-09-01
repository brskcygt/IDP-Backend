/**
 * Tests for SafeStorageSecretStore and migrateStore (T-92).
 *
 * Exercises the `safeStorage`-backed SecretStore implementation without a
 * real Electron process: a fake `safeStorage` is injected that performs a
 * simple, reversible transform with a marker prefix, so "tampered/undecryptable"
 * blobs can be simulated deterministically.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const SafeStorageSecretStore = require('../src/secrets/SafeStorageSecretStore');
const FileSecretStore = require('../src/secrets/FileSecretStore');
const { migrateSecrets } = require('../src/secrets/migrateStore');

const MARKER = 'FAKE-ENC:';

/**
 * A fake `safeStorage` that mimics Electron's contract closely enough for
 * testing: `encryptString`/`decryptString` are a reversible transform, and
 * `isEncryptionAvailable` is configurable so we can simulate a machine with
 * no OS keyring backend.
 * @param {{ available?: boolean }} [opts]
 */
function makeFakeSafeStorage(opts = {}) {
  const { available = true } = opts;
  return {
    isEncryptionAvailable() {
      return available;
    },
    encryptString(plaintext) {
      return Buffer.from(MARKER + plaintext, 'utf8');
    },
    decryptString(buf) {
      const str = buf.toString('utf8');
      if (!str.startsWith(MARKER)) {
        throw new Error('fake safeStorage: blob missing marker, cannot decrypt');
      }
      return str.slice(MARKER.length);
    },
  };
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idp-safestorage-store-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('set/get round-trip returns the original secret', async () => {
  await withTempDir(async (dir) => {
    const store = new SafeStorageSecretStore({
      filePath: path.join(dir, 'secrets.safestorage.json'),
      safeStorage: makeFakeSafeStorage(),
    });
    await store.set('db.password', 'hunter2');
    assert.equal(await store.get('db.password'), 'hunter2');
  });
});

test('get on an unknown key resolves to null and never throws', async () => {
  await withTempDir(async (dir) => {
    const store = new SafeStorageSecretStore({
      filePath: path.join(dir, 'secrets.safestorage.json'),
      safeStorage: makeFakeSafeStorage(),
    });
    await assert.doesNotReject(async () => {
      assert.equal(await store.get('nope'), null);
    });
  });
});

test('delete returns true when a secret existed, false otherwise', async () => {
  await withTempDir(async (dir) => {
    const store = new SafeStorageSecretStore({
      filePath: path.join(dir, 'secrets.safestorage.json'),
      safeStorage: makeFakeSafeStorage(),
    });
    await store.set('k', 'v');
    assert.equal(await store.delete('k'), true);
    assert.equal(await store.delete('k'), false);
    assert.equal(await store.get('k'), null);
  });
});

test('has reflects presence without decrypting', async () => {
  await withTempDir(async (dir) => {
    const store = new SafeStorageSecretStore({
      filePath: path.join(dir, 'secrets.safestorage.json'),
      safeStorage: makeFakeSafeStorage(),
    });
    assert.equal(await store.has('k'), false);
    await store.set('k', 'v');
    assert.equal(await store.has('k'), true);
  });
});

test('listKeys returns key names only, never secret values', async () => {
  await withTempDir(async (dir) => {
    const store = new SafeStorageSecretStore({
      filePath: path.join(dir, 'secrets.safestorage.json'),
      safeStorage: makeFakeSafeStorage(),
    });
    await store.set('alpha', 'super-secret-alpha');
    await store.set('beta', 'super-secret-beta');

    const keys = await store.listKeys();
    assert.deepEqual(keys.sort(), ['alpha', 'beta']);

    const serialized = JSON.stringify(keys);
    assert.ok(!serialized.includes('super-secret-alpha'));
    assert.ok(!serialized.includes('super-secret-beta'));
  });
});

test('the encrypted file on disk never contains the plaintext secret', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'secrets.safestorage.json');
    const store = new SafeStorageSecretStore({ filePath, safeStorage: makeFakeSafeStorage() });
    const plaintext = 'CorrectHorseBatteryStaple-VPN-Password';
    await store.set('vpn.password', plaintext);

    const raw = await fs.readFile(filePath, 'utf8');
    assert.ok(!raw.includes(plaintext));
  });
});

test('the secrets file is written with 0600 permissions', { skip: process.platform === 'win32' }, async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'secrets.safestorage.json');
    const store = new SafeStorageSecretStore({ filePath, safeStorage: makeFakeSafeStorage() });
    await store.set('k', 'v');
    const stat = await fs.stat(filePath);
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

test('a structurally corrupt record is skipped without affecting other records', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'secrets.safestorage.json');
    const safeStorage = makeFakeSafeStorage();
    const store = new SafeStorageSecretStore({ filePath, safeStorage });
    await store.set('good', 'good-value');
    await store.set('bad', 'irrelevant');

    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
    onDisk.bad = 12345; // not a string at all — structurally invalid
    await fs.writeFile(filePath, JSON.stringify(onDisk));

    const reopened = new SafeStorageSecretStore({ filePath, safeStorage });
    assert.equal(await reopened.get('good'), 'good-value');
    // Skipped at load time -> behaves like a missing key, not a thrown error.
    assert.equal(await reopened.get('bad'), null);
    assert.ok(!(await reopened.listKeys()).includes('bad'));
  });
});

test('a record that fails to decrypt (tampered blob) throws a clear error', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'secrets.safestorage.json');
    const safeStorage = makeFakeSafeStorage();
    const store = new SafeStorageSecretStore({ filePath, safeStorage });
    await store.set('k', 'value');

    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
    // Well-formed string, but does not decode to a blob with our marker.
    onDisk.k = Buffer.from('not-the-right-marker-content', 'utf8').toString('base64');
    await fs.writeFile(filePath, JSON.stringify(onDisk));

    const reopened = new SafeStorageSecretStore({ filePath, safeStorage });
    await assert.rejects(() => reopened.get('k'), /tampered|decrypt/i);
  });
});

test('isEncryptionAvailable() false throws a clear error instead of falling back to plaintext', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'secrets.safestorage.json');
    const store = new SafeStorageSecretStore({
      filePath,
      safeStorage: makeFakeSafeStorage({ available: false }),
    });

    await assert.rejects(() => store.set('k', 'v'), /encryption is not available/i);

    // Nothing should have been written to disk.
    await assert.rejects(() => fs.access(filePath), /ENOENT/);
  });
});

test('get() also refuses to silently succeed when encryption becomes unavailable', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'secrets.safestorage.json');
    const writableSafeStorage = makeFakeSafeStorage({ available: true });
    const store = new SafeStorageSecretStore({ filePath, safeStorage: writableSafeStorage });
    await store.set('k', 'v');

    // Reopen with encryption reported unavailable (e.g. keyring locked/removed).
    const lockedSafeStorage = makeFakeSafeStorage({ available: false });
    const reopened = new SafeStorageSecretStore({ filePath, safeStorage: lockedSafeStorage });
    await assert.rejects(() => reopened.get('k'), /encryption is not available/i);
  });
});

test('migrateSecrets copies every key and round-trips values', async () => {
  await withTempDir(async (dir) => {
    const fromStore = new FileSecretStore({
      key: require('node:crypto').randomBytes(32),
      filePath: path.join(dir, 'source.enc.json'),
    });
    const toStore = new SafeStorageSecretStore({
      filePath: path.join(dir, 'dest.safestorage.json'),
      safeStorage: makeFakeSafeStorage(),
    });

    await fromStore.set('alpha', 'alpha-value');
    await fromStore.set('beta', 'beta-value');

    const result = await migrateSecrets(fromStore, toStore);

    assert.equal(result.migrated, 2);
    assert.equal(result.skipped, 0);
    assert.deepEqual(result.keys.sort(), ['alpha', 'beta']);

    assert.equal(await toStore.get('alpha'), 'alpha-value');
    assert.equal(await toStore.get('beta'), 'beta-value');
  });
});

test('migrateSecrets is idempotent: re-running skips already-migrated keys', async () => {
  await withTempDir(async (dir) => {
    const fromStore = new FileSecretStore({
      key: require('node:crypto').randomBytes(32),
      filePath: path.join(dir, 'source.enc.json'),
    });
    const toStore = new SafeStorageSecretStore({
      filePath: path.join(dir, 'dest.safestorage.json'),
      safeStorage: makeFakeSafeStorage(),
    });

    await fromStore.set('alpha', 'alpha-value');

    const first = await migrateSecrets(fromStore, toStore);
    assert.equal(first.migrated, 1);
    assert.equal(first.skipped, 0);

    const second = await migrateSecrets(fromStore, toStore);
    assert.equal(second.migrated, 0);
    assert.equal(second.skipped, 1);

    assert.equal(await toStore.get('alpha'), 'alpha-value');
  });
});

test('migrateSecrets never deletes anything from the source store', async () => {
  await withTempDir(async (dir) => {
    const sourceFilePath = path.join(dir, 'source.enc.json');
    const fromStore = new FileSecretStore({
      key: require('node:crypto').randomBytes(32),
      filePath: sourceFilePath,
    });
    const toStore = new SafeStorageSecretStore({
      filePath: path.join(dir, 'dest.safestorage.json'),
      safeStorage: makeFakeSafeStorage(),
    });

    await fromStore.set('alpha', 'alpha-value');
    await migrateSecrets(fromStore, toStore);

    // Source file still exists and the source store still serves the value.
    await assert.doesNotReject(() => fs.access(sourceFilePath));
    assert.equal(await fromStore.get('alpha'), 'alpha-value');
    assert.deepEqual(await fromStore.listKeys(), ['alpha']);
  });
});
