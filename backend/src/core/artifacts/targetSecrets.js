'use strict';

const crypto = require('node:crypto');
const { makeRef, isRef } = require('../../secrets/secretRef');
const { ValidationError } = require('../errors');
const { isPlainObject, isLegacyRuntimeConfig } = require('./contracts');

function collectRefs(value, refs = new Set()) {
  if (isRef(value)) refs.add(value);
  else if (isPlainObject(value)) Object.values(value).forEach((entry) => collectRefs(entry, refs));
  return refs;
}

function containsEnvFile(runtimeConfig) {
  return isPlainObject(runtimeConfig) && !isLegacyRuntimeConfig(runtimeConfig) && Object.values(runtimeConfig)
    .some((spec) => isPlainObject(spec) && spec.format === 'env-file' && isPlainObject(spec.values) && Object.keys(spec.values).length > 0);
}

async function persistTargetRuntimeConfig(targetId, runtimeConfig, store, { requireEncryption = false } = {}) {
  if (!store) {
    if (requireEncryption && containsEnvFile(runtimeConfig)) {
      throw new ValidationError('IDP_SECRET_KEY is required before production .env runtime config can be saved.');
    }
    return { runtimeConfig, createdRefs: [] };
  }
  if (!isPlainObject(runtimeConfig)) return { runtimeConfig, createdRefs: [] };
  const generation = crypto.randomBytes(8).toString('hex');
  const createdRefs = [];

  async function protect(values, scope) {
    const protectedValues = {};
    for (const [key, value] of Object.entries(values)) {
      // Request values are always plaintext. A value that merely looks like
      // secret://... must not be allowed to reference another stored secret.
      const ref = makeRef(`target-${targetId}`, `runtimeConfig.${generation}.${scope}.${key}`);
      await store.set(ref, value);
      createdRefs.push(ref);
      protectedValues[key] = ref;
    }
    return protectedValues;
  }

  try {
    if (isLegacyRuntimeConfig(runtimeConfig)) {
      return { runtimeConfig: await protect(runtimeConfig, 'legacy'), createdRefs };
    }
    const protectedConfig = {};
    for (const [component, spec] of Object.entries(runtimeConfig)) {
      protectedConfig[component] = { format: spec.format, values: await protect(spec.values, component) };
    }
    return { runtimeConfig: protectedConfig, createdRefs };
  } catch (err) {
    await Promise.all(createdRefs.map((ref) => store.delete(ref).catch(() => false)));
    throw err;
  }
}

async function resolveTargetRuntimeConfig(runtimeConfig, store, { requireEncryption = false } = {}) {
  if (!isPlainObject(runtimeConfig)) return runtimeConfig;
  if (requireEncryption && containsEnvFile(runtimeConfig)) {
    const hasPlaintext = Object.values(runtimeConfig).some((spec) => (
      isPlainObject(spec)
      && spec.format === 'env-file'
      && isPlainObject(spec.values)
      && Object.values(spec.values).some((value) => !isRef(value))
    ));
    if (hasPlaintext) {
      throw new ValidationError('Production .env runtime config contains plaintext storage values. Re-save the target with IDP_SECRET_KEY configured.');
    }
  }
  if (!store) {
    if (collectRefs(runtimeConfig).size > 0) {
      throw new Error('Encrypted target runtime config cannot be resolved because IDP_SECRET_KEY is unavailable.');
    }
    return runtimeConfig;
  }

  async function reveal(values) {
    const plaintext = {};
    for (const [key, value] of Object.entries(values)) {
      if (!isRef(value)) {
        plaintext[key] = value;
        continue;
      }
      const resolved = await store.get(value);
      if (resolved === null) throw new Error(`Stored runtime config is missing for '${key}'. Re-save the deploy target.`);
      plaintext[key] = resolved;
    }
    return plaintext;
  }

  if (Object.values(runtimeConfig).every((value) => typeof value === 'string')) return reveal(runtimeConfig);
  const resolved = {};
  for (const [component, spec] of Object.entries(runtimeConfig)) {
    resolved[component] = { format: spec.format, values: await reveal(spec.values) };
  }
  return resolved;
}

async function resolveTargetSecrets(target, store, options = {}) {
  if (!target) return target;
  return { ...target, runtimeConfig: await resolveTargetRuntimeConfig(target.runtimeConfig, store, options) };
}

function redactTargetRuntimeConfig(runtimeConfig) {
  if (!isPlainObject(runtimeConfig)) return runtimeConfig;
  if (Object.values(runtimeConfig).every((value) => typeof value === 'string')) {
    return Object.fromEntries(Object.keys(runtimeConfig).map((key) => [key, '[stored]']));
  }
  return Object.fromEntries(Object.entries(runtimeConfig).map(([component, spec]) => [component, {
    format: spec.format,
    values: Object.fromEntries(Object.keys(spec.values || {}).map((key) => [key, '[stored]'])),
  }]));
}

async function deleteRefs(refs, store) {
  if (!store) return;
  await Promise.all([...refs].map((ref) => store.delete(ref)));
}

async function discardCreatedTargetSecrets(createdRefs, store) {
  await deleteRefs(new Set(createdRefs), store);
}

async function deleteReplacedTargetSecrets(previousRuntimeConfig, nextRuntimeConfig, store) {
  const next = collectRefs(nextRuntimeConfig);
  await deleteRefs(new Set([...collectRefs(previousRuntimeConfig)].filter((ref) => !next.has(ref))), store);
}

async function deleteTargetSecrets(runtimeConfig, store) {
  await deleteRefs(collectRefs(runtimeConfig), store);
}

module.exports = {
  collectRefs,
  persistTargetRuntimeConfig,
  resolveTargetRuntimeConfig,
  resolveTargetSecrets,
  redactTargetRuntimeConfig,
  discardCreatedTargetSecrets,
  deleteReplacedTargetSecrets,
  deleteTargetSecrets,
};
