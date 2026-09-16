'use strict';

/**
 * Barrel export for the transport-agnostic core (T-58).
 *
 * Nothing under `src/core/**` (including this file) may require `express`,
 * `cookie-parser`, or `express-session`, or reference `req`/`res` — see
 * `backend/scripts/check-core-boundaries.js`, wired into `npm run lint`.
 */
const errors = require('./errors');
const projectService = require('./projects/projectService');
const deploymentService = require('./deployment/deploymentService');
const { testProjectConnection } = require('./diagnostics/connectionTest');

module.exports = {
  ...errors,
  errors,
  projectService,
  deploymentService,
  testProjectConnection,
};
