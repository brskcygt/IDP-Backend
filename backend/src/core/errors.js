'use strict';

/**
 * Typed errors for the transport-agnostic core (T-58).
 *
 * `src/core/**` never knows about HTTP status codes — it throws one of
 * these instead, and the calling transport (today: the Express layer in
 * `src/server.js` / `src/http/errorMapper.js`; eventually: an Electron IPC
 * handler) decides how to represent it to its own caller.
 */

/** The requested resource does not exist. */
class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** The caller's input failed validation or is otherwise malformed. */
class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

/** The request conflicts with the resource's current state. */
class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** The caller is not allowed to perform this action. */
class PermissionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermissionError';
  }
}

module.exports = { NotFoundError, ValidationError, ConflictError, PermissionError };
