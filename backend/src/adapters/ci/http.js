'use strict';

/**
 * Minimal HTTP layer shared by the CI clients (Bitbucket Pipelines, GitHub
 * Actions). Wraps an injectable `fetchImpl` (undici's fetch in production, a
 * fake in tests) with:
 *  - a per-request timeout, combined with an optional caller abort signal;
 *  - classification of failures into transient (network, timeout, 5xx, 429,
 *    rate-limited 403) vs. permanent, plus a Retry-After hint;
 *  - extraction of the provider's own error message from the response body
 *    (`error.message` for Bitbucket, `message` for GitHub).
 *
 * Error messages built here never contain request headers (which carry the
 * token) or URLs (redirect targets can carry signed storage credentials).
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_PROVIDER_MESSAGE_LENGTH = 300;
/**
 * A just-finished step/job log can briefly 404 while the provider archives it
 * (GitHub) or moves it to long-term storage (Bitbucket). Clients keep treating
 * such a 404 as "not available yet" for this long after the first one.
 */
const LOG_NOT_AVAILABLE_BUDGET_MS = 30_000;

/** An HTTP/network failure talking to the CI provider. */
class CiHttpError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, transient?: boolean, retryAfterMs?: number|null, providerMessage?: string }} [info]
   */
  constructor(message, { status = 0, transient = false, retryAfterMs = null, providerMessage = '' } = {}) {
    super(message);
    this.name = 'CiHttpError';
    this.status = status;
    this.transient = transient;
    this.retryAfterMs = retryAfterMs;
    this.providerMessage = providerMessage;
  }
}

/** The caller's abort signal fired while a request was in flight. */
class CiAbortError extends Error {
  constructor() {
    super('Request aborted.');
    this.name = 'CiAbortError';
    this.aborted = true;
  }
}

function truncate(text) {
  return text.length > MAX_PROVIDER_MESSAGE_LENGTH ? `${text.slice(0, MAX_PROVIDER_MESSAGE_LENGTH)}…` : text;
}

/**
 * @param {Headers} headers
 * @param {number} [now]
 * @returns {number|null} milliseconds to wait before retrying, if the provider said so.
 */
function parseRetryAfterMs(headers, now = Date.now()) {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1000 - now);
  }
  return null;
}

function isTransientStatus(status, headers) {
  if (status >= 500 || status === 429) return true;
  // GitHub signals primary/secondary rate limits with a 403 plus these headers.
  if (status === 403) {
    return Boolean(headers.get('retry-after')) || headers.get('x-ratelimit-remaining') === '0';
  }
  return false;
}

/** Best-effort extraction of the provider's human-readable error message. */
async function readProviderMessage(response) {
  let text = '';
  try {
    text = await response.text();
  } catch (_err) {
    return '';
  }
  if (!text) return '';

  let body;
  try {
    body = JSON.parse(text);
  } catch (_err) {
    // An HTML error page from a proxy is noise, not a message.
    return /^\s*</.test(text) ? '' : truncate(text.trim());
  }

  const parts = [];
  if (body && typeof body.error === 'object' && body.error !== null) {
    if (typeof body.error.message === 'string') parts.push(body.error.message);
    if (typeof body.error.detail === 'string') parts.push(body.error.detail);
  }
  if (body && typeof body.message === 'string') parts.push(body.message);
  if (body && Array.isArray(body.errors)) {
    for (const entry of body.errors) {
      if (typeof entry === 'string') parts.push(entry);
      else if (entry && typeof entry.message === 'string') parts.push(entry.message);
    }
  }
  return truncate(parts.join(' — '));
}

/**
 * Builds a CiHttpError from a non-successful response (consumes its body).
 * @param {Response} response
 * @param {string} label - human-readable operation name, e.g. 'Pipeline trigger'.
 * @returns {Promise<CiHttpError>}
 */
async function toHttpError(response, label) {
  const providerMessage = await readProviderMessage(response);
  const { status } = response;
  return new CiHttpError(
    `${label} failed (HTTP ${status})${providerMessage ? `: ${providerMessage}` : '.'}`,
    {
      status,
      transient: isTransientStatus(status, response.headers),
      retryAfterMs: parseRetryAfterMs(response.headers),
      providerMessage,
    }
  );
}

/**
 * Performs one request. Resolves with the Response for ANY HTTP status —
 * callers decide what a given status means. Rejects with CiAbortError when
 * `signal` fired, or a transient CiHttpError on timeout/network failure.
 *
 * @param {Function} fetchImpl
 * @param {string} url
 * @param {{ method?: string, headers?: object, body?: string, signal?: AbortSignal, timeoutMs?: number, label?: string }} [options]
 * @returns {Promise<Response>}
 */
async function ciFetch(fetchImpl, url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    signal,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    label = 'Request',
  } = options;

  if (signal && signal.aborted) throw new CiAbortError();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  try {
    // Redirects (GitHub job logs 302, Bitbucket finished-step logs 307) point
    // at storage hosts; fetch follows them and drops Authorization cross-origin.
    return await fetchImpl(url, { method, headers, body, signal: combined, redirect: 'follow' });
  } catch (err) {
    if (signal && signal.aborted) throw new CiAbortError();
    if (timeoutSignal.aborted) {
      throw new CiHttpError(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`, { transient: true });
    }
    const cause = err && err.cause && (err.cause.code || err.cause.message);
    throw new CiHttpError(`${label} failed: ${cause || (err && err.message) || 'network error'}.`, { transient: true });
  }
}

/**
 * Reads a response body, mapping stream failures onto the error classes above.
 * @param {Response} response
 * @param {'json'|'text'|'bytes'} kind
 * @param {{ label?: string, signal?: AbortSignal }} [context]
 */
async function readBody(response, kind, { label = 'Request', signal } = {}) {
  try {
    if (kind === 'bytes') return Buffer.from(await response.arrayBuffer());
    const text = await response.text();
    if (kind === 'text') return text;
    return text ? JSON.parse(text) : null;
  } catch (err) {
    if (signal && signal.aborted) throw new CiAbortError();
    if (err instanceof SyntaxError) throw new CiHttpError(`${label} returned an invalid JSON body.`);
    throw new CiHttpError(`${label} failed while reading the response: ${err.message}.`, { transient: true });
  }
}

/** Consumes and discards a body so the underlying connection can be reused. */
async function drain(response) {
  try {
    await response.arrayBuffer();
  } catch (_err) {
    // Nothing useful to do — the body is being thrown away anyway.
  }
}

/** True for errors worth retrying with backoff (network, timeout, 5xx, 429, rate-limited 403). */
function isTransientError(err) {
  return Boolean(err && err.transient === true);
}

module.exports = {
  CiHttpError,
  CiAbortError,
  ciFetch,
  readBody,
  drain,
  toHttpError,
  parseRetryAfterMs,
  isTransientError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  LOG_NOT_AVAILABLE_BUDGET_MS,
};
