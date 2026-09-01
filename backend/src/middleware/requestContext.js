'use strict';

/**
 * Per-request context via AsyncLocalStorage (T-55 / SEC-12).
 *
 * The audit trail used to only know what each call site explicitly passed
 * in — most calls didn't pass an IP, none passed a request id, and there
 * was no way to correlate "these five audit entries all happened inside
 * the same HTTP request" after the fact. Re-threading `req` through every
 * function that might eventually call `auditLogger.log()` (including deep
 * inside the background deployment IIFE in server.js, which keeps running
 * long after the original request has been responded to) isn't practical.
 *
 * `AsyncLocalStorage` solves this without touching those call sites: a
 * context object is stashed once, at the top of the request, and
 * `getRequestContext()` transparently reads it back from anywhere that
 * runs as a descendant of that request's async execution chain — which
 * includes promises and callbacks kicked off during the request, even
 * after the response has been sent (exactly the deploy-IIFE case above).
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');

const requestContextStorage = new AsyncLocalStorage();

/**
 * Mount before every route (after `cookieParser`/`session`, so
 * `req.session.user` — when already present, e.g. a returning session
 * cookie — can be captured up front). Must run for every request: it's
 * what makes `getRequestContext()` non-null anywhere downstream.
 */
function requestContextMiddleware(req, res, next) {
  const context = {
    requestId: crypto.randomUUID(),
    ip: req.ip,
    username: req.session && req.session.user ? req.session.user.username : null,
    role: req.session && req.session.user ? req.session.user.role : null,
  };

  res.setHeader('X-Request-Id', context.requestId);

  requestContextStorage.run(context, () => next());
}

/**
 * @returns {{ requestId: string, ip: string, username: string|null, role: string|null }|null}
 *   `null` when called outside any request's async chain (startup code,
 *   a directly-invoked test, etc.) — every caller must handle that.
 */
function getRequestContext() {
  return requestContextStorage.getStore() || null;
}

/**
 * Backfills `username`/`role` onto the CURRENT request's context after a
 * route establishes identity mid-request — e.g. POST /api/auth/login sets
 * `req.session.user` itself, after `requestContextMiddleware` already ran
 * (and so couldn't have known who was logging in yet). No-op outside a
 * request context.
 * @param {string} username
 * @param {string} role
 */
function setContextUser(username, role) {
  const context = requestContextStorage.getStore();
  if (context) {
    context.username = username;
    context.role = role;
  }
}

module.exports = { requestContextMiddleware, getRequestContext, setContextUser };
