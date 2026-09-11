/**
 * Tests for the CI Pipeline provider adapter (Bitbucket Pipelines + GitHub
 * Actions): src/adapters/CiPipelineAdapter.js and src/adapters/ci/*.
 *
 * Every HTTP call goes through a fake fetch router (method + path → scripted
 * responses, every request recorded) injected via `config.fetchImpl` — no
 * test here touches a real network. Poll intervals are shrunk via the
 * adapter's `config.timing` test seam, except in the abort test, which uses
 * the real 3s minimum on purpose to prove the sleep is interruptible.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test, mock } = require('node:test');

const CiPipelineAdapter = require('../src/adapters/CiPipelineAdapter');

// DeploymentAdapter#log() mirrors every line to stdout; keep the test output readable.
mock.method(console, 'log', () => {});

const TOKEN = 'tok_SUPER_SECRET_ci_token_1234567890';
const EMAIL = 'deployer@example.com';
const BASIC = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

// ── fake fetch ──────────────────────────────────────────────────────────────

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function empty(status, headers = {}) {
  return new Response(null, { status, headers });
}

/**
 * `routes` maps 'METHOD /path' to a handler `(request, callIndex) => Response`
 * or to an array of handlers consumed in order (the last one repeats).
 * Honors the request's abort signal like a real fetch.
 */
function createFakeFetch(routes) {
  const requests = [];
  const counts = new Map();

  const fetchImpl = (url, init = {}) => {
    const parsed = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const key = `${method} ${parsed.pathname}`;
    const request = {
      method,
      key,
      path: parsed.pathname,
      query: parsed.searchParams,
      headers: { ...(init.headers || {}) },
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    const index = counts.get(key) || 0;
    counts.set(key, index + 1);

    const route = routes[key];
    const handler = Array.isArray(route) ? route[Math.min(index, route.length - 1)] : route;
    return new Promise((resolve, reject) => {
      const { signal } = init;
      const onAbort = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (!handler) return resolve(json(404, { error: { message: `no fake route for ${key}` } }));
      Promise.resolve().then(() => handler(request, index)).then(resolve, reject);
    });
  };

  return { fetchImpl, requests, count: (key) => counts.get(key) || 0 };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function lineMessages(logs) {
  return logs.map((line) => line.replace(/^\[[^\]]+\]\s*/, ''));
}

// ── Bitbucket fixtures ──────────────────────────────────────────────────────

const BB_REPO = '/2.0/repositories/acme/web';
const RUN_UUID = '{7f3c-run}';
const STEP_UUID = '{step-1}';
const RUN_PATH = `${BB_REPO}/pipelines/${encodeURIComponent(RUN_UUID)}`;
const STEPS_PATH = `${RUN_PATH}/steps/`;
const LOG_PATH = `${RUN_PATH}/steps/${encodeURIComponent(STEP_UUID)}/log`;
const STOP_PATH = `${RUN_PATH}/stopPipeline`;
const TRIGGER_KEY = `POST ${BB_REPO}/pipelines/`;

const bbTrigger = () => json(201, { uuid: RUN_UUID, build_number: 42 });
const pipelineState = (state) => () => json(200, { uuid: RUN_UUID, build_number: 42, state });
const IN_PROGRESS = { name: 'IN_PROGRESS', stage: { name: 'RUNNING' } };
const PAUSED = { name: 'IN_PROGRESS', stage: { name: 'PAUSED' } };
const completed = (result) => ({ name: 'COMPLETED', result });

function bbStep(state) {
  return {
    uuid: STEP_UUID,
    name: 'Deploy',
    state,
    started_on: '2026-09-11T10:00:00Z',
    completed_on: state.name === 'COMPLETED' ? '2026-09-11T10:00:12Z' : null,
  };
}
const stepsOf = (...steps) => () => json(200, { values: steps });

function bitbucketAdapter(fake, { ciConfig = {}, timing = {}, ...rest } = {}) {
  const adapter = new CiPipelineAdapter({
    ciConfig: {
      platform: 'bitbucket',
      owner: 'acme',
      repo: 'web',
      ref: 'master',
      pipeline: 'deploy-customer',
      variables: { CUSTOMER: 'A', VERSION: '2.5.0' },
      ...ciConfig,
    },
    apiToken: TOKEN,
    fetchImpl: fake.fetchImpl,
    timing: { pollIntervalMs: 5, ...timing },
    ...rest,
  });
  const logs = [];
  adapter.onLog((line) => logs.push(line));
  return { adapter, logs };
}

// ── Bitbucket: trigger ──────────────────────────────────────────────────────

test('Bitbucket: trigger posts a custom-pipeline body and never sends or logs environment/confirmation or values', async () => {
  const fake = createFakeFetch({ [TRIGGER_KEY]: bbTrigger });
  const { adapter, logs } = bitbucketAdapter(fake, { ciConfig: { refType: 'tag', ref: 'v2.5.0' } });

  const result = await adapter.trigger({
    environment: 'Prod',
    confirmation: 'My Project',
    variables: { VERSION: '2.6.0', BRAND: 'temsa' },
  });

  assert.deepEqual(result, {
    runId: RUN_UUID,
    runNumber: 42,
    url: 'https://bitbucket.org/acme/web/pipelines/results/42',
    status: 'started',
  });
  const [request] = fake.requests;
  assert.deepEqual(request.body, {
    target: {
      type: 'pipeline_ref_target',
      ref_type: 'tag',
      ref_name: 'v2.5.0',
      selector: { type: 'custom', pattern: 'deploy-customer' },
    },
    variables: [
      { key: 'CUSTOMER', value: 'A' },
      { key: 'VERSION', value: '2.6.0' },
      { key: 'BRAND', value: 'temsa' },
    ],
  });
  assert.doesNotMatch(JSON.stringify(request.body), /Prod|My Project|environment|confirmation/);
  assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(request.headers.Accept, 'application/json');

  const joined = logs.join('\n');
  assert.match(joined, /with variables: CUSTOMER, VERSION, BRAND/);
  assert.doesNotMatch(joined, /2\.6\.0|temsa|Prod|My Project/, 'only variable keys may be logged');
  assert.match(joined, /Triggered Bitbucket pipeline #42 on v2\.5\.0: https:\/\/bitbucket\.org\/acme\/web\/pipelines\/results\/42/);
});

test('Bitbucket: basic auth sends base64(email:token); missing email is a config error', async () => {
  const fake = createFakeFetch({ [TRIGGER_KEY]: bbTrigger });
  const { adapter } = bitbucketAdapter(fake, { ciConfig: { authType: 'basic' }, username: EMAIL });
  await adapter.trigger({});
  assert.equal(fake.requests[0].headers.Authorization, `Basic ${BASIC}`);

  assert.throws(
    () => bitbucketAdapter(fake, { ciConfig: { authType: 'basic' } }),
    /missing: username/
  );
});

test('constructor lists every missing setting', () => {
  assert.throws(
    () => new CiPipelineAdapter({ ciConfig: {}, apiToken: '' }),
    /missing: platform, owner, repo, ref, pipeline, apiToken/
  );
});

test('Bitbucket: trigger rejects invalid variable keys without echoing values', async () => {
  const fake = createFakeFetch({ [TRIGGER_KEY]: bbTrigger });
  const { adapter } = bitbucketAdapter(fake);
  await assert.rejects(
    adapter.trigger({ variables: { 'BAD-KEY': 'secret-ish-value' } }),
    (err) => /BAD-KEY/.test(err.message) && !/secret-ish-value/.test(err.message)
  );
  assert.equal(fake.requests.length, 0, 'nothing is sent when variables are invalid');
});

test('Bitbucket: trigger error surfaces HTTP status and error.message', async () => {
  const fake = createFakeFetch({
    [TRIGGER_KEY]: () => json(400, { type: 'error', error: { message: "Custom pipeline 'deploy-customer' not found" } }),
  });
  const { adapter } = bitbucketAdapter(fake);
  await assert.rejects(adapter.trigger({}), /HTTP 400.*Custom pipeline 'deploy-customer' not found/);
});

test('Bitbucket: an abort that lands while the trigger is in flight cancels the new run and throws', async () => {
  let adapter;
  let abortPromise;
  const fake = createFakeFetch({
    [TRIGGER_KEY]: () => {
      abortPromise = adapter.abort();
      return bbTrigger();
    },
    [`POST ${STOP_PATH}`]: () => empty(204),
  });
  ({ adapter } = bitbucketAdapter(fake));

  await assert.rejects(adapter.trigger({}), /Pipeline #42 was aborted\./);
  await abortPromise;
  assert.equal(fake.count(`POST ${STOP_PATH}`), 1);
});

// ── Bitbucket: connect ──────────────────────────────────────────────────────

test('Bitbucket: connect() passes when the repo, pipelines and custom pipeline are visible', async () => {
  const fake = createFakeFetch({
    [`GET ${BB_REPO}`]: () => json(200, { full_name: 'acme/web' }),
    [`GET ${BB_REPO}/pipelines/`]: () => json(200, { values: [] }),
    [`GET ${BB_REPO}/src/master/bitbucket-pipelines.yml`]: () =>
      new Response('pipelines:\n  custom:\n    deploy-customer:\n      - step:\n          script: [./deploy.sh]\n', { status: 200 }),
  });
  const { adapter, logs } = bitbucketAdapter(fake);
  await adapter.connect();
  const joined = lineMessages(logs).join('\n');
  assert.match(joined, /✓ Bitbucket Repository/);
  assert.match(joined, /✓ Bitbucket Pipelines/);
  assert.match(joined, /✓ Pipeline Definition: Custom pipeline 'deploy-customer' is declared/);
});

test('Bitbucket: connect() throws on an authentication failure', async () => {
  const fake = createFakeFetch({ [`GET ${BB_REPO}`]: () => json(401, { error: { message: 'Unauthorized' } }) });
  const { adapter } = bitbucketAdapter(fake);
  await assert.rejects(adapter.connect(), /Bitbucket Repository: Authentication failed \(HTTP 401\)/);
});

// ── Bitbucket: streamLogs ───────────────────────────────────────────────────

// '+ ./deploy.sh\n' (14 bytes) + 'line two\n' (9) → 'ü' starts at byte 23.
const FULL_LOG = Buffer.from('+ ./deploy.sh\nline two\nünïcödé ✓\nlast line without newline', 'utf8');

/** Serves FULL_LOG as a growing file: call i exposes `cuts[i]` bytes (null → 404). */
function growingLog(cuts) {
  return (request, index) => {
    const visible = cuts[Math.min(index, cuts.length - 1)];
    if (visible === null) return json(404, { error: { message: 'Log not found' } });
    const start = Number(/bytes=(\d+)-/.exec(request.headers.Range)[1]);
    if (start >= visible) return empty(416);
    const total = visible === FULL_LOG.length ? String(FULL_LOG.length) : '*';
    return new Response(FULL_LOG.subarray(start, visible), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${visible - 1}/${total}` },
    });
  };
}

test('Bitbucket: incremental log via 404 → 206 → 206 → completed, UTF-8 safe, encoded ids, SUCCESSFUL resolves', async () => {
  const fake = createFakeFetch({
    [TRIGGER_KEY]: bbTrigger,
    [`GET ${STEPS_PATH}`]: [
      stepsOf(bbStep({ name: 'IN_PROGRESS' })),
      stepsOf(bbStep({ name: 'IN_PROGRESS' })),
      stepsOf(bbStep({ name: 'IN_PROGRESS' })),
      stepsOf(bbStep(completed({ name: 'SUCCESSFUL' }))),
    ],
    // Cut at byte 24 lands in the middle of the two-byte 'ü'.
    [`GET ${LOG_PATH}`]: growingLog([null, 18, 24, FULL_LOG.length]),
    [`GET ${RUN_PATH}`]: [pipelineState(IN_PROGRESS), pipelineState(completed({ name: 'SUCCESSFUL' }))],
  });
  const { adapter, logs } = bitbucketAdapter(fake);
  await adapter.trigger({});

  const streamed = [];
  await adapter.streamLogs((line) => streamed.push(line));

  assert.deepEqual(streamed, [
    '[CI] + ./deploy.sh',
    '[CI] line two',
    '[CI] ünïcödé ✓',
    '[CI] last line without newline',
  ]);
  const ranges = fake.requests.filter((r) => r.path === LOG_PATH).map((r) => r.headers.Range);
  assert.deepEqual(ranges.slice(0, 4), ['bytes=0-', 'bytes=0-', 'bytes=18-', 'bytes=24-']);

  const messages = lineMessages(logs);
  assert.ok(messages.includes('[CI] ▶ Deploy started'), messages.join('\n'));
  assert.ok(messages.includes('[CI] ✓ Deploy succeeded (12s)'), messages.join('\n'));
  assert.ok(messages.some((m) => /^\[CI\] ✓ Pipeline #42 succeeded \(\d+s\) https:\/\/bitbucket\.org\/acme\/web\/pipelines\/results\/42$/.test(m)));

  // Braces in UUIDs are always percent-encoded in paths.
  for (const request of fake.requests.slice(1)) {
    assert.ok(request.path.includes('%7B7f3c-run%7D'), request.path);
    assert.ok(!request.path.includes('{'), request.path);
  }
  // Status is fetched only every 3rd tick while a step is running.
  assert.equal(fake.count(`GET ${RUN_PATH}`), 2);
});

test('Bitbucket: a FAILED/ERROR result throws with the result detail', async () => {
  const fake = createFakeFetch({
    [TRIGGER_KEY]: bbTrigger,
    [`GET ${STEPS_PATH}`]: stepsOf(bbStep(completed({ name: 'FAILED' }))),
    [`GET ${LOG_PATH}`]: () => new Response('npm ERR! boom\n', { status: 200 }),
    [`GET ${RUN_PATH}`]: pipelineState(completed({ name: 'ERROR', error: { message: 'Step exceeded the time limit' } })),
  });
  const { adapter, logs } = bitbucketAdapter(fake);
  await adapter.trigger({});
  const streamed = [];
  await assert.rejects(
    adapter.streamLogs((line) => streamed.push(line)),
    /^Error: Pipeline #42 finished with status: ERROR: Step exceeded the time limit$/
  );
  assert.deepEqual(streamed, ['[CI] npm ERR! boom']);
  assert.ok(lineMessages(logs).includes('[CI] ✗ Deploy failed (12s)'));
});

test('Bitbucket: PAUSED logs the waiting message once per episode and keeps polling', async () => {
  const fake = createFakeFetch({
    [TRIGGER_KEY]: bbTrigger,
    [`GET ${STEPS_PATH}`]: stepsOf(),
    [`GET ${RUN_PATH}`]: [
      pipelineState(PAUSED),
      pipelineState(PAUSED),
      pipelineState(PAUSED),
      pipelineState(completed({ name: 'SUCCESSFUL' })),
    ],
  });
  const { adapter, logs } = bitbucketAdapter(fake);
  await adapter.trigger({});
  await adapter.streamLogs(() => {});
  const paused = logs.filter((line) => line.includes('⏸ Pipeline paused — a manual step or another deployment (concurrency) is blocking it.'));
  assert.equal(paused.length, 1);
});

test('Bitbucket: STOPPED without an IDP abort → "cancelled outside IDP", no stop request', async () => {
  const fake = createFakeFetch({
    [TRIGGER_KEY]: bbTrigger,
    [`GET ${STEPS_PATH}`]: stepsOf(),
    [`GET ${RUN_PATH}`]: pipelineState(completed({ name: 'STOPPED' })),
  });
  const { adapter } = bitbucketAdapter(fake);
  await adapter.trigger({});
  await assert.rejects(adapter.streamLogs(() => {}), /Pipeline #42 was cancelled outside IDP\./);
  assert.equal(fake.count(`POST ${STOP_PATH}`), 0);
});

test('Bitbucket: abort() during the poll sleep settles streamLogs promptly and stops the pipeline once', async () => {
  const fake = createFakeFetch({
    [TRIGGER_KEY]: bbTrigger,
    [`GET ${STEPS_PATH}`]: stepsOf(),
    [`GET ${RUN_PATH}`]: pipelineState(IN_PROGRESS),
    [`POST ${STOP_PATH}`]: () => empty(204),
  });
  // The real minimum interval (3s): if the sleep weren't abortable this test would take ≥3s.
  const { adapter, logs } = bitbucketAdapter(fake, { timing: { pollIntervalMs: 3000 } });
  await adapter.trigger({});

  const streaming = adapter.streamLogs(() => {});
  streaming.catch(() => {});
  await waitFor(() => fake.count(`GET ${RUN_PATH}`) === 1);
  await new Promise((resolve) => setTimeout(resolve, 20)); // now parked in the sleep

  const startedAt = Date.now();
  const aborting = adapter.abort();
  await assert.rejects(streaming, /Pipeline #42 was aborted\./);
  const elapsedMs = Date.now() - startedAt;
  await aborting;

  assert.ok(elapsedMs < 500, `streamLogs took ${elapsedMs}ms to settle after abort()`);
  assert.equal(fake.count(`POST ${STOP_PATH}`), 1);
  assert.ok(lineMessages(logs).includes('[CI] ■ Cancel requested for pipeline #42'));

  await assert.doesNotReject(adapter.abort());
  assert.equal(fake.count(`POST ${STOP_PATH}`), 1, 'a second abort() must not re-send the stop request');
});

test('Bitbucket: abort() while a poll request hangs also settles promptly', async () => {
  const fake = createFakeFetch({
    [TRIGGER_KEY]: bbTrigger,
    [`GET ${STEPS_PATH}`]: () => new Promise(() => {}), // never answers
    [`POST ${STOP_PATH}`]: () => json(400, { error: { message: 'Pipeline already completed' } }),
  });
  const { adapter, logs } = bitbucketAdapter(fake);
  await adapter.trigger({});

  const streaming = adapter.streamLogs(() => {});
  streaming.catch(() => {});
  await waitFor(() => fake.count(`GET ${STEPS_PATH}`) === 1);

  const startedAt = Date.now();
  await adapter.abort();
  await assert.rejects(streaming, /was aborted/);
  assert.ok(Date.now() - startedAt < 500);
  assert.ok(!logs.some((line) => line.includes('Failed to cancel')), '400 from stopPipeline means already completed — not an error');
});

test('Bitbucket: the overall timeout throws and does NOT stop the pipeline', async () => {
  const fake = createFakeFetch({
    [TRIGGER_KEY]: bbTrigger,
    [`GET ${STEPS_PATH}`]: stepsOf(),
    [`GET ${RUN_PATH}`]: pipelineState(IN_PROGRESS),
    [`POST ${STOP_PATH}`]: () => empty(204),
  });
  const { adapter } = bitbucketAdapter(fake, { timing: { pollIntervalMs: 5, timeoutMs: 40 } });
  await adapter.trigger({});
  await assert.rejects(
    adapter.streamLogs(() => {}),
    /Pipeline #42 still running after .* min; IDP stopped watching but did NOT cancel it: https:\/\/bitbucket\.org/
  );
  assert.equal(fake.count(`POST ${STOP_PATH}`), 0);
});

test('Bitbucket: transient 5xx are retried; 5 consecutive failures give up', async () => {
  const recovering = createFakeFetch({
    [TRIGGER_KEY]: bbTrigger,
    [`GET ${STEPS_PATH}`]: stepsOf(),
    [`GET ${RUN_PATH}`]: [
      () => json(503, { error: { message: 'Service unavailable' } }),
      () => json(502, {}),
      pipelineState(completed({ name: 'SUCCESSFUL' })),
    ],
  });
  const first = bitbucketAdapter(recovering);
  await first.adapter.trigger({});
  await first.adapter.streamLogs(() => {});
  assert.equal(first.logs.filter((line) => line.includes('⚠ Polling failed')).length, 2);

  const broken = createFakeFetch({
    [TRIGGER_KEY]: bbTrigger,
    [`GET ${STEPS_PATH}`]: () => json(500, {}),
  });
  const second = bitbucketAdapter(broken, { timing: { pollIntervalMs: 1 } });
  await second.adapter.trigger({});
  await assert.rejects(second.adapter.streamLogs(() => {}), /after 5 consecutive errors/);
  assert.equal(broken.count(`GET ${STEPS_PATH}`), 5);
});

test('Bitbucket: 404 on the status endpoint throws immediately', async () => {
  const fake = createFakeFetch({
    [TRIGGER_KEY]: bbTrigger,
    [`GET ${STEPS_PATH}`]: stepsOf(),
    [`GET ${RUN_PATH}`]: () => json(404, { error: { message: 'Pipeline not found' } }),
  });
  const { adapter } = bitbucketAdapter(fake);
  await adapter.trigger({});
  await assert.rejects(adapter.streamLogs(() => {}), /HTTP 404.*Pipeline not found/);
  assert.equal(fake.count(`GET ${RUN_PATH}`), 1);
});

test('Bitbucket: X-RateLimit-NearLimit doubles the poll interval', async () => {
  const fake = createFakeFetch({
    [TRIGGER_KEY]: bbTrigger,
    [`GET ${STEPS_PATH}`]: () => json(200, { values: [] }, { 'X-RateLimit-NearLimit': 'true' }),
    [`GET ${RUN_PATH}`]: [pipelineState(IN_PROGRESS), pipelineState(completed({ name: 'SUCCESSFUL' }))],
  });
  const { adapter, logs } = bitbucketAdapter(fake);
  await adapter.trigger({});
  await adapter.streamLogs(() => {});
  assert.ok(logs.some((line) => line.includes('rate limit nearly reached')));
});

test('Bitbucket: the token (and the Basic credential) never appears in logs, stream lines or errors', async () => {
  const fake = createFakeFetch({
    [TRIGGER_KEY]: bbTrigger,
    [`GET ${STEPS_PATH}`]: stepsOf(bbStep({ name: 'IN_PROGRESS' })),
    [`GET ${LOG_PATH}`]: () => new Response(`echo ${TOKEN}\nAuthorization: Basic ${BASIC}\n`, { status: 200 }),
    [`GET ${RUN_PATH}`]: () => json(401, { error: { message: `Token ${TOKEN} is invalid (${BASIC})` } }),
  });
  const { adapter, logs } = bitbucketAdapter(fake, { ciConfig: { authType: 'basic' }, username: EMAIL });
  await adapter.trigger({});

  const streamed = [];
  let error;
  try {
    await adapter.streamLogs((line) => streamed.push(line));
  } catch (err) {
    error = err;
  }
  assert.ok(error, 'expected streamLogs to reject on 401');
  assert.equal(streamed.length, 2, 'the log lines themselves are still delivered');

  const everything = [...logs, ...streamed, error.message].join('\n');
  assert.ok(!everything.includes(TOKEN), everything);
  assert.ok(!everything.includes(BASIC), everything);
});

// ── GitHub fixtures ─────────────────────────────────────────────────────────

const GH_REPO = '/repos/acme/web';
const DISPATCH_KEY = `POST ${GH_REPO}/actions/workflows/deploy.yml/dispatches`;
const LOOKUP_KEY = `GET ${GH_REPO}/actions/workflows/deploy.yml/runs`;
const GH_RUN_KEY = `GET ${GH_REPO}/actions/runs/9001`;
const GH_JOBS_KEY = `GET ${GH_REPO}/actions/runs/9001/jobs`;
const GH_JOB_LOG_KEY = `GET ${GH_REPO}/actions/jobs/77/logs`;
const GH_CANCEL_KEY = `POST ${GH_REPO}/actions/runs/9001/cancel`;
const RUN_HTML = 'https://github.com/acme/web/actions/runs/9001';

const ghRun = (status, conclusion = null) => () =>
  json(200, { id: 9001, run_number: 17, status, conclusion, html_url: RUN_HTML });
const ghDispatchOk = () => json(200, { workflow_run_id: 9001, run_url: 'https://api.github.com/repos/acme/web/actions/runs/9001', html_url: RUN_HTML });

function githubAdapter(fake, { ciConfig = {}, timing = {}, ...rest } = {}) {
  const adapter = new CiPipelineAdapter({
    ciConfig: {
      platform: 'github',
      owner: 'acme',
      repo: 'web',
      ref: 'main',
      pipeline: 'deploy.yml',
      variables: { customer: 'A' },
      ...ciConfig,
    },
    apiToken: TOKEN,
    fetchImpl: fake.fetchImpl,
    timing: { pollIntervalMs: 5, correlationIntervalMs: 5, correlationTimeoutMs: 200, ...timing },
    ...rest,
  });
  const logs = [];
  adapter.onLog((line) => logs.push(line));
  return { adapter, logs };
}

// ── GitHub: trigger ─────────────────────────────────────────────────────────

test('GitHub: dispatch 200 returns the run id directly (return_run_details) with GitHub headers', async () => {
  const fake = createFakeFetch({ [DISPATCH_KEY]: ghDispatchOk, [GH_RUN_KEY]: ghRun('queued') });
  const { adapter, logs } = githubAdapter(fake, { ciConfig: { correlationInput: 'idp_correlation_id' } });

  const result = await adapter.trigger({ environment: 'Prod', confirmation: 'x' });

  assert.deepEqual(result, { runId: 9001, runNumber: 17, url: RUN_HTML, status: 'started' });
  const dispatch = fake.requests[0];
  assert.equal(dispatch.body.ref, 'main');
  assert.equal(dispatch.body.return_run_details, true);
  assert.equal(dispatch.body.inputs.customer, 'A');
  assert.match(dispatch.body.inputs.idp_correlation_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(dispatch.body.inputs).sort(), ['customer', 'idp_correlation_id']);
  assert.equal(dispatch.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(dispatch.headers.Accept, 'application/vnd.github+json');
  assert.equal(dispatch.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.match(logs.join('\n'), /Triggered GitHub workflow #17 on main: https:\/\/github\.com\/acme\/web\/actions\/runs\/9001/);
});

test('GitHub: 422 on return_run_details → retry without it → 204 → run found via display_title correlation', async () => {
  const correlationIdSent = () =>
    fake.requests.find((r) => r.key === DISPATCH_KEY && r.body.return_run_details === undefined).body.inputs.idp_correlation_id;
  const fake = createFakeFetch({
    [DISPATCH_KEY]: [
      () => json(422, { message: 'Invalid request.\n\n"return_run_details" is not a permitted key.' }),
      () => empty(204),
    ],
    [LOOKUP_KEY]: [
      () => json(200, { workflow_runs: [] }),
      () => json(200, {
        workflow_runs: [
          { id: 1, run_number: 16, display_title: 'Deploy B other-id', created_at: new Date().toISOString() },
          { id: 9001, run_number: 17, display_title: `Deploy A ${correlationIdSent()}`, html_url: RUN_HTML, created_at: new Date().toISOString() },
        ],
      }),
    ],
  });
  const { adapter } = githubAdapter(fake, { ciConfig: { correlationInput: 'idp_correlation_id' } });

  const result = await adapter.trigger({});

  assert.equal(result.runId, 9001);
  assert.equal(result.runNumber, 17);
  assert.equal(fake.count(DISPATCH_KEY), 2);
  const lookup = fake.requests.find((r) => r.key === LOOKUP_KEY);
  assert.equal(lookup.query.get('event'), 'workflow_dispatch');
  assert.equal(lookup.query.get('branch'), 'main');
  assert.equal(lookup.query.get('per_page'), '20');
});

test('GitHub: 204 without a correlation input falls back to the newest recent run and warns', async () => {
  const now = Date.now();
  const fake = createFakeFetch({
    [DISPATCH_KEY]: () => empty(204),
    [LOOKUP_KEY]: () => json(200, {
      workflow_runs: [
        { id: 5, run_number: 5, created_at: new Date(now - 10 * 60_000).toISOString() },
        { id: 9001, run_number: 17, html_url: RUN_HTML, created_at: new Date(now).toISOString() },
      ],
    }),
  });
  const { adapter, logs } = githubAdapter(fake);
  const result = await adapter.trigger({});
  assert.equal(result.runId, 9001);
  assert.ok(logs.some((line) => /Matching is heuristic/.test(line)));

  const stale = createFakeFetch({
    [DISPATCH_KEY]: () => empty(204),
    [LOOKUP_KEY]: () => json(200, { workflow_runs: [{ id: 5, created_at: new Date(now - 10 * 60_000).toISOString() }] }),
  });
  await assert.rejects(githubAdapter(stale).adapter.trigger({}), /could not be identified/);
});

test('GitHub: 422 "Unexpected inputs" explains that variables must be declared as workflow inputs', async () => {
  const fake = createFakeFetch({
    [DISPATCH_KEY]: () => json(422, { message: 'Unexpected inputs provided: ["BRAND"]' }),
  });
  const { adapter } = githubAdapter(fake);
  await assert.rejects(
    adapter.trigger({ variables: { BRAND: 'temsa' } }),
    /HTTP 422\): Unexpected inputs provided: \["BRAND"\].*declared under on\.workflow_dispatch\.inputs/
  );
});

// ── GitHub: streamLogs ──────────────────────────────────────────────────────

test('GitHub: job log is fetched once after the job completes, timestamps stripped, step progress emitted', async () => {
  const setUp = { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success', started_at: '2026-09-11T10:00:00Z', completed_at: '2026-09-11T10:00:01Z' };
  const fake = createFakeFetch({
    [DISPATCH_KEY]: ghDispatchOk,
    [GH_RUN_KEY]: [ghRun('queued'), ghRun('in_progress'), ghRun('completed', 'success')],
    [GH_JOBS_KEY]: [
      () => json(200, { jobs: [{ id: 77, name: 'build', status: 'in_progress', started_at: '2026-09-11T10:00:00Z', steps: [setUp, { number: 2, name: 'npm ci', status: 'in_progress', started_at: '2026-09-11T10:00:01Z' }] }] }),
      () => json(200, { jobs: [{ id: 77, name: 'build', status: 'completed', conclusion: 'success', started_at: '2026-09-11T10:00:00Z', completed_at: '2026-09-11T10:00:14Z', steps: [setUp, { number: 2, name: 'npm ci', status: 'completed', conclusion: 'success', started_at: '2026-09-11T10:00:01Z', completed_at: '2026-09-11T10:00:13Z' }] }] }),
    ],
    [GH_JOB_LOG_KEY]: () => new Response('﻿2026-09-11T10:00:01.1234567Z Run npm ci\r\n2026-09-11T10:00:13.0000000Z added 120 packages\n', { status: 200 }),
  });
  const { adapter, logs } = githubAdapter(fake);
  await adapter.trigger({});

  const streamed = [];
  await adapter.streamLogs((line) => streamed.push(line));

  assert.deepEqual(streamed, ['[CI] Run npm ci', '[CI] added 120 packages']);
  assert.equal(fake.count(GH_JOB_LOG_KEY), 1, 'job log must be downloaded exactly once');
  const messages = lineMessages(logs);
  for (const expected of [
    '[CI] ▶ build started',
    '[CI] ✓ build › Set up job (1s)',
    '[CI] ▶ build › npm ci',
    '[CI] ✓ build › npm ci (12s)',
    '[CI] ✓ build succeeded (14s)',
  ]) {
    assert.ok(messages.includes(expected), `missing "${expected}" in:\n${messages.join('\n')}`);
  }
});

test('GitHub: failure / timed_out / skipped conclusions fail the deploy with the conclusion as detail', async () => {
  for (const conclusion of ['failure', 'timed_out', 'skipped']) {
    const fake = createFakeFetch({
      [DISPATCH_KEY]: ghDispatchOk,
      [GH_RUN_KEY]: [ghRun('queued'), ghRun('completed', conclusion)],
      [GH_JOBS_KEY]: () => json(200, { jobs: [] }),
    });
    const { adapter } = githubAdapter(fake);
    await adapter.trigger({});
    await assert.rejects(
      adapter.streamLogs(() => {}),
      new RegExp(`Pipeline #17 finished with status: ${conclusion}$`),
      conclusion
    );
  }
});

test('GitHub: waiting status logs the environment-approval message once', async () => {
  const fake = createFakeFetch({
    [DISPATCH_KEY]: ghDispatchOk,
    [GH_RUN_KEY]: [ghRun('queued'), ghRun('waiting'), ghRun('waiting'), ghRun('completed', 'success')],
    [GH_JOBS_KEY]: () => json(200, { jobs: [] }),
  });
  const { adapter, logs } = githubAdapter(fake);
  await adapter.trigger({});
  await adapter.streamLogs(() => {});
  assert.equal(logs.filter((line) => line.includes('⏸ Waiting for environment approval in GitHub.')).length, 1);
});

test('GitHub: abort cancels the run (202); 409 "already completed" is treated as ok', async () => {
  for (const cancelResponse of [() => empty(202), () => json(409, { message: 'Cannot cancel a workflow run that is completed.' })]) {
    const fake = createFakeFetch({
      [DISPATCH_KEY]: ghDispatchOk,
      [GH_RUN_KEY]: ghRun('in_progress'),
      [GH_JOBS_KEY]: () => json(200, { jobs: [] }),
      [GH_CANCEL_KEY]: cancelResponse,
    });
    const { adapter, logs } = githubAdapter(fake);
    await adapter.trigger({});
    await adapter.abort();
    assert.equal(fake.count(GH_CANCEL_KEY), 1);
    assert.ok(lineMessages(logs).includes('[CI] ■ Cancel requested for pipeline #17'));
    assert.ok(!logs.some((line) => line.includes('Failed to cancel')), logs.join('\n'));
    await assert.rejects(adapter.streamLogs(() => {}), /Pipeline #17 was aborted\./);
  }
});
