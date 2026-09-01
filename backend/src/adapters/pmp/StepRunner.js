'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { TEMPLATE_VARS } = require('./stepSchema');

/**
 * StepRunner.js — executes a validated, whitelisted list of PMP automation
 * steps (see stepSchema.js) against a live Playwright `page`.
 *
 * SECURITY (SEC-03/T-12): this is the ONLY file in the PMP adapter allowed
 * to touch the Playwright API. Step objects are plain, schema-validated
 * data — never executable code — so there is no `new Function`, `eval`, or
 * any other dynamic-code-execution path anywhere in this module.
 */

const REDACTED_LOG_VALUE = '••••';

// SECURITY (SEC-18, mirrors PmpWebAdapter): step screenshots can capture
// portal content, so they get the same age-based purge as error screenshots
// rather than accumulating forever.
const SCREENSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SCREENSHOT_DIR = path.resolve(__dirname, '..', '..', '..', 'public', 'errors');

/**
 * Replace `{{username}}` / `{{password}}` / `{{environment}}` tokens with
 * values from `context`. stepSchema.validateSteps() has already rejected
 * any token that isn't one of TEMPLATE_VARS, so nothing else is ever
 * substituted here.
 */
function interpolate(value, context) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{\s*([^}]*)\s*\}\}/g, (match, rawName) => {
    const name = rawName.trim();
    if (!TEMPLATE_VARS.includes(name)) return match;
    const resolved = context ? context[name] : undefined;
    return resolved === undefined || resolved === null ? '' : String(resolved);
  });
}

/**
 * Render a raw (pre-interpolation) field value for logging. Never reveals a
 * password: any value containing the `{{password}}` token — even mixed
 * with other literal text — is logged as a redacted placeholder instead.
 */
function safeLogValue(rawValue) {
  if (typeof rawValue !== 'string') return String(rawValue);
  return rawValue.includes('{{password}}') ? REDACTED_LOG_VALUE : rawValue;
}

function describeStep(step) {
  const bits = [step.action];
  if (step.url) bits.push(`url=${step.url}`);
  if (step.selector) bits.push(`selector=${step.selector}`);
  if (step.value !== undefined) bits.push(`value=${safeLogValue(step.value)}`);
  if (step.contains) bits.push(`contains=${step.contains}`);
  if (step.name) bits.push(`name=${step.name}`);
  if (step.ms !== undefined) bits.push(`ms=${step.ms}`);
  return bits.join(' ');
}

async function purgeOldScreenshots() {
  let entries;
  try {
    entries = await fs.promises.readdir(SCREENSHOT_DIR);
  } catch {
    return; // directory missing or unreadable — nothing to purge
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.endsWith('.png')) continue;
    const entryPath = path.join(SCREENSHOT_DIR, entry);
    try {
      const stats = await fs.promises.stat(entryPath);
      if (now - stats.mtimeMs > SCREENSHOT_MAX_AGE_MS) {
        await fs.promises.unlink(entryPath);
      }
    } catch {
      // Removed concurrently, or stat/unlink failed — skip it.
    }
  }
}

async function takeStepScreenshot(page, name) {
  await fs.promises.mkdir(SCREENSHOT_DIR, { recursive: true });
  await purgeOldScreenshots();
  const safeName = String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'step';
  const filename = `pmp_step_${safeName}_${crypto.randomUUID()}.png`;
  const filepath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  return filepath;
}

/** Execute a single already-validated step against `page`. */
async function runStep(page, step, context) {
  switch (step.action) {
    case 'goto':
      await page.goto(step.url, { waitUntil: 'networkidle' });
      return;
    case 'fill':
      await page.fill(step.selector, interpolate(step.value, context));
      return;
    case 'click':
      await page.click(step.selector);
      return;
    case 'waitFor':
      await page.waitForSelector(step.selector, step.timeoutMs ? { timeout: step.timeoutMs } : undefined);
      return;
    case 'waitForNavigation':
      await page.waitForLoadState('networkidle', step.timeoutMs ? { timeout: step.timeoutMs } : undefined);
      return;
    case 'select':
      await page.selectOption(step.selector, interpolate(step.value, context));
      return;
    case 'assertText': {
      const element = await page.$(step.selector);
      const text = element ? await element.textContent() : null;
      if (!text || !text.includes(step.contains)) {
        throw new Error(`expected text containing "${step.contains}", found "${text || ''}"`);
      }
      return;
    }
    case 'screenshot':
      await takeStepScreenshot(page, step.name);
      return;
    case 'wait':
      await page.waitForTimeout(step.ms);
      return;
    default:
      // Unreachable when `steps` was validated via stepSchema.validateSteps()
      // first, which is a hard requirement of every caller.
      throw new Error(`unsupported action "${step.action}"`);
  }
}

/**
 * Run a validated step list in order. Steps MUST already have passed
 * `stepSchema.validateSteps()` — this function trusts its input.
 *
 * @param {import('playwright').Page} page
 * @param {Array<object>} steps
 * @param {{ username?: string, password?: string, environment?: string }} context
 * @param {(message: string) => void} log
 */
async function runSteps(page, steps, context, log) {
  const safeContext = context || {};

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const stepNumber = index + 1;

    log(`Step ${stepNumber}/${steps.length}: ${describeStep(step)}`);

    try {
      await runStep(page, step, safeContext);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const selectorInfo = step.selector ? `, selector="${step.selector}"` : '';
      throw new Error(
        `PMP step ${stepNumber} failed (action="${step.action}"${selectorInfo}): ${reason}`
      );
    }

    log(`✓ Step ${stepNumber} completed.`);
  }
}

module.exports = { runSteps };
