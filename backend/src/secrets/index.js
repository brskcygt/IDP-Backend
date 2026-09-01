'use strict';

const FileSecretStore = require('./FileSecretStore');
const SafeStorageSecretStore = require('./SafeStorageSecretStore');
const keyManager = require('./keyManager');

/**
 * Resolves a usable, OS-backed `safeStorage` implementation, or `null` if
 * one isn't available in this process.
 *
 * `electron` is required lazily and defensively: this module is loaded by
 * the plain-Node backend (server/tests), where the `electron` package isn't
 * installed at all, so a module-level `require('electron')` would break
 * every consumer of this factory. A missing module, a missing `safeStorage`
 * export, or `isEncryptionAvailable()` throwing/returning `false` (e.g. no
 * keyring backend on a bare Linux box) are all treated the same way: "not
 * available here", never a hard crash.
 *
 * @returns {object|null}
 */
function tryGetSafeStorage() {
  let electron;
  try {
    // eslint-disable-next-line global-require
    electron = require('electron');
  } catch (_err) {
    return null;
  }

  const safeStorage = electron && electron.safeStorage;
  if (!safeStorage || typeof safeStorage.encryptString !== 'function') return null;

  try {
    if (typeof safeStorage.isEncryptionAvailable === 'function' && !safeStorage.isEncryptionAvailable()) {
      return null;
    }
  } catch (_err) {
    return null;
  }

  return safeStorage;
}

/**
 * Creates the appropriate SecretStore for the current environment.
 *
 * Decision order:
 *   1. `safeStorage` present AND usable (Electron desktop app, OS keychain/
 *      keyring unlocked) -> `SafeStorageSecretStore`. No `IDP_SECRET_KEY`
 *      needed — the OS owns key management, so there's no key to lose.
 *   2. `IDP_SECRET_KEY` configured -> `FileSecretStore` (today's behavior,
 *      unchanged) — this is the path every non-Electron (browser/server)
 *      deployment takes, since `electron` is never resolvable there.
 *   3. Neither -> `null`. It's up to the caller (server startup) to decide
 *      what that means: log a loud warning and keep serving plaintext, or
 *      refuse to start. This module never guesses or falls back silently.
 *
 * @param {object} [options]
 * @param {string} [options.filePath] - override the default `FileSecretStore`
 *   encrypted file path.
 * @param {string} [options.safeStorageFilePath] - override the default
 *   `SafeStorageSecretStore` file path.
 * @returns {import('./SecretStore')|null}
 */
function createSecretStore(options = {}) {
  const safeStorage = tryGetSafeStorage();
  if (safeStorage) {
    return new SafeStorageSecretStore({ filePath: options.safeStorageFilePath, safeStorage });
  }

  const key = keyManager.resolveKey();
  if (!key) return null;
  return new FileSecretStore({ key, filePath: options.filePath });
}

module.exports = { createSecretStore, tryGetSafeStorage };
