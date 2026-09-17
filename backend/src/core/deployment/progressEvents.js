'use strict';

/**
 * Structured events travel to the UI inside the log stream: a line prefixed
 * with `__EVENT__:` followed by JSON. There is no separate SSE channel, so any
 * producer that can push a log line can also report progress.
 *
 * The UI pulls these lines out of the stream (frontend/src/lib/deployProgress.ts)
 * and feeds the progress bar with them, which is why they must never be shown
 * as text: the prefix is the contract between the two sides.
 */

const EVENT_LINE_PREFIX = '__EVENT__:';

/** Event type for adapters that can only estimate progress from elapsed time. */
const BUILD_PROGRESS_EVENT = 'build_progress';

/**
 * Serialises an event as a log line.
 * @param {string} type
 * @param {object} payload
 * @returns {string}
 */
function formatEventLine(type, payload) {
	return `${EVENT_LINE_PREFIX}${JSON.stringify({ type, payload })}`;
}

/**
 * Parses a log line back into an event, or null when the line is ordinary output.
 * @param {string} line
 * @returns {{ type: string, payload: object }|null}
 */
function parseEventLine(line) {
	const text = String(line);
	const at = text.indexOf(EVENT_LINE_PREFIX);
	if (at === -1) return null;
	try {
		const event = JSON.parse(text.slice(at + EVENT_LINE_PREFIX.length));
		return event && typeof event.type === 'string' ? event : null;
	} catch {
		return null;
	}
}

module.exports = { EVENT_LINE_PREFIX, BUILD_PROGRESS_EVENT, formatEventLine, parseEventLine };
