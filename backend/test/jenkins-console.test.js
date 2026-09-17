'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { stripConsoleNotes, consoleLines } = require('../src/adapters/jenkinsConsole');

const ESC = '\u001b';

test('stripConsoleNotes removes a concealed ConsoleNote and keeps the message', () => {
	const line = `${ESC}[8mha:////4Ab9Ea8WFFxr9kZUkD3JMQnUOfrN/wh1IBUZsM7fP5WW${ESC}[0m[Pipeline] // dir`;
	assert.equal(stripConsoleNotes(line), '[Pipeline] // dir');
});

test('stripConsoleNotes also handles markers whose ANSI codes were already stripped', () => {
	// This is the shape that reached the UI: the terminal removes ANSI codes, so
	// only the base64 blob was left in front of the real text.
	const line = 'ha:////4NU2DP0WbR2Eu/HFsgr11Wt5f4r21IJxol/dZf3Lo2suAAAApR+LCAAAAAAAAP9tjTEOwjAQBC9BFLSUPOJCBUgoFa==[Pipeline] }';
	assert.equal(stripConsoleNotes(line), '[Pipeline] }');
});

test('stripConsoleNotes leaves ordinary output untouched', () => {
	const line = 'C:\\jenkins-ws\\jetsrm-release>tar -czf "artifacts/jetsrm-backend-0.0.6-win-x64.tar.gz"';
	assert.equal(stripConsoleNotes(line), line);
	assert.equal(stripConsoleNotes('[2026-09-17T18:52:59.081Z] - built in 1m 9s'), '[2026-09-17T18:52:59.081Z] - built in 1m 9s');
});

test('stripConsoleNotes does not eat http URLs that merely contain slashes', () => {
	const line = 'Use build.rollupOptions.output.manualChunks: https://rollupjs.org/configuration-options/#output';
	assert.equal(stripConsoleNotes(line), line);
});

test('consoleLines drops marker-only lines, blank lines and trailing carriage returns', () => {
	const chunk = [
		`${ESC}[8mha:////4PCMXFoZhHEoxYw7d9kFhugIL4jIoe9hOHOaLnyWhQry${ESC}[0m`,
		'',
		'[Pipeline] bat\r',
		'   ',
		`${ESC}[8mha:////4I9WLhcXljiGBaFDQVLlqNpfpA6BFqU${ESC}[0m[Pipeline] stage`,
	].join('\n');
	assert.deepEqual(consoleLines(chunk), [ '[Pipeline] bat', '[Pipeline] stage' ]);
});
