/**
 * Regression tests for the in-memory rate limiter (T-19).
 *
 * Covers: requests under the limit pass through, requests over the limit
 * get a 429 + Retry-After, and the window resets so a client isn't blocked
 * forever.
 *
 * Run with: npm test
 */
const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const { createRateLimit } = require('../src/middleware/rateLimit');

/** Builds a minimal fake Express req for a given IP. */
function makeReq(ip = '127.0.0.1') {
  return { ip };
}

/** Builds a minimal fake Express res that records status/headers/body. */
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

// Tracks limiter instances created in each test so their cleanup intervals
// are always stopped, even on failure.
let activeLimiters = [];
function limiter(opts) {
  const l = createRateLimit(opts);
  activeLimiters.push(l);
  return l;
}
afterEach(() => {
  for (const l of activeLimiters) l.stop();
  activeLimiters = [];
});

test('createRateLimit validates its options', () => {
  assert.throws(() => createRateLimit({ windowMs: 0, max: 5 }));
  assert.throws(() => createRateLimit({ windowMs: 1000, max: 0 }));
  assert.throws(() => createRateLimit({}));
});

test('requests under the limit pass through', () => {
  const rl = limiter({ windowMs: 60_000, max: 3 });
  const req = makeReq();

  for (let i = 0; i < 3; i++) {
    const res = makeRes();
    let nextCalled = false;
    rl(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, `request ${i + 1} should pass through`);
    assert.equal(res.statusCode, 200);
  }
});

test('requests over the limit get 429 with Retry-After', () => {
  const rl = limiter({ windowMs: 60_000, max: 2 });
  const req = makeReq();

  // Two allowed requests.
  rl(req, makeRes(), () => {});
  rl(req, makeRes(), () => {});

  // Third request in the same window is rejected.
  const res = makeRes();
  let nextCalled = false;
  rl(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 429);
  assert.ok(res.headers['Retry-After'], 'Retry-After header should be set');
  assert.ok(Number(res.headers['Retry-After']) > 0);
  assert.match(res.body.error, /too many requests/i);
});

test('separate keys (e.g. different IPs) are limited independently', () => {
  const rl = limiter({ windowMs: 60_000, max: 1 });

  const resA1 = makeRes();
  rl(makeReq('1.1.1.1'), resA1, () => {});
  assert.equal(resA1.statusCode, 200);

  const resA2 = makeRes();
  rl(makeReq('1.1.1.1'), resA2, () => {});
  assert.equal(resA2.statusCode, 429);

  // A different IP has its own bucket and is unaffected.
  const resB1 = makeRes();
  rl(makeReq('2.2.2.2'), resB1, () => {});
  assert.equal(resB1.statusCode, 200);
});

test('limit resets once the window elapses', async () => {
  const rl = limiter({ windowMs: 100, max: 1 });
  const req = makeReq();

  const res1 = makeRes();
  rl(req, res1, () => {});
  assert.equal(res1.statusCode, 200);

  const res2 = makeRes();
  rl(req, res2, () => {});
  assert.equal(res2.statusCode, 429);

  // Wait out the window.
  await sleep(150);

  const res3 = makeRes();
  let nextCalled = false;
  rl(req, res3, () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'request after window reset should pass through');
  assert.equal(res3.statusCode, 200);
});

test('a custom keyFn is used to derive the bucket key', () => {
  const rl = limiter({ windowMs: 60_000, max: 1, keyFn: (req) => req.userId });

  const res1 = makeRes();
  rl({ userId: 'user-a' }, res1, () => {});
  assert.equal(res1.statusCode, 200);

  const res2 = makeRes();
  rl({ userId: 'user-a' }, res2, () => {});
  assert.equal(res2.statusCode, 429);

  // Different key -> independent bucket.
  const res3 = makeRes();
  rl({ userId: 'user-b' }, res3, () => {});
  assert.equal(res3.statusCode, 200);
});
