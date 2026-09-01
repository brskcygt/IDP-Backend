'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const SecretStore = require('./SecretStore');

const FILE_MODE = 0o600;
const DEFAULT_FILE_NAME = 'secrets.safestorage.json';

/**
 * Electron `safeStorage`-backed implementation of SecretStore (T-92).
 *
 * `safeStorage` hands off key management to the OS itself — macOS Keychain,
 * Windows DPAPI, or Linux libsecret/kwallet — so there is no `IDP_SECRET_KEY`
 * to generate, back up, or lose. Losing that key today means losing every
 * stored credential; this backend removes that failure mode entirely for the
 * desktop app.
 *
 * On-disk record shape: `{ [key]: string }`, where each value is the
 * base64-encoded Buffer that `safeStorage.encryptString()` returns. Unlike
 * `FileSecretStore`'s AES-256-GCM record (iv/authTag/ciphertext), the
 * encrypted blob `safeStorage` returns already carries everything it needs
 * to decrypt itself via the OS keystore — there is nothing else to store
 * alongside it.
 *
 * Writes are atomic (temp file + rename) and the file is created with
 * `0o600` permissions, mirroring `FileSecretStore`. Corruption handling is
 * the same two-tier approach:
 *  - A record that isn't a non-empty string is structurally invalid and is
 *    skipped at load time with a console warning — it behaves like the key
 *    was never set (`get()` resolves to `null`), never throws.
 *  - A record that is a well-formed string but fails to decrypt (tampered
 *    blob, OS keystore no longer has the key, wrong machine/user) throws a
 *    clear, specific error from `get()` — that's a genuine "cannot be
 *    trusted" condition, not a "missing" one.
 *
 * `electron` is required lazily and only when actually needed (resolving
 * the default file path, or resolving `safeStorage` when it wasn't
 * injected). This file is also loaded by the plain-Node backend test suite,
 * where the `electron` package isn't installed at all — a module-level
 * `require('electron')` would break every test that merely imports this
 * module.
 */
class SafeStorageSecretStore extends SecretStore {
  /**
   * @param {object} [options]
   * @param {string} [options.filePath] - path to the encrypted store file.
   *   Defaults to `<app.getPath('userData')>/secrets.safestorage.json`,
   *   resolved lazily (via `electron`) on first use if omitted. Tests
   *   should always pass this explicitly.
   * @param {object} [options.safeStorage] - injectable `safeStorage`
   *   implementation, e.g. Electron's `safeStorage` module, or a fake for
   *   tests. Must expose `isEncryptionAvailable()`, `encryptString(string)`
   *   -> Buffer, and `decryptString(Buffer)` -> string. When omitted, it is
   *   resolved lazily via `require('electron').safeStorage`.
   */
  constructor(options = {}) {
    super();
    const { filePath = null, safeStorage = null } = options;
    this._filePath = filePath;
    this._safeStorageOverride = safeStorage;
    this._safeStorage = null;
    /** @type {Object<string, string>|null} */
    this._cache = null;
    this._loadPromise = null;
  }

  /**
   * Resolves the store's file path, lazily falling back to Electron's
   * per-user data directory when no `filePath` was injected.
   * @returns {string}
   */
  _getFilePath() {
    if (this._filePath) return this._filePath;
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    this._filePath = path.join(app.getPath('userData'), DEFAULT_FILE_NAME);
    return this._filePath;
  }

  /**
   * Resolves the `safeStorage` implementation, lazily requiring `electron`
   * only if nothing was injected.
   * @returns {object}
   */
  _getSafeStorage() {
    if (this._safeStorage) return this._safeStorage;
    if (this._safeStorageOverride) {
      this._safeStorage = this._safeStorageOverride;
    } else {
      // eslint-disable-next-line global-require
      this._safeStorage = require('electron').safeStorage;
    }
    return this._safeStorage;
  }

  /**
   * Throws a clear, specific error if OS-backed encryption isn't available
   * (e.g. no keyring/keychain backend on this Linux install). Never falls
   * back to storing plaintext.
   */
  _assertEncryptionAvailable() {
    const safeStorage = this._getSafeStorage();
    const available = typeof safeStorage.isEncryptionAvailable === 'function'
      ? safeStorage.isEncryptionAvailable()
      : false;
    if (!available) {
      throw new Error(
        'safeStorage encryption is not available on this system (no OS keychain/keyring ' +
        'backend detected — e.g. missing gnome-keyring/kwallet on Linux). Refusing to store ' +
        'secrets in plaintext; install/unlock a keyring backend and restart the app.'
      );
    }
  }

  /**
   * Lazily loads (and caches) the record map from disk. Safe to call
   * repeatedly/concurrently.
   * @returns {Promise<Object<string, string>>}
   */
  async _load() {
    if (this._cache) return this._cache;
    if (!this._loadPromise) {
      this._loadPromise = this._readFile();
    }
    this._cache = await this._loadPromise;
    return this._cache;
  }

  /** @returns {Promise<Object<string, string>>} */
  async _readFile() {
    const filePath = this._getFilePath();
    let raw;
    try {
      raw = await fsp.readFile(filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      throw err;
    }

    if (!raw.trim()) return {};

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn(
        `[SafeStorageSecretStore] ${filePath} is not valid JSON (${err.message}). Starting with an empty store.`
      );
      return {};
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn(`[SafeStorageSecretStore] ${filePath} did not contain a JSON object. Starting with an empty store.`);
      return {};
    }

    const store = {};
    for (const [key, record] of Object.entries(parsed)) {
      if (this._isValidRecordShape(record)) {
        store[key] = record;
      } else {
        console.warn(`[SafeStorageSecretStore] Skipping malformed secret record for key "${key}" in ${filePath}.`);
      }
    }
    return store;
  }

  /**
   * Structural validation only — does NOT verify the record actually
   * decrypts. That happens lazily in `_decrypt()` so a tampered-but-
   * well-formed record still throws a specific error when actually read.
   * @param {*} record
   * @returns {boolean}
   */
  _isValidRecordShape(record) {
    return typeof record === 'string' && record.trim().length > 0;
  }

  /** Writes `this._cache` to disk atomically (temp file + rename). */
  async _persist() {
    const filePath = this._getFilePath();
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });

    const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    const data = JSON.stringify(this._cache, null, 2);
    try {
      await fsp.writeFile(tmpPath, data, { mode: FILE_MODE });
      await fsp.rename(tmpPath, filePath);
    } catch (err) {
      await fsp.unlink(tmpPath).catch(() => {});
      throw err;
    }
    // Belt-and-suspenders: ensure permissions even if the platform's rename
    // semantics or an existing target file's mode didn't preserve 0600.
    await fsp.chmod(filePath, FILE_MODE).catch(() => {});
  }

  /**
   * @param {string} plaintext
   * @returns {string} base64-encoded encrypted blob
   */
  _encrypt(plaintext) {
    this._assertEncryptionAvailable();
    const safeStorage = this._getSafeStorage();
    const buf = safeStorage.encryptString(String(plaintext));
    return Buffer.from(buf).toString('base64');
  }

  /**
   * @param {string} record - base64-encoded encrypted blob
   * @returns {string}
   */
  _decrypt(record) {
    this._assertEncryptionAvailable();
    const safeStorage = this._getSafeStorage();
    const buf = Buffer.from(record, 'base64');
    return safeStorage.decryptString(buf);
  }

  /** @inheritdoc */
  async get(key) {
    const store = await this._load();
    const record = store[key];
    if (!record) return null;
    try {
      return this._decrypt(record);
    } catch (err) {
      throw new Error(
        `Failed to decrypt secret "${key}": data is tampered, was encrypted on a different ` +
        `machine/user, or the OS keystore entry is gone (${err.message})`
      );
    }
  }

  /** @inheritdoc */
  async set(key, value) {
    const store = await this._load();
    store[key] = this._encrypt(value);
    await this._persist();
  }

  /** @inheritdoc */
  async delete(key) {
    const store = await this._load();
    const existed = Object.prototype.hasOwnProperty.call(store, key);
    if (existed) {
      delete store[key];
      await this._persist();
    }
    return existed;
  }

  /** @inheritdoc */
  async has(key) {
    const store = await this._load();
    return Object.prototype.hasOwnProperty.call(store, key);
  }

  /** @inheritdoc */
  async listKeys() {
    const store = await this._load();
    return Object.keys(store);
  }

  /** @inheritdoc */
  describe() {
    // Resolve through the same lazy getter the store itself uses. Reading the
    // raw field would print `null` before first use — which is how this line
    // first appeared in the packaged app's startup log, telling the operator
    // the blobs live at "null".
    let location;
    try {
      location = this._getFilePath();
    } catch {
      // `electron` unavailable (plain-Node consumer): still say something true.
      location = 'a path resolved on first use';
    }
    return `Secret storage: OS keychain via Electron safeStorage, blobs at ${location}.`;
  }

}

module.exports = SafeStorageSecretStore;
