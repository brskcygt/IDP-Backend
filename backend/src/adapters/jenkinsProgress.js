'use strict';

/**
 * Jenkins reports no stage markers we could count, but every build carries
 * `estimatedDuration` — the average of previous runs of the same job — plus the
 * timestamp it started at. That is enough for an honest estimate, which is what
 * the release-build progress bar shows.
 *
 * Returns null when there is nothing to base an estimate on (a job's first run
 * has estimatedDuration -1), and the caller then leaves the bar indeterminate
 * rather than inventing a number.
 */

/** Never report completion from an estimate — only the real result may do that. */
const MAX_ESTIMATED = 99;

/**
 * @param {{ timestamp?: number, estimatedDuration?: number }} buildInfo Jenkins' build api/json
 * @param {number} [now]
 * @returns {number|null} 1-99, or null when no estimate is possible
 */
function buildPercent(buildInfo, now = Date.now()) {
	const started = Number(buildInfo?.timestamp);
	const estimated = Number(buildInfo?.estimatedDuration);
	if (!Number.isFinite(started) || started <= 0) return null;
	if (!Number.isFinite(estimated) || estimated <= 0) return null;
	const elapsed = now - started;
	if (!Number.isFinite(elapsed) || elapsed < 0) return null;
	return Math.min(MAX_ESTIMATED, Math.max(1, Math.round((elapsed / estimated) * 100)));
}

module.exports = { buildPercent, MAX_ESTIMATED };
