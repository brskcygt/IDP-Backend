/**
 * Regression tests for the PMP declarative step interpreter (SEC-03 / T-12).
 *
 * These guard the RCE fix: `PmpWebAdapter` used to run project-settings text
 * through `new Function('page', 'log', scriptContent)`, giving anyone who
 * could edit a project's settings arbitrary Node.js execution on the
 * backend. It has been replaced with a whitelisted JSON step list
 * (stepSchema.validateSteps) executed by StepRunner.runSteps — no eval, no
 * Function constructor, no real Playwright/browser involved here at all.
 *
 * Run with: npm test
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { validateSteps, MAX_STEPS, MAX_SELECTOR_LENGTH } = require('../src/adapters/pmp/stepSchema');
const { runSteps } = require('../src/adapters/pmp/StepRunner');

const REAL_PASSWORD = 'REAL_SECRET_PASSWORD_123';

/** A fake Playwright `page` — no browser, no I/O, just call recording. */
function createMockPage(overrides = {}) {
  const calls = [];
  return {
    calls,
    goto: async (url, opts) => { calls.push({ op: 'goto', url, opts }); },
    fill: async (selector, value) => { calls.push({ op: 'fill', selector, value }); },
    click: async (selector) => { calls.push({ op: 'click', selector }); },
    waitForSelector: async (selector, opts) => { calls.push({ op: 'waitForSelector', selector, opts }); },
    waitForLoadState: async (state, opts) => { calls.push({ op: 'waitForLoadState', state, opts }); },
    selectOption: async (selector, value) => { calls.push({ op: 'selectOption', selector, value }); },
    waitForTimeout: async (ms) => { calls.push({ op: 'waitForTimeout', ms }); },
    $: async (selector) => {
      calls.push({ op: '$', selector });
      return overrides.elementText === undefined
        ? { textContent: async () => 'Deployment Successful' }
        : overrides.elementText === null
          ? null
          : { textContent: async () => overrides.elementText };
    },
    ...overrides.methods,
  };
}

function collectLogs() {
  const lines = [];
  return { lines, log: (message) => lines.push(message) };
}

// ─── validateSteps ───────────────────────────────────────────────────────

test('validateSteps accepts a well-formed step list covering every action', () => {
  const steps = [
    { action: 'goto', url: 'https://portal.example.com/login' },
    { action: 'fill', selector: '#username', value: '{{username}}' },
    { action: 'fill', selector: '#password', value: '{{password}}' },
    { action: 'click', selector: 'button[type="submit"]' },
    { action: 'waitFor', selector: '#dashboard', timeoutMs: 5000 },
    { action: 'waitForNavigation', timeoutMs: 10000 },
    { action: 'select', selector: '#env', value: '{{environment}}' },
    { action: 'assertText', selector: '.status', contains: 'Success' },
    { action: 'wait', ms: 500 },
    { action: 'screenshot', name: 'after-deploy' },
  ];

  const { valid, errors } = validateSteps(steps);
  assert.equal(valid, true, `expected no errors, got: ${errors.join('; ')}`);
  assert.deepEqual(errors, []);
});

test('validateSteps rejects an unknown action', () => {
  const { valid, errors } = validateSteps([{ action: 'evalScript', code: 'require("fs")' }]);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('unknown action')));
});

test('validateSteps rejects a non-array payload', () => {
  const { valid, errors } = validateSteps('not-an-array');
  assert.equal(valid, false);
  assert.ok(errors.length > 0);
});

test('validateSteps rejects javascript: URLs', () => {
  const { valid, errors } = validateSteps([{ action: 'goto', url: 'javascript:alert(document.cookie)' }]);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('scheme')));
});

test('validateSteps rejects file: URLs', () => {
  const { valid, errors } = validateSteps([{ action: 'goto', url: 'file:///etc/passwd' }]);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('scheme')));
});

test('validateSteps rejects data: URLs', () => {
  const { valid, errors } = validateSteps([{ action: 'goto', url: 'data:text/html,<script>alert(1)</script>' }]);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('scheme')));
});

test('validateSteps accepts http: and https: URLs', () => {
  assert.equal(validateSteps([{ action: 'goto', url: 'http://portal.internal/login' }]).valid, true);
  assert.equal(validateSteps([{ action: 'goto', url: 'https://portal.internal/login' }]).valid, true);
});

test('validateSteps enforces the selector length limit', () => {
  const longSelector = `#${'a'.repeat(MAX_SELECTOR_LENGTH)}`; // 1 over the limit
  const { valid, errors } = validateSteps([{ action: 'click', selector: longSelector }]);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('exceeds') && e.includes('characters')));
});

test('validateSteps accepts a selector right at the length limit', () => {
  const selector = `#${'a'.repeat(MAX_SELECTOR_LENGTH - 1)}`; // exactly MAX_SELECTOR_LENGTH chars
  assert.equal(selector.length, MAX_SELECTOR_LENGTH);
  const { valid } = validateSteps([{ action: 'click', selector }]);
  assert.equal(valid, true);
});

test('validateSteps rejects a selector that is missing or not a string', () => {
  assert.equal(validateSteps([{ action: 'click' }]).valid, false);
  assert.equal(validateSteps([{ action: 'click', selector: 123 }]).valid, false);
});

test('validateSteps enforces the step count limit', () => {
  const tooMany = Array.from({ length: MAX_STEPS + 1 }, () => ({ action: 'wait', ms: 1 }));
  const { valid, errors } = validateSteps(tooMany);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes(`maximum of ${MAX_STEPS}`)));
});

test('validateSteps accepts exactly the maximum step count', () => {
  const maxed = Array.from({ length: MAX_STEPS }, () => ({ action: 'wait', ms: 1 }));
  assert.equal(validateSteps(maxed).valid, true);
});

test('validateSteps rejects an unknown template variable', () => {
  const { valid, errors } = validateSteps([
    { action: 'fill', selector: '#x', value: '{{process.env.SECRET}}' },
  ]);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('unknown template variable')));
});

test('validateSteps accepts the three whitelisted template variables', () => {
  const { valid } = validateSteps([
    { action: 'fill', selector: '#a', value: '{{username}}' },
    { action: 'fill', selector: '#b', value: '{{password}}' },
    { action: 'select', selector: '#c', value: '{{environment}}' },
  ]);
  assert.equal(valid, true);
});

test('validateSteps rejects a "wait" step over the 30000ms ceiling', () => {
  assert.equal(validateSteps([{ action: 'wait', ms: 30001 }]).valid, false);
  assert.equal(validateSteps([{ action: 'wait', ms: 30000 }]).valid, true);
});

test('validateSteps requires "contains" on assertText', () => {
  assert.equal(validateSteps([{ action: 'assertText', selector: '.x' }]).valid, false);
});

test('validateSteps requires "name" on screenshot', () => {
  assert.equal(validateSteps([{ action: 'screenshot' }]).valid, false);
  assert.equal(validateSteps([{ action: 'screenshot', name: 'ok' }]).valid, true);
});

// ─── runSteps: template interpolation ───────────────────────────────────

test('runSteps substitutes {{username}}, {{password}}, {{environment}} at run time', async () => {
  const page = createMockPage();
  const { log } = collectLogs();
  const steps = [
    { action: 'fill', selector: '#user', value: '{{username}}' },
    { action: 'fill', selector: '#pass', value: '{{password}}' },
    { action: 'select', selector: '#env', value: 'target-{{environment}}' },
  ];

  await runSteps(page, steps, { username: 'alice', password: REAL_PASSWORD, environment: 'Prod' }, log);

  const fillUser = page.calls.find((c) => c.op === 'fill' && c.selector === '#user');
  const fillPass = page.calls.find((c) => c.op === 'fill' && c.selector === '#pass');
  const select = page.calls.find((c) => c.op === 'selectOption');

  assert.equal(fillUser.value, 'alice');
  assert.equal(fillPass.value, REAL_PASSWORD);
  assert.equal(select.value, 'target-Prod');
});

test('runSteps leaves unresolved context values as empty string', async () => {
  const page = createMockPage();
  const { log } = collectLogs();
  await runSteps(page, [{ action: 'fill', selector: '#x', value: '{{environment}}' }], {}, log);
  const fill = page.calls.find((c) => c.op === 'fill');
  assert.equal(fill.value, '');
});

// ─── runSteps: password never logged (CRITICAL) ─────────────────────────

test('runSteps never writes the real password to the log, even redacted-token-only', async () => {
  const page = createMockPage();
  const { lines, log } = collectLogs();
  const steps = [{ action: 'fill', selector: '#password', value: '{{password}}' }];

  await runSteps(page, steps, { username: 'alice', password: REAL_PASSWORD, environment: 'Prod' }, log);

  const allLogText = lines.join('\n');
  assert.ok(!allLogText.includes(REAL_PASSWORD), 'password leaked into log output');
  assert.ok(allLogText.includes('••••'), 'expected redaction marker in log output');
});

test('runSteps redacts a value that mixes {{password}} with other literal text', async () => {
  const page = createMockPage();
  const { lines, log } = collectLogs();
  const steps = [{ action: 'fill', selector: '#password', value: `pwd=${'{{password}}'}` }];

  await runSteps(page, steps, { username: 'alice', password: REAL_PASSWORD, environment: 'Prod' }, log);

  const allLogText = lines.join('\n');
  assert.ok(!allLogText.includes(REAL_PASSWORD), 'password leaked into log output via mixed value');
});

test('runSteps does not redact values that do not reference {{password}}', async () => {
  const page = createMockPage();
  const { lines, log } = collectLogs();
  const steps = [{ action: 'fill', selector: '#user', value: '{{username}}' }];

  await runSteps(page, steps, { username: 'alice', password: REAL_PASSWORD, environment: 'Prod' }, log);

  const allLogText = lines.join('\n');
  assert.ok(allLogText.includes('{{username}}'), 'non-secret field should be logged as-is');
});

// ─── runSteps: failure reporting ────────────────────────────────────────

test('runSteps throws a descriptive error identifying the failing step', async () => {
  const page = createMockPage();
  page.click = async () => { throw new Error('element not visible'); };
  const { log } = collectLogs();

  const steps = [
    { action: 'goto', url: 'https://portal.example.com' },
    { action: 'click', selector: '#deploy-button' },
  ];

  await assert.rejects(
    () => runSteps(page, steps, {}, log),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('step 2'), `expected step number in message: ${err.message}`);
      assert.ok(err.message.includes('click'), `expected action in message: ${err.message}`);
      assert.ok(err.message.includes('#deploy-button'), `expected selector in message: ${err.message}`);
      assert.ok(err.message.includes('element not visible'), `expected root cause in message: ${err.message}`);
      return true;
    }
  );
});

test('runSteps assertText fails clearly when the text does not match', async () => {
  const page = createMockPage({ elementText: 'Deployment Failed' });
  const { log } = collectLogs();
  const steps = [{ action: 'assertText', selector: '.status', contains: 'Success' }];

  await assert.rejects(() => runSteps(page, steps, {}, log));
});

test('runSteps assertText fails clearly when the element is missing', async () => {
  const page = createMockPage({ elementText: null });
  const { log } = collectLogs();
  const steps = [{ action: 'assertText', selector: '.missing', contains: 'Success' }];

  await assert.rejects(() => runSteps(page, steps, {}, log));
});
