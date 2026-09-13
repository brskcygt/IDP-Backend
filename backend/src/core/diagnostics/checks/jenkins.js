'use strict';

const { jenkinsJobPath } = require('../../../adapters/jenkinsPaths');

/** T-73 Jenkins checks: API reachability/auth, then read-only job existence. */

const { makeCheck, withTimeout } = require('./shared');

function translateJenkinsError(err) {
  const msg = (err && err.message) || String(err);
  if (/Cannot reach Jenkins/i.test(msg)) return msg;
  if (/authentication failed/i.test(msg)) {
    return 'Authentication failed — check the username or the credential in project settings.';
  }
  if (/timed out/i.test(msg)) return 'Connection to Jenkins timed out — check the URL and network/firewall rules.';
  return `Could not reach Jenkins: ${msg}`;
}

async function testJenkins({ config, appConfig, JenkinsAdapter, timeoutMs }) {
  const url = config.url || appConfig?.jenkins?.url;
  const username = config.username || appConfig?.jenkins?.user;
  const apiToken = config.apiToken || appConfig?.jenkins?.apiToken;
  const jobName = config.jobName;

  if (!url) {
    return [makeCheck('Jenkins API', false, 'No Jenkins URL configured — set it in project settings.')];
  }

  const adapter = new JenkinsAdapter({ url, username, apiToken, jobName });
  const logLines = [];
  adapter.onLog((line) => logLines.push(line));

  let apiOk = true;
  let apiDetail = 'Connected and authenticated.';
  try {
    await withTimeout(adapter.connect(), timeoutMs, 'Jenkins API');
    // JenkinsAdapter#connect() swallows anything that isn't a hard
    // connectivity/auth failure (see JenkinsAdapter.js) and just logs a
    // warning instead of throwing — a "test connection" feature should
    // surface that ambiguity rather than silently reporting success.
    const warningLine = logLines.find((line) => line.includes('Could not verify Jenkins API'));
    if (warningLine) {
      apiOk = false;
      apiDetail = 'Could not verify the Jenkins API — check the URL in project settings.';
    } else {
      const successLine = logLines.find((line) => line.includes('Connected to Jenkins'));
      apiDetail = successLine ? successLine.replace(/^.*?\]\s*/, '') : apiDetail;
    }
  } catch (err) {
    apiOk = false;
    apiDetail = translateJenkinsError(err);
  }

  const checks = [makeCheck('Jenkins API', apiOk, apiDetail)];

  if (!jobName) {
    checks.push(
      makeCheck('Jenkins Job', null, 'No job name configured — set one in project settings to verify it exists.')
    );
  } else if (!apiOk) {
    checks.push(makeCheck('Jenkins Job', null, 'Not tested — the Jenkins API check above failed.'));
  } else {
    try {
      // Read-only: fetches the job's own /api/json, never triggers a build.
      await withTimeout(adapter.client.get(`${jenkinsJobPath(jobName)}/api/json`), timeoutMs, 'Jenkins Job');
      checks.push(makeCheck('Jenkins Job', true, `Job '${jobName}' exists.`));
    } catch (err) {
      const status = err && err.response && err.response.status;
      if (status === 404) {
        checks.push(makeCheck('Jenkins Job', false, `Job '${jobName}' was not found — check the job name in project settings.`));
      } else if (status === 401 || status === 403) {
        checks.push(makeCheck('Jenkins Job', false, 'Authentication failed — check the username or the credential in project settings.'));
      } else {
        checks.push(makeCheck('Jenkins Job', false, `Could not verify the job: ${err.message}`));
      }
    }
  }

  return checks;
}

module.exports = { testJenkins };
