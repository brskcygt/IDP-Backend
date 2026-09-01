/**
 * Express adapter around the transport-agnostic fixed-window rate limiter
 * (T-19, extracted to `src/core/rateLimiter.js` in T-91b).
 *
 * All the actual windowing/counting logic now lives in
 * `../core/rateLimiter.js` (pure — no Express, no req/res, checked by
 * `backend/scripts/check-core-boundaries.js`), so the SAME behavior can run
 * for Electron IPC channels (`desktop/main/ipc/helpers.js`) with no code
 * duplication. This file is just the thin Express-specific shell: derive a
 * key from `req` (default: `req.ip`), and turn a rejected check into a 429
 * response with a `Retry-After` header — byte-for-byte the same response
 * shape as before the extraction.
 */
const { createRateLimiter } = require('../core/rateLimiter');

/**
 * @param {object} options
 * @param {number} options.windowMs - Length of the rate-limit window, in ms.
 * @param {number} options.max - Max requests allowed per key per window.
 * @param {(req: import('express').Request) => string} [options.keyFn] - Derives the bucket key from a request. Defaults to `req.ip`.
 * @returns {import('express').RequestHandler & { stop: () => void }}
 */
function createRateLimit({ windowMs, max, keyFn } = {}) {
  const limiter = createRateLimiter({ windowMs, max });
  const resolveKey = typeof keyFn === 'function' ? keyFn : (req) => req.ip;

  function middleware(req, res, next) {
    const key = resolveKey(req);
    const { allowed, retryAfterMs } = limiter.check(key);

    if (!allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: 'Too many requests. Please try again later.',
        retryAfterSeconds: retryAfterSec,
      });
    }

    return next();
  }

  // Test/shutdown hook: stops the cleanup interval so it doesn't keep a
  // process (or test runner) alive.
  middleware.stop = () => limiter.stop();

  return middleware;
}

module.exports = { createRateLimit };
