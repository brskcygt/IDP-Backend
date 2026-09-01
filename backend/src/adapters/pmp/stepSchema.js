'use strict';

/**
 * stepSchema.js — whitelisted step definitions for the PMP declarative step
 * interpreter (SEC-03 / T-12).
 *
 * Replaces free-form `new Function(...)` execution of user-supplied
 * Playwright scripts with a JSON step list that is validated here before it
 * is ever handed to StepRunner.js. Nothing in this file executes code —
 * `validateSteps()` only inspects plain data and returns a list of errors.
 */

const MAX_STEPS = 100;
const MAX_SELECTOR_LENGTH = 500;
const MAX_WAIT_MS = 30000;

/** The only names usable inside a `{{name}}` template placeholder. */
const TEMPLATE_VARS = ['username', 'password', 'environment'];

/** Matches any `{{...}}` occurrence so each one can be checked against TEMPLATE_VARS. */
const TEMPLATE_TOKEN_RE = /\{\{\s*([^}]*)\s*\}\}/g;

const ALLOWED_URL_PROTOCOLS = ['http:', 'https:'];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Verify every `{{...}}` token found in `value` is one of TEMPLATE_VARS.
 * Any other interpolation-looking token (e.g. `{{process.env.SECRET}}`,
 * `{{constructor}}`) is rejected outright — there is no fallback evaluation
 * path, so an unrecognized token can only ever be a validation error.
 */
function validateTemplateTokens(value, fieldPath, errors) {
  if (typeof value !== 'string') return;
  for (const match of value.matchAll(TEMPLATE_TOKEN_RE)) {
    const name = match[1].trim();
    if (!TEMPLATE_VARS.includes(name)) {
      errors.push(
        `${fieldPath}: unknown template variable "{{${match[1]}}}" (allowed: ${TEMPLATE_VARS.map((v) => `{{${v}}}`).join(', ')})`
      );
    }
  }
}

function validateSelector(selector, fieldPath, errors) {
  if (!isNonEmptyString(selector)) {
    errors.push(`${fieldPath}: "selector" is required and must be a non-empty string`);
    return;
  }
  if (selector.length > MAX_SELECTOR_LENGTH) {
    errors.push(`${fieldPath}: "selector" exceeds ${MAX_SELECTOR_LENGTH} characters`);
  }
}

function validateUrl(url, fieldPath, errors) {
  if (!isNonEmptyString(url)) {
    errors.push(`${fieldPath}: "url" is required and must be a non-empty string`);
    return;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    errors.push(`${fieldPath}: "url" is not a valid URL`);
    return;
  }
  if (!ALLOWED_URL_PROTOCOLS.includes(parsed.protocol)) {
    errors.push(`${fieldPath}: "url" scheme "${parsed.protocol}" is not allowed (only http:/https:)`);
  }
}

function validateValueField(value, fieldPath, errors) {
  if (typeof value !== 'string') {
    errors.push(`${fieldPath}: "value" is required and must be a string`);
    return;
  }
  validateTemplateTokens(value, fieldPath, errors);
}

function validateTimeoutMs(timeoutMs, fieldPath, errors) {
  if (timeoutMs === undefined) return;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    errors.push(`${fieldPath}: "timeoutMs" must be a positive number`);
    return;
  }
  if (timeoutMs > MAX_WAIT_MS) {
    errors.push(`${fieldPath}: "timeoutMs" exceeds the ${MAX_WAIT_MS}ms limit`);
  }
}

/** One validator per whitelisted action. The action name IS the whitelist. */
const STEP_VALIDATORS = {
  goto(step, fieldPath, errors) {
    validateUrl(step.url, fieldPath, errors);
  },
  fill(step, fieldPath, errors) {
    validateSelector(step.selector, fieldPath, errors);
    validateValueField(step.value, fieldPath, errors);
  },
  click(step, fieldPath, errors) {
    validateSelector(step.selector, fieldPath, errors);
  },
  waitFor(step, fieldPath, errors) {
    validateSelector(step.selector, fieldPath, errors);
    validateTimeoutMs(step.timeoutMs, fieldPath, errors);
  },
  waitForNavigation(step, fieldPath, errors) {
    validateTimeoutMs(step.timeoutMs, fieldPath, errors);
  },
  select(step, fieldPath, errors) {
    validateSelector(step.selector, fieldPath, errors);
    validateValueField(step.value, fieldPath, errors);
  },
  assertText(step, fieldPath, errors) {
    validateSelector(step.selector, fieldPath, errors);
    if (typeof step.contains !== 'string' || step.contains.length === 0) {
      errors.push(`${fieldPath}: "contains" is required and must be a non-empty string`);
    }
  },
  screenshot(step, fieldPath, errors) {
    if (!isNonEmptyString(step.name)) {
      errors.push(`${fieldPath}: "name" is required and must be a non-empty string`);
    }
  },
  wait(step, fieldPath, errors) {
    if (typeof step.ms !== 'number' || !Number.isFinite(step.ms) || step.ms < 0) {
      errors.push(`${fieldPath}: "ms" must be a non-negative number`);
      return;
    }
    if (step.ms > MAX_WAIT_MS) {
      errors.push(`${fieldPath}: "ms" exceeds the ${MAX_WAIT_MS}ms limit`);
    }
  },
};

const SUPPORTED_ACTIONS = Object.keys(STEP_VALIDATORS);

/**
 * Validate a full step list before it is ever passed to StepRunner.runSteps().
 * @param {unknown} steps
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateSteps(steps) {
  const errors = [];

  if (!Array.isArray(steps)) {
    return { valid: false, errors: ['"steps" must be an array'] };
  }

  if (steps.length > MAX_STEPS) {
    errors.push(`"steps" exceeds the maximum of ${MAX_STEPS} steps (got ${steps.length})`);
  }

  steps.forEach((step, index) => {
    const fieldPath = `steps[${index}]`;

    if (!isPlainObject(step)) {
      errors.push(`${fieldPath}: step must be an object`);
      return;
    }

    const { action } = step;
    if (!isNonEmptyString(action) || !STEP_VALIDATORS[action]) {
      errors.push(`${fieldPath}: unknown action "${action}" (supported: ${SUPPORTED_ACTIONS.join(', ')})`);
      return;
    }

    STEP_VALIDATORS[action](step, fieldPath, errors);
  });

  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateSteps,
  SUPPORTED_ACTIONS,
  TEMPLATE_VARS,
  MAX_STEPS,
  MAX_SELECTOR_LENGTH,
  MAX_WAIT_MS,
};
