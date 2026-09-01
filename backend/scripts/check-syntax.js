#!/usr/bin/env node
'use strict';

/**
 * check-syntax.js — minimal "linter" replacement for the backend.
 *
 * The project deliberately has no ESLint (no new dependency was to be
 * introduced for T-60). This script walks `src/**` and `test/**`, runs
 * `node --check` (syntax-only parse, no execution) against every `.js`
 * file, and fails with a non-zero exit code plus a listing of every
 * broken file if any file fails to parse.
 *
 * Usage: node backend/scripts/check-syntax.js
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET_DIRS = ['src', 'test'];

/**
 * Recursively collects every `.js` file under `dir`.
 * @param {string} dir
 * @returns {string[]} absolute file paths
 */
function collectJsFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Runs `node --check` against a single file.
 * @param {string} filePath
 * @returns {{ file: string, ok: boolean, error?: string }}
 */
function checkFile(filePath) {
  try {
    execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });
    return { file: filePath, ok: true };
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : err.message;
    return { file: filePath, ok: false, error: stderr.trim() };
  }
}

function main() {
  const files = TARGET_DIRS.flatMap((dir) => collectJsFiles(path.join(ROOT, dir)));

  if (files.length === 0) {
    console.error('[check-syntax] No .js files found under src/ or test/ — nothing to check.');
    process.exit(1);
  }

  const results = files.map(checkFile);
  const failures = results.filter((r) => !r.ok);

  console.log(`[check-syntax] Checked ${results.length} file(s).`);

  if (failures.length > 0) {
    console.error(`\n[check-syntax] ${failures.length} file(s) failed to parse:\n`);
    for (const failure of failures) {
      const relPath = path.relative(ROOT, failure.file);
      console.error(`  ✗ ${relPath}`);
      console.error(
        failure.error
          .split('\n')
          .map((line) => `      ${line}`)
          .join('\n')
      );
    }
    process.exit(1);
  }

  console.log('[check-syntax] All files parse cleanly.');
  process.exit(0);
}

main();
