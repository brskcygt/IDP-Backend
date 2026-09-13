/**
 * `artifactDeploy.source.token` is a project secret: encrypted at rest,
 * redacted to a `hasToken` presence flag in API responses, preserved when a
 * settings save omits it — while the rest of `artifactDeploy` is replaced
 * wholesale on save (like ciConfig).
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FileSecretStore = require('../src/secrets/FileSecretStore');
const { isRef, SECRET_FIELD_PATHS } = require('../src/secrets/secretRef');
const { persistProjectSecrets, resolveProjectSecrets, deleteProjectSecrets } = require('../src/secrets/projectSecrets');
const { redactProject, mergeProjectConfig } = require('../src/api/projectSerialization');

const SOURCE_TOKEN = 'SRC-TOKEN-plaintext-123';

const components = () => [
  { name: 'backend', subdir: 'backend', runtime: { type: 'nssm', serviceName: 'jetsrm-backend' } },
  { name: 'frontend', subdir: 'frontend', runtime: { type: 'iis-static' }, writeRuntimeConfig: true },
];

const storedProject = () => ({
  id: 'p1',
  name: 'JetSRM',
  config: {
    apiToken: 'CI-TOKEN',
    artifactDeploy: {
      source: { platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm', token: SOURCE_TOKEN },
      build: { provider: 'pipeline' },
      components: components(),
    },
  },
});

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-artifact-secret-'));
  const store = new FileSecretStore({ filePath: path.join(dir, 'secrets.enc.json'), key: crypto.randomBytes(32) });
  return { store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('artifactDeploy.source.token is a registered secret field', () => {
  assert.ok(SECRET_FIELD_PATHS.includes('artifactDeploy.source.token'));
});

test('redactProject strips the source token and reports hasToken', () => {
  const redacted = redactProject(storedProject());
  assert.ok(!JSON.stringify(redacted).includes(SOURCE_TOKEN));
  assert.equal(redacted.config.artifactDeploy.source.hasToken, true);
  assert.equal(redacted.config.artifactDeploy.source.token, undefined);
  assert.equal(redacted.config.artifactDeploy.source.owner, 'mdp');

  const withoutToken = storedProject();
  delete withoutToken.config.artifactDeploy.source.token;
  assert.equal(redactProject(withoutToken).config.artifactDeploy.source.hasToken, undefined);
});

test('a settings save without the token keeps it, and artifactDeploy is replaced wholesale', () => {
  const stored = storedProject();
  // What the UI sends back: redacted source (hasToken flag, no token) and one component removed.
  const incoming = {
    artifactDeploy: {
      source: { platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm', hasToken: true },
      build: { provider: 'none' },
      components: [components()[1]],
    },
  };
  const merged = mergeProjectConfig(stored.config, incoming);
  assert.equal(merged.artifactDeploy.source.token, SOURCE_TOKEN);
  assert.equal(merged.artifactDeploy.source.hasToken, undefined);
  assert.deepEqual(merged.artifactDeploy.components.map((c) => c.name), ['frontend']);
  assert.equal(merged.artifactDeploy.build.provider, 'none');
  assert.equal(merged.apiToken, 'CI-TOKEN');

  // A blank token field means "unchanged" as well.
  const blank = mergeProjectConfig(stored.config, { artifactDeploy: { ...incoming.artifactDeploy, source: { ...incoming.artifactDeploy.source, token: '' } } });
  assert.equal(blank.artifactDeploy.source.token, SOURCE_TOKEN);

  // A typed token replaces it.
  const replaced = mergeProjectConfig(stored.config, { artifactDeploy: { ...incoming.artifactDeploy, source: { ...incoming.artifactDeploy.source, token: 'NEW' } } });
  assert.equal(replaced.artifactDeploy.source.token, 'NEW');

  // A saved token cannot silently follow a repo/API/auth identity change.
  const movedSource = mergeProjectConfig(stored.config, {
    artifactDeploy: {
      ...incoming.artifactDeploy,
      source: { ...incoming.artifactDeploy.source, repo: 'other-repo', token: '' },
    },
  });
  assert.equal(movedSource.artifactDeploy.source.token, undefined);

  const movedWithNewToken = mergeProjectConfig(stored.config, {
    artifactDeploy: {
      ...incoming.artifactDeploy,
      source: { ...incoming.artifactDeploy.source, baseUrl: 'https://git.example/api/v3', token: 'NEW-FOR-HOST' },
    },
  });
  assert.equal(movedWithNewToken.artifactDeploy.source.token, 'NEW-FOR-HOST');

  // A removed hook disappears instead of being resurrected by a deep merge.
  const withHook = storedProject();
  withHook.config.artifactDeploy.components[0].hooks = { preStart: [{ name: 'migrate', command: 'node', args: [] }] };
  const noHook = mergeProjectConfig(withHook.config, { artifactDeploy: { ...withHook.config.artifactDeploy, components: components() } });
  assert.equal(noHook.artifactDeploy.components[0].hooks, undefined);

  // Unrelated saves leave artifactDeploy untouched.
  const unrelated = mergeProjectConfig(stored.config, { host: '10.0.0.1' });
  assert.deepEqual(unrelated.artifactDeploy, stored.config.artifactDeploy);
});

test('the source token is encrypted at rest and resolved for backend use only', async () => {
  const { store, cleanup } = makeStore();
  try {
    const persisted = await persistProjectSecrets(storedProject(), store);
    assert.ok(isRef(persisted.config.artifactDeploy.source.token));
    assert.ok(!JSON.stringify(persisted).includes(SOURCE_TOKEN));

    const resolved = await resolveProjectSecrets(persisted, store);
    assert.equal(resolved.config.artifactDeploy.source.token, SOURCE_TOKEN);
    assert.ok(isRef(persisted.config.artifactDeploy.source.token), 'resolve must not mutate the persisted project');

    // Saving again without re-typing the token keeps the reference, not plaintext.
    const merged = mergeProjectConfig(persisted.config, { artifactDeploy: { ...persisted.config.artifactDeploy, source: { platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm', hasToken: true } } });
    assert.equal(merged.artifactDeploy.source.token, persisted.config.artifactDeploy.source.token);

    assert.ok((await deleteProjectSecrets('p1', store, persisted.config)) >= 2);
    assert.equal(await store.get(persisted.config.artifactDeploy.source.token), null);
  } finally {
    cleanup();
  }
});
