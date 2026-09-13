'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  collectRefs,
  persistTargetRuntimeConfig,
  resolveTargetRuntimeConfig,
  deleteReplacedTargetSecrets,
  deleteTargetSecrets,
  redactTargetRuntimeConfig,
} = require('../src/core/artifacts/targetSecrets');

class MemorySecretStore {
  constructor() { this.values = new Map(); }
  async set(key, value) { this.values.set(key, value); }
  async get(key) { return this.values.get(key) ?? null; }
  async delete(key) { return this.values.delete(key); }
}

test('target runtime config is encrypted behind opaque refs and resolves for authorized use', async () => {
  const store = new MemorySecretStore();
  const plain = {
    backend: { format: 'env-file', values: { DB_PASSWORD: 'top-secret', PORT: '3000' } },
    frontend: { format: 'frontend-config-js', values: { VITE_API_URL: 'https://api.example' } },
  };
  const persisted = await persistTargetRuntimeConfig('tgt_1', plain, store);

  assert.equal(JSON.stringify(persisted.runtimeConfig).includes('top-secret'), false);
  assert.equal(collectRefs(persisted.runtimeConfig).size, 3);
  assert.deepEqual(await resolveTargetRuntimeConfig(persisted.runtimeConfig, store), plain);
});

test('replacing and deleting config removes only stale target secret generations', async () => {
  const store = new MemorySecretStore();
  const first = await persistTargetRuntimeConfig('tgt_1', {
    backend: { format: 'env-file', values: { TOKEN: 'old' } },
  }, store);
  const second = await persistTargetRuntimeConfig('tgt_1', {
    backend: { format: 'env-file', values: { TOKEN: 'new' } },
  }, store);

  await deleteReplacedTargetSecrets(first.runtimeConfig, second.runtimeConfig, store);
  assert.equal(store.values.size, 1);
  assert.deepEqual(await resolveTargetRuntimeConfig(second.runtimeConfig, store), {
    backend: { format: 'env-file', values: { TOKEN: 'new' } },
  });
  await deleteTargetSecrets(second.runtimeConfig, store);
  assert.equal(store.values.size, 0);
});

test('without a secret store runtime config remains backward compatible', async () => {
  const plain = { backend: { format: 'env-file', values: { PORT: '3000' } } };
  assert.deepEqual((await persistTargetRuntimeConfig('tgt_1', plain, null)).runtimeConfig, plain);
  assert.deepEqual(await resolveTargetRuntimeConfig(plain, null), plain);
});

test('production env-file config fails closed without encryption and client-supplied refs are encrypted as text', async () => {
  const config = { backend: { format: 'env-file', values: { TOKEN: 'secret://foreign/key' } } };
  await assert.rejects(
    persistTargetRuntimeConfig('tgt_1', config, null, { requireEncryption: true }),
    /IDP_SECRET_KEY/
  );
  await assert.rejects(
    resolveTargetRuntimeConfig(config, null, { requireEncryption: true }),
    /IDP_SECRET_KEY/
  );
  const store = new MemorySecretStore();
  const persisted = await persistTargetRuntimeConfig('tgt_1', config, store);
  assert.notEqual(persisted.runtimeConfig.backend.values.TOKEN, 'secret://foreign/key');
  assert.deepEqual(await resolveTargetRuntimeConfig(persisted.runtimeConfig, store), config);
  await assert.rejects(
    resolveTargetRuntimeConfig({
      backend: { format: 'env-file', values: { TOKEN: 'old-plaintext-value' } },
    }, store, { requireEncryption: true }),
    /plaintext storage values/
  );
});

test('redacted target config exposes key names and formats but never values', () => {
  assert.deepEqual(redactTargetRuntimeConfig({
    backend: { format: 'env-file', values: { TOKEN: 'secret://target/value' } },
  }), {
    backend: { format: 'env-file', values: { TOKEN: '[stored]' } },
  });
});
