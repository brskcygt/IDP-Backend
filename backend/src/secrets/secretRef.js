'use strict';

const REF_PREFIX = 'secret://';
const REF_PATTERN = /^secret:\/\/([^/]+)\/(.+)$/;

/**
 * Dotted field paths (relative to a project's `config` object) known to hold
 * secret values that must never be stored as plaintext. This module doesn't
 * enforce the list itself — it's the shared source of truth for whichever
 * code migrates/redacts project config (server.js / services layer).
 * @type {string[]}
 */
const SECRET_FIELD_PATHS = [
  'password',
  'apiToken',
  'pmpConfig.authToken',
  'vpnConfig.password',
  'vpnConfig.mfaConfig.secret',
  // Artifact deploy: Bitbucket/GitHub token used to read release artifacts
  // (backend-only; never sent to agents). Presence flag: artifactDeploy.source.hasToken.
  'artifactDeploy.source.token',
];

/**
 * @param {object} obj
 * @param {string} dottedPath
 * @returns {boolean} true if every segment of `dottedPath` exists in `obj`
 *   (regardless of the value found there — including `null`/`''`).
 */
function pathExists(obj, dottedPath) {
  const parts = dottedPath.split('.');
  let cursor = obj;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, part)) {
      return false;
    }
    cursor = cursor[part];
  }
  return true;
}

/**
 * Dotted field paths known to hold secret values for a *specific* project
 * config: the static `SECRET_FIELD_PATHS` plus, for every environment
 * override actually defined under `config.environments`, the same set of
 * paths rooted at `environments.<name>.` — but only the ones that actually
 * exist in that override (T-50). This is how `environments.Prod.password` or
 * `environments.Prod.vpnConfig.password` get encrypted/decrypted alongside
 * the base fields without hardcoding every possible environment name.
 * @param {object} config - a project's `config` object.
 * @returns {string[]}
 */
function getSecretFieldPaths(config) {
  const paths = [...SECRET_FIELD_PATHS];
  const environments = config && typeof config === 'object' && !Array.isArray(config)
    ? config.environments
    : null;
  if (!environments || typeof environments !== 'object' || Array.isArray(environments)) {
    return paths;
  }

  for (const envName of Object.keys(environments)) {
    const envConfig = environments[envName];
    if (!envConfig || typeof envConfig !== 'object' || Array.isArray(envConfig)) continue;

    for (const basePath of SECRET_FIELD_PATHS) {
      if (pathExists(envConfig, basePath)) {
        paths.push(`environments.${envName}.${basePath}`);
      }
    }
  }

  return paths;
}

/**
 * Builds a secret reference string to store in place of a plaintext value.
 * @param {string|number} projectId
 * @param {string} fieldPath - caller-supplied dotted path, e.g. 'config.password'.
 * @returns {string} e.g. makeRef(123, 'config.password') => 'secret://123/config.password'
 */
function makeRef(projectId, fieldPath) {
  if (projectId === undefined || projectId === null || String(projectId).trim() === '') {
    throw new Error('makeRef requires a non-empty projectId');
  }
  if (typeof fieldPath !== 'string' || fieldPath.trim() === '') {
    throw new Error('makeRef requires a non-empty fieldPath string');
  }
  return `${REF_PREFIX}${projectId}/${fieldPath}`;
}

/**
 * @param {*} value
 * @returns {boolean} true if `value` is a syntactically valid secret ref string.
 */
function isRef(value) {
  return typeof value === 'string' && REF_PATTERN.test(value);
}

/**
 * @param {string} ref
 * @returns {{ projectId: string, fieldPath: string } | null} null if `ref`
 *   isn't a valid secret ref.
 */
function parseRef(ref) {
  if (typeof ref !== 'string') return null;
  const match = ref.match(REF_PATTERN);
  if (!match) return null;
  return { projectId: match[1], fieldPath: match[2] };
}

module.exports = { makeRef, isRef, parseRef, SECRET_FIELD_PATHS, getSecretFieldPaths };
