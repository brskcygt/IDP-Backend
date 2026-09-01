/**
 * Regression tests for the Prod deploy confirmation gate (T-51).
 *
 * Two layers:
 *  1. Direct unit tests of `checkProdConfirmation()` — the actual function
 *     wired into POST /api/deploy/trigger in server.js.
 *  2. A thin HTTP-level check that mounts that exact same function (and the
 *     same deployTriggerSchema validation it sits behind) on a real,
 *     ephemeral-port Express server, so the "-> 400 with this exact body"
 *     half of the contract is verified over real HTTP, not just in-process
 *     function calls. server.js itself is never imported here — it starts
 *     listening on the configured PORT as an import side effect, which
 *     would collide with a real dev server already running on that port;
 *     this test instead builds the minimal slice of routing server.js uses
 *     (validate() + checkProdConfirmation()), so the exact production
 *     modules are exercised without that collision risk.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');

const { checkProdConfirmation } = require('../src/validation/prodConfirmation');
const { validate } = require('../src/validation/schema');
const { deployTriggerSchema } = require('../src/validation/projectSchemas');

// ---------------------------------------------------------------------------
// checkProdConfirmation() — direct unit tests
// ---------------------------------------------------------------------------

const PROJECT = { id: 'p1', name: 'Payments API' };

test('checkProdConfirmation: the correct project name passes (returns null)', () => {
  const result = checkProdConfirmation(PROJECT, { environment: 'Prod', confirmation: 'Payments API' });
  assert.equal(result, null);
});

test('checkProdConfirmation: a trimmed-whitespace correct name still passes', () => {
  const result = checkProdConfirmation(PROJECT, { environment: 'Prod', confirmation: '  Payments API  ' });
  assert.equal(result, null);
});

test('checkProdConfirmation: the wrong name is rejected with the exact contract body', () => {
  const result = checkProdConfirmation(PROJECT, { environment: 'Prod', confirmation: 'Wrong Name' });
  assert.deepEqual(result, {
    error: 'Production deployments require typing the project name to confirm.',
    code: 'CONFIRMATION_REQUIRED',
    expected: 'Payments API',
  });
});

test('checkProdConfirmation: comparison is case-sensitive', () => {
  const result = checkProdConfirmation(PROJECT, { environment: 'Prod', confirmation: 'payments api' });
  assert.notEqual(result, null);
  assert.equal(result.code, 'CONFIRMATION_REQUIRED');
});

test('checkProdConfirmation: a missing confirmation field is rejected', () => {
  const result = checkProdConfirmation(PROJECT, { environment: 'Prod' });
  assert.notEqual(result, null);
  assert.equal(result.code, 'CONFIRMATION_REQUIRED');
  assert.equal(result.expected, 'Payments API');
});

test('checkProdConfirmation: an empty-string confirmation is rejected', () => {
  const result = checkProdConfirmation(PROJECT, { environment: 'Prod', confirmation: '' });
  assert.notEqual(result, null);
});

test('checkProdConfirmation: confirmation is not required for Dev or Stage', () => {
  assert.equal(checkProdConfirmation(PROJECT, { environment: 'Dev' }), null);
  assert.equal(checkProdConfirmation(PROJECT, { environment: 'Stage' }), null);
  assert.equal(checkProdConfirmation(PROJECT, { environment: 'Dev', confirmation: 'garbage' }), null,
    'an incorrect confirmation value must simply be ignored outside Prod');
});

test('checkProdConfirmation: no environment at all is treated the same as non-Prod', () => {
  assert.equal(checkProdConfirmation(PROJECT, {}), null);
});

// ---------------------------------------------------------------------------
// HTTP-level: same modules, mounted on a real ephemeral-port server
// ---------------------------------------------------------------------------

/** Mirrors the exact validation + confirmation wiring in server.js's POST /api/deploy/trigger. */
function buildTestApp(projects) {
  const app = express();
  app.use(express.json());

  app.post('/api/deploy/trigger', (req, res) => {
    const bodyValidation = validate(req.body, deployTriggerSchema);
    if (!bodyValidation.valid) {
      return res.status(400).json({ error: 'Invalid deploy trigger request.', details: bodyValidation.errors });
    }
    const { projectId, parameters } = bodyValidation.value;
    const project = projects.find((p) => p.id === projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const confirmationError = checkProdConfirmation(project, parameters || {});
    if (confirmationError) {
      return res.status(400).json(confirmationError);
    }

    return res.status(200).json({ ok: true, projectId, environment: (parameters || {}).environment });
  });

  return app;
}

/** Starts `app` on an OS-assigned port; returns { baseUrl, close }. */
function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
    server.on('error', reject);
  });
}

async function postTrigger(baseUrl, body) {
  const res = await fetch(`${baseUrl}/api/deploy/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

test('POST /api/deploy/trigger (HTTP): correct confirmation for Prod succeeds', async () => {
  const { baseUrl, close } = await listen(buildTestApp([PROJECT]));
  try {
    const { status, body } = await postTrigger(baseUrl, {
      projectId: 'p1',
      parameters: { environment: 'Prod', confirmation: 'Payments API' },
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  } finally {
    await close();
  }
});

test('POST /api/deploy/trigger (HTTP): wrong confirmation for Prod returns 400 with the exact contract body', async () => {
  const { baseUrl, close } = await listen(buildTestApp([PROJECT]));
  try {
    const { status, body } = await postTrigger(baseUrl, {
      projectId: 'p1',
      parameters: { environment: 'Prod', confirmation: 'not the name' },
    });
    assert.equal(status, 400);
    assert.deepEqual(body, {
      error: 'Production deployments require typing the project name to confirm.',
      code: 'CONFIRMATION_REQUIRED',
      expected: 'Payments API',
    });
  } finally {
    await close();
  }
});

test('POST /api/deploy/trigger (HTTP): missing confirmation field for Prod returns 400', async () => {
  const { baseUrl, close } = await listen(buildTestApp([PROJECT]));
  try {
    const { status, body } = await postTrigger(baseUrl, {
      projectId: 'p1',
      parameters: { environment: 'Prod' },
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'CONFIRMATION_REQUIRED');
  } finally {
    await close();
  }
});

test('POST /api/deploy/trigger (HTTP): Dev and Stage never require confirmation', async () => {
  const { baseUrl, close } = await listen(buildTestApp([PROJECT]));
  try {
    const dev = await postTrigger(baseUrl, { projectId: 'p1', parameters: { environment: 'Dev' } });
    assert.equal(dev.status, 200);

    const stage = await postTrigger(baseUrl, { projectId: 'p1', parameters: { environment: 'Stage' } });
    assert.equal(stage.status, 200);
  } finally {
    await close();
  }
});

test('POST /api/deploy/trigger (HTTP): a malformed body (missing projectId) is rejected before confirmation logic even runs', async () => {
  const { baseUrl, close } = await listen(buildTestApp([PROJECT]));
  try {
    const { status, body } = await postTrigger(baseUrl, { parameters: { environment: 'Prod' } });
    assert.equal(status, 400);
    assert.equal(body.error, 'Invalid deploy trigger request.');
    assert.ok(Array.isArray(body.details));
  } finally {
    await close();
  }
});
