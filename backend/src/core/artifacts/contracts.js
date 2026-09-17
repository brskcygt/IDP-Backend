'use strict';

/**
 * Artifact deploy — shared contracts (see docs/ARTIFACT-DEPLOY.md).
 *
 * Pure and dependency-free: the manifest contract (1.1), the project's
 * `config.artifactDeploy` shape, deploy-target input, artifact selection and
 * the `artifact_deploy` agent payload (1.2) are all defined here so the
 * validation layer, the services and the tests share exactly one definition.
 * Nothing here performs I/O.
 */

const { normalizeBuildParameters, validateBuildParameters } = require('../deployment/buildParameters');

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const COMPONENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const ARTIFACT_OS_VALUES = ['any', 'win-x64', 'linux-x64'];
const ARTIFACT_FILE_PATTERN = /^[A-Za-z0-9._-]+\.tar\.gz$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** `manifest.project` and the artifact file-name prefix (e.g. `jetsrm`). */
const ARTIFACT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MANIFEST_PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SUBDIR_PATTERN = /^[A-Za-z0-9._-]+$/;
const OWNER_REPO_PATTERN = /^[A-Za-z0-9._-]{1,255}$/;
/** Branch/tag names for a release build: no whitespace, no `..`, no leading `-`/`/`. */
const GIT_REF_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/;
const VARIABLE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const RUNTIME_TYPES = ['nssm', 'windows-service', 'iis-static', 'systemd', 'none'];
const SERVICE_RUNTIMES = new Set(['nssm', 'windows-service', 'systemd']);
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9._@-]{1,128}$/;
const APP_POOL_PATTERN = /^[A-Za-z0-9._-][A-Za-z0-9 ._-]{0,127}$/;
const EXPECT_VERSION_PATH_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

const SOURCE_PLATFORMS = ['bitbucket', 'github'];
const SOURCE_AUTH_TYPES = ['bearer', 'basic'];
const BUILD_PROVIDERS = ['pipeline', 'jenkins', 'none'];
const TARGET_OS_VALUES = ['windows', 'linux'];
const TARGET_ENVIRONMENTS = ['Dev', 'Stage', 'Prod'];

const DEFAULT_SOURCE_BASE_URLS = {
  bitbucket: 'https://api.bitbucket.org/2.0',
  github: 'https://api.github.com',
};

const MAX_COMPONENTS = 10;
const MAX_PRESERVE = 50;
const MAX_PRESERVE_LENGTH = 260;
const MAX_MANIFEST_ARTIFACTS = 40;
const HEALTH_TIMEOUT_SEC = { min: 5, max: 600, default: 90 };

// preStart hooks (e.g. JetSRM `sequelize-cli db:migrate` between swap and start).
const MAX_HOOKS = 5;
const HOOK_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** A bare executable name resolved from PATH by the agent — never a path. */
const HOOK_COMMAND_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_HOOK_ARGS = 20;
const MAX_HOOK_ARG_LENGTH = 512;
const HOOK_ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SAFE_HOOK_ENV_KEYS = new Set(['NODE_ENV']);
const MAX_HOOK_ENV = 20;
const MAX_HOOK_ENV_VALUE_LENGTH = 1024;
const HOOK_TIMEOUT_SEC = { min: 1, max: 3600, default: 600 };

// Target runtime config → `config.js` (`window.__ENV__`) written by the agent.
const RUNTIME_CONFIG_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_RUNTIME_CONFIG_KEYS = 100;
const MAX_RUNTIME_CONFIG_VALUE_LENGTH = 2000;
const RUNTIME_CONFIG_FORMATS = ['frontend-config-js', 'env-file'];
// Leave headroom under the gateway's 256 KiB typed-command body limit.
const MAX_RUNTIME_CONFIG_TOTAL_BYTES = 192 * 1024;

const DEPLOY_STAGES = [
  'accepted', 'downloading', 'verifying', 'extracting', 'preserving', 'configuring', 'stopping',
  'switching', 'pre_start', 'starting', 'health_check', 'rolling_back', 'cleanup',
];
const DEPLOY_EVENT_STATUSES = ['started', 'progress', 'done', 'failed', 'skipped'];

/** Agent-side global deploy timeout bounds (payload `timeoutSec`). */
const DEPLOY_TIMEOUT_SEC = { min: 1800, max: 4 * 3600, base: 900 };

const ARTIFACT_COMMAND_PROCESSES = [
  'artifact_deploy', 'artifact_rollback', 'artifact_config_apply', 'artifact_cancel', 'artifact_status',
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function childPath(base, key) {
  return base ? `${base}.${key}` : String(key);
}

/** Accepts a JS number or a numeric string (form inputs); returns the number or NaN. */
function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return Number.NaN;
}

function hasControlChars(value) {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}

function unknownKeyErrors(value, allowed, path) {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({ path: childPath(path, key), message: `Unknown field "${key}" is not allowed.` }));
}

function integerInRange(value, { min, max }, path, errors) {
  const numeric = toNumber(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    errors.push({ path, message: `Must be an integer between ${min} and ${max}.` });
    return false;
  }
  return true;
}

/** Relative, portable path fragment: no `..`, no leading slash, no drive letter, no NUL. */
function isSafePreservePattern(value) {
  if (typeof value !== 'string') return false;
  const pattern = value.trim();
  if (pattern === '' || pattern.length > MAX_PRESERVE_LENGTH) return false;
  if (hasControlChars(pattern)) return false;
  if (/^[\\/]/.test(pattern) || /^[A-Za-z]:/.test(pattern)) return false;
  return !pattern.split(/[\\/]+/).some((segment) => segment === '..');
}

function isSafeSubdir(value) {
  return typeof value === 'string' && SUBDIR_PATTERN.test(value) && value !== '.' && value !== '..';
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1.1 Manifest
// ---------------------------------------------------------------------------

/**
 * Validates a build manifest.
 *
 * @param {*} manifest - parsed JSON.
 * @param {{ project?: string, version?: string }} [expected] - when given, the
 *   manifest must be for exactly this artifact name / version.
 * @returns {{ valid: boolean, errors: string[], manifest: object|null }} `manifest`
 *   is a normalized copy (only known fields) when valid.
 */
function validateManifest(manifest, expected = {}) {
  const errors = [];
  if (!isPlainObject(manifest)) return { valid: false, errors: ['Manifest must be a JSON object.'], manifest: null };

  if (manifest.schema !== 1) errors.push('schema must be 1.');
  if (typeof manifest.project !== 'string' || !MANIFEST_PROJECT_PATTERN.test(manifest.project)) {
    errors.push('project is missing or invalid.');
  } else if (expected.project && manifest.project !== expected.project) {
    errors.push(`project is '${manifest.project}', expected '${expected.project}'.`);
  }
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) {
    errors.push('version is missing or invalid.');
  } else if (expected.version && manifest.version !== expected.version) {
    errors.push(`version is '${manifest.version}', expected '${expected.version}'.`);
  }
  if (manifest.commit !== undefined && manifest.commit !== null
    && (typeof manifest.commit !== 'string' || manifest.commit.length > 128 || hasControlChars(manifest.commit))) {
    errors.push('commit must be a short string.');
  }
  if (manifest.createdAt !== undefined && manifest.createdAt !== null
    && (typeof manifest.createdAt !== 'string' || manifest.createdAt.length > 64 || hasControlChars(manifest.createdAt))) {
    errors.push('createdAt must be a short string.');
  }

  const artifacts = [];
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    errors.push('artifacts must be a non-empty array.');
  } else if (manifest.artifacts.length > MAX_MANIFEST_ARTIFACTS) {
    errors.push(`artifacts may contain at most ${MAX_MANIFEST_ARTIFACTS} entries.`);
  } else {
    const seenFiles = new Set();
    const seenComponentOs = new Set();
    manifest.artifacts.forEach((artifact, index) => {
      const at = `artifacts[${index}]`;
      if (!isPlainObject(artifact)) {
        errors.push(`${at} must be an object.`);
        return;
      }
      const problems = [];
      if (typeof artifact.component !== 'string' || !COMPONENT_NAME_PATTERN.test(artifact.component)) problems.push('component');
      if (!ARTIFACT_OS_VALUES.includes(artifact.os)) problems.push('os');
      if (typeof artifact.file !== 'string' || !ARTIFACT_FILE_PATTERN.test(artifact.file)) problems.push('file');
      if (typeof artifact.sha256 !== 'string' || !SHA256_PATTERN.test(artifact.sha256)) problems.push('sha256');
      if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) problems.push('size');
      if (problems.length > 0) {
        errors.push(`${at} has invalid ${problems.join(', ')}.`);
        return;
      }
      if (seenFiles.has(artifact.file)) errors.push(`${at}.file '${artifact.file}' is listed twice.`);
      const key = `${artifact.component}/${artifact.os}`;
      if (seenComponentOs.has(key)) errors.push(`${at} duplicates component '${artifact.component}' for os '${artifact.os}'.`);
      seenFiles.add(artifact.file);
      seenComponentOs.add(key);
      artifacts.push({
        component: artifact.component,
        os: artifact.os,
        file: artifact.file,
        sha256: artifact.sha256,
        size: artifact.size,
      });
    });
  }

  if (errors.length > 0) return { valid: false, errors, manifest: null };
  return {
    valid: true,
    errors: [],
    manifest: {
      schema: 1,
      project: manifest.project,
      version: manifest.version,
      commit: typeof manifest.commit === 'string' ? manifest.commit : null,
      createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : null,
      artifacts,
    },
  };
}

/** `<artifactName>-<version>-manifest.json` */
function manifestFileName(artifactName, version) {
  return `${artifactName}-${version}-manifest.json`;
}

// ---------------------------------------------------------------------------
// 2.2 Project config: config.artifactDeploy
// ---------------------------------------------------------------------------

const ARTIFACT_DEPLOY_KEYS = ['source', 'build', 'versionVariable', 'artifactName', 'components'];
const SOURCE_KEYS = ['platform', 'owner', 'repo', 'baseUrl', 'authType', 'username', 'token', 'hasToken'];
const BUILD_KEYS = ['provider', 'parameters'];
const COMPONENT_KEYS = ['name', 'subdir', 'os', 'runtime', 'preserve', 'health', 'writeRuntimeConfig', 'hooks'];
const RUNTIME_KEYS = ['type', 'serviceName', 'appPool'];
const HEALTH_KEYS = ['url', 'expectVersionPath', 'timeoutSec'];
const HOOKS_KEYS = ['preStart'];
const HOOK_KEYS = ['name', 'command', 'args', 'env', 'timeoutSec'];

function optionalEnum(value, allowed, path, errors) {
  if (value === undefined || value === null || value === '') return;
  if (!allowed.includes(value)) errors.push({ path, message: `Must be one of: ${allowed.join(', ')}.` });
}

function optionalPatternString(value, pattern, max, path, errors) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') {
    errors.push({ path, message: 'Must be a string.' });
  } else if (value.length > max || !pattern.test(value)) {
    errors.push({ path, message: 'Does not match the required format.' });
  }
}

function validateSource(source, path, errors) {
  if (source === undefined || source === null) return;
  if (!isPlainObject(source)) {
    errors.push({ path, message: 'Must be an object.' });
    return;
  }
  errors.push(...unknownKeyErrors(source, SOURCE_KEYS, path));
  optionalEnum(source.platform, SOURCE_PLATFORMS, childPath(path, 'platform'), errors);
  optionalPatternString(source.owner, OWNER_REPO_PATTERN, 255, childPath(path, 'owner'), errors);
  optionalPatternString(source.repo, OWNER_REPO_PATTERN, 255, childPath(path, 'repo'), errors);
  // https only: every request to this URL carries the repository token.
  optionalPatternString(source.baseUrl, /^https:\/\/\S+$/, 2000, childPath(path, 'baseUrl'), errors);
  optionalEnum(source.authType, SOURCE_AUTH_TYPES, childPath(path, 'authType'), errors);
  if (source.username !== undefined && source.username !== null
    && (typeof source.username !== 'string' || source.username.length > 255)) {
    errors.push({ path: childPath(path, 'username'), message: 'Must be a string of at most 255 characters.' });
  }
  // No minimum: '' means "keep the stored token" (see api/projectSerialization.js).
  if (source.token !== undefined && source.token !== null
    && (typeof source.token !== 'string' || source.token.length > 2000)) {
    errors.push({ path: childPath(path, 'token'), message: 'Must be a string of at most 2000 characters.' });
  }
  if (source.hasToken !== undefined && typeof source.hasToken !== 'boolean') {
    errors.push({ path: childPath(path, 'hasToken'), message: 'Must be a boolean.' });
  }
}

function validateRuntime(runtime, path, errors, { required = true } = {}) {
  if (runtime === undefined || runtime === null) {
    if (required) errors.push({ path, message: 'This field is required.' });
    return;
  }
  if (!isPlainObject(runtime)) {
    errors.push({ path, message: 'Must be an object.' });
    return;
  }
  errors.push(...unknownKeyErrors(runtime, RUNTIME_KEYS, path));
  if (!RUNTIME_TYPES.includes(runtime.type)) {
    errors.push({ path: childPath(path, 'type'), message: `Must be one of: ${RUNTIME_TYPES.join(', ')}.` });
    return;
  }
  const serviceName = runtime.serviceName;
  if (SERVICE_RUNTIMES.has(runtime.type)) {
    if (typeof serviceName !== 'string' || !SERVICE_NAME_PATTERN.test(serviceName)) {
      errors.push({
        path: childPath(path, 'serviceName'),
        message: `Required for '${runtime.type}': 1-128 letters, digits, '.', '_', '@' or '-'.`,
      });
    }
  } else if (serviceName !== undefined && serviceName !== null && serviceName !== '') {
    errors.push({ path: childPath(path, 'serviceName'), message: `Not used by runtime '${runtime.type}'.` });
  }
  const appPool = runtime.appPool;
  if (appPool !== undefined && appPool !== null && appPool !== '') {
    if (runtime.type !== 'iis-static') {
      errors.push({ path: childPath(path, 'appPool'), message: "Only used by runtime 'iis-static'." });
    } else if (typeof appPool !== 'string' || !APP_POOL_PATTERN.test(appPool) || appPool.trim() !== appPool) {
      errors.push({ path: childPath(path, 'appPool'), message: 'Does not match the required format.' });
    }
  }
}

function validateHealth(health, path, errors) {
  if (health === undefined || health === null) return;
  if (!isPlainObject(health)) {
    errors.push({ path, message: 'Must be an object or null.' });
    return;
  }
  errors.push(...unknownKeyErrors(health, HEALTH_KEYS, path));
  if (!isHttpUrl(health.url)) {
    errors.push({ path: childPath(path, 'url'), message: 'Must be an http:// or https:// URL.' });
  }
  optionalPatternString(health.expectVersionPath, EXPECT_VERSION_PATH_PATTERN, 128, childPath(path, 'expectVersionPath'), errors);
  if (health.timeoutSec !== undefined && health.timeoutSec !== null && health.timeoutSec !== '') {
    integerInRange(health.timeoutSec, HEALTH_TIMEOUT_SEC, childPath(path, 'timeoutSec'), errors);
  }
}

function validateHook(hook, path, errors) {
  if (!isPlainObject(hook)) {
    errors.push({ path, message: 'Must be an object.' });
    return;
  }
  errors.push(...unknownKeyErrors(hook, HOOK_KEYS, path));
  if (typeof hook.name !== 'string' || !HOOK_NAME_PATTERN.test(hook.name)) {
    errors.push({ path: childPath(path, 'name'), message: 'Must match ^[a-z][a-z0-9-]{0,31}$.' });
  }
  if (typeof hook.command !== 'string' || !HOOK_COMMAND_PATTERN.test(hook.command) || hook.command === '.' || hook.command === '..') {
    errors.push({
      path: childPath(path, 'command'),
      message: 'Must be a bare executable name (letters, digits, ".", "_", "-"; no path separators).',
    });
  }
  if (hook.args !== undefined && hook.args !== null) {
    if (!Array.isArray(hook.args)) {
      errors.push({ path: childPath(path, 'args'), message: 'Must be an array of strings.' });
    } else {
      if (hook.args.length > MAX_HOOK_ARGS) {
        errors.push({ path: childPath(path, 'args'), message: `Must contain at most ${MAX_HOOK_ARGS} item(s).` });
      }
      hook.args.forEach((arg, index) => {
        if (typeof arg !== 'string' || arg.length > MAX_HOOK_ARG_LENGTH || arg.includes('\u0000')) {
          errors.push({
            path: childPath(childPath(path, 'args'), index),
            message: `Must be a string of at most ${MAX_HOOK_ARG_LENGTH} characters without NUL.`,
          });
        }
      });
    }
  }
  if (hook.env !== undefined && hook.env !== null) {
    if (!isPlainObject(hook.env)) {
      errors.push({ path: childPath(path, 'env'), message: 'Must be an object of string values.' });
    } else {
      const entries = Object.entries(hook.env);
      if (entries.length > MAX_HOOK_ENV) {
        errors.push({ path: childPath(path, 'env'), message: `Must contain at most ${MAX_HOOK_ENV} entries.` });
      }
      for (const [key, value] of entries) {
        // Messages name the key only — env values may be sensitive and must never be echoed.
        if (!HOOK_ENV_KEY_PATTERN.test(key)) {
          errors.push({ path: childPath(path, 'env'), message: `Variable name '${key.slice(0, 40)}' must match ^[A-Z_][A-Z0-9_]*$.` });
        } else if (!SAFE_HOOK_ENV_KEYS.has(key)) {
          errors.push({
            path: childPath(path, 'env'),
            message: `Hook variable '${key.slice(0, 40)}' is not allowlisted; target-specific values must be stored in encrypted env-file runtime config.`,
          });
        }
        if (typeof value !== 'string' || value.length > MAX_HOOK_ENV_VALUE_LENGTH || value.includes('\u0000')) {
          errors.push({
            path: childPath(path, 'env'),
            message: `Value of '${key.slice(0, 40)}' must be a string of at most ${MAX_HOOK_ENV_VALUE_LENGTH} characters.`,
          });
        }
      }
    }
  }
  if (hook.timeoutSec !== undefined && hook.timeoutSec !== null && hook.timeoutSec !== '') {
    integerInRange(hook.timeoutSec, HOOK_TIMEOUT_SEC, childPath(path, 'timeoutSec'), errors);
  }
}

function validateHooks(hooks, path, errors) {
  if (hooks === undefined || hooks === null) return;
  if (!isPlainObject(hooks)) {
    errors.push({ path, message: 'Must be an object or null.' });
    return;
  }
  errors.push(...unknownKeyErrors(hooks, HOOKS_KEYS, path));
  const preStart = hooks.preStart;
  if (preStart === undefined || preStart === null) return;
  const listPath = childPath(path, 'preStart');
  if (!Array.isArray(preStart)) {
    errors.push({ path: listPath, message: 'Must be an array.' });
    return;
  }
  if (preStart.length > MAX_HOOKS) {
    errors.push({ path: listPath, message: `Must contain at most ${MAX_HOOKS} item(s).` });
  }
  const names = new Set();
  preStart.forEach((hook, index) => {
    const hookPath = childPath(listPath, index);
    validateHook(hook, hookPath, errors);
    if (isPlainObject(hook) && typeof hook.name === 'string') {
      if (names.has(hook.name)) errors.push({ path: childPath(hookPath, 'name'), message: `Duplicate hook name '${hook.name}'.` });
      names.add(hook.name);
    }
  });
}

function validateComponent(component, path, errors) {
  if (!isPlainObject(component)) {
    errors.push({ path, message: 'Must be an object.' });
    return;
  }
  errors.push(...unknownKeyErrors(component, COMPONENT_KEYS, path));
  if (typeof component.name !== 'string' || !COMPONENT_NAME_PATTERN.test(component.name)) {
    errors.push({ path: childPath(path, 'name'), message: 'Must match ^[a-z][a-z0-9-]{0,31}$.' });
  }
  if (!isSafeSubdir(component.subdir)) {
    errors.push({ path: childPath(path, 'subdir'), message: "Must be a single folder name (letters, digits, '.', '_', '-'), not '.' or '..'." });
  }
  optionalEnum(component.os, ARTIFACT_OS_VALUES, childPath(path, 'os'), errors);
  validateRuntime(component.runtime, childPath(path, 'runtime'), errors);
  if (component.preserve !== undefined && component.preserve !== null) {
    const preservePath = childPath(path, 'preserve');
    if (!Array.isArray(component.preserve)) {
      errors.push({ path: preservePath, message: 'Must be an array of relative path patterns.' });
    } else {
      if (component.preserve.length > MAX_PRESERVE) {
        errors.push({ path: preservePath, message: `Must contain at most ${MAX_PRESERVE} item(s).` });
      }
      component.preserve.forEach((pattern, index) => {
        if (!isSafePreservePattern(pattern)) {
          errors.push({
            path: childPath(preservePath, index),
            message: "Must be a relative pattern (no '..', no leading '/' or drive letter).",
          });
        }
      });
    }
  }
  validateHealth(component.health, childPath(path, 'health'), errors);
  if (component.writeRuntimeConfig !== undefined && typeof component.writeRuntimeConfig !== 'boolean') {
    errors.push({ path: childPath(path, 'writeRuntimeConfig'), message: 'Must be a boolean.' });
  }
  validateHooks(component.hooks, childPath(path, 'hooks'), errors);
}

/**
 * Validates `config.artifactDeploy` (a settings patch or the stored value).
 * `undefined`/`null` is valid (feature not configured).
 * @param {*} value
 * @param {string} [path]
 * @returns {{ path: string, message: string }[]}
 */
function validateArtifactDeployConfig(value, path = 'artifactDeploy') {
  if (value === undefined || value === null) return [];
  if (!isPlainObject(value)) return [{ path, message: 'Must be an object.' }];

  const errors = [...unknownKeyErrors(value, ARTIFACT_DEPLOY_KEYS, path)];
  validateSource(value.source, childPath(path, 'source'), errors);

  if (value.build !== undefined && value.build !== null) {
    const buildPath = childPath(path, 'build');
    if (!isPlainObject(value.build)) {
      errors.push({ path: buildPath, message: 'Must be an object.' });
    } else {
      errors.push(...unknownKeyErrors(value.build, BUILD_KEYS, buildPath));
      optionalEnum(value.build.provider, BUILD_PROVIDERS, childPath(buildPath, 'provider'), errors);
      errors.push(...validateBuildParameters(value.build.parameters, childPath(buildPath, 'parameters')));
    }
  }
  optionalPatternString(value.versionVariable, VARIABLE_KEY_PATTERN, 100, childPath(path, 'versionVariable'), errors);
  optionalPatternString(value.artifactName, ARTIFACT_NAME_PATTERN, 64, childPath(path, 'artifactName'), errors);

  if (value.components !== undefined && value.components !== null) {
    const componentsPath = childPath(path, 'components');
    if (!Array.isArray(value.components)) {
      errors.push({ path: componentsPath, message: 'Must be an array.' });
    } else {
      if (value.components.length > MAX_COMPONENTS) {
        errors.push({ path: componentsPath, message: `Must contain at most ${MAX_COMPONENTS} item(s).` });
      }
      const names = new Set();
      const subdirs = new Set();
      value.components.forEach((component, index) => {
        const componentPath = childPath(componentsPath, index);
        validateComponent(component, componentPath, errors);
        if (!isPlainObject(component)) return;
        if (typeof component.name === 'string') {
          if (names.has(component.name)) errors.push({ path: childPath(componentPath, 'name'), message: `Duplicate component name '${component.name}'.` });
          names.add(component.name);
        }
        if (typeof component.subdir === 'string') {
          // Case-insensitive: two components must never share a folder on Windows.
          const key = component.subdir.toLowerCase();
          if (subdirs.has(key)) errors.push({ path: childPath(componentPath, 'subdir'), message: `Duplicate subdir '${component.subdir}'.` });
          subdirs.add(key);
        }
      });
    }
  }
  return errors;
}

function normalizeHealth(health) {
  if (!isPlainObject(health)) return null;
  const timeout = toNumber(health.timeoutSec);
  return {
    url: health.url,
    expectVersionPath: trimmed(health.expectVersionPath) || null,
    timeoutSec: Number.isInteger(timeout) ? timeout : HEALTH_TIMEOUT_SEC.default,
  };
}

function normalizeHooks(hooks) {
  if (!isPlainObject(hooks) || !Array.isArray(hooks.preStart) || hooks.preStart.length === 0) return null;
  return {
    preStart: hooks.preStart.map((hook) => {
      const timeout = toNumber(hook.timeoutSec);
      return {
        name: hook.name,
        command: hook.command,
        args: Array.isArray(hook.args) ? [...hook.args] : [],
        env: isPlainObject(hook.env) ? { ...hook.env } : {},
        timeoutSec: Number.isInteger(timeout) ? timeout : HOOK_TIMEOUT_SEC.default,
      };
    }),
  };
}

function normalizeRuntime(runtime) {
  const type = runtime.type;
  return {
    type,
    serviceName: SERVICE_RUNTIMES.has(type) ? runtime.serviceName : null,
    appPool: type === 'iis-static' && trimmed(runtime.appPool) ? runtime.appPool : null,
  };
}

function normalizeComponent(component) {
  return {
    name: component.name,
    subdir: component.subdir,
    os: ARTIFACT_OS_VALUES.includes(component.os) ? component.os : null,
    runtime: normalizeRuntime(component.runtime),
    preserve: Array.isArray(component.preserve) ? component.preserve.map((p) => p.trim()) : [],
    health: normalizeHealth(component.health),
    writeRuntimeConfig: component.writeRuntimeConfig === true,
    hooks: normalizeHooks(component.hooks),
  };
}

/**
 * Fully-defaulted copy of a VALID `config.artifactDeploy` without the token.
 * Returns null when the feature isn't configured at all.
 * @param {*} raw
 * @returns {object|null}
 */
function normalizeArtifactDeployConfig(raw) {
  if (!isPlainObject(raw)) return null;
  const source = isPlainObject(raw.source) ? raw.source : {};
  const platform = SOURCE_PLATFORMS.includes(source.platform) ? source.platform : '';
  const repo = trimmed(source.repo);
  const derivedName = repo.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '');
  const artifactName = trimmed(raw.artifactName) || (ARTIFACT_NAME_PATTERN.test(derivedName) ? derivedName : '');
  const build = isPlainObject(raw.build) ? raw.build : {};

  return {
    source: {
      platform,
      owner: trimmed(source.owner),
      repo,
      baseUrl: (trimmed(source.baseUrl) || DEFAULT_SOURCE_BASE_URLS[platform] || '').replace(/\/+$/, ''),
      authType: platform === 'bitbucket' && source.authType === 'basic' ? 'basic' : 'bearer',
      username: trimmed(source.username),
    },
    build: {
      provider: BUILD_PROVIDERS.includes(build.provider) ? build.provider : 'none',
      // null rather than {} so a project without parameters stays indistinguishable
      // from one whose last entry was removed.
      parameters: normalizeBuildParameters(build.parameters),
    },
    versionVariable: trimmed(raw.versionVariable) || 'VERSION',
    artifactName,
    components: Array.isArray(raw.components) ? raw.components.filter(isPlainObject).map(normalizeComponent) : [],
  };
}

/**
 * @param {object|null} normalized - output of normalizeArtifactDeployConfig().
 * @param {{ token?: string, username?: string }} credentials - resolved source credentials.
 * @returns {string[]} missing settings, stable order.
 */
function findMissingSourceFields(normalized, { token, username } = {}) {
  if (!normalized) return ['artifactDeploy'];
  const missing = [];
  const { source } = normalized;
  if (!source.platform) missing.push('artifactDeploy.source.platform');
  if (!source.owner) missing.push('artifactDeploy.source.owner');
  if (!source.repo) missing.push('artifactDeploy.source.repo');
  if (!normalized.artifactName) missing.push('artifactDeploy.artifactName');
  if (!trimmed(token)) missing.push('artifactDeploy.source.token');
  if (source.platform === 'bitbucket' && source.authType === 'basic' && !trimmed(username)) {
    missing.push('artifactDeploy.source.username');
  }
  return missing;
}

/**
 * Credentials for the artifact source from a RESOLVED (secret-decrypted)
 * project config: `artifactDeploy.source.token`, falling back to the
 * project's `apiToken` (+ `username`) when no dedicated token is set and the
 * source uses the official provider API. A custom API host always needs its
 * own token so changing baseUrl cannot redirect an existing CI credential.
 * @returns {{ token: string, username: string, fallback: boolean }}
 */
function resolveSourceCredentials(runtimeConfig, normalized) {
  const config = isPlainObject(runtimeConfig) ? runtimeConfig : {};
  const deploy = isPlainObject(config.artifactDeploy) ? config.artifactDeploy : {};
  const source = isPlainObject(deploy.source) ? deploy.source : {};
  const username = (normalized && normalized.source.username) || '';
  const own = trimmed(source.token);
  if (own) return { token: own, username, fallback: false };
  const officialBaseUrl = normalized && DEFAULT_SOURCE_BASE_URLS[normalized.source.platform];
  const mayUseProjectToken = officialBaseUrl && normalized.source.baseUrl === officialBaseUrl;
  return {
    token: mayUseProjectToken ? trimmed(config.apiToken) : '',
    username: username || trimmed(config.username),
    fallback: Boolean(mayUseProjectToken),
  };
}

// ---------------------------------------------------------------------------
// Deploy targets (one agent = one target = one project per server)
// ---------------------------------------------------------------------------

const TARGET_KEYS = ['name', 'agentId', 'os', 'environment', 'basePath', 'components', 'runtimeConfig'];
const TARGET_COMPONENT_KEYS = ['name', 'runtime', 'health'];
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

function validateRuntimeConfigValues(value, path, errors) {
  if (value === undefined || value === null) return;
  if (!isPlainObject(value)) {
    errors.push({ path, message: 'Must be an object of string values or null.' });
    return;
  }
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RUNTIME_CONFIG_TOTAL_BYTES) {
      errors.push({ path, message: `Must be at most ${MAX_RUNTIME_CONFIG_TOTAL_BYTES} UTF-8 bytes.` });
    }
  } catch {
    errors.push({ path, message: 'Must be JSON serializable.' });
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_RUNTIME_CONFIG_KEYS) {
    errors.push({ path, message: `Must contain at most ${MAX_RUNTIME_CONFIG_KEYS} entries.` });
  }
  for (const [key, entry] of entries) {
    if (!RUNTIME_CONFIG_KEY_PATTERN.test(key)) {
      errors.push({ path: childPath(path, key.slice(0, 40)), message: 'Key must match ^[A-Z][A-Z0-9_]*$.' });
    }
    if (typeof entry !== 'string' || entry.length > MAX_RUNTIME_CONFIG_VALUE_LENGTH) {
      errors.push({ path: childPath(path, key.slice(0, 40)), message: `Must be a string of at most ${MAX_RUNTIME_CONFIG_VALUE_LENGTH} characters.` });
    }
  }
}

function isLegacyRuntimeConfig(value) {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function validateRuntimeConfig(value, path, errors) {
  if (value === undefined || value === null) return;
  if (!isPlainObject(value)) {
    errors.push({ path, message: 'Must be a component config object, a legacy string map, or null.' });
    return;
  }
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RUNTIME_CONFIG_TOTAL_BYTES) {
      errors.push({ path, message: `Serialized runtime config must be at most ${MAX_RUNTIME_CONFIG_TOTAL_BYTES} UTF-8 bytes.` });
      return;
    }
  } catch {
    errors.push({ path, message: 'Must be JSON serializable.' });
    return;
  }
  if (isLegacyRuntimeConfig(value)) {
    validateRuntimeConfigValues(value, path, errors);
    return;
  }
  if (Object.keys(value).length > MAX_COMPONENTS) {
    errors.push({ path, message: `Must contain at most ${MAX_COMPONENTS} component entries.` });
  }
  for (const [componentName, spec] of Object.entries(value)) {
    const specPath = childPath(path, componentName.slice(0, 40));
    if (!COMPONENT_NAME_PATTERN.test(componentName)) {
      errors.push({ path: specPath, message: 'Component name must match ^[a-z][a-z0-9-]{0,31}$.' });
      continue;
    }
    if (!isPlainObject(spec)) {
      errors.push({ path: specPath, message: 'Must be an object with format and values.' });
      continue;
    }
    errors.push(...unknownKeyErrors(spec, ['format', 'values'], specPath));
    if (!RUNTIME_CONFIG_FORMATS.includes(spec.format)) {
      errors.push({ path: childPath(specPath, 'format'), message: `Must be one of: ${RUNTIME_CONFIG_FORMATS.join(', ')}.` });
    }
    if (!Object.prototype.hasOwnProperty.call(spec, 'values')) {
      errors.push({ path: childPath(specPath, 'values'), message: 'Is required.' });
    } else {
      validateRuntimeConfigValues(spec.values, childPath(specPath, 'values'), errors);
    }
  }
}

function cloneRuntimeConfig(value) {
  if (!isPlainObject(value)) return null;
  if (isLegacyRuntimeConfig(value)) return { ...value };
  return Object.fromEntries(Object.entries(value).map(([name, spec]) => [name, {
    format: spec.format,
    values: isPlainObject(spec.values) ? { ...spec.values } : spec.values,
  }]));
}

/** Resolve a target config for one component. Legacy maps remain frontend config.js. */
function runtimeConfigForComponent(runtimeConfig, component) {
  if (!isPlainObject(runtimeConfig)) return null;
  if (isLegacyRuntimeConfig(runtimeConfig)) {
    return component.writeRuntimeConfig && Object.keys(runtimeConfig).length > 0
      ? { format: 'frontend-config-js', values: { ...runtimeConfig } }
      : null;
  }
  const spec = runtimeConfig[component.name];
  return isPlainObject(spec) && isPlainObject(spec.values)
    ? { format: spec.format, values: { ...spec.values } }
    : null;
}

function validateTargetComponents(value, path, errors) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'Must be an array or null.' });
    return;
  }
  if (value.length > MAX_COMPONENTS) errors.push({ path, message: `Must contain at most ${MAX_COMPONENTS} item(s).` });
  const names = new Set();
  value.forEach((entry, index) => {
    const entryPath = childPath(path, index);
    if (!isPlainObject(entry)) {
      errors.push({ path: entryPath, message: 'Must be an object.' });
      return;
    }
    errors.push(...unknownKeyErrors(entry, TARGET_COMPONENT_KEYS, entryPath));
    if (typeof entry.name !== 'string' || !COMPONENT_NAME_PATTERN.test(entry.name)) {
      errors.push({ path: childPath(entryPath, 'name'), message: 'Must match ^[a-z][a-z0-9-]{0,31}$.' });
    } else {
      if (names.has(entry.name)) errors.push({ path: childPath(entryPath, 'name'), message: `Duplicate component '${entry.name}'.` });
      names.add(entry.name);
    }
    if (entry.runtime !== undefined) validateRuntime(entry.runtime, childPath(entryPath, 'runtime'), errors, { required: false });
    if (entry.health !== undefined) validateHealth(entry.health, childPath(entryPath, 'health'), errors);
  });
}

/**
 * Validates deploy-target input for create (`partial: false`) or update (`partial: true`).
 * @returns {{ errors: {path: string, message: string}[], value: object }} `value` holds only known, present fields.
 */
function validateTargetInput(input, { partial = false } = {}) {
  if (!isPlainObject(input)) return { errors: [{ path: '', message: 'Must be an object.' }], value: {} };
  const errors = [...unknownKeyErrors(input, TARGET_KEYS, '')];
  const value = {};
  const present = (key) => input[key] !== undefined;

  if (present('name') || !partial) {
    if (typeof input.name !== 'string' || input.name.trim() === '' || input.name.trim().length > 120 || hasControlChars(input.name)) {
      errors.push({ path: 'name', message: 'Must be 1-120 characters.' });
    } else value.name = input.name.trim();
  }
  if (present('agentId') || !partial) {
    if (typeof input.agentId !== 'string' || !AGENT_ID_PATTERN.test(input.agentId)) {
      errors.push({ path: 'agentId', message: 'Must be a valid agent id (^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$).' });
    } else value.agentId = input.agentId;
  }
  if (present('os') || !partial) {
    if (!TARGET_OS_VALUES.includes(input.os)) errors.push({ path: 'os', message: `Must be one of: ${TARGET_OS_VALUES.join(', ')}.` });
    else value.os = input.os;
  }
  if (present('environment')) {
    if (input.environment !== null && input.environment !== '' && !TARGET_ENVIRONMENTS.includes(input.environment)) {
      errors.push({ path: 'environment', message: `Must be one of: ${TARGET_ENVIRONMENTS.join(', ')} (or null).` });
    } else value.environment = input.environment || null;
  }
  if (present('basePath')) {
    if (input.basePath !== null && (typeof input.basePath !== 'string' || input.basePath.length > 500 || hasControlChars(input.basePath))) {
      errors.push({ path: 'basePath', message: 'Must be a string of at most 500 characters (or null).' });
    } else value.basePath = input.basePath || null;
  }
  if (present('components')) {
    validateTargetComponents(input.components, 'components', errors);
    value.components = Array.isArray(input.components) && input.components.length > 0 ? input.components : null;
  }
  if (present('runtimeConfig')) {
    validateRuntimeConfig(input.runtimeConfig, 'runtimeConfig', errors);
    value.runtimeConfig = cloneRuntimeConfig(input.runtimeConfig);
  }
  return { errors, value };
}

/**
 * Production targets require typing the target name to confirm (mirrors
 * validation/prodConfirmation.js, same 400 body shape).
 */
function isProdTarget(target, project) {
  if (target.environment === 'Prod') return true;
  if (!target.environment && project && project.environment === 'Prod') return true;
  return /(^|[^a-z])prod/i.test(String(target.name || ''));
}

function checkTargetConfirmation(target, project, confirmation) {
  if (!isProdTarget(target, project)) return null;
  const provided = typeof confirmation === 'string' ? confirmation.trim() : '';
  if (provided === target.name) return null;
  return {
    error: 'Production targets require typing the target name to confirm.',
    code: 'CONFIRMATION_REQUIRED',
    expected: target.name,
  };
}

// ---------------------------------------------------------------------------
// Artifact selection + 1.2 payload
// ---------------------------------------------------------------------------

/** The artifact `os` a target natively needs. */
function targetArtifactOs(targetOs) {
  return targetOs === 'windows' ? 'win-x64' : 'linux-x64';
}

/**
 * Picks the artifact for one component: the target's own os first, then `any`.
 * A component pinned to a specific os (`component.os`) never falls back.
 * @returns {object|null}
 */
function selectArtifact(artifacts, component, targetOs) {
  const nativeOs = targetArtifactOs(targetOs);
  const candidates = artifacts.filter((artifact) => artifact.component === component.name);
  const acceptable = component.os && component.os !== 'any'
    ? (component.os === nativeOs ? [nativeOs] : [])
    : component.os === 'any' ? ['any'] : [nativeOs, 'any'];
  for (const os of acceptable) {
    const match = candidates.find((artifact) => artifact.os === os);
    if (match) return match;
  }
  return null;
}

/**
 * Effective component definitions for a target: the project's component
 * definitions, restricted to (and overridden by) the target's `components`
 * entries when it has any, then to `requested` names when given.
 * @returns {{ components: object[], errors: string[] }}
 */
function resolveTargetComponents(projectComponents, targetComponents, requested) {
  const errors = [];
  const byName = new Map(projectComponents.map((component) => [component.name, component]));
  let selected = projectComponents;
  const overrides = new Map();

  if (Array.isArray(targetComponents) && targetComponents.length > 0) {
    selected = [];
    for (const entry of targetComponents) {
      const base = byName.get(entry.name);
      if (!base) {
        errors.push(`Target component '${entry.name}' is not defined in the project's artifactDeploy.components.`);
        continue;
      }
      selected.push(base);
      overrides.set(entry.name, entry);
    }
  }

  if (Array.isArray(requested) && requested.length > 0) {
    const allowed = new Map(selected.map((component) => [component.name, component]));
    const picked = [];
    for (const name of requested) {
      if (!allowed.has(name)) errors.push(`Component '${name}' is not deployable on this target.`);
      else if (!picked.includes(allowed.get(name))) picked.push(allowed.get(name));
    }
    selected = picked;
  }

  const components = selected.map((component) => {
    const override = overrides.get(component.name);
    if (!override) return component;
    return {
      ...component,
      runtime: isPlainObject(override.runtime) ? normalizeRuntime(override.runtime) : component.runtime,
      health: Object.prototype.hasOwnProperty.call(override, 'health') ? normalizeHealth(override.health) : component.health,
    };
  });
  if (components.length === 0 && errors.length === 0) errors.push('No components to deploy.');
  return { components, errors };
}

/** Agent-side global timeout: generous base + every health/hook budget. */
function computeDeployTimeoutSec(components) {
  let total = DEPLOY_TIMEOUT_SEC.base;
  for (const component of components) {
    if (component.health) total += component.health.timeoutSec;
    for (const hook of (component.hooks && component.hooks.preStart) || []) total += hook.timeoutSec;
  }
  return Math.min(DEPLOY_TIMEOUT_SEC.max, Math.max(DEPLOY_TIMEOUT_SEC.min, total));
}

function artifactDownloadUrl(publicUrl, artifactId) {
  return `${String(publicUrl).replace(/\/+$/, '')}/api/artifacts/${encodeURIComponent(artifactId)}/download`;
}

/**
 * Builds the `artifact_deploy` payload (contract 1.2). It carries short-lived
 * download tokens and target runtime values, so the agent transport must use WSS.
 *
 * @param {object} args
 * @param {string} args.deployId
 * @param {{ version: string, manifest: { project: string } }} args.release
 * @param {object[]} args.components - effective component definitions.
 * @param {Map<string, object>} args.artifacts - component name → selected artifact row.
 * @param {Map<string, string>} args.tokens - component name → download token.
 * @param {object|null} args.runtimeConfig - target runtime config.
 * @param {string} args.publicUrl - IDP_PUBLIC_URL.
 */
function buildDeployPayload({ deployId, release, components, artifacts, tokens, runtimeConfig, publicUrl }) {
  return {
    deployId,
    project: release.manifest.project,
    version: release.version,
    timeoutSec: computeDeployTimeoutSec(components),
    components: components.map((component) => {
      const artifact = artifacts.get(component.name);
      return {
        name: component.name,
        subdir: component.subdir,
        version: release.version,
        download: {
          url: artifactDownloadUrl(publicUrl, artifact.id),
          token: tokens.get(component.name),
          sha256: artifact.sha256,
          size: artifact.size,
        },
        runtime: { ...component.runtime },
        preserve: [...component.preserve],
        health: component.health ? { ...component.health } : null,
        runtimeConfig: runtimeConfigForComponent(runtimeConfig, component),
        hooks: component.hooks
          ? { preStart: component.hooks.preStart.map((hook) => ({ ...hook, args: [...hook.args], env: { ...hook.env } })) }
          : null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Agent → server message sanitizing
// ---------------------------------------------------------------------------

/** Printable, single-line, length-capped text from an agent message. */
function sanitizeAgentText(value, max = 500) {
  if (value === undefined || value === null) return '';
  // eslint-disable-next-line no-control-regex
  const text = String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/[\r\n]+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sanitizeVersion(value) {
  return typeof value === 'string' && VERSION_PATTERN.test(value) ? value : null;
}

module.exports = {
  VERSION_PATTERN,
  COMPONENT_NAME_PATTERN,
  ARTIFACT_OS_VALUES,
  ARTIFACT_FILE_PATTERN,
  ARTIFACT_NAME_PATTERN,
  SHA256_PATTERN,
  GIT_REF_PATTERN,
  RUNTIME_TYPES,
  SOURCE_PLATFORMS,
  BUILD_PROVIDERS,
  TARGET_OS_VALUES,
  DEPLOY_STAGES,
  DEPLOY_EVENT_STATUSES,
  ARTIFACT_COMMAND_PROCESSES,
  DEFAULT_SOURCE_BASE_URLS,
  HOOK_TIMEOUT_SEC,
  HEALTH_TIMEOUT_SEC,
  MAX_COMPONENTS,
  RUNTIME_CONFIG_FORMATS,
  RUNTIME_CONFIG_KEY_PATTERN,
  MAX_RUNTIME_CONFIG_KEYS,
  MAX_RUNTIME_CONFIG_VALUE_LENGTH,
  MAX_RUNTIME_CONFIG_TOTAL_BYTES,
  isPlainObject,
  isSafePreservePattern,
  isSafeSubdir,
  validateManifest,
  manifestFileName,
  validateArtifactDeployConfig,
  normalizeArtifactDeployConfig,
  findMissingSourceFields,
  resolveSourceCredentials,
  validateTargetInput,
  isLegacyRuntimeConfig,
  runtimeConfigForComponent,
  isProdTarget,
  checkTargetConfirmation,
  targetArtifactOs,
  selectArtifact,
  resolveTargetComponents,
  computeDeployTimeoutSec,
  artifactDownloadUrl,
  buildDeployPayload,
  sanitizeAgentText,
  sanitizeVersion,
};
