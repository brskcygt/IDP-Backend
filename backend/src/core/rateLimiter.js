'use strict';

/**
 * Transport-agnostic core of the fixed-window rate limiter (T-91b).
 *
 * Originally `backend/src/middleware/rateLimit.js` (T-19) held both the
 * windowing/counting logic AND the Express-specific bits (reading `req.ip`,
 * writing `res.status(429).json(...)` + `Retry-After`). Pulled the pure
 * counting logic out here so the SAME limiting behavior can run in the
 * Electron main process (`desktop/main/ipc/helpers.js`) for IPC channels,
 * without either side depending on the other's transport.
 *
 * `src/core/**` must stay transport-agnostic — no Express, no req/res, see
 * `backend/scripts/check-core-boundaries.js` (wired into `npm run lint`,
 * and therefore into CI via verify.sh). This file only ever sees a plain
 * string `key` and returns a plain `{ allowed, retryAfterMs }` — no HTTP
 * concept anywhere.
 *
 * `backend/src/middleware/rateLimit.js`'s `createRateLimit()` wraps this
 * with the Express adapter (deriving a key from `req`, writing the 429
 * response); `desktop/main/ipc/helpers.js`'s `ipcHandler()` wraps this with
 * the IPC adapter (deriving a key per channel, throwing a `ConflictError`).
 * Same core, two thin transport-specific shells — HTTP behavior is
 * unchanged bit-for-bit; see `backend/test/rate-limit.test.js`, still
 * green because the windowing/counting logic itself didn't move.
 */

/**
 * @param {object} options
 * @param {number} options.windowMs - Length of the rate-limit window, in ms.
 * @param {number} options.max - Max requests allowed per key per window.
 * @returns {{ check: (key: string) => { allowed: boolean, retryAfterMs: number }, stop: () => void }}
 */
function createRateLimiter({ windowMs, max } = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('createRateLimiter requires a positive windowMs');
  }
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error('createRateLimiter requires a positive max');
  }

  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();

  // Periodically drop expired buckets so long-lived processes (the backend
  // server, or the Electron main process) don't leak memory accumulating
  // one entry per distinct key forever.
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) {
        buckets.delete(key);
      }
    }
  }, windowMs);
  // Don't let the cleanup timer keep the process alive (e.g. during tests).
  if (typeof cleanupInterval.unref === 'function') {
    cleanupInterval.unref();
  }

  /**
   * @param {string} key - the bucket to count this request against (e.g.
   *   an IP address for HTTP, or a fixed per-channel string for IPC).
   * @returns {{ allowed: boolean, retryAfterMs: number }} `retryAfterMs` is
   *   the time remaining until the current window resets — always a
   *   well-formed non-negative number, even when `allowed` is true (the
   *   caller just has no reason to use it in that case).
   */
  function check(key) {
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    const retryAfterMs = Math.max(0, bucket.resetAt - now);
    if (bucket.count > max) {
      return { allowed: false, retryAfterMs };
    }
    return { allowed: true, retryAfterMs };
  }

  // Test/shutdown hook: stops the cleanup interval so it doesn't keep a
  // process (or test runner) alive.
  function stop() {
    clearInterval(cleanupInterval);
  }

  return { check, stop };
}

module.exports = { createRateLimiter };
