'use strict';

/**
 * Finds VPN helper binaries by absolute path.
 *
 * Why this exists: a macOS app launched from Finder does NOT inherit the
 * shell's PATH. It gets the minimal system one (`/usr/bin:/bin:/usr/sbin:/sbin`),
 * which excludes both Homebrew prefixes. Every VPN tool this app drives
 * (`openfortivpn`, `openconnect`, `wg-quick`, `expect`, `sshpass`) is installed
 * by Homebrew, so a bare command name resolves fine when the backend is started
 * from a terminal and fails with "command not found" the moment the same code
 * runs inside the packaged desktop app.
 *
 * Resolving to an absolute path also removes a real risk in the elevated path:
 * handing an unqualified command name to `do shell script ... with
 * administrator privileges` means the PATH decides which binary runs as root.
 *
 * @module binaryResolver
 */

const fs = require('fs');
const path = require('path');

/**
 * Searched in order. The Homebrew prefixes come first because that's where
 * these tools actually live on a developer machine; the system directories
 * cover binaries macOS ships itself (`expect`, `ssh`).
 */
const SEARCH_DIRS = [
  '/opt/homebrew/bin', // Homebrew, Apple Silicon
  '/opt/homebrew/sbin',
  '/usr/local/bin', // Homebrew, Intel
  '/usr/local/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/bin',
  '/sbin',
];

/** How to get each tool, surfaced in the error when it's missing. */
const INSTALL_HINTS = {
  openfortivpn: 'brew install openfortivpn',
  openconnect: 'brew install openconnect',
  openvpn: 'brew install openvpn',
  'wg-quick': 'brew install wireguard-tools',
  sshpass: 'brew install sshpass',
  expect: 'brew install expect',
};

function isExecutableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `name` to an absolute executable path.
 *
 * An absolute path is returned as-is when it exists, so a project that pins a
 * custom build keeps working.
 *
 * @param {string} name
 * @returns {string|null} absolute path, or null when not found
 */
function findBinary(name) {
  if (!name || typeof name !== 'string') return null;

  if (path.isAbsolute(name)) {
    return isExecutableFile(name) ? name : null;
  }

  // Anything the process's own PATH turns up is preferred — it reflects a
  // deliberate environment (a terminal-started server, or a launcher that set
  // PATH explicitly).
  const envDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);

  for (const dir of [...envDirs, ...SEARCH_DIRS]) {
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }

  return null;
}

/**
 * Like `findBinary`, but throws an actionable error instead of returning null.
 *
 * The message names the tool, says where we looked, and gives the install
 * command — "command not found" from a shell three layers down is not
 * something an operator can act on.
 *
 * @param {string} name
 * @returns {string} absolute path
 */
function requireBinary(name) {
  const resolved = findBinary(name);
  if (resolved) return resolved;

  const hint = INSTALL_HINTS[name];
  throw new Error(
    `Required tool "${name}" was not found on this machine.` +
      (hint ? ` Install it with: ${hint}.` : '') +
      ' Searched the process PATH plus: ' +
      SEARCH_DIRS.join(', ') +
      '. (A desktop app launched from Finder does not inherit your shell PATH,' +
      ' so a tool that works in a terminal can still be missing here.)'
  );
}

module.exports = { findBinary, requireBinary, SEARCH_DIRS, INSTALL_HINTS };
