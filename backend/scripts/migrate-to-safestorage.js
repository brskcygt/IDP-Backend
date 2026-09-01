#!/usr/bin/env node
/**
 * One-time migration: move every secret from the `IDP_SECRET_KEY`-based
 * `FileSecretStore` into a `safeStorage`-backed `SafeStorageSecretStore`
 * (T-92), for installs moving to the Electron desktop app.
 *
 * Runs as a dry run by default. Pass --apply to actually write.
 *
 *   node scripts/migrate-to-safestorage.js            # report only
 *   node scripts/migrate-to-safestorage.js --apply    # migrate
 *
 * Idempotent: keys already present in the destination store are left alone,
 * so re-running (e.g. after a partial failure) is safe.
 *
 * The source `FileSecretStore` is NEVER deleted by this script — it stays in
 * place as a backup until the operator has verified the migrated app works,
 * mirroring `scripts/migrate-secrets.js`.
 *
 * This script only runs meaningfully inside the Electron desktop app, since
 * that's the only place `safeStorage` exists. Running it from the plain
 * Node backend will fail fast with a clear message instead of silently
 * doing nothing.
 */
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const FileSecretStore = require('../src/secrets/FileSecretStore');
const SafeStorageSecretStore = require('../src/secrets/SafeStorageSecretStore');
const { migrateSecrets } = require('../src/secrets/migrateStore');
const { resolveKey, describeKeyStatus } = require('../src/secrets/keyManager');
const { tryGetSafeStorage } = require('../src/secrets');

const APPLY = process.argv.includes('--apply');

async function main() {
  const keyStatus = describeKeyStatus();
  console.log(`\nSource (FileSecretStore) key: ${keyStatus.message}`);

  const sourceKey = resolveKey();
  if (!sourceKey) {
    console.error(
      '\n✗ IDP_SECRET_KEY is not configured, so there is no source FileSecretStore to migrate from.\n'
    );
    process.exit(1);
  }

  const safeStorage = tryGetSafeStorage();
  if (!safeStorage) {
    console.error(
      '\n✗ safeStorage is not available in this process. This script must be run from inside\n' +
      '  the Electron desktop app (main process), where the OS keychain/keyring is reachable.\n'
    );
    process.exit(1);
  }

  const fromStore = new FileSecretStore({ key: sourceKey });
  const toStore = new SafeStorageSecretStore({ safeStorage });

  const sourceKeys = await fromStore.listKeys();
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`Secrets in source store : ${sourceKeys.length}`);

  if (sourceKeys.length === 0) {
    console.log('\nNothing to migrate.\n');
    return;
  }

  if (!APPLY) {
    let alreadyPresent = 0;
    for (const key of sourceKeys) {
      // eslint-disable-next-line no-await-in-loop
      if (await toStore.has(key)) alreadyPresent += 1;
    }
    console.log(`Already in destination  : ${alreadyPresent}`);
    console.log(`Would migrate           : ${sourceKeys.length - alreadyPresent}`);
    for (const key of sourceKeys) {
      console.log(`  • ${key}`);
    }
    console.log(`\n${'─'.repeat(64)}`);
    console.log('DRY RUN — nothing was written. Re-run with --apply to migrate.\n');
    return;
  }

  const result = await migrateSecrets(fromStore, toStore);

  console.log(`Migrated                : ${result.migrated}`);
  console.log(`Already present (skipped): ${result.skipped}`);
  for (const key of result.keys) {
    console.log(`  • ${key}`);
  }

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`✓ Migrated ${result.migrated} secret(s) into the safeStorage-backed store.`);
  console.log('\nThe original FileSecretStore file was left untouched as a backup. Once you\'ve');
  console.log('verified the app works with the new store, you can remove IDP_SECRET_KEY and');
  console.log('delete the old secrets.enc.json file.\n');
}

main().catch((err) => {
  console.error('\n✗ Migration failed:', err.message);
  process.exit(1);
});
