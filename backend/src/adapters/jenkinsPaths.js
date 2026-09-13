'use strict';

/**
 * Jenkins addresses nested folder jobs as:
 *   team/release -> /job/team/job/release
 *
 * Encoding the complete name (`team%2Frelease`) does not work because `/`
 * represents the folder boundary in Jenkins' remote API.
 */
function jenkinsJobPath(jobName) {
  const segments = String(jobName || '').split('/').filter(Boolean);
  if (segments.length === 0) throw new Error('Jenkins job name is required.');
  return `/${segments.map((segment) => `job/${encodeURIComponent(segment)}`).join('/')}`;
}

module.exports = { jenkinsJobPath };
