/**
 * Artifact deploy contracts (core/artifacts/contracts.js): manifest (1.1),
 * config.artifactDeploy validation incl. preStart hooks, target input,
 * artifact selection, the artifact_deploy payload (1.2), Prod confirmation
 * and IDP_PUBLIC_URL validation (config.js).
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const contracts = require('../src/core/artifacts/contracts');
const { validateProjectConfig } = require('../src/validation/projectSchemas');
const { validateArtifactPublicUrlEnv, validateArtifactStorageEnv, validateHttpServerEnv } = require('../src/config');

const {
  validateManifest,
  validateArtifactDeployConfig,
  normalizeArtifactDeployConfig,
  validateTargetInput,
  selectArtifact,
  resolveTargetComponents,
  buildDeployPayload,
  checkTargetConfirmation,
  computeDeployTimeoutSec,
  resolveSourceCredentials,
} = contracts;

const NUL = String.fromCharCode(0);
const BACKSLASH = String.fromCharCode(92);
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const manifest = () => ({
  schema: 1,
  project: 'jetsrm',
  version: '2.5.0',
  commit: 'abc123',
  createdAt: '2026-09-11T10:00:00Z',
  artifacts: [
    { component: 'backend', os: 'win-x64', file: 'jetsrm-backend-2.5.0-win-x64.tar.gz', sha256: SHA_A, size: 123 },
    { component: 'frontend', os: 'any', file: 'jetsrm-frontend-2.5.0.tar.gz', sha256: SHA_B, size: 456 },
  ],
});

const artifactDeploy = () => ({
  source: { platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm', token: 'SOURCE-TOKEN-SECRET' },
  build: { provider: 'pipeline' },
  versionVariable: 'VERSION',
  components: [
    {
      name: 'backend',
      subdir: 'backend',
      os: 'win-x64',
      runtime: { type: 'nssm', serviceName: 'jetsrm-backend' },
      preserve: ['.env', 'certificates/**', 'uploads/**'],
      health: { url: 'http://127.0.0.1:3000/health', timeoutSec: 90 },
      writeRuntimeConfig: false,
      hooks: {
        preStart: [
          { name: 'migrate', command: 'node', args: ['node_modules/sequelize-cli/lib/sequelize', 'db:migrate'], env: { NODE_ENV: 'prod' } },
        ],
      },
    },
    {
      name: 'frontend',
      subdir: 'frontend',
      runtime: { type: 'iis-static', appPool: null },
      preserve: ['web.config'],
      health: null,
      writeRuntimeConfig: true,
    },
  ],
});

const paths = (errors) => errors.map((e) => e.path);

// ------------------------------------------------------------------ manifest

test('validateManifest accepts the contract example and normalizes it', () => {
  const result = validateManifest(manifest(), { project: 'jetsrm', version: '2.5.0' });
  assert.equal(result.valid, true, result.errors.join(' '));
  assert.equal(result.manifest.artifacts.length, 2);
  assert.equal(result.manifest.commit, 'abc123');
});

test('validateManifest rejects every broken field', () => {
  const cases = [
    [(m) => { m.schema = 2; }, /schema/],
    [(m) => { m.version = '../2.5.0'; }, /version/],
    [(m) => { m.project = ''; }, /project/],
    [(m) => { m.artifacts = []; }, /artifacts/],
    [(m) => { m.artifacts[0].file = '../evil.tar.gz'; }, /file/],
    [(m) => { m.artifacts[0].file = 'backend.zip'; }, /file/],
    [(m) => { m.artifacts[0].file = `a${BACKSLASH}b.tar.gz`; }, /file/],
    [(m) => { m.artifacts[0].sha256 = 'A'.repeat(64); }, /sha256/],
    [(m) => { m.artifacts[0].size = 0; }, /size/],
    [(m) => { m.artifacts[0].size = 1.5; }, /size/],
    [(m) => { m.artifacts[0].os = 'mac'; }, /os/],
    [(m) => { m.artifacts[0].component = 'Backend'; }, /component/],
    [(m) => { m.artifacts[1] = { ...m.artifacts[0], file: 'other.tar.gz' }; }, /duplicates/],
    [(m) => { m.artifacts[1].file = m.artifacts[0].file; }, /twice/],
  ];
  for (const [mutate, pattern] of cases) {
    const m = manifest();
    mutate(m);
    const result = validateManifest(m);
    assert.equal(result.valid, false, pattern.toString());
    assert.match(result.errors.join(' '), pattern);
  }
  assert.match(validateManifest(manifest(), { version: '2.6.0' }).errors.join(' '), /expected '2.6.0'/);
  assert.match(validateManifest(manifest(), { project: 'other' }).errors.join(' '), /expected 'other'/);
  assert.equal(validateManifest(null).valid, false);
});

// ------------------------------------------------------ config.artifactDeploy

test('validateArtifactDeployConfig accepts the documented shape (incl. JetSRM migrate hook)', () => {
  assert.deepEqual(validateArtifactDeployConfig(artifactDeploy()), []);
  assert.deepEqual(validateArtifactDeployConfig(undefined), []);
  assert.deepEqual(validateArtifactDeployConfig(null), []);
  // A settings save echoes the presence flag back; it must be accepted.
  const withFlag = artifactDeploy();
  withFlag.source = { platform: 'github', owner: 'o', repo: 'r', hasToken: true, token: '' };
  assert.deepEqual(validateArtifactDeployConfig(withFlag), []);
});

test('validateArtifactDeployConfig: components, subdir, preserve, runtime, health', () => {
  const check = (mutate) => {
    const config = artifactDeploy();
    mutate(config);
    return paths(validateArtifactDeployConfig(config));
  };
  assert.ok(check((c) => { c.components = Array.from({ length: 11 }, (_, i) => ({ ...c.components[1], name: `c${i}`, subdir: `d${i}` })); })
    .includes('artifactDeploy.components'));
  assert.ok(check((c) => { c.components[1].name = 'backend'; }).includes('artifactDeploy.components.1.name'));
  assert.ok(check((c) => { c.components[1].subdir = 'BACKEND'; }).includes('artifactDeploy.components.1.subdir'));
  for (const subdir of ['..', '.', 'a/b', `a${BACKSLASH}b`, '']) {
    assert.ok(check((c) => { c.components[0].subdir = subdir; }).includes('artifactDeploy.components.0.subdir'), subdir);
  }
  for (const pattern of ['../x', '/etc/passwd', 'C:/Windows', `${BACKSLASH}share`, 'a/../../b', '', `a${NUL}b`]) {
    assert.ok(check((c) => { c.components[0].preserve = [pattern]; }).includes('artifactDeploy.components.0.preserve.0'), JSON.stringify(pattern));
  }
  assert.ok(check((c) => { c.components[0].preserve = Array.from({ length: 51 }, (_, i) => `f${i}`); })
    .includes('artifactDeploy.components.0.preserve'));
  assert.ok(check((c) => { c.components[0].runtime = { type: 'nssm' }; }).includes('artifactDeploy.components.0.runtime.serviceName'));
  assert.ok(check((c) => { c.components[0].runtime = { type: 'docker' }; }).includes('artifactDeploy.components.0.runtime.type'));
  assert.ok(check((c) => { c.components[0].runtime = { type: 'nssm', serviceName: 'a b' }; }).includes('artifactDeploy.components.0.runtime.serviceName'));
  assert.ok(check((c) => { c.components[0].health = { url: 'ftp://x/health' }; }).includes('artifactDeploy.components.0.health.url'));
  assert.ok(check((c) => { c.components[0].health.timeoutSec = 4; }).includes('artifactDeploy.components.0.health.timeoutSec'));
  assert.ok(check((c) => { c.components[0].health.timeoutSec = 601; }).includes('artifactDeploy.components.0.health.timeoutSec'));
  assert.ok(check((c) => { c.components[0].extra = 1; }).includes('artifactDeploy.components.0.extra'));
  assert.ok(check((c) => { c.source.baseUrl = 'http://api.bitbucket.org'; }).includes('artifactDeploy.source.baseUrl'));
  assert.ok(check((c) => { c.build.provider = 'gitlab'; }).includes('artifactDeploy.build.provider'));
  assert.ok(check((c) => { c.versionVariable = '1VERSION'; }).includes('artifactDeploy.versionVariable'));
});

test('validateArtifactDeployConfig: preStart hook rules', () => {
  const hookErrors = (hook) => {
    const config = artifactDeploy();
    config.components[0].hooks = { preStart: [hook] };
    return paths(validateArtifactDeployConfig(config)).filter((p) => p.includes('hooks'));
  };
  const valid = { name: 'migrate', command: 'node', args: ['x'], env: { NODE_ENV: 'prod' }, timeoutSec: 600 };
  assert.deepEqual(hookErrors(valid), []);

  assert.ok(hookErrors({ ...valid, name: 'Migrate' }).length > 0);
  for (const command of ['bin/node', `C:${BACKSLASH}node.exe`, '..', '.', 'node js', 'x'.repeat(65), '']) {
    assert.ok(hookErrors({ ...valid, command }).some((p) => p.endsWith('.command')), command);
  }
  assert.ok(hookErrors({ ...valid, args: Array.from({ length: 21 }, () => 'a') }).some((p) => p.endsWith('.args')));
  assert.ok(hookErrors({ ...valid, args: ['x'.repeat(513)] }).some((p) => p.endsWith('.args.0')));
  assert.ok(hookErrors({ ...valid, args: [`a${NUL}b`] }).some((p) => p.endsWith('.args.0')));
  assert.ok(hookErrors({ ...valid, args: [1] }).some((p) => p.endsWith('.args.0')));
  assert.ok(hookErrors({ ...valid, env: { node_env: 'prod' } }).some((p) => p.endsWith('.env')));
  assert.ok(hookErrors({ ...valid, env: { DB_PASSWORD: 'secret' } }).some((p) => p.endsWith('.env')));
  assert.ok(hookErrors({ ...valid, env: { DATABASE_URL: 'postgres://secret' } }).some((p) => p.endsWith('.env')));
  assert.ok(hookErrors({ ...valid, env: { A: 'x'.repeat(1025) } }).some((p) => p.endsWith('.env')));
  const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`K${i}`, 'v']));
  assert.ok(hookErrors({ ...valid, env: tooMany }).some((p) => p.endsWith('.env')));
  assert.ok(hookErrors({ ...valid, timeoutSec: 0 }).some((p) => p.endsWith('.timeoutSec')));
  assert.ok(hookErrors({ ...valid, timeoutSec: 3601 }).some((p) => p.endsWith('.timeoutSec')));
  assert.ok(hookErrors({ ...valid, shell: true }).some((p) => p.endsWith('.shell')));

  const config = artifactDeploy();
  config.components[0].hooks = { preStart: Array.from({ length: 6 }, (_, i) => ({ ...valid, name: `h${i}` })) };
  assert.ok(paths(validateArtifactDeployConfig(config)).includes('artifactDeploy.components.0.hooks.preStart'));
  config.components[0].hooks = { preStart: [valid, valid] };
  assert.ok(paths(validateArtifactDeployConfig(config)).includes('artifactDeploy.components.0.hooks.preStart.1.name'));

  // Env values never appear in error messages.
  const secretish = artifactDeploy();
  secretish.components[0].hooks = { preStart: [{ ...valid, env: { lower: 'VALUE-THAT-MUST-NOT-LEAK' } }] };
  assert.ok(!JSON.stringify(validateArtifactDeployConfig(secretish)).includes('VALUE-THAT-MUST-NOT-LEAK'));
});

test('validateProjectConfig runs the artifactDeploy rules on a settings patch', () => {
  const ok = validateProjectConfig({ artifactDeploy: artifactDeploy() });
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
  const bad = artifactDeploy();
  bad.components[0].hooks.preStart[0].command = '/usr/bin/node';
  const result = validateProjectConfig({ artifactDeploy: bad });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === 'artifactDeploy.components.0.hooks.preStart.0.command'));
  assert.equal(validateProjectConfig({ artifactDeploy: null }).valid, true);
});

test('normalizeArtifactDeployConfig fills defaults and never carries the token', () => {
  const normalized = normalizeArtifactDeployConfig(artifactDeploy());
  assert.equal(normalized.artifactName, 'jetsrm');
  assert.equal(normalized.source.baseUrl, 'https://api.bitbucket.org/2.0');
  assert.equal(normalized.components[0].hooks.preStart[0].timeoutSec, 600);
  assert.deepEqual(normalized.components[0].hooks.preStart[0].env, { NODE_ENV: 'prod' });
  assert.equal(normalized.components[0].health.expectVersionPath, null);
  assert.equal(normalized.components[1].hooks, null);
  assert.equal(normalized.components[1].runtime.serviceName, null);
  assert.ok(!JSON.stringify(normalized).includes('SOURCE-TOKEN-SECRET'));
  assert.equal(normalizeArtifactDeployConfig(undefined), null);
});

test('resolveSourceCredentials: dedicated token first, project apiToken as fallback', () => {
  const normalized = normalizeArtifactDeployConfig(artifactDeploy());
  assert.deepEqual(resolveSourceCredentials({ artifactDeploy: artifactDeploy(), apiToken: 'CI' }, normalized),
    { token: 'SOURCE-TOKEN-SECRET', username: '', fallback: false });
  const noToken = artifactDeploy();
  delete noToken.source.token;
  assert.deepEqual(resolveSourceCredentials({ artifactDeploy: noToken, apiToken: 'CI', username: 'me@x' }, normalized),
    { token: 'CI', username: 'me@x', fallback: true });

  noToken.source.baseUrl = 'https://git.example/api/v3';
  const custom = normalizeArtifactDeployConfig(noToken);
  assert.deepEqual(resolveSourceCredentials({ artifactDeploy: noToken, apiToken: 'CI', username: 'me@x' }, custom),
    { token: '', username: 'me@x', fallback: false });
});

// ------------------------------------------------------------------ targets

test('validateTargetInput: create requires name/agentId/os, update is partial', () => {
  const ok = validateTargetInput({ name: 'temsa-prod', agentId: 'WIN-01', os: 'windows', runtimeConfig: { VITE_APP_MAIN_URL: 'https://api' } });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.name, 'temsa-prod');
  assert.deepEqual(paths(validateTargetInput({}).errors).sort(), ['agentId', 'name', 'os']);
  assert.deepEqual(validateTargetInput({ name: 'x' }, { partial: true }).errors, []);
  assert.ok(paths(validateTargetInput({ runtimeConfig: { lower: 'x' } }, { partial: true }).errors).some((p) => p.startsWith('runtimeConfig')));
  const structured = validateTargetInput({ runtimeConfig: {
    backend: { format: 'env-file', values: { PORT: '3000', DB_URL: 'secret' } },
    frontend: { format: 'frontend-config-js', values: { VITE_API_URL: 'https://api' } },
  } }, { partial: true });
  assert.deepEqual(structured.errors, []);
  assert.deepEqual(structured.value.runtimeConfig.backend, { format: 'env-file', values: { PORT: '3000', DB_URL: 'secret' } });
  assert.ok(paths(validateTargetInput({ runtimeConfig: {
    backend: { format: 'dotenv', values: {} },
  } }, { partial: true }).errors).includes('runtimeConfig.backend.format'));
  const oversized = Object.fromEntries(Array.from({ length: 100 }, (_unused, index) => [`KEY_${index}`, 'ş'.repeat(1000)]));
  assert.ok(validateTargetInput({ runtimeConfig: oversized }, { partial: true }).errors
    .some((error) => error.message.includes('UTF-8 bytes')));
  const largeComponent = Object.fromEntries(Array.from({ length: 100 }, (_unused, index) => [`KEY_${index}`, 'x'.repeat(1200)]));
  assert.ok(validateTargetInput({ runtimeConfig: {
    backend: { format: 'env-file', values: largeComponent },
    frontend: { format: 'frontend-config-js', values: largeComponent },
  } }, { partial: true }).errors.some((error) => error.message.includes('Serialized runtime config')));
  assert.ok(paths(validateTargetInput({ agentId: '-x' }, { partial: true }).errors).includes('agentId'));
  assert.ok(paths(validateTargetInput({ os: 'mac' }, { partial: true }).errors).includes('os'));
  assert.ok(paths(validateTargetInput({ environment: 'QA' }, { partial: true }).errors).includes('environment'));
  assert.ok(paths(validateTargetInput({ components: [{ name: 'backend', runtime: { type: 'nssm' } }] }, { partial: true }).errors)
    .some((p) => p.startsWith('components.0.runtime')));
  assert.ok(paths(validateTargetInput({ bogus: 1 }, { partial: true }).errors).includes('bogus'));
});

test('checkTargetConfirmation mirrors the Prod confirmation contract', () => {
  const project = { name: 'JetSRM', environment: 'Dev' };
  assert.equal(checkTargetConfirmation({ name: 'temsa-test', environment: 'Dev' }, project, undefined), null);
  assert.deepEqual(checkTargetConfirmation({ name: 'temsa', environment: 'Prod' }, project, 'nope'), {
    error: 'Production targets require typing the target name to confirm.',
    code: 'CONFIRMATION_REQUIRED',
    expected: 'temsa',
  });
  assert.equal(checkTargetConfirmation({ name: 'temsa', environment: 'Prod' }, project, ' temsa '), null);
  assert.ok(checkTargetConfirmation({ name: 'temsa-prod', environment: null }, project, undefined));
  assert.ok(checkTargetConfirmation({ name: 'temsa', environment: null }, { ...project, environment: 'Prod' }, undefined));
});

// ---------------------------------------------------- selection + payload

test('selectArtifact: target OS first, then any; pinned components never fall back', () => {
  const artifacts = [
    { id: 'a1', component: 'backend', os: 'win-x64' },
    { id: 'a2', component: 'backend', os: 'linux-x64' },
    { id: 'a3', component: 'backend', os: 'any' },
    { id: 'a4', component: 'frontend', os: 'any' },
  ];
  assert.equal(selectArtifact(artifacts, { name: 'backend', os: null }, 'windows').id, 'a1');
  assert.equal(selectArtifact(artifacts, { name: 'backend', os: null }, 'linux').id, 'a2');
  assert.equal(selectArtifact(artifacts.filter((a) => a.id !== 'a2'), { name: 'backend', os: null }, 'linux').id, 'a3');
  assert.equal(selectArtifact(artifacts, { name: 'frontend', os: null }, 'windows').id, 'a4');
  assert.equal(selectArtifact(artifacts, { name: 'backend', os: 'win-x64' }, 'linux'), null);
  assert.equal(selectArtifact(artifacts, { name: 'backend', os: 'any' }, 'windows').id, 'a3');
  assert.equal(selectArtifact(artifacts, { name: 'worker', os: null }, 'windows'), null);
});

test('resolveTargetComponents applies target overrides and requested names', () => {
  const { components } = normalizeArtifactDeployConfig(artifactDeploy());
  const all = resolveTargetComponents(components, null, null);
  assert.deepEqual(all.components.map((c) => c.name), ['backend', 'frontend']);

  const overridden = resolveTargetComponents(components, [
    { name: 'backend', runtime: { type: 'nssm', serviceName: 'temsa-backend' }, health: { url: 'http://127.0.0.1:4000/health' } },
  ], null);
  assert.deepEqual(overridden.components.map((c) => c.name), ['backend']);
  assert.equal(overridden.components[0].runtime.serviceName, 'temsa-backend');
  assert.equal(overridden.components[0].health.url, 'http://127.0.0.1:4000/health');
  assert.equal(overridden.components[0].hooks.preStart[0].name, 'migrate');

  assert.deepEqual(resolveTargetComponents(components, null, ['frontend']).components.map((c) => c.name), ['frontend']);
  assert.match(resolveTargetComponents(components, [{ name: 'backend' }], ['frontend']).errors.join(' '), /not deployable/);
  assert.match(resolveTargetComponents(components, [{ name: 'worker' }], null).errors.join(' '), /not defined/);
});

test('buildDeployPayload matches contract 1.2: runtimeConfig only where flagged, hooks copied, only the download token', () => {
  const { components } = normalizeArtifactDeployConfig(artifactDeploy());
  const release = { id: 'rel_1', version: '2.5.0', manifest: { project: 'jetsrm' } };
  const artifacts = new Map([
    ['backend', { id: 'art_backend', sha256: SHA_A, size: 123 }],
    ['frontend', { id: 'art_frontend', sha256: SHA_B, size: 456 }],
  ]);
  const tokens = new Map([['backend', 'T'.repeat(43)], ['frontend', 'U'.repeat(43)]]);
  const runtimeConfig = { VITE_APP_MAIN_URL: 'https://api.customer', VITE_COMPANY_NAME: 'temsa' };

  const payload = buildDeployPayload({
    deployId: 'dep_x', release, components, artifacts, tokens, runtimeConfig, publicUrl: 'https://idp.example/',
  });

  assert.deepEqual(Object.keys(payload).sort(), ['components', 'deployId', 'project', 'timeoutSec', 'version']);
  assert.equal(payload.project, 'jetsrm');
  assert.equal(payload.timeoutSec, computeDeployTimeoutSec(components));
  const [backend, frontend] = payload.components;
  assert.deepEqual(Object.keys(backend).sort(),
    ['download', 'health', 'hooks', 'name', 'preserve', 'runtime', 'runtimeConfig', 'subdir', 'version']);
  assert.deepEqual(backend.download, {
    url: 'https://idp.example/api/artifacts/art_backend/download', token: 'T'.repeat(43), sha256: SHA_A, size: 123,
  });
  assert.deepEqual(backend.runtime, { type: 'nssm', serviceName: 'jetsrm-backend', appPool: null });
  assert.equal(backend.runtimeConfig, null);
  assert.deepEqual(backend.hooks, {
    preStart: [{ name: 'migrate', command: 'node', args: ['node_modules/sequelize-cli/lib/sequelize', 'db:migrate'], env: { NODE_ENV: 'prod' }, timeoutSec: 600 }],
  });
  assert.deepEqual(backend.health, { url: 'http://127.0.0.1:3000/health', expectVersionPath: null, timeoutSec: 90 });
  assert.deepEqual(frontend.runtimeConfig, { format: 'frontend-config-js', values: runtimeConfig });
  assert.equal(frontend.hooks, null);
  assert.deepEqual(frontend.runtime, { type: 'iis-static', serviceName: null, appPool: null });
  assert.ok(!JSON.stringify(payload).includes('SOURCE-TOKEN-SECRET'));

  // Hooks are copies: mutating the payload never touches the project config.
  backend.hooks.preStart[0].env.NODE_ENV = 'changed';
  assert.equal(components[0].hooks.preStart[0].env.NODE_ENV, 'prod');
});

test('buildDeployPayload sends component-specific frontend config.js and backend .env specs', () => {
  const { components } = normalizeArtifactDeployConfig(artifactDeploy());
  const release = { id: 'rel_1', version: '2.5.0', manifest: { project: 'jetsrm' } };
  const artifacts = new Map([
    ['backend', { id: 'art_backend', sha256: SHA_A, size: 123 }],
    ['frontend', { id: 'art_frontend', sha256: SHA_B, size: 456 }],
  ]);
  const payload = buildDeployPayload({
    deployId: 'dep_x', release, components, artifacts,
    tokens: new Map([['backend', 'T'], ['frontend', 'U']]), publicUrl: 'https://idp.example',
    runtimeConfig: {
      backend: { format: 'env-file', values: { PORT: '3000' } },
      frontend: { format: 'frontend-config-js', values: { VITE_API_URL: 'https://api' } },
    },
  });
  assert.deepEqual(payload.components[0].runtimeConfig, { format: 'env-file', values: { PORT: '3000' } });
  assert.deepEqual(payload.components[1].runtimeConfig, {
    format: 'frontend-config-js', values: { VITE_API_URL: 'https://api' },
  });
});

test('computeDeployTimeoutSec: at least 30 min, grows with health + hook budgets, capped at 4 h', () => {
  assert.equal(computeDeployTimeoutSec([]), 1800);
  const heavy = [{ health: { timeoutSec: 600 }, hooks: { preStart: Array.from({ length: 5 }, () => ({ timeoutSec: 3600 })) } }];
  assert.equal(computeDeployTimeoutSec(heavy), 4 * 3600);
  const medium = [{ health: { timeoutSec: 300 }, hooks: { preStart: [{ timeoutSec: 1200 }] } }];
  assert.equal(computeDeployTimeoutSec(medium), 900 + 300 + 1200);
});

// ------------------------------------------------------------ IDP_PUBLIC_URL

test('IDP_PUBLIC_URL validation', () => {
  assert.deepEqual(validateArtifactPublicUrlEnv({}), { warnings: [], publicUrl: null, publicUrlError: 'IDP_PUBLIC_URL tanımlı değil.' });
  assert.equal(validateArtifactPublicUrlEnv({ IDP_PUBLIC_URL: 'https://idp.example/' }).publicUrl, 'https://idp.example');
  assert.equal(validateArtifactPublicUrlEnv({ IDP_PUBLIC_URL: 'https://idp.example/idp' }).publicUrl, 'https://idp.example/idp');
  assert.equal(validateArtifactPublicUrlEnv({ IDP_PUBLIC_URL: 'http://10.0.0.5:3001' }).publicUrl, 'http://10.0.0.5:3001');
  for (const value of ['ftp://x', 'not a url', 'https://u:p@idp.example', 'https://idp.example/?x=1', 'https://idp.example/#a']) {
    const result = validateArtifactPublicUrlEnv({ IDP_PUBLIC_URL: value });
    assert.equal(result.publicUrl, null, value);
    assert.equal(result.warnings.length, 1, value);
  }
  const prodHttp = validateArtifactPublicUrlEnv({ IDP_PUBLIC_URL: 'http://idp.example', NODE_ENV: 'production' });
  assert.equal(prodHttp.publicUrl, null);
  assert.match(prodHttp.publicUrlError, /https/);
  // Never blocks startup.
  assert.equal(validateHttpServerEnv({ IDP_PUBLIC_URL: 'ftp://x' }).valid, true);
  assert.equal(validateHttpServerEnv({ IDP_PUBLIC_URL: 'https://idp.example' }).artifactDeploy.publicUrl, 'https://idp.example');
});

test('local artifact storage env uses a safe data default and validates CI upload controls', () => {
  const defaulted = validateArtifactStorageEnv({ IDP_DB_PATH: '/srv/idp/idp.db' });
  assert.equal(defaulted.storageRoot, '/srv/idp/artifacts');
  assert.equal(defaulted.maxArtifactBytes, 1024 * 1024 * 1024);
  assert.equal(defaulted.uploadToken, null);
  assert.deepEqual(defaulted.warnings, []);

  const configured = validateArtifactStorageEnv({
    IDP_ARTIFACT_STORAGE_ROOT: '/data/idp-artifacts',
    IDP_ARTIFACT_UPLOAD_TOKEN: 'x'.repeat(32),
    IDP_ARTIFACT_MAX_BYTES: '2048',
  });
  assert.deepEqual(configured.errors, []);
  assert.equal(configured.storageRoot, '/data/idp-artifacts');
  assert.equal(configured.maxArtifactBytes, 2048);
  assert.equal(configured.uploadToken, 'x'.repeat(32));

  assert.ok(validateArtifactStorageEnv({ IDP_ARTIFACT_STORAGE_ROOT: 'relative' }).errors.length > 0);
  assert.ok(validateArtifactStorageEnv({ IDP_ARTIFACT_UPLOAD_TOKEN: 'short' }).errors.length > 0);
  assert.ok(validateArtifactStorageEnv({ IDP_ARTIFACT_MAX_BYTES: '10' }).errors.length > 0);
  assert.equal(validateHttpServerEnv({ IDP_ARTIFACT_UPLOAD_TOKEN: 'short' }).valid, false);
});
