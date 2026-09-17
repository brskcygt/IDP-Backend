'use strict';

/**
 * Jenkins' progressive text API interleaves the real console output with
 * ConsoleNote markers: a base64 blob starting with `ha:////` wrapped in the
 * ANSI "conceal" sequence (ESC[8m … ESC[0m). Jenkins' own web UI hides them,
 * but our terminal strips ANSI codes for readability, which left long
 * unreadable base64 runs in front of otherwise useful lines
 * (`ha:////4Ab9Ea8WFFxr…[Pipeline] // dir`).
 *
 * They carry no information for the operator, so they are removed here — at
 * the source — which also keeps them out of the archived log text.
 */

/** ConsoleNote as Jenkins emits it: concealed via ESC[8m … ESC[0m. */
// eslint-disable-next-line no-control-regex
const CONCEALED_NOTE = /\[8m.*?\[0m/g;
/** The same marker once something has already dropped the ANSI codes. */
const BARE_NOTE = /ha:\/\/\/\/[A-Za-z0-9+/]+={0,2}/g;
/** Trailing carriage returns from Windows agents. */
const TRAILING_CR = /\r+$/;

/**
 * Removes Jenkins ConsoleNote markers from a single console line.
 * @param {string} line
 * @returns {string} the line without markers; may end up empty
 */
function stripConsoleNotes(line) {
	return String(line)
		.replace(CONCEALED_NOTE, '')
		.replace(BARE_NOTE, '')
		.replace(TRAILING_CR, '')
		.trimEnd();
}

/**
 * Splits a progressive-text chunk into the lines worth showing: markers are
 * stripped and lines that consisted only of a marker are dropped.
 * @param {string} chunk
 * @returns {string[]}
 */
function consoleLines(chunk) {
	const lines = [];
	for (const raw of String(chunk).split('\n')) {
		const line = stripConsoleNotes(raw);
		if (line.trim() !== '') lines.push(line);
	}
	return lines;
}

module.exports = { stripConsoleNotes, consoleLines };
