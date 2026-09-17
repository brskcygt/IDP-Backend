'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  normalizeBuildParameters,
  validateBuildParameters,
  mergeBuildParameters,
} = require('../src/core/deployment/buildParameters');
const { validateArtifactDeployConfig, normalizeArtifactDeployConfig } = require('../src/core/artifacts/contracts');
const { defaultCreateBuildAdapter } = require('../src/core/artifacts/releaseService');
const { openDatabase } = require('../src/store/db');
const { createSettingsRepository } = require('../src/store/settingsRepository');
const { createSettingsService, SettingsValidationError } = require('../src/core/settings/settingsService');

test('normalizeBuildParameters keeps usable entries and reports nothing to send as null', () => {
	assert.deepEqual(normalizeBuildParameters({ IDP_PROJECT_ID: ' p-1 ', COUNT: 3 }), { IDP_PROJECT_ID: ' p-1 ', COUNT: '3' });
	// An entry the operator cleared must disappear rather than reach the build empty.
	assert.equal(normalizeBuildParameters({ EMPTY: '   ' }), null);
	assert.equal(normalizeBuildParameters({}), null);
	assert.equal(normalizeBuildParameters(null), null);
});

test('validateBuildParameters rejects names that are not shell-safe identifiers', () => {
	assert.deepEqual(validateBuildParameters(undefined, 'p'), []);
	assert.deepEqual(validateBuildParameters({ OK_1: 'x' }, 'p'), []);
	assert.deepEqual(validateBuildParameters('nope', 'p'), [{ path: 'p', message: 'Must be an object.' }]);
	const errors = validateBuildParameters({ '1BAD': 'x' }, 'p');
	assert.equal(errors.length, 1);
	assert.equal(errors[0].path, 'p.1BAD');
	assert.match(errors[0].message, /invalid/);
});

test('mergeBuildParameters layers global defaults under the project, and the version wins', () => {
	const merged = mergeBuildParameters(
		{ POSTHOG_HOST: 'https://eu.posthog.com', TENANT_SLUG: 'global' },
		{ TENANT_SLUG: 'koksan', VERSION: '9.9.9' },
		'VERSION',
		'1.2.3',
	);
	assert.deepEqual(merged, {
		POSTHOG_HOST: 'https://eu.posthog.com',
		TENANT_SLUG: 'koksan',
		// A project must not be able to publish under a version nobody asked for.
		VERSION: '1.2.3',
	});
});

test('artifactDeploy config accepts build.parameters and drops emptied entries', () => {
	const config = { build: { provider: 'jenkins', parameters: { IDP_PROJECT_ID: 'p-1', GONE: '' } } };
	assert.deepEqual(validateArtifactDeployConfig(config), []);
	assert.deepEqual(normalizeArtifactDeployConfig(config).build, {
		provider: 'jenkins',
		parameters: { IDP_PROJECT_ID: 'p-1' },
	});

	const bad = validateArtifactDeployConfig({ build: { provider: 'jenkins', parameters: { 'no-dashes': 'x' } } });
	assert.equal(bad.length, 1);
	assert.equal(bad[0].path, 'artifactDeploy.build.parameters.no-dashes');
});

test('defaultCreateBuildAdapter forwards the parameters to Jenkins alongside the version', () => {
	const { triggerParams } = defaultCreateBuildAdapter({
		provider: 'jenkins',
		config: { url: 'http://127.0.0.1:8080', jobName: 'jetsrm-release' },
		version: '1.2.3',
		versionVariable: 'VERSION',
		ref: null,
		parameters: { IDP_PROJECT_ID: 'p-1', VERSION: '1.2.3' },
	});
	assert.deepEqual(triggerParams, { IDP_PROJECT_ID: 'p-1', VERSION: '1.2.3' });
});

test('settings service stores, replaces and validates the global build parameters', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-settings-'));
	const db = openDatabase(path.join(dir, 'test.db'));
	try {
		const logged = [];
		const service = createSettingsService({
			repository: createSettingsRepository(db),
			auditLogger: { log: (...args) => logged.push(args) },
		});

		assert.deepEqual(service.getBuildParameters(), { parameters: {}, updatedAt: null, updatedBy: null });
		assert.equal(service.readBuildParametersForBuild(), null);

		const saved = service.updateBuildParameters({ POSTHOG_HOST: 'https://eu.posthog.com', DROP_ME: '' }, 'baris');
		assert.deepEqual(saved.parameters, { POSTHOG_HOST: 'https://eu.posthog.com' });
		assert.equal(saved.updatedBy, 'baris');
		assert.equal(logged.length, 1);
		assert.deepEqual(service.readBuildParametersForBuild(), { POSTHOG_HOST: 'https://eu.posthog.com' });

		// The document is replaced, not merged: a removed key has to be gone.
		service.updateBuildParameters({ OTHER: '1' }, 'baris');
		assert.deepEqual(service.getBuildParameters().parameters, { OTHER: '1' });

		assert.throws(
			() => service.updateBuildParameters({ 'bad key': 'x' }, 'baris'),
			(err) => err instanceof SettingsValidationError && err.details[0].path === 'parameters.bad key',
		);
		// The rejected write left the stored document untouched.
		assert.deepEqual(service.getBuildParameters().parameters, { OTHER: '1' });
	} finally {
		db.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
