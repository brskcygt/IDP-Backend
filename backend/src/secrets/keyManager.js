'use strict';

const crypto = require('crypto');

const ENV_VAR = 'IDP_SECRET_KEY';
const KEY_LENGTH_BYTES = 32; // AES-256

/**
 * Reads and validates the secret-encryption key from `process.env.IDP_SECRET_KEY`.
 *
 * The env var is expected to be a base64-encoded 32-byte value (generate one
 * with `generateKey()`).
 *
 * @returns {Buffer|null} the 32-byte key, or `null` if `IDP_SECRET_KEY` is
 *   unset/empty. Never throws for the "unset" case — the caller decides what
 *   to do when secret storage isn't configured.
 * @throws {Error} if `IDP_SECRET_KEY` is set but is not valid base64, or
 *   doesn't decode to exactly 32 bytes.
 */
function resolveKey() {
  const raw = process.env[ENV_VAR];
  if (raw === undefined || raw === null || raw.trim() === '') return null;

  let key;
  try {
    key = Buffer.from(raw.trim(), 'base64');
  } catch (err) {
    throw new Error(`${ENV_VAR} is not valid base64: ${err.message}`);
  }

  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `${ENV_VAR} must decode to exactly ${KEY_LENGTH_BYTES} bytes (got ${key.length}). ` +
        'Generate a valid key with keyManager.generateKey() (or: node -e ' +
        '"console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))").'
    );
  }

  return key;
}

/**
 * Generates a new random 32-byte key, base64-encoded — for initial setup
 * (e.g. printing a value for the operator to put in `.env`).
 * @returns {string}
 */
function generateKey() {
  return crypto.randomBytes(KEY_LENGTH_BYTES).toString('base64');
}

/**
 * Describes whether a valid secret-encryption key is configured, for use in
 * startup logging. This NEVER returns the key material itself.
 * @returns {{ configured: boolean, message: string }}
 */
function describeKeyStatus() {
  try {
    const key = resolveKey();
    if (key) {
      return { configured: true, message: `${ENV_VAR} is configured — secret storage is enabled.` };
    }
    return {
      configured: false,
      message: `${ENV_VAR} is not set — secret storage is disabled; secrets will remain in plaintext.`,
    };
  } catch (err) {
    return { configured: false, message: `${ENV_VAR} is set but invalid: ${err.message}` };
  }
}

module.exports = { resolveKey, generateKey, describeKeyStatus };
