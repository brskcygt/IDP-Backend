/**
 * Tests for VPN log redaction (T-14 / SEC-06).
 *
 * The bug this replaces was subtle: masking looked at argument *positions*
 * (`--passwd…`, anything containing `-p`), so `['-p', password]` masked the flag
 * and printed the password. These tests assert on values, not shapes.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  collectSecretValues,
  createScrubber,
  createConfigScrubber,
  REDACTED,
} = require('../src/services/vpn/logScrubber');

const vpnConfig = {
  type: 'fortinet',
  host: 'vpn.example.com',
  port: '20443',
  username: 'operator',
  password: 'Sup3rSecret!Pass',
  mfaConfig: { type: 'totp', secret: 'JBSWY3DPEHPK3PXP', rememberSession: true },
};

test('collects secret-looking values and ignores the rest', () => {
  const found = collectSecretValues(vpnConfig);
  assert.ok(found.has('Sup3rSecret!Pass'));
  assert.ok(found.has('JBSWY3DPEHPK3PXP'));
  assert.ok(!found.has('vpn.example.com'), 'host is not a secret');
  assert.ok(!found.has('operator'), 'username is not a secret');
});

test('the regression case: password beside its flag is redacted', () => {
  const scrub = createConfigScrubber(vpnConfig);
  const line = '[VPN] Executing: sudo openfortivpn vpn.example.com:20443 -u operator -p Sup3rSecret!Pass --persistent=0';
  const scrubbed = scrub(line);

  assert.ok(!scrubbed.includes('Sup3rSecret!Pass'), 'password leaked into the log line');
  assert.ok(scrubbed.includes(REDACTED));
  assert.ok(scrubbed.includes('vpn.example.com:20443'), 'non-secret args stay readable');
  assert.ok(scrubbed.includes('-u operator'), 'username stays readable for debugging');
});

test('redacts a secret echoed back by the VPN binary, not just our own line', () => {
  const scrub = createConfigScrubber(vpnConfig);
  const fromBinary = 'ERROR: authentication failed for user operator with password Sup3rSecret!Pass';
  assert.ok(!scrub(fromBinary).includes('Sup3rSecret!Pass'));
});

test('redacts nested secrets such as the TOTP seed', () => {
  const scrub = createConfigScrubber(vpnConfig);
  assert.ok(!scrub('seed=JBSWY3DPEHPK3PXP').includes('JBSWY3DPEHPK3PXP'));
});

test('extra runtime secrets (stdin payload, SAML cookie) are covered', () => {
  const scrub = createConfigScrubber(vpnConfig, ['portal-userauthcookie=abc123def456']);
  assert.ok(!scrub('Got cookie portal-userauthcookie=abc123def456').includes('abc123def456'));
});

test('multiple occurrences on one line are all redacted', () => {
  const scrub = createConfigScrubber(vpnConfig);
  const scrubbed = scrub('pw=Sup3rSecret!Pass retry with Sup3rSecret!Pass again');
  assert.equal(scrubbed.includes('Sup3rSecret!Pass'), false);
  assert.equal(scrubbed.split(REDACTED).length - 1, 2);
});

test('a secret containing another secret is replaced whole', () => {
  const scrub = createScrubber(['abcd', 'abcdefgh']);
  assert.equal(scrub('value abcdefgh here'), `value ${REDACTED} here`);
});

test('very short values are not redacted — they would mangle ordinary output', () => {
  const scrub = createScrubber(['ab']);
  assert.equal(scrub('about to connect'), 'about to connect');
});

test('regex metacharacters in a password do not break the scrubber', () => {
  const scrub = createScrubber(['a.*b(c)[d]$']);
  assert.equal(scrub('pw=a.*b(c)[d]$ end'), `pw=${REDACTED} end`);
  assert.equal(scrub('pw=axxb end'), 'pw=axxb end', 'must match literally, not as a pattern');
});

test('no secrets configured means the line is passed through untouched', () => {
  const scrub = createConfigScrubber({ host: 'vpn.example.com', type: 'openvpn' });
  assert.equal(scrub('[VPN] connecting'), '[VPN] connecting');
});

test('tolerates a missing config and non-string input', () => {
  const scrub = createConfigScrubber(undefined);
  assert.equal(scrub('plain'), 'plain');
  assert.equal(createConfigScrubber(vpnConfig)(undefined), undefined);
});
