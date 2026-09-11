'use strict';

/**
 * Concrete schemas for the request bodies accepted by the project/user/
 * deploy routes (T-20 / SEC-15). Built entirely from the small DSL in
 * ./schema.js — see that file for why there's no zod/joi/ajv here.
 */
const { string, number, boolean, object, optional, validate } = require('./schema');
const {
  CI_PLATFORMS,
  CI_REF_TYPES,
  CI_AUTH_TYPES,
  VARIABLE_KEY_PATTERN,
  POLL_INTERVAL_SECONDS,
  TIMEOUT_MINUTES,
  validateCiVariables,
} = require('../adapters/ci/config');

const ENVIRONMENTS = ['Dev', 'Stage', 'Prod'];
const PROVIDERS = ['Jenkins', 'PMP', 'Server', 'Pipeline'];
const TARGET_OS_VALUES = ['linux', 'windows'];
const WINDOWS_TRANSPORT_VALUES = ['winrm', 'idp-agent'];
const AUTH_TYPES = ['manual', 'pmp'];
const HOST_KEY_POLICIES = ['tofu', 'strict', 'insecure'];
const USER_ROLES = ['admin', 'deployer', 'viewer'];

// 64 KB — matches T-20's explicit ceiling on a project's deploy script.
const MAX_SCRIPT_CONTENT_LENGTH = 64 * 1024;

// ---------------------------------------------------------------------------
// POST /api/projects
// ---------------------------------------------------------------------------

const createProjectSchema = object({
  fields: {
    name: string({ min: 1, max: 120 }),
    tenant: string({ min: 1, max: 120 }),
    environment: string({ enum: ENVIRONMENTS }),
    provider: string({ enum: PROVIDERS }),
  },
  allowUnknown: false,
});

// ---------------------------------------------------------------------------
// POST /api/projects/:id/settings
//
// The request body IS a partial project config patch (see server.js —
// `mergeProjectConfig(project.config, req.body)`), so every field here is
// optional: a settings save typically only carries the fields the user
// touched. `password`/`apiToken`/pmpConfig/vpnConfig secrets deliberately
// have no `min` — mergeProjectConfig() treats an empty string as "no
// change, keep the stored secret" (see api/projectSerialization.js), and a
// schema that rejected '' would break that contract. `has*` presence flags
// (e.g. `hasPassword`) are never declared as known fields, but every object
// rule below sets `allowUnknown: true`, so they simply pass through
// unvalidated here — mergeProjectConfig() already strips them itself.
// ---------------------------------------------------------------------------

/** Loosely-typed passthrough for pmpConfig/vpnConfig — shape isn't pinned down by T-20. */
const looseNestedConfig = () => optional(object({ allowUnknown: true }));

/**
 * `ciConfig` for the CI Pipeline provider (see adapters/ci/config.js). Every
 * field is optional here — projects are created with an empty config and
 * CiPipelineAdapter reports missing fields at deploy time. The settings form
 * sends a cleared text/select field as '', which is accepted (and treated as
 * unset by normalizeCiConfig). `variables` is only shape-checked here; its
 * entries are validated in validateProjectConfig() so each error carries the
 * variable's own path.
 */
const ciConfigRule = () => optional(object({
  fields: {
    platform: optional(string({ enum: CI_PLATFORMS, allowEmpty: true })),
    // https only: every request to this URL carries the token.
    baseUrl: optional(string({ max: 2000, pattern: /^https:\/\/\S+$/ })),
    owner: optional(string({ max: 255 })),
    repo: optional(string({ max: 255 })),
    refType: optional(string({ enum: CI_REF_TYPES, allowEmpty: true })),
    ref: optional(string({ max: 255 })),
    pipeline: optional(string({ max: 255 })),
    variables: optional(object({ allowUnknown: true })),
    authType: optional(string({ enum: CI_AUTH_TYPES, allowEmpty: true })),
    pollIntervalSeconds: optional(number({ min: POLL_INTERVAL_SECONDS.min, max: POLL_INTERVAL_SECONDS.max, integer: true })),
    timeoutMinutes: optional(number({ min: TIMEOUT_MINUTES.min, max: TIMEOUT_MINUTES.max, integer: true })),
    correlationInput: optional(string({ max: 100, pattern: VARIABLE_KEY_PATTERN })),
  },
  allowUnknown: false,
}));

/** Shared field rules for both a project's base config and each `environments.*` override. */
const baseConfigFields = {
  url: optional(string({ max: 2000 })),
  jobName: optional(string({ max: 255 })),
  username: optional(string({ max: 255 })),
  password: optional(string({ max: 2000 })),
  apiToken: optional(string({ max: 2000 })),
  host: optional(string({ max: 255 })),
  port: optional(number({ min: 1, max: 65535, integer: true })),
  targetOS: optional(string({ enum: TARGET_OS_VALUES })),
  windowsTransport: optional(string({ enum: WINDOWS_TRANSPORT_VALUES })),
  runnerAgentId: optional(string({ max: 64 })),
  runnerTimeoutSeconds: optional(number({ min: 1, max: 3600, integer: true })),
  agentId: optional(string({ max: 128 })),
  agentCommandTimeoutSeconds: optional(number({ min: 1, max: 3600, integer: true })),
  authType: optional(string({ enum: AUTH_TYPES })),
  scriptContent: optional(string({ max: MAX_SCRIPT_CONTENT_LENGTH })),
  hostKeyPolicy: optional(string({ enum: HOST_KEY_POLICIES })),
  vpnEnabled: optional(boolean()),
  // T-18b: server telemetry (CPU/RAM polling) is opt-in per project, defaulting
  // to false — see core/projects/projectService.js#getProjectTelemetry and
  // services/TelemetryService.js, which both refuse to open a connection when
  // this isn't exactly `true`.
  telemetryEnabled: optional(boolean()),
  privateKeyPath: optional(string({ max: 2000 })),
  timeoutMs: optional(number({ min: 0, integer: true })),
  vpnConfig: looseNestedConfig(),
  pmpConfig: looseNestedConfig(),
  ciConfig: ciConfigRule(),
};

/** A single `environments.<Name>` override — same fields, no nested `environments` of its own. */
const environmentOverrideSchema = object({ fields: baseConfigFields, allowUnknown: true });

const projectConfigSchema = object({
  fields: {
    ...baseConfigFields,
    // Shape-checked here (must be an object); each entry's fields are
    // validated separately in validateProjectConfig() below so errors come
    // back with an `environments.<Name>.<field>` path instead of a single
    // opaque "environments is invalid".
    environments: optional(object({ allowUnknown: true })),
  },
  allowUnknown: true,
});

/**
 * Validates a project settings PATCH body: the base config fields, plus
 * every `environments.<Name>` override recursively (T-50 configs nest
 * arbitrarily-named environment keys, which the plain `object()` DSL can't
 * express directly since it only knows fixed field names).
 * @param {object} body
 * @returns {import('./schema').ValidationResult}
 */
function validateProjectConfig(body) {
  const base = validate(body, projectConfigSchema);
  const errors = [...base.errors, ...ciVariableErrors(body, '')];

  const environments = base.value && isPlainObject(base.value.environments) ? base.value.environments : null;
  if (environments) {
    for (const [envName, envConfig] of Object.entries(environments)) {
      const envPath = `environments.${envName}`;
      const envResult = validate(envConfig, environmentOverrideSchema, envPath);
      errors.push(...envResult.errors, ...ciVariableErrors(envConfig, envPath));
    }
  }

  return { valid: errors.length === 0, value: base.value, errors };
}

/** Entry-level checks for `ciConfig.variables`: count, key format, value type/length. */
function ciVariableErrors(config, basePath) {
  const variables = isPlainObject(config) && isPlainObject(config.ciConfig) ? config.ciConfig.variables : undefined;
  if (!isPlainObject(variables)) return [];
  const path = basePath ? `${basePath}.ciConfig.variables` : 'ciConfig.variables';
  return validateCiVariables(variables).map(({ key, message }) => ({
    path: key === null ? path : `${path}.${key}`,
    message,
  }));
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// POST /api/deploy/trigger
// ---------------------------------------------------------------------------

const deployTriggerSchema = object({
  fields: {
    projectId: string({ min: 1 }),
    parameters: optional(object({ allowUnknown: true })),
  },
  allowUnknown: false,
});

// ---------------------------------------------------------------------------
// POST /api/users (create) and PATCH /api/users/:id (update)
// ---------------------------------------------------------------------------

const userSchema = object({
  fields: {
    username: string({ min: 3, max: 64, pattern: /^[a-zA-Z0-9._-]+$/ }),
    password: string({ min: 8 }),
    role: string({ enum: USER_ROLES }),
  },
  allowUnknown: false,
});

/** PATCH allows updating role and/or password only — see routes/users.js. */
const userUpdateSchema = object({
  fields: {
    role: optional(string({ enum: USER_ROLES })),
    password: optional(string({ min: 8 })),
  },
  allowUnknown: false,
});

module.exports = {
  createProjectSchema,
  projectConfigSchema,
  validateProjectConfig,
  deployTriggerSchema,
  userSchema,
  userUpdateSchema,
  ENVIRONMENTS,
  PROVIDERS,
};
