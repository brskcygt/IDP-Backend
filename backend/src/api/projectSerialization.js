/**
 * Project serialization for the HTTP API (T-04 / SEC-01).
 *
 * Two directions, both of which exist to keep credentials off the wire:
 *
 *   redactProject()      stored project  →  response safe to send to a browser
 *   mergeProjectConfig() incoming patch  →  config safe to persist
 *
 * Extracted from server.js so it can be imported and tested directly (and so the
 * eventual transport-agnostic core can use it without pulling in Express).
 */
const { getSecretFieldPaths } = require('../secrets/secretRef');

/**
 * Redact a project for API responses: strips plaintext secrets out of
 * config (and nested pmpConfig/vpnConfig/mfaConfig) and replaces each
 * with a `has*` boolean presence flag. Returns a new object — the
 * original `project` (and its nested config objects) is never mutated.
 */
function getAtPath(obj, dottedPath) {
  return dottedPath.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), obj);
}

/** Deletes `dottedPath` from `obj` in place and reports whether it held a value. */
function deleteAtPath(obj, dottedPath) {
  const parts = dottedPath.split('.');
  const leaf = parts.pop();
  const parent = parts.reduce((acc, part) => (acc == null ? acc : acc[part]), obj);
  if (!parent || typeof parent !== 'object') return false;

  const had = Boolean(parent[leaf]);
  delete parent[leaf];
  return had;
}

/** `password` → `hasPassword`, `pmpConfig.authToken` → `pmpConfig.hasAuthToken` */
function presenceFlagPath(dottedPath) {
  const parts = dottedPath.split('.');
  const leaf = parts.pop();
  parts.push(`has${leaf.charAt(0).toUpperCase()}${leaf.slice(1)}`);
  return parts;
}

function setAtPathInPlace(obj, parts, value) {
  const leaf = parts[parts.length - 1];
  const parent = parts.slice(0, -1).reduce((acc, part) => (acc == null ? acc : acc[part]), obj);
  if (parent && typeof parent === 'object') parent[leaf] = value;
}

/**
 * Strip every credential from a project before it goes over the wire, leaving a
 * `has…` boolean so the UI can show "a value is saved" without knowing it.
 *
 * The path list is derived from the config itself, so per-environment overrides
 * (`environments.Prod.password`) are covered the same way base fields are — they
 * used to come back as raw `secret://…` reference strings, which is not a
 * credential leak but is an inconsistency the UI then had to special-case.
 */
function redactProject(project) {
  const cloned = JSON.parse(JSON.stringify(project || {}));
  const config = cloned.config;
  if (!config) return cloned;

  for (const fieldPath of getSecretFieldPaths(config)) {
    const present = Boolean(getAtPath(config, fieldPath));
    deleteAtPath(config, fieldPath);
    if (present || fieldPath.indexOf('.') === -1) {
      setAtPathInPlace(config, presenceFlagPath(fieldPath), present);
    }
  }

  return cloned;
}

/**
 * Merge an incoming settings payload into the stored config without ever
 * clobbering a saved credential with a blank.
 *
 * The client never receives secrets — only `has…` presence flags — so an
 * untouched password field comes back empty. Treating that as "clear it" would
 * silently destroy the credential on every unrelated settings save. A secret is
 * therefore only replaced when the client sends a non-empty value.
 *
 * Secret paths are derived from the configs themselves, so per-environment
 * overrides are protected exactly like base fields. Returns a new object;
 * neither input is mutated.
 */
function mergeProjectConfig(existingConfig, incoming) {
  const existing = existingConfig || {};
  const body = incoming || {};

  const merged = deepMerge(stripPresenceFlags(existing), stripPresenceFlags(body));

  // Union of secret paths on both sides: a path may exist only in the stored
  // config (client omitted it) or only in the incoming one (new environment).
  const paths = new Set([...getSecretFieldPaths(existing), ...getSecretFieldPaths(body)]);

  for (const fieldPath of paths) {
    const incomingValue = getAtPath(body, fieldPath);
    const isReplacement = typeof incomingValue === 'string' && incomingValue.trim() !== '';
    if (isReplacement) continue;

    const existingValue = getAtPath(existing, fieldPath);
    if (existingValue === undefined) {
      deleteAtPath(merged, fieldPath);
    } else {
      setAtPathDeep(merged, fieldPath, existingValue);
    }
  }

  return merged;
}

/** Recursively drop every `has…` presence flag — those are response-only. */
function stripPresenceFlags(value) {
  if (Array.isArray(value)) return value.map(stripPresenceFlags);
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (/^has[A-Z]/.test(key)) continue;
    out[key] = stripPresenceFlags(inner);
  }
  return out;
}

/** Field-level merge so overriding one nested key doesn't drop its siblings. */
function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch ?? base;
  if (!base || typeof base !== 'object' || Array.isArray(base)) return { ...patch };

  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? deepMerge(base[key], value)
      : value;
  }
  return out;
}

/** Sets a dotted path, creating intermediate objects as needed. */
function setAtPathDeep(obj, dottedPath, value) {
  const parts = dottedPath.split('.');
  const leaf = parts.pop();
  let cursor = obj;
  for (const part of parts) {
    if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[leaf] = value;
}

module.exports = { redactProject, mergeProjectConfig };
