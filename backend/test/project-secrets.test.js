/**
 * Tests for the projects.json ↔ SecretStore bridge (T-10 / SEC-01).
 *
 * The failure modes these guard against are both silent and expensive:
 *   - resolving secrets into the persisted project object, so the next
 *     saveProjects() writes plaintext credentials back to disk;
 *   - a reference that resolves to nothing being handed to an adapter as a
 *     password, which surfaces as a confusing auth failure against a real server.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FileSecretStore = require('../src/secrets/FileSecretStore');
const { isRef } = require('../src/secrets/secretRef');
const {
  persistProjectSecrets,
  resolveProjectSecrets,
  deleteProjectSecrets,
} = require('../src/secrets/projectSecrets');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-projsec-'));
  const store = new FileSecretStore({
    filePath: path.join(dir, 'secrets.enc.json'),
    key: crypto.randomBytes(32),
  });
  return { store, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const sampleProject = () => ({
  id: 'p1',
  name: 'Example',
  config: {
    host: '10.0.0.1',
    username: 'deployer',
    password: 'SSH_PLAINTEXT',
    apiToken: 'JENKINS_PLAINTEXT',
    pmpConfig: { baseUrl: 'https://pmp', authToken: 'PMP_PLAINTEXT' },
    vpnConfig: {
      type: 'fortinet',
      password: 'VPN_PLAINTEXT',
      mfaConfig: { type: 'totp', secret: 'TOTP_PLAINTEXT', rememberSession: true },
    },
  },
});

const ALL_PLAINTEXT = ['SSH_PLAINTEXT', 'JENKINS_PLAINTEXT', 'PMP_PLAINTEXT', 'VPN_PLAINTEXT', 'TOTP_PLAINTEXT'];

test('persist replaces every secret with a reference', async () => {
  const { store, cleanup } = makeStore();
  try {
    const persisted = await persistProjectSecrets(sampleProject(), store);
    const serialized = JSON.stringify(persisted);

    for (const secret of ALL_PLAINTEXT) {
      assert.ok(!serialized.includes(secret), `plaintext survived persist: ${secret}`);
    }
    assert.ok(isRef(persisted.config.password));
    assert.ok(isRef(persisted.config.apiToken));
    assert.ok(isRef(persisted.config.pmpConfig.authToken));
    assert.ok(isRef(persisted.config.vpnConfig.password));
    assert.ok(isRef(persisted.config.vpnConfig.mfaConfig.secret));
  } finally { cleanup(); }
});

test('persist does not mutate the input project', async () => {
  const { store, cleanup } = makeStore();
  try {
    const original = sampleProject();
    await persistProjectSecrets(original, store);
    assert.equal(original.config.password, 'SSH_PLAINTEXT');
    assert.equal(original.config.vpnConfig.mfaConfig.secret, 'TOTP_PLAINTEXT');
  } finally { cleanup(); }
});

test('persist preserves non-secret fields', async () => {
  const { store, cleanup } = makeStore();
  try {
    const persisted = await persistProjectSecrets(sampleProject(), store);
    assert.equal(persisted.config.host, '10.0.0.1');
    assert.equal(persisted.config.username, 'deployer');
    assert.equal(persisted.config.vpnConfig.type, 'fortinet');
    assert.equal(persisted.config.vpnConfig.mfaConfig.rememberSession, true);
  } finally { cleanup(); }
});

test('persist → resolve round-trips every credential', async () => {
  const { store, cleanup } = makeStore();
  try {
    const persisted = await persistProjectSecrets(sampleProject(), store);
    const resolved = await resolveProjectSecrets(persisted, store);

    assert.equal(resolved.config.password, 'SSH_PLAINTEXT');
    assert.equal(resolved.config.apiToken, 'JENKINS_PLAINTEXT');
    assert.equal(resolved.config.pmpConfig.authToken, 'PMP_PLAINTEXT');
    assert.equal(resolved.config.vpnConfig.password, 'VPN_PLAINTEXT');
    assert.equal(resolved.config.vpnConfig.mfaConfig.secret, 'TOTP_PLAINTEXT');
  } finally { cleanup(); }
});

test('resolve does not mutate the persisted project — the disk-safety invariant', async () => {
  const { store, cleanup } = makeStore();
  try {
    const persisted = await persistProjectSecrets(sampleProject(), store);
    await resolveProjectSecrets(persisted, store);

    // If resolve mutated `persisted`, the next saveProjects() would write
    // plaintext credentials straight back to projects.json.
    const serialized = JSON.stringify(persisted);
    for (const secret of ALL_PLAINTEXT) {
      assert.ok(!serialized.includes(secret), `resolve leaked plaintext back into the persisted object: ${secret}`);
    }
  } finally { cleanup(); }
});

test('persist is idempotent — re-running does not double-wrap references', async () => {
  const { store, cleanup } = makeStore();
  try {
    const once = await persistProjectSecrets(sampleProject(), store);
    const twice = await persistProjectSecrets(once, store);

    assert.deepEqual(twice.config, once.config);
    const resolved = await resolveProjectSecrets(twice, store);
    assert.equal(resolved.config.password, 'SSH_PLAINTEXT');
  } finally { cleanup(); }
});

test('a dangling reference throws instead of reaching an adapter', async () => {
  const { store, cleanup } = makeStore();
  try {
    const persisted = await persistProjectSecrets(sampleProject(), store);
    await store.delete(persisted.config.password); // simulate a wiped store

    await assert.rejects(
      () => resolveProjectSecrets(persisted, store),
      /Stored credential missing/
    );
  } finally { cleanup(); }
});

test('blank and absent secrets are left alone', async () => {
  const { store, cleanup } = makeStore();
  try {
    const project = { id: 'p2', name: 'Sparse', config: { host: 'h', password: '   ' } };
    const persisted = await persistProjectSecrets(project, store);
    assert.equal(persisted.config.password, '   ', 'blank should not become a reference');
    assert.ok(!('apiToken' in persisted.config), 'absent field should not be invented');
  } finally { cleanup(); }
});

test('with no store configured both directions are pass-throughs', async () => {
  const project = sampleProject();
  assert.deepEqual(await persistProjectSecrets(project, null), project);
  assert.deepEqual(await resolveProjectSecrets(project, null), project);
  assert.equal(await deleteProjectSecrets('p1', null), 0);
});

test('deleting a project removes its stored credentials', async () => {
  const { store, cleanup } = makeStore();
  try {
    await persistProjectSecrets(sampleProject(), store);
    const removed = await deleteProjectSecrets('p1', store);
    assert.equal(removed, 5, 'all five secret fields should be removed');
    assert.deepEqual(await store.listKeys(), []);
  } finally { cleanup(); }
});

test('one project cannot read another project’s secrets', async () => {
  const { store, cleanup } = makeStore();
  try {
    await persistProjectSecrets(sampleProject(), store);
    const other = { ...sampleProject(), id: 'p2' };
    await persistProjectSecrets(other, store);

    await deleteProjectSecrets('p1', store);

    // p2's credentials must be untouched by p1's deletion.
    const persistedOther = await persistProjectSecrets({ ...other, config: { ...other.config } }, store);
    const resolved = await resolveProjectSecrets(persistedOther, store);
    assert.equal(resolved.config.password, 'SSH_PLAINTEXT');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// T-50: environment override secrets (config.environments.<name>.<field>)
// ---------------------------------------------------------------------------

const sampleProjectWithEnvironments = () => ({
  id: 'p1',
  name: 'Example',
  config: {
    host: '10.0.0.1',
    username: 'deployer',
    password: 'SSH_PLAINTEXT',
    environments: {
      Dev: { host: '10.0.0.2' }, // no secrets of its own
      Prod: {
        host: '10.0.9.9',
        username: 'prod-deployer',
        password: 'PROD_PLAINTEXT',
        vpnConfig: { password: 'VPN_PROD_PLAINTEXT' },
      },
    },
  },
});

test('persist replaces environment-override secrets with references too', async () => {
  const { store, cleanup } = makeStore();
  try {
    const persisted = await persistProjectSecrets(sampleProjectWithEnvironments(), store);
    const serialized = JSON.stringify(persisted);

    assert.ok(!serialized.includes('PROD_PLAINTEXT'), 'plaintext survived persist');
    assert.ok(!serialized.includes('VPN_PROD_PLAINTEXT'), 'plaintext survived persist');
    assert.ok(isRef(persisted.config.environments.Prod.password));
    assert.ok(isRef(persisted.config.environments.Prod.vpnConfig.password));

    // Dev never had a secret of its own — nothing invented for it.
    assert.equal(persisted.config.environments.Dev.host, '10.0.0.2');
    assert.ok(!('password' in persisted.config.environments.Dev));

    // Base secret still handled as before.
    assert.ok(isRef(persisted.config.password));
  } finally { cleanup(); }
});

test('environment secrets round-trip persist -> resolve back to plaintext', async () => {
  const { store, cleanup } = makeStore();
  try {
    const persisted = await persistProjectSecrets(sampleProjectWithEnvironments(), store);
    const resolved = await resolveProjectSecrets(persisted, store);

    assert.equal(resolved.config.environments.Prod.password, 'PROD_PLAINTEXT');
    assert.equal(resolved.config.environments.Prod.vpnConfig.password, 'VPN_PROD_PLAINTEXT');
    assert.equal(resolved.config.password, 'SSH_PLAINTEXT');
  } finally { cleanup(); }
});

test('persisting environment secrets does not mutate the input project', async () => {
  const { store, cleanup } = makeStore();
  try {
    const original = sampleProjectWithEnvironments();
    await persistProjectSecrets(original, store);
    assert.equal(original.config.environments.Prod.password, 'PROD_PLAINTEXT');
    assert.equal(original.config.environments.Prod.vpnConfig.password, 'VPN_PROD_PLAINTEXT');
  } finally { cleanup(); }
});

test('deleteProjectSecrets(id, store, config) also removes environment-scoped secrets', async () => {
  const { store, cleanup } = makeStore();
  try {
    await persistProjectSecrets(sampleProjectWithEnvironments(), store);

    // Base password + Prod password + Prod vpnConfig.password = 3 stored secrets.
    const removed = await deleteProjectSecrets('p1', store, sampleProjectWithEnvironments().config);
    assert.equal(removed, 3);
    assert.deepEqual(await store.listKeys(), []);
  } finally { cleanup(); }
});

test('deleteProjectSecrets without a config argument falls back to the static base paths only', async () => {
  const { store, cleanup } = makeStore();
  try {
    const persisted = await persistProjectSecrets(sampleProjectWithEnvironments(), store);

    // Old 2-arg call site (pre-T-50 callers): only the 5 static base paths
    // are attempted. Only `password` exists among them for this project, so
    // exactly one entry is removed — the environment-scoped ones are left behind.
    const removed = await deleteProjectSecrets('p1', store);
    assert.equal(removed, 1);

    // The base password reference is now dangling (deleted)...
    assert.equal(await store.get(persisted.config.password), null);
    // ...but the environment-scoped secrets are untouched by the fallback.
    assert.equal(
      await store.get(persisted.config.environments.Prod.password),
      'PROD_PLAINTEXT'
    );
    assert.equal(
      await store.get(persisted.config.environments.Prod.vpnConfig.password),
      'VPN_PROD_PLAINTEXT'
    );
  } finally { cleanup(); }
});

test('a project with no environments configured behaves exactly as before', async () => {
  const { store, cleanup } = makeStore();
  try {
    const persisted = await persistProjectSecrets(sampleProject(), store);
    assert.ok(isRef(persisted.config.password));
    assert.ok(!('environments' in persisted.config));
  } finally { cleanup(); }
});
