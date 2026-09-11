'use strict';

/**
 * CI Pipeline provider — config constants, normalization and validation
 * helpers (Bitbucket Pipelines / GitHub Actions).
 *
 * Pure and dependency-free on purpose: validation/projectSchemas.js imports
 * the constants from here without pulling in the HTTP clients or undici.
 *
 * Shape of `project.config.ciConfig` (see docs/CI-PIPELINE.md):
 *   { platform, baseUrl?, owner, repo, refType?, ref, pipeline, variables?,
 *     authType?, pollIntervalSeconds?, timeoutMinutes?, correlationInput? }
 * The token lives in the existing `config.apiToken` secret field and the
 * Atlassian email (Bitbucket basic auth only) in `config.username`.
 */

const CI_PLATFORMS = ['bitbucket', 'github'];
const CI_REF_TYPES = ['branch', 'tag'];
const CI_AUTH_TYPES = ['bearer', 'basic'];

const DEFAULT_BASE_URLS = {
  bitbucket: 'https://api.bitbucket.org/2.0',
  github: 'https://api.github.com',
};

/** Variable (and GitHub workflow input) names: shell-safe identifiers. */
const VARIABLE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VARIABLES = 25;
const MAX_VARIABLE_VALUE_LENGTH = 2000;

const POLL_INTERVAL_SECONDS = { default: 10, min: 3, max: 60 };
const TIMEOUT_MINUTES = { default: 60, min: 1, max: 720 };

/** Fields that must be present before a deploy/diagnostic can run. */
const REQUIRED_CI_FIELDS = ['platform', 'owner', 'repo', 'ref', 'pipeline'];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Numbers may arrive as numeric strings from form inputs; out-of-range values are clamped. */
function clampNumber(value, { default: fallback, min, max }) {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

/**
 * Converts a variables map to string values. `null`/`undefined` entries are
 * dropped; objects/arrays are kept as-is so validateCiVariables() reports them.
 * @param {*} variables
 * @returns {Record<string, *>}
 */
function toStringVariables(variables) {
  const out = {};
  if (!isPlainObject(variables)) return out;
  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) continue;
    out[key] = typeof value === 'object' ? value : String(value);
  }
  return out;
}

/**
 * Validates a variables map. Messages name the offending KEY only — never
 * the value, since values are user data that may end up in logs.
 * @param {Record<string, *>} variables
 * @returns {{ key: string|null, message: string }[]}
 */
function validateCiVariables(variables) {
  const errors = [];
  if (!isPlainObject(variables)) return errors;

  const entries = Object.entries(variables);
  if (entries.length > MAX_VARIABLES) {
    errors.push({ key: null, message: `At most ${MAX_VARIABLES} variables are allowed (got ${entries.length}).` });
  }
  for (const [key, value] of entries) {
    if (!VARIABLE_KEY_PATTERN.test(key)) {
      errors.push({
        key,
        message: `Variable name '${key}' is invalid — use letters, digits and underscores, not starting with a digit.`,
      });
    }
    if (typeof value !== 'string') {
      errors.push({ key, message: `Variable '${key}' must be a string.` });
    } else if (value.length > MAX_VARIABLE_VALUE_LENGTH) {
      errors.push({ key, message: `Variable '${key}' is longer than ${MAX_VARIABLE_VALUE_LENGTH} characters.` });
    }
  }
  return errors;
}

/**
 * Returns a fully-defaulted, trimmed copy of a (possibly partial or empty)
 * ciConfig. Never throws; missing required fields come back as ''.
 * @param {*} raw - `project.config.ciConfig` as stored.
 * @returns {object}
 */
function normalizeCiConfig(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const platformRaw = trimmed(src.platform).toLowerCase();
  const platform = CI_PLATFORMS.includes(platformRaw) ? platformRaw : '';

  const baseUrl = (trimmed(src.baseUrl) || DEFAULT_BASE_URLS[platform] || '').replace(/\/+$/, '');
  const refType = CI_REF_TYPES.includes(trimmed(src.refType)) ? trimmed(src.refType) : 'branch';
  // GitHub only ever uses bearer tokens.
  const authType = platform === 'bitbucket' && trimmed(src.authType) === 'basic' ? 'basic' : 'bearer';

  return {
    platform,
    baseUrl,
    owner: trimmed(src.owner),
    repo: trimmed(src.repo),
    refType,
    ref: trimmed(src.ref),
    pipeline: trimmed(src.pipeline),
    variables: toStringVariables(src.variables),
    authType,
    pollIntervalSeconds: clampNumber(src.pollIntervalSeconds, POLL_INTERVAL_SECONDS),
    timeoutMinutes: clampNumber(src.timeoutMinutes, TIMEOUT_MINUTES),
    correlationInput: platform === 'github' ? trimmed(src.correlationInput) : '',
  };
}

/**
 * @param {object} ciConfig - output of normalizeCiConfig().
 * @param {{ token?: string, username?: string }} credentials
 * @returns {string[]} names of missing settings, in a stable order.
 */
function findMissingCiFields(ciConfig, { token, username } = {}) {
  const missing = REQUIRED_CI_FIELDS.filter((field) => !ciConfig[field]);
  if (!trimmed(token)) missing.push('apiToken');
  if (ciConfig.platform === 'bitbucket' && ciConfig.authType === 'basic' && !trimmed(username)) {
    missing.push('username');
  }
  return missing;
}

module.exports = {
  CI_PLATFORMS,
  CI_REF_TYPES,
  CI_AUTH_TYPES,
  DEFAULT_BASE_URLS,
  VARIABLE_KEY_PATTERN,
  MAX_VARIABLES,
  MAX_VARIABLE_VALUE_LENGTH,
  POLL_INTERVAL_SECONDS,
  TIMEOUT_MINUTES,
  normalizeCiConfig,
  findMissingCiFields,
  validateCiVariables,
  toStringVariables,
  isPlainObject,
};
