'use strict';

/**
 * Maps a `core/errors.js` typed error to an HTTP status + response body
 * (T-58). The core layer never knows about status codes; this is the one
 * place that translates its error taxonomy into Express responses.
 *
 *   NotFoundError    → 404
 *   ValidationError  → 400 (includes `details` when the error carries them)
 *   ConflictError    → 409
 *   PermissionError  → 403
 *   UpstreamError    → 502
 *   anything else    → 500
 */
const { NotFoundError, ValidationError, ConflictError, PermissionError, UpstreamError } = require('../core/errors');

/**
 * @param {Error} err
 * @returns {{ status: number, body: object }}
 */
function mapErrorToResponse(err) {
  if (err instanceof NotFoundError) {
    return { status: 404, body: { error: err.message } };
  }
  if (err instanceof ValidationError) {
    return {
      status: 400,
      body: err.details !== undefined ? { error: err.message, details: err.details } : { error: err.message },
    };
  }
  if (err instanceof ConflictError) {
    return { status: 409, body: { error: err.message } };
  }
  if (err instanceof PermissionError) {
    return { status: 403, body: { error: err.message } };
  }
  if (err instanceof UpstreamError) {
    return { status: 502, body: { error: err.message } };
  }
  return { status: 500, body: { error: err.message } };
}

/**
 * Sends the mapped error response on `res`.
 * @param {import('express').Response} res
 * @param {Error} err
 */
function sendError(res, err) {
  const { status, body } = mapErrorToResponse(err);
  res.status(status).json(body);
}

module.exports = { mapErrorToResponse, sendError };
