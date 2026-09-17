'use strict';

/**
 * Build parameters — the free-form key/value map a project (and the global
 * defaults) hand to the CI job when a release build is triggered.
 *
 * Until now only the version reached the build, so everything else had to be
 * typed into the CI tool by hand. Jenkins makes that untenable for a
 * declarative pipeline: the `parameters { }` block overwrites the job's
 * parameter definitions on every run, so a default set in its UI is gone after
 * the next build. Keeping the values here means they survive, live next to the
 * project they belong to, and are audited like the rest of its config.
 *
 * SECRETS DO NOT BELONG HERE. Parameters travel to Jenkins as a query string
 * (JenkinsAdapter.trigger) and are echoed into the build log, so a secret would
 * leak into both. Pass the *id* of a CI credential instead and let the CI tool
 * resolve it.
 *
 * The naming rules are shared with CI pipeline variables rather than reinvented:
 * both end up as environment variables in a build, so "shell-safe identifier"
 * is the same constraint, and one set of limits keeps the two editors
 * interchangeable.
 */

const {
  MAX_VARIABLES,
  MAX_VARIABLE_KEY_LENGTH,
  MAX_VARIABLE_VALUE_LENGTH,
  isPlainObject,
  toStringVariables,
  validateCiVariables,
} = require('../../adapters/ci/config');

/**
 * Normalizes a raw map into string values, dropping empty entries.
 * @param {*} raw
 * @returns {Record<string, string>|null} null when there is nothing to send
 */
function normalizeBuildParameters(raw) {
	if (!isPlainObject(raw)) return null;
	const normalized = toStringVariables(raw);
	const out = {};
	for (const [key, value] of Object.entries(normalized)) {
		if (typeof value !== 'string' || value.trim() === '') continue;
		out[key] = value;
	}
	return Object.keys(out).length > 0 ? out : null;
}

/**
 * Validates a raw map, in the `{ path, message }` shape the config validators use.
 * @param {*} raw
 * @param {string} path
 * @returns {{ path: string, message: string }[]}
 */
function validateBuildParameters(raw, path) {
	if (raw === undefined || raw === null) return [];
	if (!isPlainObject(raw)) return [{ path, message: 'Must be an object.' }];
	return validateCiVariables(raw).map((error) => ({
		path: error.key ? `${path}.${error.key}` : path,
		message: error.message,
	}));
}

/**
 * Merges the layers that feed one build, lowest precedence first.
 *
 * The version always wins: it identifies the release being cut, and a project
 * that shadowed it could publish a build under a version nobody asked for.
 *
 * @param {object|null} globalDefaults applied to every project
 * @param {object|null} projectParameters the project's own values
 * @param {string} versionVariable name that must not be overridden
 * @param {string} version
 * @returns {Record<string, string>}
 */
function mergeBuildParameters(globalDefaults, projectParameters, versionVariable, version) {
	return {
		...(normalizeBuildParameters(globalDefaults) || {}),
		...(normalizeBuildParameters(projectParameters) || {}),
		[versionVariable]: version,
	};
}

module.exports = {
	MAX_BUILD_PARAMETERS: MAX_VARIABLES,
	MAX_BUILD_PARAMETER_KEY_LENGTH: MAX_VARIABLE_KEY_LENGTH,
	MAX_BUILD_PARAMETER_VALUE_LENGTH: MAX_VARIABLE_VALUE_LENGTH,
	normalizeBuildParameters,
	validateBuildParameters,
	mergeBuildParameters,
};
