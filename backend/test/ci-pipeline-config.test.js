/**
 * CI Pipeline provider — config plumbing: how `ciConfig` survives a settings
 * save (validation + projectService.updateProjectConfig, mirroring
 * POST /api/projects/:id/settings), how environment overrides merge it, and
 * how blank ('') fields from the settings form are treated.
 *
 * The settings form sends the whole config: cleared text/select fields as '',
 * cleared number fields omitted. These tests pin the three save-path
 * guarantees that depend on that:
 *   1. a deleted variable / cleared optional field really disappears
 *      (ciConfig is replaced on save, not deep-merged);
 *   2. a variable whose name looks like a presence flag (`hasCache`) is data,
 *      not a flag to strip;
 *   3. '' is accepted everywhere and means "unset" (defaults apply).
 *
 * Uses the per-process throwaway DB from test/helpers/isolateDb.js.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test, mock } = require('node:test');

const projectService = require('../src/core/projects/projectService');
const { validateProjectConfig } = require('../src/validation/projectSchemas');
const { mergeProjectConfig } = require('../src/api/projectSerialization');
const { resolveEnvironmentConfig } = require('../src/utils/environmentConfig');
const { normalizeCiConfig, findMissingCiFields, DEFAULT_BASE_URLS } = require('../src/adapters/ci');
const CiPipelineAdapter = require('../src/adapters/CiPipelineAdapter');

mock.method(console, 'log', () => {});

const ACTOR = 'test-actor';

/** Everything the settings form sends for ciConfig, with blanks as ''. */
const FORM_CI = {
  platform: 'bitbucket',
  baseUrl: '',
  owner: 'acme',
  repo: 'web',
  refType: 'branch',
  ref: 'master',
  pipeline: 'deploy-customer',
  authType: 'bearer',
  correlationInput: '',
};

/** createProject() ids are Date.now() — step past the current millisecond (see project-service.test.js). */
function createPipelineProject() {
  const start = Date.now();
  while (Date.now() === start) {
    // intentionally empty — sub-millisecond busy-wait
  }
  return projectService.createProject(
    { name: `CI ${start}-${Math.random().toString(36).slice(2)}`, tenant: 'Tenant QA', environment: 'Dev', provider: 'Pipeline' },
    ACTOR
  );
}

/** Mirrors POST /api/projects/:id/settings: validate, then merge + persist. */
async function saveSettings(id, body) {
  const validation = validateProjectConfig(body);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  return projectService.updateProjectConfig(id, body, ACTOR);
}

// ── save path ───────────────────────────────────────────────────────────────

test('settings save: saving variables {A,B} then {A} removes B; a cleared number field disappears', async () => {
  const project = createPipelineProject();
  await saveSettings(project.id, {
    ciConfig: { ...FORM_CI, variables: { A: '1', B: '2' }, pollIntervalSeconds: 5, timeoutMinutes: 30 },
    apiToken: 'ci-token-123456',
  });
  await saveSettings(project.id, {
    ciConfig: { ...FORM_CI, variables: { A: '1' }, timeoutMinutes: 30 },
    apiToken: '', // untouched secret field comes back blank
  });

  const stored = projectService.getProject(project.id).config;
  assert.deepEqual(stored.ciConfig.variables, { A: '1' });
  assert.equal(Object.prototype.hasOwnProperty.call(stored.ciConfig, 'pollIntervalSeconds'), false);
  assert.equal(stored.ciConfig.timeoutMinutes, 30);
  assert.ok(stored.apiToken, 'the stored token must survive a save that resubmits it blank');
});

test('settings save: a variable named like a presence flag (hasCache) round-trips, base and per-environment', async () => {
  const project = createPipelineProject();
  await saveSettings(project.id, {
    ciConfig: { ...FORM_CI, variables: { hasCache: 'true', A: '1' } },
    environments: { Prod: { ciConfig: { ref: 'release', variables: { hasFeature: 'yes' } } } },
  });

  const stored = projectService.getProject(project.id).config;
  assert.deepEqual(stored.ciConfig.variables, { hasCache: 'true', A: '1' });
  assert.deepEqual(stored.environments.Prod.ciConfig.variables, { hasFeature: 'yes' });

  const listed = projectService.listProjects().find((p) => p.id === project.id);
  assert.deepEqual(listed.config.ciConfig.variables, { hasCache: 'true', A: '1' }, 'the redacted API view keeps it too');
});

test('settings save: environment-override ciConfig is replaced as well, other environments untouched', () => {
  const existing = {
    ciConfig: { ...FORM_CI, variables: { A: '1' } },
    environments: {
      Prod: { ciConfig: { ref: 'release', variables: { X: '1', Y: '2' } } },
      Stage: { ciConfig: { ref: 'develop' } },
    },
  };
  const merged = mergeProjectConfig(existing, {
    environments: { Prod: { ciConfig: { ref: 'release', variables: { X: '1' } } } },
  });
  assert.deepEqual(merged.environments.Prod.ciConfig.variables, { X: '1' });
  assert.deepEqual(merged.environments.Stage.ciConfig, { ref: 'develop' });
  assert.deepEqual(merged.ciConfig.variables, { A: '1' }, 'a patch without ciConfig keeps the stored one');
});

test('settings save: presence flags outside ciConfig are still stripped', () => {
  const merged = mergeProjectConfig({}, { hasApiToken: true, ciConfig: { ...FORM_CI, variables: {} } });
  assert.equal(Object.prototype.hasOwnProperty.call(merged, 'hasApiToken'), false);
});

// ── blank ('') fields ───────────────────────────────────────────────────────

test("'' baseUrl is accepted by validation and resolves to the default API base", async () => {
  assert.equal(validateProjectConfig({ ciConfig: { ...FORM_CI, baseUrl: '' } }).valid, true);
  assert.equal(normalizeCiConfig({ ...FORM_CI, baseUrl: '' }).baseUrl, DEFAULT_BASE_URLS.bitbucket);
  assert.equal(normalizeCiConfig({ platform: 'github', baseUrl: '' }).baseUrl, 'https://api.github.com');

  const urls = [];
  const adapter = new CiPipelineAdapter({
    ciConfig: { ...FORM_CI, baseUrl: '' },
    apiToken: 'ci-token-123456',
    fetchImpl: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ uuid: '{run}', build_number: 1 }), { status: 201 });
    },
  });
  await adapter.trigger({});
  assert.equal(urls[0], 'https://api.bitbucket.org/2.0/repositories/acme/web/pipelines/');
});

test("'' in enum fields means unset: defaults apply and a blank platform is still a missing field", () => {
  const blank = normalizeCiConfig({ platform: '', refType: '', authType: '', owner: '', correlationInput: '' });
  assert.equal(blank.platform, '');
  assert.equal(blank.refType, 'branch');
  assert.equal(blank.authType, 'bearer');
  assert.deepEqual(findMissingCiFields(blank, { token: '' }), ['platform', 'owner', 'repo', 'ref', 'pipeline', 'apiToken']);
});

test('normalizeCiConfig clamps poll interval/timeout, accepts numeric strings, forces bearer on GitHub', () => {
  assert.equal(normalizeCiConfig({ pollIntervalSeconds: 1 }).pollIntervalSeconds, 3);
  assert.equal(normalizeCiConfig({ pollIntervalSeconds: '15' }).pollIntervalSeconds, 15);
  assert.equal(normalizeCiConfig({}).pollIntervalSeconds, 10);
  assert.equal(normalizeCiConfig({ timeoutMinutes: 5000 }).timeoutMinutes, 720);
  assert.equal(normalizeCiConfig({}).timeoutMinutes, 60);
  assert.equal(normalizeCiConfig({ platform: 'github', authType: 'basic' }).authType, 'bearer');
  assert.equal(normalizeCiConfig({ baseUrl: 'https://ghe.local/api/v3/' , platform: 'github' }).baseUrl, 'https://ghe.local/api/v3');
});

// ── environment overrides ───────────────────────────────────────────────────

test('environment override: ciConfig merges one level deep; blank override fields inherit the base value', () => {
  const config = {
    apiToken: 'tok',
    ciConfig: { ...FORM_CI, variables: { CUSTOMER: 'A' } },
    environments: { Prod: { ciConfig: { ref: 'release', owner: '', variables: { CUSTOMER: 'B' } } } },
  };
  const { config: resolved, matched } = resolveEnvironmentConfig(config, 'Prod');
  assert.equal(matched, true);
  assert.equal(resolved.ciConfig.ref, 'release');
  assert.equal(resolved.ciConfig.owner, 'acme', "a blank override field must not wipe the base value");
  assert.equal(resolved.ciConfig.pipeline, 'deploy-customer');
  assert.deepEqual(resolved.ciConfig.variables, { CUSTOMER: 'B' });
  assert.equal(config.ciConfig.ref, 'master', 'the stored config is never mutated');
});
