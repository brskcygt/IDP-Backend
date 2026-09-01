/**
 * Tests for environment config resolution (T-50).
 *
 * The failure mode this guards against is silent and dangerous: a project
 * with no environment overrides configured must resolve to the exact same
 * config regardless of which environment was requested — that's what makes
 * "Dev/Stage/Prod all hit the same server" an honest default instead of a
 * false promise once overrides *are* configured for some environments but
 * not others.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  resolveEnvironmentConfig,
  listConfiguredEnvironments,
  hasEnvironmentOverrides,
} = require('../src/utils/environmentConfig');
const { getSecretFieldPaths, SECRET_FIELD_PATHS } = require('../src/secrets/secretRef');

const baseConfig = () => ({
  host: '10.0.0.1',
  port: '22',
  username: 'deployer',
  scriptContent: 'echo hi',
  vpnConfig: {
    type: 'fortinet',
    host: 'vpn.base.example.com',
    username: 'vpn-user',
    mfaConfig: { type: 'totp', rememberSession: true },
  },
  environments: {
    Dev: { host: '10.0.0.2' },
    Prod: {
      host: '10.0.9.9',
      username: 'prod-deployer',
      password: 'PROD_SECRET',
      vpnConfig: { host: 'vpn.prod.example.com', password: 'VPN_PROD_SECRET' },
    },
  },
});

test('no environments configured -> base config returned unchanged, matched: false', () => {
  const config = { host: '10.0.0.1', username: 'deployer' };
  const result = resolveEnvironmentConfig(config, 'Prod');
  assert.deepEqual(result, { config: { host: '10.0.0.1', username: 'deployer' }, matched: false });
});

test('unknown environment name -> base config returned, matched: false', () => {
  const result = resolveEnvironmentConfig(baseConfig(), 'DoesNotExist');
  assert.equal(result.matched, false);
  assert.equal(result.config.host, '10.0.0.1');
  assert.equal(result.config.username, 'deployer');
});

test('no environment requested at all -> base config, matched: false', () => {
  const result = resolveEnvironmentConfig(baseConfig(), undefined);
  assert.equal(result.matched, false);
  assert.equal(result.config.host, '10.0.0.1');
});

test('matched environment overrides only the fields it defines, rest inherited from base', () => {
  const result = resolveEnvironmentConfig(baseConfig(), 'Prod');
  assert.equal(result.matched, true);
  assert.equal(result.config.host, '10.0.9.9');
  assert.equal(result.config.username, 'prod-deployer');
  assert.equal(result.config.password, 'PROD_SECRET');
  // Inherited from base — Prod's override never mentions it.
  assert.equal(result.config.port, '22');
  assert.equal(result.config.scriptContent, 'echo hi');
});

test('a partial override (Dev only sets host) inherits everything else from base', () => {
  const result = resolveEnvironmentConfig(baseConfig(), 'Dev');
  assert.equal(result.matched, true);
  assert.equal(result.config.host, '10.0.0.2');
  assert.equal(result.config.username, 'deployer'); // from base
  assert.equal(result.config.port, '22'); // from base
});

test('nested vpnConfig is merged field-by-field, not replaced wholesale', () => {
  const result = resolveEnvironmentConfig(baseConfig(), 'Prod');
  assert.equal(result.config.vpnConfig.host, 'vpn.prod.example.com'); // overridden
  assert.equal(result.config.vpnConfig.password, 'VPN_PROD_SECRET'); // overridden
  assert.equal(result.config.vpnConfig.username, 'vpn-user'); // inherited from base
  assert.equal(result.config.vpnConfig.type, 'fortinet'); // inherited from base
  // mfaConfig wasn't touched by the override at all — stays intact.
  assert.deepEqual(result.config.vpnConfig.mfaConfig, { type: 'totp', rememberSession: true });
});

test('the effective config never carries the environments map itself', () => {
  const matched = resolveEnvironmentConfig(baseConfig(), 'Prod');
  const unmatched = resolveEnvironmentConfig(baseConfig(), 'Nope');
  assert.equal('environments' in matched.config, false);
  assert.equal('environments' in unmatched.config, false);
});

test('resolveEnvironmentConfig never mutates its input', () => {
  const original = baseConfig();
  const snapshot = JSON.parse(JSON.stringify(original));

  resolveEnvironmentConfig(original, 'Prod');
  resolveEnvironmentConfig(original, 'Dev');
  resolveEnvironmentConfig(original, 'Unknown');

  assert.deepEqual(original, snapshot);
});

test('listConfiguredEnvironments lists override names; empty when none configured', () => {
  assert.deepEqual(listConfiguredEnvironments(baseConfig()), ['Dev', 'Prod']);
  assert.deepEqual(listConfiguredEnvironments({ host: 'h' }), []);
  assert.deepEqual(listConfiguredEnvironments(undefined), []);
});

test('hasEnvironmentOverrides reflects whether any override exists', () => {
  assert.equal(hasEnvironmentOverrides(baseConfig()), true);
  assert.equal(hasEnvironmentOverrides({ host: 'h' }), false);
  assert.equal(hasEnvironmentOverrides({ host: 'h', environments: {} }), false);
});

test('getSecretFieldPaths returns the base paths unchanged when no environments exist', () => {
  assert.deepEqual(getSecretFieldPaths({ host: 'h' }), SECRET_FIELD_PATHS);
});

test('getSecretFieldPaths adds only the environment paths that actually exist in config', () => {
  const paths = getSecretFieldPaths(baseConfig());

  // Base paths still present.
  for (const basePath of SECRET_FIELD_PATHS) {
    assert.ok(paths.includes(basePath), `missing base path: ${basePath}`);
  }

  // Prod defines password and vpnConfig.password -> both discovered.
  assert.ok(paths.includes('environments.Prod.password'));
  assert.ok(paths.includes('environments.Prod.vpnConfig.password'));

  // Dev only defines `host` -> no secret paths invented for Dev.
  assert.ok(!paths.includes('environments.Dev.password'));
  assert.ok(!paths.includes('environments.Dev.vpnConfig.password'));

  // Neither environment defines apiToken or pmpConfig.authToken.
  assert.ok(!paths.includes('environments.Prod.apiToken'));
  assert.ok(!paths.includes('environments.Prod.pmpConfig.authToken'));
});

test('getSecretFieldPaths tolerates a missing or malformed environments map', () => {
  assert.deepEqual(getSecretFieldPaths(null), SECRET_FIELD_PATHS);
  assert.deepEqual(getSecretFieldPaths({ environments: null }), SECRET_FIELD_PATHS);
  assert.deepEqual(getSecretFieldPaths({ environments: 'not-an-object' }), SECRET_FIELD_PATHS);
  assert.deepEqual(getSecretFieldPaths({ environments: [] }), SECRET_FIELD_PATHS);
});
