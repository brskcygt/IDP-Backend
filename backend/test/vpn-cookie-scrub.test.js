/**
 * Regression tests for a real secret leak found during T-56/T-93 review
 * (see coordinator note): VpnManager's log scrubber only ever knew about
 * secrets living in `vpnConfig` (plus the stdin payload). A SAML/
 * GlobalProtect session cookie is fetched or resumed at RUNTIME —
 * `mfaVpnHandler.getCachedSession()` or `azureAdMfaHandler.fetchHeadlessCookie()`
 * — and is never a `vpnConfig` field, so it sailed straight past the
 * scrubber and into `[VPN] Executing: ... --cookie <value> ...`, which is
 * archived to `deployments.log_text` and streamed to the browser/IPC —
 * i.e. a durable, exfiltratable VPN credential.
 *
 * The fix threads every such value into `context.extraSecrets` /
 * `spawnCtx.extraSecrets` the moment it's known, and VpnManager's scrubber
 * construction (spawnAndWait/spawnElevatedAndWait, and connect()'s own
 * onLog) reads that array. These tests must fail if that wiring regresses.
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { spawn } = require('node:child_process');
const VpnManager = require('../src/services/vpn/VpnManager');
const mfaVpnHandler = require('../src/services/vpn/MfaVpnHandler');
const { REDACTED } = require('../src/services/vpn/logScrubber');
const { setElevationProvider } = require('../src/services/vpn/elevationProvider');

test('spawnAndWait redacts a runtime secret passed via context.extraSecrets, in both the "Executing:" line and echoed process output', async () => {
  const cookie = 'portal-userauthcookie=SUPERSECRETSESSIONVALUE12345';
  const vpnConfig = { type: 'globalprotect', host: 'vpn.example.com', username: 'operator', password: 'Sup3rSecretPass!' };
  const lines = [];
  const onLog = (line) => lines.push(line);
  const context = { vpnConfig, extraSecrets: [cookie] };

  // Real spawned process (no VPN binary needed): prints an argv-shaped line
  // containing the cookie, the way openconnect echoing back a `--cookie`
  // value (e.g. on a rejected/duplicate session) would.
  await VpnManager.spawnAndWait('echo', [`--cookie ${cookie} --background`], null, onLog, {}, context);

  const combined = lines.join('\n');
  assert.ok(!combined.includes(cookie), 'session cookie leaked into VPN logs');
  assert.ok(combined.includes(REDACTED), 'expected a redaction marker in the captured log lines');

  const execLine = lines.find((l) => l.includes('[VPN] Executing:'));
  assert.ok(execLine, 'expected an "[VPN] Executing:" log line');
  assert.ok(!execLine.includes(cookie), 'cookie leaked specifically in the "[VPN] Executing:" line');
});

test('_establishTunnel scrubs a cached session cookie resumed via mfaVpnHandler.getCachedSession (anyconnect)', async () => {
  const cookie = 'portal-userauthcookie=REALWORLDCACHEDCOOKIE999';
  const originalGetCachedSession = mfaVpnHandler.getCachedSession;
  mfaVpnHandler.getCachedSession = async () => cookie;

  const lines = [];
  const onLog = (line) => lines.push(line);
  const vpnConfig = {
    type: 'anyconnect',
    host: 'vpn.example.com',
    username: 'operator',
    password: 'Sup3rSecretPass!',
    mfaConfig: { rememberSession: true },
  };

  try {
    // openconnect isn't installed in CI — spawn fails (ENOENT) and the
    // promise rejects, which is fine: the "[VPN] Executing:" line is
    // logged synchronously before spawn() even runs.
    await assert.rejects(() => VpnManager._establishTunnel(vpnConfig, onLog, 'proj-1', 'deploy-1'));
  } finally {
    mfaVpnHandler.getCachedSession = originalGetCachedSession;
  }

  const execLine = lines.find((l) => l.includes('[VPN] Executing:'));
  assert.ok(execLine, 'expected an "[VPN] Executing:" log line');
  assert.ok(!execLine.includes(cookie), 'cached session cookie leaked into the executed command line');
  assert.ok(execLine.includes(REDACTED), 'expected the cookie position to be redacted');
});

test('spawnElevatedAndWait also redacts context.extraSecrets, via a registered elevation provider', async () => {
  const cookie = 'portal-userauthcookie=ELEVATEDPATHCOOKIE777';
  const vpnConfig = { type: 'fortinet', host: 'vpn.example.com', username: 'operator', password: 'Sup3rSecretPass!' };
  const lines = [];
  const onLog = (line) => lines.push(line);
  const context = { vpnConfig, extraSecrets: [cookie] };

  // Fake provider — a real spawned `echo` process standing in for "the
  // OS-elevated child process", so this test never touches real sudo/
  // osascript and never risks an actual administrator prompt.
  setElevationProvider(({ args }) => Promise.resolve(spawn('echo', [args.join(' ')])));

  try {
    await VpnManager.spawnElevatedAndWait('openfortivpn', [`--cookie=${cookie}`], null, onLog, {}, context);
  } finally {
    setElevationProvider(null);
  }

  const combined = lines.join('\n');
  assert.ok(!combined.includes(cookie), 'runtime secret leaked via the elevated-provider logging path');
  assert.ok(combined.includes(REDACTED));
});
