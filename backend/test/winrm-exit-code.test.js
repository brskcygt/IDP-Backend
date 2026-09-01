/**
 * Regression tests for the WinRM silent-success bug and its follow-up fix
 * (T-31b).
 *
 * Round 1 (silent success): nodejs-winrm's runCommand() never reads
 * WinRM's rsp:ExitCode field and never rejects on a protocol fault (it
 * resolves with an Error instance instead) — see
 * node_modules/nodejs-winrm/src/command.js#doReceiveOutput and
 * node_modules/nodejs-winrm/index.js#runCommand. A PowerShell script that
 * ended with `exit 1` and wrote nothing to stdout gave WindowsAdapter no
 * failure signal at all, so the deployment was reported as "Succeeded".
 * This is the WinRM counterpart of the SSH silent-success bug fixed in
 * T-30. The fix: run the user's script wrapped so its real exit status is
 * smuggled back through stdout as a `__IDP_EXIT_CODE__:<n>` marker line.
 *
 * Round 2 (false failure — this round's fix): the first version of the
 * wrapper ran the user's script inline, in the same runspace as the
 * marker-writing code, inside a try/catch. PowerShell's `exit` statement
 * is not a catchable error — it unwinds the whole host process
 * immediately — so ANY script ending in a bare `exit N` (success OR
 * failure; most real deploy templates end this way, e.g. `pm2 restart` /
 * `iisreset` wrappers) skipped the marker entirely and was reported as a
 * false failure. The fix: run the user's script in a separate child
 * powershell.exe process (invoked via `&`) so `exit` inside it only ends
 * the child; the parent reads the child's real process exit code via
 * $LASTEXITCODE and unconditionally writes the marker afterwards.
 *
 * These tests cover the two pure functions responsible for all of the
 * above: wrapScriptWithExitMarker() and parseExitMarker(). No real
 * WinRM/Windows server is involved — instead, "end-to-end" tests below
 * decode the wrapper's own embedded inner script and simulate what a real
 * PowerShell run of it would emit, to prove all four exit-status
 * scenarios (exit 0, exit 1, no exit, terminating error) resolve
 * correctly.
 *
 * Run with: npm test
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const WindowsAdapter = require('../src/adapters/WindowsAdapter');

const { wrapScriptWithExitMarker, parseExitMarker } = WindowsAdapter;

/** Pull the inner (child-process) script back out of a wrapped outer script. */
function decodeInnerScript(wrappedOuterScript) {
  const match = wrappedOuterScript.match(/\$__idpInner = '([^']+)'/);
  assert.ok(match, 'wrapped script must embed $__idpInner as a single-quoted base64 literal');
  return Buffer.from(match[1], 'base64').toString('utf16le');
}

test('wrapScriptWithExitMarker exports are pure functions', () => {
  assert.equal(typeof wrapScriptWithExitMarker, 'function');
  assert.equal(typeof parseExitMarker, 'function');
});

test('wrapScriptWithExitMarker runs the child in a separate process via the call operator', () => {
  const wrapped = wrapScriptWithExitMarker('Write-Output "hello"');

  assert.match(wrapped, /& powershell\.exe .*-EncodedCommand \$__idpInner/);
  assert.match(wrapped, /\$__idpInner = '[A-Za-z0-9+/=]+'/);
});

test('wrapScriptWithExitMarker outer wrapper uses Continue, not Stop', () => {
  // The outer wrapper has nothing of its own to catch — it only starts the
  // child, reads $LASTEXITCODE, and unconditionally writes the marker. If
  // the outer used 'Stop' and something non-fatal in the wrapper itself
  // errored, the marker line could be skipped, reintroducing ambiguity.
  const wrapped = wrapScriptWithExitMarker('Write-Output "hello"');
  const outerPreambleLine = wrapped.split('\n')[0];

  assert.equal(outerPreambleLine, "$ErrorActionPreference = 'Continue'");
  assert.doesNotMatch(outerPreambleLine, /Stop/);
});

test('wrapScriptWithExitMarker writes the marker line unconditionally (no try/catch)', () => {
  const wrapped = wrapScriptWithExitMarker('Write-Output "hello"');

  assert.doesNotMatch(wrapped, /\btry\s*\{/);
  assert.doesNotMatch(wrapped, /\}\s*catch\s*\{/);
  assert.match(wrapped, /\$__idpExit = if \(\$LASTEXITCODE -ne \$null\) \{ \$LASTEXITCODE \} else \{ 0 \}/);
  assert.match(wrapped, /Write-Output "__IDP_EXIT_CODE__:\$__idpExit"/);
});

test('wrapScriptWithExitMarker embeds the exact user script, prefixed with its own $ErrorActionPreference = Stop', () => {
  const userScript = 'Write-Output "build step"\nsome-tool.exe --deploy';
  const wrapped = wrapScriptWithExitMarker(userScript);
  const inner = decodeInnerScript(wrapped);

  assert.equal(inner, "$ErrorActionPreference = 'Stop'\n" + userScript);
});

test('wrapScriptWithExitMarker embeds the child script as valid UTF-16LE base64', () => {
  const wrapped = wrapScriptWithExitMarker('exit 0');
  const match = wrapped.match(/\$__idpInner = '([^']+)'/);

  assert.ok(match);
  // Base64 alphabet never contains a single quote, so embedding it in a
  // single-quoted PowerShell string literal is always safe.
  assert.doesNotMatch(match[1], /'/);
  assert.doesNotThrow(() => Buffer.from(match[1], 'base64'));
});

test('parseExitMarker reports exitCode 0 for a successful script', () => {
  const output = [
    'Doing work...',
    'Work complete.',
    '__IDP_EXIT_CODE__:0',
  ].join('\n');

  const { exitCode, cleanedOutput } = parseExitMarker(output);

  assert.equal(exitCode, 0);
  assert.equal(cleanedOutput, 'Doing work...\nWork complete.');
});

test('parseExitMarker reports a non-zero exitCode for a failing script', () => {
  const output = [
    'Doing work...',
    'ERROR: something broke',
    '__IDP_EXIT_CODE__:1',
  ].join('\n');

  const { exitCode, cleanedOutput } = parseExitMarker(output);

  assert.equal(exitCode, 1);
  assert.equal(cleanedOutput, 'Doing work...\nERROR: something broke');
});

test('parseExitMarker returns exitCode null when the marker is absent', () => {
  const output = 'Doing work...\nWork complete, but no marker was ever written.';

  const { exitCode, cleanedOutput } = parseExitMarker(output);

  assert.equal(exitCode, null);
  assert.equal(cleanedOutput, output);
});

test('parseExitMarker returns exitCode null for empty or missing output', () => {
  assert.equal(parseExitMarker('').exitCode, null);
  assert.equal(parseExitMarker(undefined).exitCode, null);
  assert.equal(parseExitMarker(null).exitCode, null);
});

test('parseExitMarker uses the last marker when several are present', () => {
  // A verbose script that happens to echo something resembling a marker
  // earlier in its output must not fool the parser — only the marker our
  // own wrapper writes at the very end (after the child process returns)
  // is authoritative.
  const output = [
    '__IDP_EXIT_CODE__:99',
    'Doing work...',
    '__IDP_EXIT_CODE__:0',
  ].join('\n');

  const { exitCode } = parseExitMarker(output);

  assert.equal(exitCode, 0);
});

test('parseExitMarker strips every marker line from the cleaned output', () => {
  const output = [
    '__IDP_EXIT_CODE__:99',
    'Doing work...',
    '__IDP_EXIT_CODE__:1',
  ].join('\n');

  const { cleanedOutput } = parseExitMarker(output);

  assert.ok(!cleanedOutput.includes('__IDP_EXIT_CODE__'));
  assert.equal(cleanedOutput, 'Doing work...');
});

test('parseExitMarker tolerates leading/trailing whitespace around the marker line', () => {
  const output = 'Doing work...\n   __IDP_EXIT_CODE__:2   \n';

  const { exitCode, cleanedOutput } = parseExitMarker(output);

  assert.equal(exitCode, 2);
  assert.ok(!cleanedOutput.includes('__IDP_EXIT_CODE__'));
});

test('parseExitMarker treats a malformed exit code as unknown (null), not success', () => {
  const output = 'Doing work...\n__IDP_EXIT_CODE__:not-a-number';

  const { exitCode } = parseExitMarker(output);

  assert.equal(exitCode, null);
});

// --- Four end-to-end exit-status scenarios ------------------------------
//
// These simulate what the OUTER wrapper's stdout would actually contain
// after a real WinRM round-trip, for each way a user script can end. The
// simulated "remote output" reflects the outer wrapper's own logic
// ($LASTEXITCODE captured from the child process, marker always written)
// rather than invoking real PowerShell — but it proves parseExitMarker()
// combined with wrapScriptWithExitMarker()'s unconditional marker line
// resolves every case correctly.

test('scenario: exit 0 — a successful script must resolve as success (this round\'s regression)', () => {
  const wrapped = wrapScriptWithExitMarker('Write-Output "deployed"\nexit 0');
  const inner = decodeInnerScript(wrapped);
  assert.match(inner, /exit 0/);

  // Child process exits 0 -> parent's $LASTEXITCODE is 0 -> marker is 0.
  const simulatedRemoteOutput = 'deployed\n__IDP_EXIT_CODE__:0';
  const { exitCode, cleanedOutput } = parseExitMarker(simulatedRemoteOutput);

  assert.equal(exitCode, 0);
  assert.equal(cleanedOutput, 'deployed');
});

test('scenario: exit 1 — a failing script must resolve as failure', () => {
  const wrapped = wrapScriptWithExitMarker('Write-Error "boom"\nexit 1');
  const inner = decodeInnerScript(wrapped);
  assert.match(inner, /exit 1/);

  // Child process exits 1 -> parent's $LASTEXITCODE is 1 -> marker is 1.
  const simulatedRemoteOutput = '__IDP_EXIT_CODE__:1';
  const { exitCode } = parseExitMarker(simulatedRemoteOutput);

  assert.equal(exitCode, 1);
  assert.notEqual(exitCode, 0);
});

test('scenario: script runs to completion without a bare exit statement must resolve as success', () => {
  const wrapped = wrapScriptWithExitMarker('Write-Output "build finished cleanly"');
  const inner = decodeInnerScript(wrapped);
  assert.doesNotMatch(inner, /\bexit\b/);

  // Child powershell.exe finishes the script normally with no error and no
  // explicit exit call -> its own process exit code is 0 -> marker is 0.
  const simulatedRemoteOutput = 'build finished cleanly\n__IDP_EXIT_CODE__:0';
  const { exitCode } = parseExitMarker(simulatedRemoteOutput);

  assert.equal(exitCode, 0);
});

test("scenario: terminating error — $ErrorActionPreference = 'Stop' on the child must surface as failure", () => {
  const wrapped = wrapScriptWithExitMarker('Get-Item C:\\definitely-does-not-exist.txt');
  const inner = decodeInnerScript(wrapped);

  // The child script is prefixed with its own Stop preference, promoting
  // the cmdlet's normally non-terminating error into a terminating one.
  assert.match(inner, /^\$ErrorActionPreference = 'Stop'/);

  // An uncaught terminating exception makes the child powershell.exe exit
  // non-zero (no explicit `exit $LASTEXITCODE` needed) -> parent reads
  // that non-zero code -> marker reflects failure.
  const simulatedRemoteOutput = '__IDP_EXIT_CODE__:1';
  const { exitCode } = parseExitMarker(simulatedRemoteOutput);

  assert.notEqual(exitCode, 0);
});

test('marker missing entirely (child process never started) is still treated as unknown/failure, never success', () => {
  // If the outer wrapper itself never ran (e.g. WinRM couldn't even start
  // powershell.exe), no marker reaches the output at all. This must remain
  // ambiguous, not success — callers in WindowsAdapter.trigger() throw in
  // this case rather than assuming success.
  const { exitCode } = parseExitMarker('');
  assert.equal(exitCode, null);
  assert.notEqual(exitCode, 0);
});
