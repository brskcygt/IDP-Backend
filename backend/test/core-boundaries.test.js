/**
 * Tests for scripts/check-core-boundaries.js (T-58).
 *
 * The whole point of `src/core/**` is that it stays transport-agnostic so
 * it can eventually be called from Electron's main process over IPC
 * instead of from Express route handlers. These tests don't just check
 * that the real `src/core/` tree currently passes (a tautology that would
 * pass even if the checker were a no-op) — they plant a real violation
 * file under `src/core/`, run the checker as a child process exactly like
 * `npm run lint` does, and assert it actually fails and reports the
 * offending file + line. The planted file is always removed in a
 * `finally`, even if an assertion throws.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'check-core-boundaries.js');
const CORE_DIR = path.join(__dirname, '..', 'src', 'core');

/**
 * Runs the checker script as a child process.
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runChecker() {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    };
  }
}

/** Plants `content` at a throwaway path under src/core/, runs `fn`, always removes it after. */
function withPlantedFile(relativeName, content, fn) {
  const dir = fs.mkdtempSync(path.join(CORE_DIR, '__boundary_test_'));
  const filePath = path.join(dir, relativeName);
  fs.writeFileSync(filePath, content);
  try {
    return fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('passes (exit 0) against the real src/core/ tree', () => {
  const result = runChecker();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /clean/i);
});

test('fails and reports the file+line when a file under src/core/ requires express', () => {
  withPlantedFile(
    'bad-require.js',
    [
      "'use strict';",
      "const express = require('express');",
      'module.exports = express;',
      '',
    ].join('\n'),
    () => {
      const result = runChecker();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /bad-require\.js:2/);
      assert.match(result.stderr, /require\('express'\)/);
    }
  );
});

test("fails when a file under src/core/ requires 'cookie-parser' or 'express-session'", () => {
  withPlantedFile(
    'bad-cookie.js',
    [
      "'use strict';",
      "const cookieParser = require('cookie-parser');",
      "const session = require('express-session');",
      'module.exports = { cookieParser, session };',
      '',
    ].join('\n'),
    () => {
      const result = runChecker();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /bad-cookie\.js:2/);
      assert.match(result.stderr, /bad-cookie\.js:3/);
    }
  );
});

test('fails and reports the file+line when a file under src/core/ reads req./res.', () => {
  withPlantedFile(
    'bad-reqres.js',
    [
      "'use strict';",
      'function handler(req, res) {',
      '  res.status(200).json({ ok: req.body });',
      '}',
      'module.exports = handler;',
      '',
    ].join('\n'),
    () => {
      const result = runChecker();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /bad-reqres\.js:3/);
    }
  );
});

test('does not flag req./res. mentioned only in comments or string literals', () => {
  withPlantedFile(
    'clean-mentions.js',
    [
      "'use strict';",
      '// This function never touches req. or res. — it just talks about them.',
      '/* also fine in a block comment: req.session, res.json */',
      'function pureHelper(input) {',
      '  const message = "req.session expired, res.status unrelated string";',
      '  return { input, message };',
      '}',
      'module.exports = pureHelper;',
      '',
    ].join('\n'),
    () => {
      const result = runChecker();
      assert.equal(result.status, 0);
      assert.match(result.stdout, /clean/i);
    }
  );
});
