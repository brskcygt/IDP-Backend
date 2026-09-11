'use strict';

/**
 * CI Pipeline provider — client factory and shared helpers.
 *
 * `createCiClient()` returns a BitbucketPipelinesClient or GitHubActionsClient
 * for a ciConfig; both implement the same interface (see either file's
 * header). Used by CiPipelineAdapter (deploys) and by
 * core/diagnostics/checks/ciPipeline.js ("Test Connection").
 */

const { fetch: undiciFetch } = require('undici');
const { createScrubber } = require('../../services/vpn/logScrubber');
const config = require('./config');
const { DEFAULT_REQUEST_TIMEOUT_MS } = require('./http');
const BitbucketPipelinesClient = require('./BitbucketPipelinesClient');
const GitHubActionsClient = require('./GitHubActionsClient');

/**
 * @param {object} ciConfig - raw or normalized `project.config.ciConfig`.
 * @param {object} [options]
 * @param {string} options.token - `project.config.apiToken` (resolved plaintext).
 * @param {string} [options.username] - Atlassian email for Bitbucket basic auth.
 * @param {Function} [options.fetchImpl] - defaults to undici's fetch; tests inject a fake.
 * @param {AbortSignal} [options.signal] - aborts polling requests.
 * @param {number} [options.requestTimeoutMs] - per-request timeout (default 15s).
 * @param {(ms: number) => Promise<void>} [options.sleep] - GitHub 204-fallback lookup delay.
 * @param {{ intervalMs?: number, timeoutMs?: number }} [options.correlation] - GitHub 204-fallback timing.
 * @returns {BitbucketPipelinesClient|GitHubActionsClient}
 */
function createCiClient(ciConfig, {
  token,
  username,
  fetchImpl = undiciFetch,
  signal,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  sleep,
  correlation,
} = {}) {
  const normalized = config.normalizeCiConfig(ciConfig);
  const options = { token, username, fetchImpl, signal, requestTimeoutMs, sleep, correlation };
  if (normalized.platform === 'bitbucket') return new BitbucketPipelinesClient(normalized, options);
  if (normalized.platform === 'github') return new GitHubActionsClient(normalized, options);
  throw new Error("Unsupported CI platform — set ciConfig.platform to 'bitbucket' or 'github'.");
}

/**
 * Scrubber that removes the token — and the Basic credential built from it —
 * from any string before it is logged or put in an error message.
 * @param {{ token?: string, username?: string }} credentials
 * @returns {(text: string) => string}
 */
function createCiScrubber({ token, username } = {}) {
  const secrets = [];
  if (typeof token === 'string' && token !== '') {
    secrets.push(token);
    if (typeof username === 'string' && username !== '') {
      const basic = `${username}:${token}`;
      secrets.push(basic, Buffer.from(basic).toString('base64'));
    }
  }
  return createScrubber(secrets);
}

module.exports = {
  ...config,
  createCiClient,
  createCiScrubber,
  BitbucketPipelinesClient,
  GitHubActionsClient,
};
