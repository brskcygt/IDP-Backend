/**
 * Regression tests for secret redaction (T-04).
 *
 * These guard the two failure modes that would be silent and destructive:
 *   1. A stored secret leaking out through GET /api/projects.
 *   2. A stored secret being wiped when the user saves settings without
 *      re-typing it (the client only ever receives `has*` presence flags).
 *
 * Run with: npm test
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { redactProject, mergeProjectConfig } = require('../src/api/projectSerialization');

const SECRETS = ['REAL_PASSWORD', 'REAL_TOKEN', 'REAL_PMP', 'REAL_VPN', 'REAL_SECRET'];

const storedProject = () => ({
  id: '1',
  name: 'Example',
  config: {
    host: '10.0.0.1',
    username: 'deployer',
    password: 'REAL_PASSWORD',
    apiToken: 'REAL_TOKEN',
    pmpConfig: { baseUrl: 'https://pmp', accountName: 'acc', authToken: 'REAL_PMP' },
    vpnConfig: {
      type: 'fortinet',
      host: 'vpn.example.com',
      password: 'REAL_VPN',
      mfaConfig: { type: 'totp', secret: 'REAL_SECRET', rememberSession: true },
    },
  },
});

test('redactProject strips every secret from the API response', () => {
  const serialized = JSON.stringify(redactProject(storedProject()));
  for (const secret of SECRETS) {
    assert.ok(!serialized.includes(secret), `secret leaked: ${secret}`);
  }
});

test('redactProject reports presence via has* flags', () => {
  const r = redactProject(storedProject());
  assert.equal(r.config.hasPassword, true);
  assert.equal(r.config.hasApiToken, true);
  assert.equal(r.config.pmpConfig.hasAuthToken, true);
  assert.equal(r.config.vpnConfig.hasPassword, true);
  assert.equal(r.config.vpnConfig.mfaConfig.hasSecret, true);
});

test('redactProject does not mutate the stored project', () => {
  const project = storedProject();
  redactProject(project);
  assert.equal(project.config.password, 'REAL_PASSWORD');
});

test('redactProject preserves non-secret fields', () => {
  const r = redactProject(storedProject());
  assert.equal(r.config.host, '10.0.0.1');
  assert.equal(r.config.vpnConfig.mfaConfig.rememberSession, true);
});

test('redactProject tolerates a project with no config', () => {
  assert.doesNotThrow(() => redactProject({ id: '2', name: 'Bare' }));
});

test('saving settings without retyping secrets preserves them', () => {
  const stored = storedProject();
  // What the client sends back: the redacted config it was given, plus one edit.
  const roundtrip = JSON.parse(JSON.stringify(redactProject(stored).config));
  roundtrip.host = '10.0.0.99';

  const merged = mergeProjectConfig(stored.config, roundtrip);

  assert.equal(merged.password, 'REAL_PASSWORD');
  assert.equal(merged.apiToken, 'REAL_TOKEN');
  assert.equal(merged.pmpConfig.authToken, 'REAL_PMP');
  assert.equal(merged.vpnConfig.password, 'REAL_VPN');
  assert.equal(merged.vpnConfig.mfaConfig.secret, 'REAL_SECRET');
  assert.equal(merged.host, '10.0.0.99', 'non-secret edit should still apply');
});

test('has* flags are never persisted into config', () => {
  const stored = storedProject();
  const roundtrip = JSON.parse(JSON.stringify(redactProject(stored).config));
  const merged = mergeProjectConfig(stored.config, roundtrip);

  assert.ok(!('hasPassword' in merged));
  assert.ok(!('hasApiToken' in merged));
  assert.ok(!('hasAuthToken' in merged.pmpConfig));
  assert.ok(!('hasPassword' in merged.vpnConfig));
  assert.ok(!('hasSecret' in merged.vpnConfig.mfaConfig));
});

test('a newly typed secret overwrites the stored one', () => {
  const stored = storedProject();
  const merged = mergeProjectConfig(stored.config, { password: 'NEW_PASSWORD' });
  assert.equal(merged.password, 'NEW_PASSWORD');
});

test('a blank or whitespace secret does not erase the stored one', () => {
  const stored = storedProject();
  assert.equal(mergeProjectConfig(stored.config, { password: '   ' }).password, 'REAL_PASSWORD');
  assert.equal(mergeProjectConfig(stored.config, { password: '' }).password, 'REAL_PASSWORD');
});

test('mergeProjectConfig tolerates an empty existing config', () => {
  assert.equal(mergeProjectConfig(undefined, { host: 'h' }).host, 'h');
});

// ── Per-environment overrides (T-50) ──────────────────────────────────────────
// Environment secrets used to slip through both directions: redaction returned
// the raw `secret://…` reference, and a settings save wiped the stored value and
// persisted `hasPassword: true` in its place.

const projectWithEnvironments = () => ({
  id: 'p-env',
  name: 'Multi-env',
  config: {
    host: 'base-host',
    password: 'BASE_SECRET',
    environments: {
      Prod: { host: 'prod-host', password: 'PROD_SECRET', vpnConfig: { password: 'PROD_VPN_SECRET' } },
      Dev: { host: 'dev-host' },
    },
  },
});

test('redaction covers per-environment secrets', () => {
  const redacted = redactProject(projectWithEnvironments());
  const serialized = JSON.stringify(redacted);

  for (const secret of ['BASE_SECRET', 'PROD_SECRET', 'PROD_VPN_SECRET']) {
    assert.ok(!serialized.includes(secret), `environment secret leaked: ${secret}`);
  }
  assert.equal(redacted.config.environments.Prod.hasPassword, true);
  assert.equal(redacted.config.environments.Prod.vpnConfig.hasPassword, true);
  assert.equal(redacted.config.environments.Prod.host, 'prod-host', 'non-secret overrides stay visible');
});

test('saving settings preserves per-environment secrets', () => {
  const stored = projectWithEnvironments();
  const roundtrip = JSON.parse(JSON.stringify(redactProject(stored).config));
  roundtrip.host = 'changed-host';

  const merged = mergeProjectConfig(stored.config, roundtrip);

  assert.equal(merged.password, 'BASE_SECRET');
  assert.equal(merged.environments.Prod.password, 'PROD_SECRET');
  assert.equal(merged.environments.Prod.vpnConfig.password, 'PROD_VPN_SECRET');
  assert.equal(merged.host, 'changed-host');
  assert.equal(merged.environments.Dev.host, 'dev-host', 'untouched environments survive');
});

test('no has* presence flag is ever persisted, at any depth', () => {
  const stored = projectWithEnvironments();
  const roundtrip = JSON.parse(JSON.stringify(redactProject(stored).config));
  const serialized = JSON.stringify(mergeProjectConfig(stored.config, roundtrip));

  assert.ok(!/"has[A-Z]/.test(serialized), `presence flag persisted into config: ${serialized}`);
});

test('a newly typed environment secret overwrites the stored one', () => {
  const stored = projectWithEnvironments();
  const merged = mergeProjectConfig(stored.config, {
    environments: { Prod: { password: 'ROTATED' } },
  });
  assert.equal(merged.environments.Prod.password, 'ROTATED');
  assert.equal(merged.environments.Prod.host, 'prod-host', 'sibling fields survive a partial patch');
});
