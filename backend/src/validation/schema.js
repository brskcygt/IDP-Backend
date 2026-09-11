'use strict';

/**
 * Minimal, dependency-free schema validator (T-20 / SEC-15).
 *
 * The project deliberately avoids third-party validation libraries (zod,
 * joi, ajv) to keep the dependency surface small for Electron packaging.
 * This module is the whole replacement: a handful of rule builders
 * (`string`/`number`/`boolean`/`object`/`array`/`optional`) plus a single
 * recursive `validate(value, rule)` that walks a rule tree and returns a
 * structured result instead of throwing.
 *
 * No `eval`/`new Function` anywhere in this file, by design.
 *
 * Every builder returns a plain, JSON-serializable "rule" object — never a
 * class instance and never a closure — so rules can be composed, spread,
 * and reused freely (see projectSchemas.js, which reuses the same field
 * rules both for a project's base config and for each `environments.*`
 * override).
 */

/**
 * @typedef {{ path: string, message: string }} ValidationError
 * @typedef {{ valid: boolean, value: *, errors: ValidationError[] }} ValidationResult
 */

/** Builds a child path: '' + 'name' -> 'name'; 'a' + 'b' -> 'a.b'. */
function childPath(base, key) {
  return base ? `${base}.${key}` : String(key);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Rule builders
// ---------------------------------------------------------------------------

/** @param {{min?: number, max?: number, pattern?: RegExp, enum?: string[], allowEmpty?: boolean}} [opts] */
function string(opts = {}) {
  return { type: 'string', required: true, ...opts };
}

/** @param {{min?: number, max?: number, integer?: boolean}} [opts] */
function number(opts = {}) {
  return { type: 'number', required: true, ...opts };
}

function boolean() {
  return { type: 'boolean', required: true };
}

/** @param {{fields?: Record<string, object>, allowUnknown?: boolean}} [opts] */
function object(opts = {}) {
  return { type: 'object', required: true, fields: {}, allowUnknown: false, ...opts };
}

/** @param {{of?: object, max?: number}} [opts] */
function array(opts = {}) {
  return { type: 'array', required: true, ...opts };
}

/** Wraps any rule so a missing/undefined value is accepted (skips checks). */
function optional(rule) {
  return { ...rule, required: false };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * @param {*} value
 * @param {object} rule - built with string()/number()/boolean()/object()/array()/optional().
 * @param {string} [path] - dotted path prefix for nested error reporting.
 * @returns {ValidationResult}
 */
function validate(value, rule, path = '') {
  if (!rule || typeof rule.type !== 'string') {
    throw new Error('validate() requires a rule built with string()/number()/boolean()/object()/array().');
  }

  if (value === undefined) {
    if (rule.required === false) {
      return { valid: true, value: undefined, errors: [] };
    }
    return { valid: false, value: undefined, errors: [{ path, message: 'This field is required.' }] };
  }

  switch (rule.type) {
    case 'string':
      return validateString(value, rule, path);
    case 'number':
      return validateNumber(value, rule, path);
    case 'boolean':
      return validateBoolean(value, rule, path);
    case 'object':
      return validateObject(value, rule, path);
    case 'array':
      return validateArray(value, rule, path);
    default:
      throw new Error(`validate(): unknown rule type "${rule.type}"`);
  }
}

function validateString(value, rule, path) {
  const errors = [];
  if (typeof value !== 'string') {
    return { valid: false, value, errors: [{ path, message: 'Must be a string.' }] };
  }
  if (typeof rule.min === 'number' && value.length < rule.min) {
    errors.push({ path, message: `Must be at least ${rule.min} character(s).` });
  }
  if (typeof rule.max === 'number' && value.length > rule.max) {
    errors.push({ path, message: `Must be at most ${rule.max} character(s).` });
  }
  if (rule.pattern instanceof RegExp && value !== '' && !rule.pattern.test(value)) {
    errors.push({ path, message: 'Does not match the required format.' });
  }
  // `allowEmpty`: a cleared <select> arrives as '' and means "unset".
  if (Array.isArray(rule.enum) && !(rule.allowEmpty && value === '') && !rule.enum.includes(value)) {
    errors.push({ path, message: `Must be one of: ${rule.enum.join(', ')}.` });
  }
  return { valid: errors.length === 0, value, errors };
}

/**
 * Numbers frequently arrive as numeric strings from HTML form inputs (e.g.
 * a project's `config.port` is persisted and sent as `"22"`, never `22`,
 * throughout this codebase — see projects.example.json / project.ts). This
 * accepts both a real JS number and a string that parses cleanly to a
 * finite number, validates the parsed magnitude, but returns the ORIGINAL
 * value unchanged (never coerces the stored type) so downstream code that
 * already handles `pCfg.port` as a string keeps working unmodified.
 */
function validateNumber(value, rule, path) {
  const errors = [];
  let numeric;
  if (typeof value === 'number') {
    numeric = value;
  } else if (typeof value === 'string' && value.trim() !== '' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    numeric = Number(value.trim());
  } else {
    return { valid: false, value, errors: [{ path, message: 'Must be a number.' }] };
  }

  if (!Number.isFinite(numeric)) {
    return { valid: false, value, errors: [{ path, message: 'Must be a finite number.' }] };
  }
  if (rule.integer && !Number.isInteger(numeric)) {
    errors.push({ path, message: 'Must be an integer.' });
  }
  if (typeof rule.min === 'number' && numeric < rule.min) {
    errors.push({ path, message: `Must be at least ${rule.min}.` });
  }
  if (typeof rule.max === 'number' && numeric > rule.max) {
    errors.push({ path, message: `Must be at most ${rule.max}.` });
  }
  return { valid: errors.length === 0, value, errors };
}

function validateBoolean(value, rule, path) {
  if (typeof value !== 'boolean') {
    return { valid: false, value, errors: [{ path, message: 'Must be a boolean.' }] };
  }
  return { valid: true, value, errors: [] };
}

function validateObject(value, rule, path) {
  if (!isPlainObject(value)) {
    return { valid: false, value, errors: [{ path, message: 'Must be an object.' }] };
  }

  const fields = rule.fields || {};
  const errors = [];
  const outValue = {};

  for (const [key, fieldRule] of Object.entries(fields)) {
    const fieldPath = childPath(path, key);
    const result = validate(value[key], fieldRule, fieldPath);
    if (!result.valid) {
      errors.push(...result.errors);
    }
    if (result.value !== undefined) {
      outValue[key] = result.value;
    }
  }

  for (const key of Object.keys(value)) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) continue;
    if (rule.allowUnknown) {
      outValue[key] = value[key];
    } else {
      errors.push({ path: childPath(path, key), message: `Unknown field "${key}" is not allowed.` });
    }
  }

  return { valid: errors.length === 0, value: outValue, errors };
}

function validateArray(value, rule, path) {
  if (!Array.isArray(value)) {
    return { valid: false, value, errors: [{ path, message: 'Must be an array.' }] };
  }

  const errors = [];
  if (typeof rule.max === 'number' && value.length > rule.max) {
    errors.push({ path, message: `Must contain at most ${rule.max} item(s).` });
  }

  const outValue = [];
  if (rule.of) {
    value.forEach((item, index) => {
      const result = validate(item, rule.of, childPath(path, index));
      if (!result.valid) errors.push(...result.errors);
      outValue.push(result.value);
    });
  } else {
    outValue.push(...value);
  }

  return { valid: errors.length === 0, value: outValue, errors };
}

module.exports = { string, number, boolean, object, array, optional, validate };
