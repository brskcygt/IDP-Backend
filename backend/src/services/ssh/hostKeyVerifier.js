'use strict';

/**
 * SSH host key verification (SEC-10 / T-17).
 *
 * Previously, SSH connections (both the `ssh-jump` VPN branch and
 * SshServerAdapter's node-ssh/ssh2 connections) accepted whatever host key
 * the remote end presented, with no verification at all. That means a
 * machine-in-the-middle impersonating the target server could harvest the
 * SSH password or the production credential pulled from the PMP vault —
 * this portal's whole reason for existing is to broker those credentials,
 * so that's a high-value target.
 *
 * This module provides:
 *  - `computeFingerprint(keyBuffer)` — OpenSSH-style `SHA256:<base64>`
 *    fingerprint (no trailing `=` padding), matching `ssh-keygen -lf` output.
 *  - `createHostVerifier(...)` — builds the `hostVerifier` callback ssh2
 *    expects (see node_modules/ssh2/README.md, "hostVerifier"), backed by
 *    hostKeyRepository.js for persistence.
 *
 * Policies:
 *  - 'tofu' (default)  — trust-on-first-use. First connection to a given
 *    (host, port) is trusted and pinned. Every later connection must match
 *    the pinned fingerprint exactly, or the connection is REJECTED.
 *  - 'strict'           — only a fingerprint pinned by an earlier TOFU (or
 *    manually seeded) connection is accepted. An unknown host is rejected
 *    outright — there is no "first use" here.
 *  - 'insecure'          — no verification at all (the old, unsafe default
 *    behavior). Every use logs a loud, explicit warning so it can't happen
 *    silently.
 */

const crypto = require('node:crypto');
const hostKeyRepository = require('../../store/hostKeyRepository');

const VALID_POLICIES = new Set(['tofu', 'strict', 'insecure']);
const DEFAULT_POLICY = 'tofu';

/**
 * OpenSSH-style fingerprint: base64(SHA256(raw key blob)), '=' padding
 * stripped, prefixed with "SHA256:" — the same format `ssh-keygen -lf`
 * and OpenSSH's own "ECDSA key fingerprint is SHA256:..." prompt use.
 *
 * @param {Buffer} keyBuffer - the raw SSH wire-format public key blob, as
 *   handed to ssh2's hostVerifier callback when `hostHash` is not set.
 * @returns {string}
 */
function computeFingerprint(keyBuffer) {
  if (!Buffer.isBuffer(keyBuffer)) {
    throw new TypeError('computeFingerprint expects a Buffer');
  }
  const digest = crypto.createHash('sha256').update(keyBuffer).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/**
 * Best-effort extraction of the key's algorithm name (e.g. "ssh-ed25519",
 * "ssh-rsa", "ecdsa-sha2-nistp256") straight out of the SSH wire format,
 * whose first field is always a length-prefixed ASCII string naming the
 * key type. Used only for the informational `key_type` column — never for
 * anything security-relevant, so a malformed blob just yields 'unknown'
 * rather than throwing.
 *
 * @param {Buffer} keyBuffer
 * @returns {string}
 */
function extractKeyType(keyBuffer) {
  if (!Buffer.isBuffer(keyBuffer) || keyBuffer.length < 4) return 'unknown';
  const len = keyBuffer.readUInt32BE(0);
  if (len <= 0 || len > keyBuffer.length - 4) return 'unknown';
  const type = keyBuffer.toString('ascii', 4, 4 + len);
  return type || 'unknown';
}

/**
 * Builds the clear, side-by-side mismatch message logged (and used as the
 * rejection reason) when a host presents a fingerprint that doesn't match
 * what was previously pinned.
 */
function formatMismatchMessage({ host, port, expected, received }) {
  return [
    `[SSH] ✗ Host key verification FAILED for ${host}:${port}.`,
    `[SSH]   Expected fingerprint: ${expected}`,
    `[SSH]   Received fingerprint: ${received}`,
    '[SSH] This either means the server was reinstalled/rekeyed, or someone is',
    '[SSH] intercepting the connection (machine-in-the-middle). Do NOT proceed',
    '[SSH] without verifying the new fingerprint out-of-band with the server owner.',
    '[SSH] If the server change is expected, clear the stored host key (project',
    "[SSH] setting 'hostKeyPolicy' > reset/forget known host key for this host,",
    '[SSH] or call hostKeyRepository.forget(host, port)) and reconnect to re-pin it.',
  ].join('\n');
}

/**
 * Build an ssh2-compatible `hostVerifier` function.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port=22]
 * @param {'tofu'|'strict'|'insecure'} [opts.policy='tofu']
 * @param {(line: string) => void} [opts.onLog] - receives log lines; defaults to a no-op
 * @param {ReturnType<typeof import('../../store/hostKeyRepository').createHostKeyRepository>} [opts.repository]
 *   - defaults to the shared hostKeyRepository singleton; tests should pass their own.
 * @returns {(key: Buffer, verify?: (permitted: boolean) => void) => boolean}
 */
function createHostVerifier({ host, port = 22, policy = DEFAULT_POLICY, onLog = () => {}, repository = hostKeyRepository } = {}) {
  if (!host) {
    throw new Error('createHostVerifier requires a host');
  }
  const effectivePolicy = VALID_POLICIES.has(policy) ? policy : DEFAULT_POLICY;

  return function hostVerifier(keyBuffer) {
    const fingerprint = computeFingerprint(keyBuffer);
    const keyType = extractKeyType(keyBuffer);

    if (effectivePolicy === 'insecure') {
      onLog(
        `[SSH] ⚠ WARNING: host key verification is DISABLED (hostKeyPolicy=insecure) for ${host}:${port}. ` +
        `Accepting fingerprint ${fingerprint} without verification. This is unsafe against ` +
        'machine-in-the-middle attacks — do not use this setting in production.'
      );
      return true;
    }

    const known = repository.find(host, port);

    if (!known) {
      if (effectivePolicy === 'strict') {
        onLog(
          `[SSH] ✗ Host key verification FAILED for ${host}:${port}: no key pinned yet and policy is 'strict'. ` +
          `Refusing to trust an unknown host key (fingerprint ${fingerprint}). Connect once under the 'tofu' ` +
          'policy to pin it first, or pre-register the expected key.'
        );
        return false;
      }

      // tofu: first sighting for this (host, port) — trust it and pin it.
      repository.remember(host, port, keyType, fingerprint);
      onLog(
        `[SSH] Host key for ${host}:${port} not previously known. Trusting on first use (TOFU) ` +
        `and pinning fingerprint ${fingerprint} (${keyType}).`
      );
      return true;
    }

    if (known.fingerprint === fingerprint) {
      // Refresh last_seen; the pinned fingerprint itself is unchanged.
      repository.remember(host, port, known.keyType, known.fingerprint);
      return true;
    }

    onLog(formatMismatchMessage({ host, port, expected: known.fingerprint, received: fingerprint }));
    return false;
  };
}

module.exports = {
  computeFingerprint,
  extractKeyType,
  createHostVerifier,
  DEFAULT_POLICY,
};
