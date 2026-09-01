#!/usr/bin/env node
'use strict';

/**
 * check-core-boundaries.js — enforces that `src/core/**` stays
 * transport-agnostic (T-58).
 *
 * The whole point of `src/core/` is that it holds pure business logic the
 * eventual Electron migration can call over IPC instead of HTTP. That only
 * holds if nothing in there actually depends on Express. This script walks
 * every `.js` file under `src/core/` and fails (exit 1) if any file:
 *
 *   - `require()`s 'express', 'cookie-parser', or 'express-session'
 *   - references `req.` or `res.` in actual code (comments/strings are
 *     stripped first, so mentioning them in a comment — as this file's
 *     header just did — is fine)
 *
 * On failure, prints every offending file + line number + the offending
 * text, then exits 1. Wired into `npm run lint` alongside check-syntax.js,
 * and therefore runs in CI via verify.sh too.
 *
 * Usage: node backend/scripts/check-core-boundaries.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CORE_DIR = path.join(ROOT, 'src', 'core');

const FORBIDDEN_REQUIRES = ['express', 'cookie-parser', 'express-session'];

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
 * Strips `//` line comments, `/* *\/` block comments, and string/template
 * literal contents from a line of JS, replacing removed characters with
 * spaces so column positions of anything left over are preserved. Not a
 * full parser — good enough to stop this checker from flagging its own
 * doc comments or a string like `"req.session"` used in an error message.
 *
 * Operates line-by-line and tracks whether the previous line left us
 * inside an unterminated block comment.
 *
 * @param {string[]} lines
 * @returns {string[]} same length, with comment/string content blanked out
 */
function stripComments(lines) {
  let inBlockComment = false;
  return lines.map((line) => {
    let out = '';
    let i = 0;
    let inString = null; // one of `'`, `"`, `` ` ``, or null — tracked (but kept) so a
    // `//` or `/*` inside a string literal isn't mistaken for a real comment.

    while (i < line.length) {
      const ch = line[i];
      const next = line[i + 1];

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          out += '  ';
          i += 2;
          continue;
        }
        out += ' ';
        i += 1;
        continue;
      }

      if (inString) {
        if (ch === '\\') {
          out += line.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (ch === inString) {
          inString = null;
        }
        out += ch;
        i += 1;
        continue;
      }

      if (ch === '/' && next === '/') {
        out += ' '.repeat(line.length - i);
        break;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = ch;
        out += ch;
        i += 1;
        continue;
      }

      out += ch;
      i += 1;
    }

    return out;
  });
}

/**
 * Same as `stripComments`, but additionally blanks out the *contents* of
 * string/template literals (quotes kept as spaces too) so a message like
 * `"req.session expired"` can never trip the `req.`/`res.` identifier check
 * below. Only safe to use for that check — never for detecting `require(...)`
 * calls, since it destroys the very string content that check needs to read.
 */
function stripCommentsAndStrings(lines) {
  let inBlockComment = false;
  return lines.map((line) => {
    let out = '';
    let i = 0;
    let inString = null; // one of `'`, `"`, `` ` ``, or null

    while (i < line.length) {
      const ch = line[i];
      const next = line[i + 1];

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          out += '  ';
          i += 2;
          continue;
        }
        out += ' ';
        i += 1;
        continue;
      }

      if (inString) {
        if (ch === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (ch === inString) {
          inString = null;
          out += ' ';
          i += 1;
          continue;
        }
        out += ' ';
        i += 1;
        continue;
      }

      if (ch === '/' && next === '/') {
        // Rest of the line is a line comment.
        out += ' '.repeat(line.length - i);
        break;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = ch;
        out += ' ';
        i += 1;
        continue;
      }

      out += ch;
      i += 1;
    }

    return out;
  });
}

/**
 * @param {string} filePath
 * @returns {{ line: number, text: string }[]} violations found in this file
 */
function checkFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const rawLines = raw.split('\n');
  // Comments stripped, strings kept — needed so require('express') is still
  // visible as a string literal.
  const noCommentLines = stripComments(rawLines);
  // Comments AND string contents stripped — needed so a string/comment that
  // merely mentions "req." or "res." never trips the identifier check.
  const noStringLines = stripCommentsAndStrings(rawLines);

  const violations = [];

  rawLines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const noCommentLine = noCommentLines[idx];
    const noStringLine = noStringLines[idx];

    for (const forbidden of FORBIDDEN_REQUIRES) {
      const requirePattern = new RegExp(
        `require\\(\\s*['"\`]${forbidden.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}['"\`]\\s*\\)`
      );
      if (requirePattern.test(noCommentLine)) {
        violations.push({ line: lineNo, text: rawLine.trim() });
      }
    }

    // `req.` / `res.` used as identifiers (property access, e.g. `req.session`,
    // `res.status(...)`) — word-boundaried so `preserved.` or `request.` etc
    // don't false-positive.
    if (/\breq\.\w/.test(noStringLine) || /\bres\.\w/.test(noStringLine)) {
      violations.push({ line: lineNo, text: rawLine.trim() });
    }
  });

  return violations;
}

function main() {
  const files = collectJsFiles(CORE_DIR);

  if (files.length === 0) {
    console.error('[check-core-boundaries] No .js files found under src/core/ — nothing to check.');
    process.exit(1);
  }

  let totalViolations = 0;

  console.log(`[check-core-boundaries] Checked ${files.length} file(s) under src/core/.`);

  for (const file of files) {
    const violations = checkFile(file);
    if (violations.length === 0) continue;

    const relPath = path.relative(ROOT, file);
    for (const v of violations) {
      console.error(`  ✗ ${relPath}:${v.line}  ${v.text}`);
      totalViolations++;
    }
  }

  if (totalViolations > 0) {
    console.error(
      `\n[check-core-boundaries] ${totalViolations} violation(s) found. ` +
      `src/core/** must stay transport-agnostic — no express/cookie-parser/` +
      `express-session, and no req./res. usage.`
    );
    process.exit(1);
  }

  console.log('[check-core-boundaries] src/core/** is clean — no Express/req/res dependencies.');
  process.exit(0);
}

main();
