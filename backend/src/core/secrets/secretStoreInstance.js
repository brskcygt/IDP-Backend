'use strict';

/**
 * Shared encrypted credential store singleton (T-10 / SEC-01), used by every
 * core service that touches project secrets (`projectService`,
 * `deploymentService`).
 *
 * Extracted so the store is constructed exactly once — previously
 * `server.js` created it at module load and every helper (persist/resolve/
 * delete project secrets) received it as an argument. Now that the same
 * secrets need to be reachable from two separate core modules, this gives
 * both a single shared instance instead of each constructing (and each
 * `describeKeyStatus()`-logging) its own.
 *
 * `null` when IDP_SECRET_KEY is not configured — every helper that
 * receives `null` here is a documented pass-through (see
 * secrets/projectSecrets.js), so an install without encryption set up
 * still deploys rather than failing at the first credential.
 */
const { createSecretStore } = require('../../secrets');
const { describeKeyStatus } = require('../../secrets/keyManager');

const secretStore = createSecretStore();

// Ask the store what it is rather than inferring from IDP_SECRET_KEY. With
// safeStorage in the picture, "IDP_SECRET_KEY is not set" no longer implies
// "secrets are unprotected" — it would be an actively false startup message.
console.log(secretStore ? secretStore.describe() : describeKeyStatus().message);

module.exports = secretStore;
