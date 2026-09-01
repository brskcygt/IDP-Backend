'use strict';

/**
 * Generic SecretStore → SecretStore migration (T-92).
 *
 * Used to move every key from `FileSecretStore` (AES-256-GCM, `IDP_SECRET_KEY`)
 * into `SafeStorageSecretStore` (OS keychain-backed) once the desktop app is
 * available, without either store needing to know about the other.
 *
 * Deliberately does NOT delete anything from `fromStore` — the source stays
 * intact as a backup until the operator has verified the new store works,
 * matching the same caution as `scripts/migrate-secrets.js`.
 */

/**
 * Copies every secret from `fromStore` to `toStore`.
 *
 * Idempotent: a key that already exists in `toStore` (per `has()`) is left
 * untouched and counted as skipped, so re-running after a partial failure
 * never overwrites something already migrated.
 *
 * @param {import('./SecretStore')} fromStore
 * @param {import('./SecretStore')} toStore
 * @returns {Promise<{ migrated: number, skipped: number, keys: string[] }>}
 *   `migrated` — count of keys newly written to `toStore`.
 *   `skipped` — count of keys already present in `toStore`.
 *   `keys` — the key names that were newly migrated (never their values).
 */
async function migrateSecrets(fromStore, toStore) {
  if (!fromStore || !toStore) {
    throw new Error('migrateSecrets requires both a fromStore and a toStore');
  }

  const keys = await fromStore.listKeys();
  let migrated = 0;
  let skipped = 0;
  const migratedKeys = [];

  for (const key of keys) {
    if (await toStore.has(key)) {
      skipped += 1;
      continue;
    }

    const value = await fromStore.get(key);
    if (value === null) {
      // Vanished between listKeys() and get() (deleted concurrently, or a
      // corrupt-but-listed record) — nothing to migrate for this key.
      skipped += 1;
      continue;
    }

    await toStore.set(key, value);
    migrated += 1;
    migratedKeys.push(key);
  }

  return { migrated, skipped, keys: migratedKeys };
}

module.exports = { migrateSecrets };
