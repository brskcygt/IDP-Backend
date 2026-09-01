/**
 * Tests for SSH host key verification (SEC-10 / T-17).
 *
 * Covers computeFingerprint/extractKeyType, the three hostVerifier
 * policies (tofu / strict / insecure), and hostKeyRepository round-trips.
 * Every test opens its own throwaway database file under a fresh
 * `fs.mkdtemp()` directory and tears it down afterwards — none of this
 * touches the real src/idp.db. Follows the same shape as test/store.test.js.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/store/db');
const { createHostKeyRepository } = require('../src/store/hostKeyRepository');
const { computeFingerprint, extractKeyType, createHostVerifier } = require('../src/services/ssh/hostKeyVerifier');

/** Opens a fresh throwaway DB under its own temp dir; returns db + cleanup. */
function withTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-hostkey-test-'));
  const dbPath = path.join(dir, 'test.db');
  const db = openDatabase(dbPath);
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Builds a synthetic SSH wire-format public key blob: type + payload. */
function wireKey(type, payloadHex) {
  const typeBuf = Buffer.from(type, 'ascii');
  const typeHeader = Buffer.alloc(4);
  typeHeader.writeUInt32BE(typeBuf.length, 0);

  const payload = Buffer.from(payloadHex, 'hex');
  const payloadHeader = Buffer.alloc(4);
  payloadHeader.writeUInt32BE(payload.length, 0);

  return Buffer.concat([typeHeader, typeBuf, payloadHeader, payload]);
}

// A fixed, reproducible test vector. Its expected fingerprint below was
// independently computed once with Node's crypto (SHA256 -> base64,
// '=' padding stripped, "SHA256:" prefix) and hardcoded so this test
// catches any accidental change to the fingerprint format, not just
// "computeFingerprint agrees with itself".
const KNOWN_KEY = wireKey('ssh-ed25519', '0123456789abcdef0123456789abcdef');
const KNOWN_KEY_FINGERPRINT = 'SHA256:eYOI7idaSgWpW3wnwc3/MNFvmHM+tLSdrCr/EHmll8A';

const OTHER_KEY = wireKey('ssh-ed25519', 'fedcba9876543210fedcba9876543210');

function collectLogs() {
  const lines = [];
  return { onLog: (line) => lines.push(line), lines };
}

// ---------------------------------------------------------------------------
// computeFingerprint / extractKeyType
// ---------------------------------------------------------------------------

test('computeFingerprint: known key yields a fixed, correctly formatted fingerprint', () => {
  const fingerprint = computeFingerprint(KNOWN_KEY);
  assert.equal(fingerprint, KNOWN_KEY_FINGERPRINT);
  assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]+$/);
  assert.ok(!fingerprint.includes('='), 'fingerprint must not carry base64 padding');
});

test('computeFingerprint: is deterministic for the same key bytes', () => {
  assert.equal(computeFingerprint(KNOWN_KEY), computeFingerprint(Buffer.from(KNOWN_KEY)));
});

test('computeFingerprint: different keys produce different fingerprints', () => {
  assert.notEqual(computeFingerprint(KNOWN_KEY), computeFingerprint(OTHER_KEY));
});

test('extractKeyType: reads the algorithm name out of the wire format', () => {
  assert.equal(extractKeyType(KNOWN_KEY), 'ssh-ed25519');
  assert.equal(extractKeyType(wireKey('ssh-rsa', 'aa')), 'ssh-rsa');
});

test('extractKeyType: falls back to "unknown" for malformed input', () => {
  assert.equal(extractKeyType(Buffer.from([1, 2])), 'unknown');
  assert.equal(extractKeyType(null), 'unknown');
});

// ---------------------------------------------------------------------------
// createHostVerifier: tofu
// ---------------------------------------------------------------------------

test('tofu: first connection is accepted and the key is pinned', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repository = createHostKeyRepository(db);
    const { onLog } = collectLogs();
    const verifier = createHostVerifier({ host: 'bastion.example.com', port: 22, policy: 'tofu', onLog, repository });

    assert.equal(repository.find('bastion.example.com', 22), null);
    const accepted = verifier(KNOWN_KEY);
    assert.equal(accepted, true);

    const stored = repository.find('bastion.example.com', 22);
    assert.ok(stored);
    assert.equal(stored.fingerprint, KNOWN_KEY_FINGERPRINT);
    assert.equal(stored.keyType, 'ssh-ed25519');
  } finally {
    cleanup();
  }
});

test('tofu: the same fingerprint is accepted again on a later connection', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repository = createHostKeyRepository(db);
    const verifier = createHostVerifier({ host: 'bastion.example.com', port: 22, policy: 'tofu', repository });

    assert.equal(verifier(KNOWN_KEY), true);
    assert.equal(verifier(KNOWN_KEY), true);
  } finally {
    cleanup();
  }
});

test('tofu: a DIFFERENT fingerprint on a later connection is REJECTED', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repository = createHostKeyRepository(db);
    const { onLog, lines } = collectLogs();
    const verifier = createHostVerifier({ host: 'bastion.example.com', port: 22, policy: 'tofu', onLog, repository });

    assert.equal(verifier(KNOWN_KEY), true);
    const accepted = verifier(OTHER_KEY);
    assert.equal(accepted, false, 'a changed host key must be rejected, not silently trusted');

    // The originally pinned fingerprint must survive the rejected attempt.
    const stored = repository.find('bastion.example.com', 22);
    assert.equal(stored.fingerprint, KNOWN_KEY_FINGERPRINT);

    const mismatchLog = lines.join('\n');
    assert.match(mismatchLog, /verification FAILED/);
    assert.match(mismatchLog, new RegExp(KNOWN_KEY_FINGERPRINT.replace(/[+/]/g, '\\$&')));
    assert.match(mismatchLog, /machine-in-the-middle/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// createHostVerifier: strict
// ---------------------------------------------------------------------------

test('strict: an unregistered host is rejected outright', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repository = createHostKeyRepository(db);
    const { onLog, lines } = collectLogs();
    const verifier = createHostVerifier({ host: 'bastion.example.com', port: 22, policy: 'strict', onLog, repository });

    const accepted = verifier(KNOWN_KEY);
    assert.equal(accepted, false);
    assert.equal(repository.find('bastion.example.com', 22), null, 'strict must never learn a new key');
    assert.match(lines.join('\n'), /policy is 'strict'/);
  } finally {
    cleanup();
  }
});

test('strict: a previously pinned key is accepted', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repository = createHostKeyRepository(db);
    repository.remember('bastion.example.com', 22, 'ssh-ed25519', KNOWN_KEY_FINGERPRINT);

    const verifier = createHostVerifier({ host: 'bastion.example.com', port: 22, policy: 'strict', repository });
    assert.equal(verifier(KNOWN_KEY), true);
  } finally {
    cleanup();
  }
});

test('strict: a mismatched key is rejected, same as tofu', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repository = createHostKeyRepository(db);
    repository.remember('bastion.example.com', 22, 'ssh-ed25519', KNOWN_KEY_FINGERPRINT);

    const verifier = createHostVerifier({ host: 'bastion.example.com', port: 22, policy: 'strict', repository });
    assert.equal(verifier(OTHER_KEY), false);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// createHostVerifier: insecure
// ---------------------------------------------------------------------------

test('insecure: everything is accepted, but a warning is logged every time', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repository = createHostKeyRepository(db);
    const { onLog, lines } = collectLogs();
    const verifier = createHostVerifier({ host: 'bastion.example.com', port: 22, policy: 'insecure', onLog, repository });

    assert.equal(verifier(KNOWN_KEY), true);
    assert.equal(verifier(OTHER_KEY), true, 'insecure must accept a mismatched key too');
    assert.equal(lines.length, 2, 'a warning must be logged on every single connection, not just once');
    for (const line of lines) {
      assert.match(line, /WARNING/);
      assert.match(line, /disabled/i);
    }

    // insecure must never write to the repository — it isn't "learning" anything.
    assert.equal(repository.find('bastion.example.com', 22), null);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// forget() -> tofu re-learns
// ---------------------------------------------------------------------------

test('forget(): after forgetting a host, tofu treats the next connection as first-use again', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repository = createHostKeyRepository(db);
    const verifier = createHostVerifier({ host: 'bastion.example.com', port: 22, policy: 'tofu', repository });

    assert.equal(verifier(KNOWN_KEY), true);
    // A rotated key would normally be rejected...
    assert.equal(verifier(OTHER_KEY), false);

    const forgotten = repository.forget('bastion.example.com', 22);
    assert.equal(forgotten, true);
    assert.equal(repository.find('bastion.example.com', 22), null);

    // ...but after forget(), the new key is accepted and re-pinned.
    assert.equal(verifier(OTHER_KEY), true);
    assert.equal(repository.find('bastion.example.com', 22).fingerprint, computeFingerprint(OTHER_KEY));
  } finally {
    cleanup();
  }
});

test('forget(): returns false for a host that was never known', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repository = createHostKeyRepository(db);
    assert.equal(repository.forget('never-seen.example.com', 22), false);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// hostKeyRepository round-trip
// ---------------------------------------------------------------------------

test('hostKeyRepository: remember -> find round-trip preserves all fields', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repository = createHostKeyRepository(db);
    const stored = repository.remember('10.0.0.5', 2222, 'ssh-rsa', 'SHA256:abcdef');

    assert.equal(stored.host, '10.0.0.5');
    assert.equal(stored.port, 2222);
    assert.equal(stored.keyType, 'ssh-rsa');
    assert.equal(stored.fingerprint, 'SHA256:abcdef');
    assert.ok(stored.firstSeen);
    assert.ok(stored.lastSeen);

    const found = repository.find('10.0.0.5', 2222);
    assert.deepEqual(found, stored);
  } finally {
    cleanup();
  }
});

test('hostKeyRepository: distinct ports on the same host are independent rows', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repository = createHostKeyRepository(db);
    repository.remember('bastion.example.com', 22, 'ssh-ed25519', 'SHA256:aaa');
    repository.remember('bastion.example.com', 2222, 'ssh-ed25519', 'SHA256:bbb');

    assert.equal(repository.find('bastion.example.com', 22).fingerprint, 'SHA256:aaa');
    assert.equal(repository.find('bastion.example.com', 2222).fingerprint, 'SHA256:bbb');
    assert.equal(repository.listAll().length, 2);
  } finally {
    cleanup();
  }
});

test('hostKeyRepository: remember() updates last_seen on a repeat call without changing first_seen', async () => {
  const { db, cleanup } = withTempDb();
  try {
    const repository = createHostKeyRepository(db);
    const first = repository.remember('bastion.example.com', 22, 'ssh-ed25519', 'SHA256:aaa');

    // Ensure the ISO timestamp (second resolution in the assertion below)
    // has a chance to move forward before the second remember() call.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = repository.remember('bastion.example.com', 22, 'ssh-ed25519', 'SHA256:aaa');

    assert.equal(second.firstSeen, first.firstSeen, 'first_seen must not change on refresh');
    assert.equal(repository.listAll().length, 1, 'refresh must not create a duplicate row');
  } finally {
    cleanup();
  }
});

test('hostKeyRepository: remove() deletes the row', () => {
  const { db, cleanup } = withTempDb();
  try {
    const repository = createHostKeyRepository(db);
    repository.remember('bastion.example.com', 22, 'ssh-ed25519', 'SHA256:aaa');
    assert.equal(repository.forget('bastion.example.com', 22), true);
    assert.equal(repository.find('bastion.example.com', 22), null);
  } finally {
    cleanup();
  }
});
