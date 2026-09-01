'use strict';

/**
 * Abstract secret storage interface (T-10).
 *
 * This is the contract every secret backend must honor — today that's
 * `FileSecretStore` (AES-256-GCM on disk). When this backend is embedded in
 * the Electron desktop app, a second implementation backed by `safeStorage`
 * (macOS Keychain / Windows DPAPI / Linux libsecret) will sit behind this
 * same interface, so callers never need to know which backend is active.
 *
 * Contract (all implementations MUST follow this exactly):
 *  - `get(key)` NEVER throws for a key that simply doesn't exist — it
 *    resolves to `null`. It MAY throw if the stored data for a key that DOES
 *    exist cannot be decrypted (tampered ciphertext, wrong key, etc.) —
 *    that's a real error, not a "missing" state, and callers should be able
 *    to tell the difference.
 *  - `set(key, value)` overwrites any existing value for `key`.
 *  - `delete(key)` resolves to `true` if a secret existed and was removed,
 *    `false` if there was nothing to delete. It never throws for a missing key.
 *  - `has(key)` never throws.
 *  - `listKeys()` NEVER returns secret values — key names only, always.
 */
class SecretStore {
  /**
   * @param {string} key
   * @returns {Promise<string|null>} the secret value, or `null` if `key` was never set.
   */
  async get(key) {
    throw new Error('SecretStore.get() not implemented');
  }

  /**
   * @param {string} key
   * @param {string} value
   * @returns {Promise<void>}
   */
  async set(key, value) {
    throw new Error('SecretStore.set() not implemented');
  }

  /**
   * @param {string} key
   * @returns {Promise<boolean>} true if a secret existed and was deleted, false otherwise.
   */
  async delete(key) {
    throw new Error('SecretStore.delete() not implemented');
  }

  /**
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async has(key) {
    throw new Error('SecretStore.has() not implemented');
  }

  /**
   * @returns {Promise<string[]>} the list of stored key names — never values.
   */
  /**
   * A one-line, human-readable description of where secrets are kept and how
   * they are protected — for the startup log.
   *
   * Each implementation answers for itself. The caller must not infer this from
   * environment variables: with more than one backing store, "IDP_SECRET_KEY is
   * not set" no longer means "secrets are unprotected".
   *
   * MUST NOT include any key material.
   * @returns {string}
   */
  describe() {
    return 'Secret storage: unknown backend.';
  }

  async listKeys() {
    throw new Error('SecretStore.listKeys() not implemented');
  }
}

module.exports = SecretStore;
