/**
 * Tests for T-93: the injectable `elevationProvider` slot
 * (`backend/src/services/vpn/elevationProvider.js`) that VpnManager uses to
 * run root-requiring commands (today: only the fortinet/openfortivpn
 * branch), plus the argument-escaping guarantee made by the real macOS
 * implementation (`desktop/main/elevation/osElevation.js`).
 *
 * SEC-02 (`POST /api/vpn/grant-permissions`, removed) was a command
 * injection bug: user input was concatenated straight into a shell string.
 * The escaping tests below exist specifically so that bug class can never
 * silently come back — they build a real shell command via osElevation's
 * quoting helpers and execute it with a real shell, proving a malicious
 * argument is treated as inert data, not as a second command.
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VpnManager = require('../src/services/vpn/VpnManager');
const {
  setElevationProvider,
  getElevationProvider,
} = require('../src/services/vpn/elevationProvider');
const { REDACTED } = require('../src/services/vpn/logScrubber');
const {
  buildShellCommand,
  shellQuote,
} = require('../../desktop/main/elevation/osElevation');

// ---------------------------------------------------------------------------
// Pluggability: registered provider is used; absent provider falls back to
// the pre-T-93 sudo-spawn behavior.
// ---------------------------------------------------------------------------

test('setElevationProvider/getElevationProvider round-trip, and reject non-function/non-null', () => {
  assert.equal(getElevationProvider(), null, 'no provider registered by default');

  const fn = async () => {};
  setElevationProvider(fn);
  assert.equal(getElevationProvider(), fn);

  setElevationProvider(null);
  assert.equal(getElevationProvider(), null);

  assert.throws(() => setElevationProvider('not a function'), TypeError);
  assert.throws(() => setElevationProvider(123), TypeError);
});

test('spawnElevatedAndWait uses the registered provider instead of spawning sudo', async () => {
  const calls = [];
  const fakeChild = spawn('echo', ['tunnel is up and running']);
  setElevationProvider(async (opts) => {
    calls.push(opts);
    return fakeChild;
  });

  const lines = [];
  try {
    await VpnManager.spawnElevatedAndWait(
      'openfortivpn',
      ['vpn.example.com:443', '-u', 'operator', '-p', 'secret', '--persistent=0'],
      'up and running',
      (line) => lines.push(line),
      {},
      { vpnConfig: { type: 'fortinet', host: 'vpn.example.com', username: 'operator', password: 'secret' } },
      'test reason'
    );
  } finally {
    setElevationProvider(null);
  }

  assert.equal(calls.length, 1, 'expected the registered provider to be invoked exactly once');
  // The provider receives an ABSOLUTE path, not the bare name. A desktop app
  // launched from Finder has no Homebrew on its PATH, and handing an
  // unqualified name to a root shell would let PATH pick the binary.
  assert.ok(
    path.isAbsolute(calls[0].command),
    `expected an absolute path, got: ${calls[0].command}`
  );
  assert.equal(path.basename(calls[0].command), 'openfortivpn');
  assert.deepEqual(calls[0].args, ['vpn.example.com:443', '-u', 'operator', '-p', 'secret', '--persistent=0']);
  assert.equal(calls[0].reason, 'test reason');
  assert.ok(!lines.some((l) => l.includes('falling back to sudo')), 'must not have used the sudo fallback path');
  assert.ok(!lines.some((l) => l.includes('secret')), 'password must still be redacted on the elevated path');
  assert.ok(lines.some((l) => l.includes(REDACTED)));
});

test('spawnElevatedAndWait falls back to spawning sudo directly when no provider is registered (pre-T-93 behavior)', async () => {
  setElevationProvider(null);
  const lines = [];

  // `sudo` isn't authorized non-interactively in this environment, so this
  // is expected to reject — we only care that it actually ATTEMPTED the
  // legacy `sudo <command> <args>` path rather than silently doing nothing.
  await assert.rejects(() =>
    VpnManager.spawnElevatedAndWait(
      'openfortivpn',
      ['vpn.example.com:443', '-u', 'operator', '-p', 'secret', '--persistent=0'],
      'up and running',
      (line) => lines.push(line),
      {},
      { vpnConfig: { type: 'fortinet', host: 'vpn.example.com', username: 'operator', password: 'secret' } }
    )
  );

  assert.ok(
    lines.some((l) => l.includes('No OS elevation provider registered') && l.includes('sudo')),
    'expected the legacy sudo-fallback notice to be logged'
  );
});

test('a provider rejection (administrator approval declined) surfaces as a clear error, not a hang or crash', async () => {
  setElevationProvider(async () => {
    throw new Error('Administrator approval was declined by the user.');
  });

  try {
    await assert.rejects(
      () =>
        VpnManager.spawnElevatedAndWait(
          'openfortivpn',
          ['vpn.example.com:443'],
          'up and running',
          () => {},
          {},
          { vpnConfig: { type: 'fortinet', host: 'vpn.example.com' } }
        ),
      /declined/i
    );
  } finally {
    setElevationProvider(null);
  }
});

// ---------------------------------------------------------------------------
// Argument escaping (SEC-02 regression guard) — exercises the REAL quoting
// helpers used by desktop/main/elevation/osElevation.js's `elevate()` before
// it ever hands a string to osascript/`do shell script`.
// ---------------------------------------------------------------------------

test('argument escaping: a shell-metacharacter payload does not inject a second command', () => {
  const markerFile = path.join(os.tmpdir(), `idp-elevation-escape-test-${Date.now()}-${process.pid}.marker`);
  try {
    // The classic injection shape from SEC-02: a value that tries to end
    // the current command and start a new one. Using `touch <marker>`
    // instead of `rm -rf /` proves the exact same thing (arbitrary command
    // execution) without doing anything destructive.
    const malicious = `x"; touch ${markerFile}; echo "pwned`;
    const shellCommand = buildShellCommand('echo', [malicious]);

    const output = execFileSync('sh', ['-c', shellCommand], { encoding: 'utf8' });

    assert.equal(output.trim(), malicious, 'echo must print the payload back literally, unmodified by the shell');
    assert.equal(fs.existsSync(markerFile), false, 'the injected `touch` command must never have executed');
  } finally {
    try { fs.unlinkSync(markerFile); } catch (_err) { /* wasn't created — that's the point of this test */ }
  }
});

test('argument escaping: a semicolon-chained rm-style payload is treated as inert data', () => {
  const markerFile = path.join(os.tmpdir(), `idp-elevation-escape-test-rm-${Date.now()}-${process.pid}.marker`);
  fs.writeFileSync(markerFile, 'must survive');
  try {
    const malicious = `; rm -f ${markerFile} #`;
    const shellCommand = buildShellCommand('echo', [malicious]);
    execFileSync('sh', ['-c', shellCommand], { encoding: 'utf8' });

    assert.equal(fs.existsSync(markerFile), true, 'the marker file must survive — the payload must not run as a command');
  } finally {
    try { fs.unlinkSync(markerFile); } catch (_err) { /* already gone / never existed */ }
  }
});

test('argument escaping: an embedded single quote does not break out of the quoted token', () => {
  const payload = `it's a test; rm -rf /tmp/should-not-be-touched`;
  const shellCommand = buildShellCommand('echo', [payload]);
  const output = execFileSync('sh', ['-c', shellCommand], { encoding: 'utf8' });
  assert.equal(output.trim(), payload);
});

test('shellQuote wraps every value in single quotes and escapes embedded single quotes', () => {
  assert.equal(shellQuote('plain'), "'plain'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test('buildShellCommand quotes every argument independently, preserving argument boundaries', () => {
  const cmd = buildShellCommand('kill', ['-TERM', '12345']);
  assert.equal(cmd, "'kill' '-TERM' '12345'");
});

// ---------------------------------------------------------------------------
// Platform guard
// ---------------------------------------------------------------------------

test('elevate() gives a clear "not implemented" error on a non-macOS platform', async () => {
  const { elevate } = require('../../desktop/main/elevation/osElevation');
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    await assert.rejects(
      () => elevate({ command: 'openfortivpn', args: [], onLog: () => {} }),
      /not implemented on this platform/i
    );
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});
