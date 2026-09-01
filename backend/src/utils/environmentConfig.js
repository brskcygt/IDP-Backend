'use strict';

/**
 * Environment overrides for project config (T-50).
 *
 * A project's `config` stays a single flat object — the shared base every
 * environment deploys with by default. `config.environments` is an optional
 * map of environment name -> partial overrides. Resolving a config for a
 * given environment shallow-merges the matching override on top of the base;
 * a couple of known nested objects (`pmpConfig`, `vpnConfig`, and its
 * `mfaConfig`) are merged field-by-field instead of replaced wholesale, so
 * overriding just `vpnConfig.host` for Prod doesn't blow away the shared
 * `vpnConfig.username`.
 *
 * When `config.environments` is absent, or the requested environment isn't
 * one of its keys, every helper here behaves exactly as if environments
 * didn't exist — this is what keeps the seven pre-T-50 projects deploying
 * unchanged.
 */

/**
 * @param {*} value
 * @returns {boolean} true if `value` is a non-array, non-null object.
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Nested config keys merged field-by-field (rather than wholesale replaced)
// when an environment override defines them.
const NESTED_MERGE_KEYS = ['pmpConfig', 'vpnConfig'];

function mergeNestedField(baseValue, overrideValue) {
  if (!isPlainObject(overrideValue)) return baseValue;
  const base = isPlainObject(baseValue) ? baseValue : {};
  const merged = { ...base, ...overrideValue };

  // vpnConfig.mfaConfig is itself worth field-merging rather than replacing —
  // overriding just the MFA secret for Prod shouldn't drop the shared type.
  if (Object.prototype.hasOwnProperty.call(overrideValue, 'mfaConfig')) {
    merged.mfaConfig = {
      ...(isPlainObject(base.mfaConfig) ? base.mfaConfig : {}),
      ...(isPlainObject(overrideValue.mfaConfig) ? overrideValue.mfaConfig : {}),
    };
  }

  return merged;
}

/**
 * Resolves the effective config for a given environment. Never mutates
 * `config` — always returns a new object (or the same values shallow-copied
 * into a new one).
 *
 * @param {object} config - a project's `config` object (may be undefined/null).
 * @param {string} [environment] - environment name, e.g. 'Prod'.
 * @returns {{ config: object, matched: boolean }} `matched` is true only when
 *   `environment` names a key actually present in `config.environments`. When
 *   false, `config` in the return value is the base config, untouched.
 */
function resolveEnvironmentConfig(config, environment) {
  const base = isPlainObject(config) ? config : {};
  const environments = isPlainObject(base.environments) ? base.environments : {};

  // Always drop `environments` from the effective/runtime config: it's
  // metadata about other environments (potentially including their
  // credentials), never a field an adapter should read.
  const { environments: _omitted, ...baseWithoutEnvironments } = base;

  if (
    !environment ||
    typeof environment !== 'string' ||
    !Object.prototype.hasOwnProperty.call(environments, environment)
  ) {
    return { config: { ...baseWithoutEnvironments }, matched: false };
  }

  const override = isPlainObject(environments[environment]) ? environments[environment] : {};
  const merged = { ...baseWithoutEnvironments, ...override };
  delete merged.environments;

  for (const key of NESTED_MERGE_KEYS) {
    if (
      Object.prototype.hasOwnProperty.call(override, key) ||
      Object.prototype.hasOwnProperty.call(baseWithoutEnvironments, key)
    ) {
      merged[key] = mergeNestedField(baseWithoutEnvironments[key], override[key]);
    }
  }

  return { config: merged, matched: true };
}

/**
 * @param {object} config
 * @returns {string[]} names of environments with a configured override,
 *   in insertion order. Empty when `config.environments` is absent.
 */
function listConfiguredEnvironments(config) {
  const base = isPlainObject(config) ? config : {};
  const environments = isPlainObject(base.environments) ? base.environments : {};
  return Object.keys(environments);
}

/**
 * @param {object} config
 * @returns {boolean} true when at least one environment override is configured.
 */
function hasEnvironmentOverrides(config) {
  return listConfiguredEnvironments(config).length > 0;
}

module.exports = {
  resolveEnvironmentConfig,
  listConfiguredEnvironments,
  hasEnvironmentOverrides,
};
