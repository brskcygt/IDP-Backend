/**
 * Regression tests for the dependency-free schema validator (T-20 / SEC-15).
 *
 * Covers each rule type (string/number/boolean/object/array/optional),
 * nested objects, size limits, unknown-field behavior, and error path
 * accuracy — plus the concrete project/user/deploy-trigger schemas built
 * on top of it in src/validation/projectSchemas.js.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { string, number, boolean, object, array, optional, validate } = require('../src/validation/schema');
const {
  createProjectSchema,
  projectConfigSchema,
  validateProjectConfig,
  deployTriggerSchema,
  userSchema,
  userUpdateSchema,
} = require('../src/validation/projectSchemas');

// ---------------------------------------------------------------------------
// string()
// ---------------------------------------------------------------------------

test('string(): rejects non-string values', () => {
  const result = validate(123, string(), 'name');
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].path, 'name');
  assert.match(result.errors[0].message, /string/i);
});

test('string(): enforces min/max length', () => {
  const rule = string({ min: 3, max: 5 });
  assert.equal(validate('ab', rule).valid, false);
  assert.equal(validate('abc', rule).valid, true);
  assert.equal(validate('abcde', rule).valid, true);
  assert.equal(validate('abcdef', rule).valid, false);
});

test('string(): enforces a pattern', () => {
  const rule = string({ pattern: /^[a-z]+$/ });
  assert.equal(validate('abc', rule).valid, true);
  assert.equal(validate('ABC', rule).valid, false);
});

test('string(): empty string is exempt from pattern checks (secrets may be blank)', () => {
  const rule = string({ pattern: /^[a-z]+$/ });
  assert.equal(validate('', rule).valid, true);
});

test('string(): enforces an enum', () => {
  const rule = string({ enum: ['a', 'b'] });
  assert.equal(validate('a', rule).valid, true);
  assert.equal(validate('c', rule).valid, false);
  assert.match(validate('c', rule).errors[0].message, /must be one of/i);
});

// ---------------------------------------------------------------------------
// number()
// ---------------------------------------------------------------------------

test('number(): rejects non-numeric values', () => {
  assert.equal(validate('abc', number()).valid, false);
  assert.equal(validate(true, number()).valid, false);
  assert.equal(validate(NaN, number()).valid, false);
});

test('number(): accepts a real number and enforces min/max', () => {
  const rule = number({ min: 1, max: 65535 });
  assert.equal(validate(0, rule).valid, false);
  assert.equal(validate(1, rule).valid, true);
  assert.equal(validate(65535, rule).valid, true);
  assert.equal(validate(65536, rule).valid, false);
});

test('number(): accepts a numeric string (project.config.port is stored as a string) and preserves the original type', () => {
  const rule = number({ min: 1, max: 65535, integer: true });
  const result = validate('22', rule);
  assert.equal(result.valid, true);
  assert.equal(result.value, '22', 'must not coerce the stored type from string to number');
});

test('number(): rejects an out-of-range numeric string', () => {
  const rule = number({ min: 1, max: 65535 });
  assert.equal(validate('70000', rule).valid, false);
  assert.equal(validate('0', rule).valid, false);
  assert.equal(validate('not-a-port', rule).valid, false);
});

test('number(): integer rejects a fractional value', () => {
  const rule = number({ integer: true });
  assert.equal(validate(1.5, rule).valid, false);
  assert.equal(validate(2, rule).valid, true);
});

// ---------------------------------------------------------------------------
// boolean()
// ---------------------------------------------------------------------------

test('boolean(): only true/false pass', () => {
  assert.equal(validate(true, boolean()).valid, true);
  assert.equal(validate(false, boolean()).valid, true);
  assert.equal(validate('true', boolean()).valid, false);
  assert.equal(validate(1, boolean()).valid, false);
});

// ---------------------------------------------------------------------------
// object()
// ---------------------------------------------------------------------------

test('object(): validates known fields and reports nested error paths', () => {
  const rule = object({
    fields: {
      host: string({ max: 5 }),
      port: number({ min: 1, max: 65535 }),
    },
  });
  const result = validate({ host: 'too-long-hostname', port: 70000 }, rule, 'config');
  assert.equal(result.valid, false);
  const paths = result.errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ['config.host', 'config.port']);
});

test('object(): rejects unknown fields when allowUnknown is false (default)', () => {
  const rule = object({ fields: { a: string() } });
  const result = validate({ a: 'x', b: 'y' }, rule);
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, 'b');
});

test('object(): passes unknown fields through untouched when allowUnknown is true', () => {
  const rule = object({ fields: { a: string() }, allowUnknown: true });
  const result = validate({ a: 'x', b: 'y', c: 42 }, rule);
  assert.equal(result.valid, true);
  assert.deepEqual(result.value, { a: 'x', b: 'y', c: 42 });
});

test('object(): rejects non-object values (arrays, null, primitives)', () => {
  const rule = object({ fields: {} });
  assert.equal(validate([], rule).valid, false);
  assert.equal(validate(null, rule).valid, false);
  assert.equal(validate('x', rule).valid, false);
});

test('object(): nested objects report deeply-dotted error paths', () => {
  const rule = object({
    fields: {
      pmpConfig: object({ fields: { resourceName: string({ max: 3 }) } }),
    },
  });
  const result = validate({ pmpConfig: { resourceName: 'way-too-long' } }, rule);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].path, 'pmpConfig.resourceName');
});

// ---------------------------------------------------------------------------
// array()
// ---------------------------------------------------------------------------

test('array(): rejects non-array values', () => {
  assert.equal(validate('not-an-array', array({ of: string() })).valid, false);
});

test('array(): validates every item and enforces max length', () => {
  const rule = array({ of: number({ min: 0 }), max: 2 });
  assert.equal(validate([1, 2], rule).valid, true);
  assert.equal(validate([1, 2, 3], rule).valid, false, 'exceeds max length');

  const badItems = validate([1, -1, 'x'], array({ of: number({ min: 0 }) }));
  assert.equal(badItems.valid, false);
  const paths = badItems.errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ['1', '2']);
});

// ---------------------------------------------------------------------------
// optional()
// ---------------------------------------------------------------------------

test('optional(): undefined is accepted; a present value is still validated', () => {
  const rule = optional(string({ min: 3 }));
  assert.equal(validate(undefined, rule).valid, true);
  assert.equal(validate('ab', rule).valid, false);
  assert.equal(validate('abc', rule).valid, true);
});

test('a required (non-optional) field missing entirely produces a "required" error', () => {
  const rule = object({ fields: { name: string() } });
  const result = validate({}, rule);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].path, 'name');
  assert.match(result.errors[0].message, /required/i);
});

// ---------------------------------------------------------------------------
// createProjectSchema
// ---------------------------------------------------------------------------

test('createProjectSchema: accepts a well-formed project', () => {
  const result = validate(
    { name: 'Payments API', tenant: 'Team Alpha', environment: 'Dev', provider: 'Jenkins' },
    createProjectSchema
  );
  assert.equal(result.valid, true);
});

test('createProjectSchema: rejects a missing field, an unknown provider, and an unknown field', () => {
  const missing = validate({ tenant: 'A', environment: 'Dev', provider: 'Jenkins' }, createProjectSchema);
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((e) => e.path === 'name'));

  const badProvider = validate(
    { name: 'X', tenant: 'A', environment: 'Dev', provider: 'Terraform' },
    createProjectSchema
  );
  assert.equal(badProvider.valid, false);

  const unknownField = validate(
    { name: 'X', tenant: 'A', environment: 'Dev', provider: 'Jenkins', extra: 'nope' },
    createProjectSchema
  );
  assert.equal(unknownField.valid, false);
});

// ---------------------------------------------------------------------------
// projectConfigSchema / validateProjectConfig
// ---------------------------------------------------------------------------

test('validateProjectConfig: accepts a typical Server-provider config', () => {
  const result = validateProjectConfig({
    host: '10.0.0.1',
    port: '22',
    username: 'deployer',
    password: 'super-secret',
    targetOS: 'linux',
    scriptContent: '#!/bin/bash\necho hi',
    hostKeyPolicy: 'tofu',
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('validateProjectConfig: an empty-string secret is allowed (mergeProjectConfig treats it as "keep existing")', () => {
  const result = validateProjectConfig({ password: '', apiToken: '' });
  assert.equal(result.valid, true);
});

test('validateProjectConfig: has* presence flags are never rejected', () => {
  const result = validateProjectConfig({ hasPassword: true, hasApiToken: false, host: '10.0.0.1' });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('validateProjectConfig: rejects an out-of-range port', () => {
  const tooLow = validateProjectConfig({ port: '0' });
  assert.equal(tooLow.valid, false);
  assert.ok(tooLow.errors.some((e) => e.path === 'port'));

  const tooHigh = validateProjectConfig({ port: '70000' });
  assert.equal(tooHigh.valid, false);
});

test('validateProjectConfig: rejects host/username longer than 255 characters', () => {
  const longValue = 'x'.repeat(256);
  const result = validateProjectConfig({ host: longValue, username: longValue });
  assert.equal(result.valid, false);
  const paths = result.errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ['host', 'username']);
});

test('validateProjectConfig: rejects scriptContent over the 64 KB limit', () => {
  const oversized = 'a'.repeat(64 * 1024 + 1);
  const result = validateProjectConfig({ scriptContent: oversized });
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].path, 'scriptContent');

  const atLimit = validateProjectConfig({ scriptContent: 'a'.repeat(64 * 1024) });
  assert.equal(atLimit.valid, true);
});

test('validateProjectConfig: rejects an invalid hostKeyPolicy, accepts the three valid ones', () => {
  assert.equal(validateProjectConfig({ hostKeyPolicy: 'yolo' }).valid, false);
  for (const policy of ['tofu', 'strict', 'insecure']) {
    assert.equal(validateProjectConfig({ hostKeyPolicy: policy }).valid, true, policy);
  }
});

test('validateProjectConfig: validates nested environments.<Name> overrides with a prefixed error path', () => {
  const result = validateProjectConfig({
    host: '10.0.0.1',
    environments: {
      Prod: { port: '99999', scriptContent: 'echo ok' },
      Stage: { host: 'stage.example.com' },
    },
  });
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, 'environments.Prod.port');
});

test('validateProjectConfig: an unknown top-level field does not break the save (adapter-specific fields pass through)', () => {
  const result = validateProjectConfig({ jobName: 'deploy-job', someFutureAdapterField: 'whatever' });
  assert.equal(result.valid, true);
});

// ---------------------------------------------------------------------------
// CI Pipeline provider (`provider: 'Pipeline'`, `config.ciConfig`)
// ---------------------------------------------------------------------------

const VALID_CI_CONFIG = {
  platform: 'bitbucket',
  owner: 'acme',
  repo: 'web',
  refType: 'tag',
  ref: 'v2.5.0',
  pipeline: 'deploy-customer',
  variables: { CUSTOMER: 'A', BRAND: 'temsa', VERSION: '2.5.0' },
  authType: 'basic',
  pollIntervalSeconds: 10,
  timeoutMinutes: 60,
};

test('string(): allowEmpty lets "" through an enum, other values are still checked', () => {
  const rule = string({ enum: ['a', 'b'], allowEmpty: true });
  assert.equal(validate('', rule).valid, true);
  assert.equal(validate('a', rule).valid, true);
  assert.equal(validate('c', rule).valid, false);
  assert.equal(validate('', string({ enum: ['a'] })).valid, false, 'without allowEmpty, "" is still rejected');
});

test('createProjectSchema: accepts the Pipeline provider', () => {
  const result = validate(
    { name: 'Temsa Deploy', tenant: 'Customer A', environment: 'Prod', provider: 'Pipeline' },
    createProjectSchema
  );
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('validateProjectConfig: accepts a complete ciConfig (plus the shared username/apiToken fields)', () => {
  const result = validateProjectConfig({ ciConfig: VALID_CI_CONFIG, username: 'dev@example.com', apiToken: 'tok' });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('validateProjectConfig: accepts "" for every cleared ciConfig text/select field', () => {
  const result = validateProjectConfig({
    ciConfig: {
      platform: '',
      baseUrl: '',
      owner: '',
      repo: '',
      refType: '',
      ref: '',
      pipeline: '',
      authType: '',
      correlationInput: '',
    },
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('validateProjectConfig: rejects a bad platform, a bad variable key, and more than 25 variables', () => {
  const badPlatform = validateProjectConfig({ ciConfig: { platform: 'gitlab' } });
  assert.equal(badPlatform.valid, false);
  assert.equal(badPlatform.errors[0].path, 'ciConfig.platform');

  const badKey = validateProjectConfig({ ciConfig: { variables: { 'BAD-KEY': 'x', '1ST': 'y', OK_1: 'z' } } });
  assert.equal(badKey.valid, false);
  assert.deepEqual(badKey.errors.map((e) => e.path).sort(), ['ciConfig.variables.1ST', 'ciConfig.variables.BAD-KEY']);

  const many = Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`VAR_${i}`, 'x']));
  const tooMany = validateProjectConfig({ ciConfig: { variables: many } });
  assert.equal(tooMany.valid, false);
  assert.equal(tooMany.errors[0].path, 'ciConfig.variables');

  const exactly25 = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`VAR_${i}`, 'x']));
  assert.equal(validateProjectConfig({ ciConfig: { variables: exactly25 } }).valid, true);
});

test('validateProjectConfig: rejects non-string/oversized variable values, unknown ciConfig fields, and out-of-range numbers', () => {
  const badValue = validateProjectConfig({ ciConfig: { variables: { A: 5, B: 'x'.repeat(2001) } } });
  assert.deepEqual(badValue.errors.map((e) => e.path).sort(), ['ciConfig.variables.A', 'ciConfig.variables.B']);

  assert.equal(validateProjectConfig({ ciConfig: { branch: 'main' } }).valid, false, 'unknown ciConfig field');
  assert.equal(validateProjectConfig({ ciConfig: { pollIntervalSeconds: 1 } }).valid, false);
  assert.equal(validateProjectConfig({ ciConfig: { timeoutMinutes: 721 } }).valid, false);
  assert.equal(validateProjectConfig({ ciConfig: { baseUrl: 'ftp://nope' } }).valid, false);
  assert.equal(validateProjectConfig({ ciConfig: { correlationInput: 'bad-name' } }).valid, false);
});

test('validateProjectConfig: an environment override with a partial ciConfig is accepted; its variables get a prefixed error path', () => {
  const ok = validateProjectConfig({
    ciConfig: VALID_CI_CONFIG,
    environments: { Prod: { ciConfig: { ref: 'v2.5.1' } } },
  });
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));

  const bad = validateProjectConfig({
    environments: { Prod: { ciConfig: { variables: { 'no-dashes': 'x' } } } },
  });
  assert.equal(bad.valid, false);
  assert.equal(bad.errors[0].path, 'environments.Prod.ciConfig.variables.no-dashes');
});

// ---------------------------------------------------------------------------
// deployTriggerSchema
// ---------------------------------------------------------------------------

test('deployTriggerSchema: requires projectId; parameters is optional and passes arbitrary keys through', () => {
  const missingProjectId = validate({}, deployTriggerSchema);
  assert.equal(missingProjectId.valid, false);
  assert.ok(missingProjectId.errors.some((e) => e.path === 'projectId'));

  const withParams = validate(
    { projectId: '123', parameters: { environment: 'Prod', confirmation: 'My Project', BUILD_NUMBER: '5' } },
    deployTriggerSchema
  );
  assert.equal(withParams.valid, true);
  assert.deepEqual(withParams.value.parameters, {
    environment: 'Prod',
    confirmation: 'My Project',
    BUILD_NUMBER: '5',
  });
});

test('deployTriggerSchema: rejects a non-object parameters value', () => {
  const result = validate({ projectId: '123', parameters: 'not-an-object' }, deployTriggerSchema);
  assert.equal(result.valid, false);
});

// ---------------------------------------------------------------------------
// userSchema / userUpdateSchema
// ---------------------------------------------------------------------------

test('userSchema: accepts a well-formed new user', () => {
  const result = validate({ username: 'alice.b', password: 'correct-horse-battery', role: 'deployer' }, userSchema);
  assert.equal(result.valid, true);
});

test('userSchema: rejects a too-short password (min 8), a bad username, and an unknown role', () => {
  const shortPassword = validate({ username: 'bob', password: 'short7', role: 'viewer' }, userSchema);
  assert.equal(shortPassword.valid, false);
  assert.ok(shortPassword.errors.some((e) => e.path === 'password'));

  const badUsername = validate(
    { username: 'bob!!', password: 'correct-horse-battery', role: 'viewer' },
    userSchema
  );
  assert.equal(badUsername.valid, false);
  assert.ok(badUsername.errors.some((e) => e.path === 'username'));

  const badRole = validate(
    { username: 'bob', password: 'correct-horse-battery', role: 'superadmin' },
    userSchema
  );
  assert.equal(badRole.valid, false);
});

test('userUpdateSchema: allows a partial patch (role only, or password only)', () => {
  assert.equal(validate({ role: 'admin' }, userUpdateSchema).valid, true);
  assert.equal(validate({ password: 'correct-horse-battery' }, userUpdateSchema).valid, true);
  assert.equal(validate({}, userUpdateSchema).valid, true, 'schema itself allows an empty patch; the route enforces "at least one field"');
});

test('userUpdateSchema: still enforces the password minimum and role enum when provided', () => {
  assert.equal(validate({ password: 'short' }, userUpdateSchema).valid, false);
  assert.equal(validate({ role: 'superadmin' }, userUpdateSchema).valid, false);
});

// ---------------------------------------------------------------------------
// No eval / new Function anywhere in the validator source (defense-in-depth
// smoke test — the module must never gain a code-execution path).
// ---------------------------------------------------------------------------

test('schema.js source contains no eval() or new Function() usage', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../src/validation/schema.js'), 'utf8');
  assert.doesNotMatch(source, /\beval\s*\(/);
  assert.doesNotMatch(source, /new\s+Function\s*\(/);
});
