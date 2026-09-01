#!/usr/bin/env node
'use strict';

/**
 * scan-secrets.js — grep-based leaked-credential scanner.
 *
 * Walks the repository (default: two levels up from this script, i.e. the
 * project root containing `backend/` and `frontend/`) looking for text that
 * matches common secret/token formats. Intended to run in CI (see
 * `.github/workflows/security.yml`) as a cheap guardrail — it is NOT a
 * substitute for a real secret-scanning tool (gitleaks/trufflehog), but it
 * needs no new dependency.
 *
 * Usage:
 *   node backend/scripts/scan-secrets.js [rootDir]
 *
 * Exit code: 1 if any match is found (and the file+line is printed), 0
 * otherwise.
 */

const fs = require('fs');
const path = require('path');

const rootArg = process.argv[2];
const ROOT = rootArg ? path.resolve(rootArg) : path.resolve(__dirname, '..', '..');

// Directories never worth scanning.
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'dist-ssr', 'build', '.next']);

// File name patterns to skip entirely (runtime data / backups / binaries
// that are either already gitignored or not meaningful to scan as text).
const EXCLUDED_FILE_PATTERNS = [
  /\.db$/,
  /\.db-wal$/,
  /\.db-shm$/,
  /\.enc\.json$/,
  /\.bak$/,
  /\.png$/,
  /\.jpe?g$/,
  /\.gif$/,
  /\.ico$/,
  /\.woff2?$/,
  /\.ttf$/,
  /\.eot$/,
  /\.pdf$/,
  /\.zip$/,
  /\.lock$/, // package-lock.json is exempt below via explicit allow, this covers other *.lock
];

// package-lock.json files are huge and never contain secrets in practice;
// skip for scan speed but keep the pattern list explicit for auditability.
const EXCLUDED_FILE_NAMES = new Set(['package-lock.json']);

/**
 * Secret patterns. Each entry: { name, regex } — regex must be global so
 * `matchAll` can find every occurrence on a line.
 */
const SECRET_PATTERNS = [
  { name: 'GitHub Personal Access Token (classic)', regex: /ghp_[A-Za-z0-9]{36,}/g },
  { name: 'GitHub Fine-Grained PAT', regex: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'GitLab Personal Access Token', regex: /glpat-[A-Za-z0-9\-_]{20,}/g },
  { name: 'Slack Token', regex: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'AWS Access Key ID', regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'Private Key Block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

/**
 * @param {string} name
 * @returns {boolean}
 */
function isExcludedFile(name) {
  if (EXCLUDED_FILE_NAMES.has(name)) return true;
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Recursively collects candidate files under `dir`.
 * @param {string} dir
 * @returns {string[]}
 */
function collectFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      results.push(...collectFiles(path.join(dir, entry.name)));
      continue;
    }

    if (entry.isFile() && !isExcludedFile(entry.name)) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

/**
 * Scans a single file for secret patterns.
 * @param {string} filePath
 * @returns {Array<{ file: string, line: number, name: string, match: string }>}
 */
function scanFile(filePath) {
  const findings = [];
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    // Unreadable file — skip silently.
    return findings;
  }

  // Skip files that look binary (contain a NUL byte) that slipped past the
  // extension filter.
  if (buffer.includes(0)) return findings;

  const content = buffer.toString('utf8');
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    for (const { name, regex } of SECRET_PATTERNS) {
      regex.lastIndex = 0;
      const matches = line.match(regex);
      if (matches) {
        for (const match of matches) {
          findings.push({ file: filePath, line: index + 1, name, match: redact(match) });
        }
      }
    }
  });

  return findings;
}

/**
 * Redacts a matched secret for safe display in CI logs — keeps enough
 * context to identify the finding without printing the full credential.
 * @param {string} value
 * @returns {string}
 */
function redact(value) {
  if (value.length <= 12) return `${value.slice(0, 4)}***`;
  return `${value.slice(0, 8)}...${value.slice(-4)} (${value.length} chars)`;
}

function main() {
  if (!fs.existsSync(ROOT)) {
    console.error(`[scan-secrets] Root directory does not exist: ${ROOT}`);
    process.exit(1);
  }

  const files = collectFiles(ROOT);
  const allFindings = files.flatMap(scanFile);

  console.log(`[scan-secrets] Scanned ${files.length} file(s) under ${ROOT}`);

  if (allFindings.length > 0) {
    console.error(`\n[scan-secrets] Found ${allFindings.length} potential secret(s):\n`);
    for (const finding of allFindings) {
      const relPath = path.relative(ROOT, finding.file);
      console.error(`  ✗ ${relPath}:${finding.line} — ${finding.name}: ${finding.match}`);
    }
    console.error(
      '\n[scan-secrets] If any of these are real credentials, rotate them immediately and ' +
        'remove them from the file (and from git history, if committed).'
    );
    process.exit(1);
  }

  console.log('[scan-secrets] No known secret patterns found.');
  process.exit(0);
}

main();
