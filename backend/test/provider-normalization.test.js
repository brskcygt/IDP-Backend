/**
 * Regression tests for provider normalization (T-35/T-36).
 *
 * `Server`, `SSH`, and `WinRM` are one adapter family split only by
 * `config.targetOS` — these tests guard the two things that would silently
 * break if that stopped being true:
 *   1. `isServerProvider` routing a legacy `SSH`/`WinRM` project to the
 *      wrong adapter (or a canonical `Server` project to none at all).
 *   2. `migrateProjectProviders` losing data — clobbering an already-set
 *      `targetOS`, mutating the input, or dropping fields — while folding
 *      legacy provider names into the canonical `Server` value.
 *
 * Run with: npm test
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { isServerProvider, migrateProjectProviders } = require('../src/utils/providerUtils');

test('isServerProvider recognizes the whole Server/SSH/WinRM family', () => {
  assert.equal(isServerProvider('Server'), true);
  assert.equal(isServerProvider('SSH'), true);
  assert.equal(isServerProvider('WinRM'), true);
});

test('isServerProvider rejects non-server providers', () => {
  assert.equal(isServerProvider('Jenkins'), false);
  assert.equal(isServerProvider('PMP'), false);
  assert.equal(isServerProvider('bogus'), false);
  assert.equal(isServerProvider(undefined), false);
});

test('migrateProjectProviders converts SSH to Server and fills targetOS=linux', () => {
  const [migrated] = migrateProjectProviders([
    { id: '1', name: 'Legacy SSH box', provider: 'SSH', config: { host: '10.0.0.1' } },
  ]);
  assert.equal(migrated.provider, 'Server');
  assert.equal(migrated.config.targetOS, 'linux');
  assert.equal(migrated.config.host, '10.0.0.1');
});

test('migrateProjectProviders converts WinRM to Server and fills targetOS=windows', () => {
  const [migrated] = migrateProjectProviders([
    { id: '2', name: 'Legacy WinRM box', provider: 'WinRM', config: { host: '10.0.0.2' } },
  ]);
  assert.equal(migrated.provider, 'Server');
  assert.equal(migrated.config.targetOS, 'windows');
});

test('migrateProjectProviders never overwrites an already-set targetOS', () => {
  // Real data can be inconsistent (e.g. a WinRM record whose targetOS was
  // hand-edited to 'linux') — migration must preserve it rather than
  // "fixing" it based on the legacy provider name.
  const [migrated] = migrateProjectProviders([
    { id: '3', name: 'Inconsistent record', provider: 'WinRM', config: { targetOS: 'linux' } },
  ]);
  assert.equal(migrated.provider, 'Server');
  assert.equal(migrated.config.targetOS, 'linux');
});

test('migrateProjectProviders leaves already-canonical providers unchanged', () => {
  const input = [
    { id: '4', name: 'Already Server', provider: 'Server', config: { targetOS: 'windows' } },
    { id: '5', name: 'Jenkins job', provider: 'Jenkins', config: { url: 'http://ci' } },
    { id: '6', name: 'PMP portal', provider: 'PMP', config: {} },
  ];
  const migrated = migrateProjectProviders(input);
  assert.deepEqual(migrated, input);
});

test('migrateProjectProviders handles a missing config object', () => {
  const [migrated] = migrateProjectProviders([{ id: '7', name: 'No config', provider: 'SSH' }]);
  assert.equal(migrated.provider, 'Server');
  assert.equal(migrated.config.targetOS, 'linux');
});

test('migrateProjectProviders is pure: it never mutates its input', () => {
  const original = { id: '8', name: 'SSH box', provider: 'SSH', config: { host: '10.0.0.8' } };
  const input = [original];
  const originalSnapshot = JSON.parse(JSON.stringify(original));

  const migrated = migrateProjectProviders(input);

  assert.deepEqual(original, originalSnapshot, 'the original project object must not be mutated');
  assert.deepEqual(input, [originalSnapshot], 'the input array must not be mutated');
  assert.notEqual(migrated, input, 'migrateProjectProviders must return a new array');
  assert.notEqual(migrated[0], original, 'migrateProjectProviders must return new project objects');
});

test('migrateProjectProviders handles empty and missing input', () => {
  assert.deepEqual(migrateProjectProviders([]), []);
  assert.deepEqual(migrateProjectProviders(undefined), []);
});
