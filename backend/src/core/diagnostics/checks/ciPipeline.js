'use strict';

/**
 * CI Pipeline checks (Bitbucket Pipelines / GitHub Actions): read-only API
 * verification — repository access, pipeline/workflow existence, and a
 * best-effort look at the pipeline definition. Never triggers a run.
 */

const { makeCheck } = require('./shared');
const { normalizeCiConfig, findMissingCiFields, createCiScrubber } = require('../../../adapters/ci');

/**
 * @param {object} args
 * @param {object} args.config - resolved (secrets decrypted, environment merged) project config.
 * @param {Function} args.createCiClient - factory, injectable for tests (see adapters/ci/index.js).
 * @param {Function} [args.fetchImpl] - forwarded to the client factory.
 * @param {number} args.timeoutMs - per-request timeout.
 * @returns {Promise<{ name: string, ok: boolean|null, detail: string }[]>}
 */
async function testCiPipeline({ config, createCiClient, fetchImpl, timeoutMs }) {
  const ciConfig = normalizeCiConfig(config.ciConfig);
  const token = config.apiToken;
  const username = config.username;

  const missing = findMissingCiFields(ciConfig, { token, username });
  if (missing.length > 0) {
    return [
      makeCheck('Configuration', false, `CI Pipeline settings are incomplete — missing: ${missing.join(', ')}.`),
    ];
  }

  // Provider error messages are echoed into check details; make sure the
  // token can never ride along.
  const scrub = createCiScrubber({ token, username });
  try {
    const client = createCiClient(ciConfig, { token, username, fetchImpl, requestTimeoutMs: timeoutMs });
    const result = await client.verify();
    const checks = result && Array.isArray(result.checks) ? result.checks : [];
    return checks.map((item) => makeCheck(item.name, item.ok, scrub(String(item.detail))));
  } catch (err) {
    return [makeCheck('CI Pipeline API', false, scrub(`Could not verify the CI pipeline: ${err && err.message}`))];
  }
}

module.exports = { testCiPipeline };
