/**
 * Tests for VPN helper-binary resolution.
 *
 * The bug these lock in: a macOS app launched from Finder does not inherit the
 * shell's PATH, so `openfortivpn` — installed by Homebrew and perfectly
 * resolvable in a terminal — fails with "command not found" inside the packaged
 * desktop app. Every VPN type was affected, not just Fortinet.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findBinary, requireBinary, SEARCH_DIRS } = require('../src/services/vpn/binaryResolver');

function withTempBin(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-bin-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('finds a binary that exists on the process PATH', () => {
  withTempBin((dir) => {
    const bin = path.join(dir, 'idp-fake-tool');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const originalPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      assert.equal(findBinary('idp-fake-tool'), bin);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

test('returns null for a binary that does not exist anywhere', () => {
  assert.equal(findBinary('idp-definitely-not-installed-xyz'), null);
});

test('an absolute path is returned as-is when it is executable', () => {
  withTempBin((dir) => {
    const bin = path.join(dir, 'pinned-build');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.equal(findBinary(bin), bin, 'a project pinning a custom build must keep working');
  });
});

test('an absolute path that does not exist resolves to null', () => {
  assert.equal(findBinary('/nope/does/not/exist'), null);
});

test('a non-executable file is not accepted', () => {
  withTempBin((dir) => {
    const notExec = path.join(dir, 'readme');
    fs.writeFileSync(notExec, 'text', { mode: 0o644 });
    assert.equal(findBinary(notExec), null);
  });
});

test('Homebrew prefixes are searched even when absent from PATH', () => {
  // This is the actual regression: with PATH stripped to the system minimum —
  // exactly what a Finder-launched app sees — a Homebrew tool must still resolve.
  assert.ok(
    SEARCH_DIRS.includes('/opt/homebrew/bin'),
    'Apple Silicon Homebrew prefix must be searched'
  );
  assert.ok(
    SEARCH_DIRS.includes('/usr/local/bin'),
    'Intel Homebrew prefix must be searched'
  );
});

test('a system tool still resolves with a minimal PATH', () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin'; // simulate the Finder-launched environment
  try {
    const resolved = findBinary('sh');
    assert.ok(resolved && path.isAbsolute(resolved), `expected an absolute path, got ${resolved}`);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('requireBinary throws an actionable error naming the tool and how to install it', () => {
  assert.throws(
    () => requireBinary('openvpn'),
    (err) => {
      assert.match(err.message, /openvpn/, 'must name the tool');
      assert.match(err.message, /brew install openvpn/, 'must say how to install it');
      assert.match(err.message, /Finder does not inherit your shell PATH/, 'must explain why a terminal-working tool is missing here');
      return true;
    }
  );
});

test('requireBinary returns the path when the tool is present', () => {
  withTempBin((dir) => {
    const bin = path.join(dir, 'idp-present-tool');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      assert.equal(requireBinary('idp-present-tool'), bin);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
