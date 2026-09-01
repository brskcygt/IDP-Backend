/**
 * Preload that gives every test process its own throwaway database.
 *
 * Loaded via `node --require` from the `test` script, so it runs before any test
 * file — and therefore before the singletons those files import (DeploymentManager,
 * the repositories) open a connection at import time.
 *
 * Without it a test run writes into `src/idp.db`, the real data: deployment rows
 * from tests pile up in the live history.
 *
 * The pid stamp matters. node:test spawns a child process per test file, and
 * children inherit the parent's environment — so simply setting IDP_DB_PATH when
 * it is unset leaves every child pointing at the path the *parent* created. They
 * then race each other inside openDatabase()'s `ALTER TABLE` migration step and
 * fail intermittently with SQLITE_BUSY. Re-deriving the path whenever the stamp
 * doesn't match this process gives each child its own file, while still honouring
 * an IDP_DB_PATH the caller set deliberately (no stamp present).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OWNER_STAMP = 'IDP_DB_PATH_OWNER_PID';
const explicitlySet = process.env.IDP_DB_PATH && !process.env[OWNER_STAMP];
const inheritedFromAnotherProcess =
  process.env[OWNER_STAMP] && process.env[OWNER_STAMP] !== String(process.pid);

if (!explicitlySet && (!process.env.IDP_DB_PATH || inheritedFromAnotherProcess)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `idp-test-${process.pid}-`));
  process.env.IDP_DB_PATH = path.join(dir, 'test.db');
  process.env[OWNER_STAMP] = String(process.pid);

  process.on('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp directory is harmless; never fail a test run over it.
    }
  });
}
