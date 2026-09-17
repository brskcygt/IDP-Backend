'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const SecretStore = require('./SecretStore');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // GCM standard: 96-bit IV, never reused per key.
const AUTH_TAG_LENGTH_BYTES = 16;
const KEY_LENGTH_BYTES = 32; // AES-256
const FILE_MODE = 0o600;
const DEFAULT_FILE_PATH = path.join(__dirname, '..', 'secrets.enc.json');

/**
 * Where the encrypted store lives when the caller doesn't pass `filePath`.
 *
 * `IDP_SECRETS_PATH` follows IDP_DB_PATH / IDP_USERS_PATH / IDP_SESSIONS_PATH:
 * a server install keeps its data outside the code directory, so an update
 * that replaces backend/ can't take the secrets with it. Read at construction
 * time (not module load) so it's honoured however late the env is set.
 * @returns {string}
 */
function resolveDefaultFilePath() {
  const override = process.env.IDP_SECRETS_PATH;
  return override && override.trim() !== '' ? override.trim() : DEFAULT_FILE_PATH;
}

/**
 * @typedef {object} EncryptedRecord
 * @property {string} iv - base64, 12 random bytes, unique per encryption.
 * @property {string} authTag - base64, GCM authentication tag (16 bytes).
 * @property {string} ciphertext - base64.
 */

/**
 * AES-256-GCM, on-disk implementation of SecretStore (T-10 / SEC-01).
 *
 * On-disk record shape: `{ [key]: { iv, authTag, ciphertext } }`, all fields
 * base64-encoded. A fresh random 12-byte IV is generated for every `set()`
 * call — IVs are never reused for a given key, which is what makes AES-GCM
 * safe here.
 *
 * Writes are atomic: content is written to a temp file next to the target
 * and then moved into place with `fs.rename`, so a crash mid-write can never
 * leave a half-written or truncated store file. The file is created with
 * `0o600` permissions (owner read/write only).
 *
 * Corruption handling is deliberately layered:
 *  - A record that is structurally broken (missing/invalid iv, authTag, or
 *    ciphertext) is skipped when the file is loaded, with a console warning.
 *    It behaves as if that key was never set — `get()` returns `null` for
 *    it, not a thrown error — so one bad row never takes the rest of the
 *    store down.
 *  - A record that is structurally valid but fails GCM authentication at
 *    decrypt time (tampered ciphertext/authTag, or the wrong key) throws a
 *    clear, specific error from `get()`, because the caller explicitly asked
 *    for that key and the data genuinely cannot be trusted.
 */
class FileSecretStore extends SecretStore {
  /**
   * @param {object} options
   * @param {Buffer} options.key - 32-byte AES-256 key (see keyManager.resolveKey()).
   * @param {string} [options.filePath] - path to the encrypted store file.
   *   Defaults to `IDP_SECRETS_PATH`, else `backend/src/secrets.enc.json`.
   *   Missing parent directories are created on first write (see _persist).
   */
  constructor(options = {}) {
    super();
    const { key, filePath = resolveDefaultFilePath() } = options;
    if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH_BYTES) {
      throw new Error(`FileSecretStore requires a ${KEY_LENGTH_BYTES}-byte Buffer key`);
    }
    this._key = key;
    this._filePath = filePath;
    /** @type {Object<string, EncryptedRecord>|null} */
    this._cache = null;
    this._loadPromise = null;
    /** Serializes _writeCache() calls; see _persist(). @type {Promise<void>|null} */
    this._persistQueue = null;
  }

  /**
   * Lazily loads (and caches) the decrypted-structure-but-still-encrypted
   * record map from disk. Safe to call repeatedly/concurrently.
   * @returns {Promise<Object<string, EncryptedRecord>>}
   */
  async _load() {
    if (this._cache) return this._cache;
    if (!this._loadPromise) {
      this._loadPromise = this._readFile();
    }
    this._cache = await this._loadPromise;
    return this._cache;
  }

  /** @returns {Promise<Object<string, EncryptedRecord>>} */
  async _readFile() {
    let raw;
    try {
      raw = await fsp.readFile(this._filePath, 'utf8');
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
        `[FileSecretStore] ${this._filePath} is not valid JSON (${err.message}). Starting with an empty store.`
      );
      return {};
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn(`[FileSecretStore] ${this._filePath} did not contain a JSON object. Starting with an empty store.`);
      return {};
    }

    const store = {};
    for (const [key, record] of Object.entries(parsed)) {
      if (this._isValidRecordShape(record)) {
        store[key] = record;
      } else {
        console.warn(`[FileSecretStore] Skipping malformed secret record for key "${key}" in ${this._filePath}.`);
      }
    }
    return store;
  }

  /**
   * Structural validation only — does NOT verify the GCM auth tag. That
   * happens lazily in `_decrypt()` so a tampered-but-well-formed record
   * still throws a specific error when actually read.
   * @param {*} record
   * @returns {boolean}
   */
  _isValidRecordShape(record) {
    if (!record || typeof record !== 'object') return false;
    const { iv, authTag, ciphertext } = record;
    if (typeof iv !== 'string' || typeof authTag !== 'string' || typeof ciphertext !== 'string') return false;
    try {
      if (Buffer.from(iv, 'base64').length !== IV_LENGTH_BYTES) return false;
      if (Buffer.from(authTag, 'base64').length !== AUTH_TAG_LENGTH_BYTES) return false;
      Buffer.from(ciphertext, 'base64');
    } catch (_err) {
      return false;
    }
    return true;
  }

  /**
   * Writes `this._cache` to disk atomically (temp file + rename).
   *
   * Saving a target's runtime config persists one secret per key, so a dozen
   * set() calls run concurrently. Two guards make that safe:
   *   - a random suffix in the temp name — pid+timestamp alone collided when
   *     two writes landed in the same millisecond, and the loser's rename then
   *     failed with ENOENT because the winner had already moved the file away;
   *   - a promise chain, so writes of the same cache never interleave.
   */
  async _persist() {
    this._persistQueue = (this._persistQueue || Promise.resolve())
      .catch(() => {})
      .then(() => this._writeCache());
    return this._persistQueue;
  }

  async _writeCache() {
    const dir = path.dirname(this._filePath);
    await fsp.mkdir(dir, { recursive: true });

    const unique = `${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}`;
    const tmpPath = path.join(dir, `.${path.basename(this._filePath)}.${unique}.tmp`);
    const data = JSON.stringify(this._cache, null, 2);
    try {
      await fsp.writeFile(tmpPath, data, { mode: FILE_MODE });
      await fsp.rename(tmpPath, this._filePath);
    } catch (err) {
      await fsp.unlink(tmpPath).catch(() => {});
      throw err;
    }
    // Belt-and-suspenders: ensure permissions even if the platform's rename
    // semantics or an existing target file's mode didn't preserve 0600.
    await fsp.chmod(this._filePath, FILE_MODE).catch(() => {});
  }

  /**
   * @param {string} plaintext
   * @returns {EncryptedRecord}
   */
  _encrypt(plaintext) {
    const iv = crypto.randomBytes(IV_LENGTH_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, this._key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  /**
   * @param {EncryptedRecord} record
   * @returns {string}
   */
  _decrypt(record) {
    const iv = Buffer.from(record.iv, 'base64');
    const authTag = Buffer.from(record.authTag, 'base64');
    const ciphertext = Buffer.from(record.ciphertext, 'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, this._key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
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
        `Failed to decrypt secret "${key}": data is tampered or was encrypted with a different key (${err.message})`
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
    return `Secret storage: encrypted file (AES-256-GCM) at ${this._filePath}, key from IDP_SECRET_KEY.`;
  }

}

module.exports = FileSecretStore;
