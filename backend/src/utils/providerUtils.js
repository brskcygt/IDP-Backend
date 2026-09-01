'use strict';

/**
 * Provider normalization helpers (T-35/T-36).
 *
 * `Server`, `SSH`, and `WinRM` are not three different providers — they are
 * one adapter family (see server.js#createAdapter) split only by
 * `config.targetOS` (`linux` -> SSH, `windows` -> WinRM). `SSH`/`WinRM` are
 * legacy names kept alive by old records; new records use `Server`.
 */

/** Raw provider names that belong to the Server/SSH/WinRM adapter family. */
const SERVER_PROVIDER_NAMES = ['Server', 'SSH', 'WinRM'];

/** True when `provider` should be routed to the Server-family adapter. */
function isServerProvider(provider) {
  return SERVER_PROVIDER_NAMES.includes(provider);
}

/**
 * Migrate legacy `SSH`/`WinRM` provider values to the canonical `Server`
 * value, filling in `config.targetOS` from the legacy name when it is not
 * already set. Pure: returns a new array of new project objects (with a new
 * `config` object where changed); never mutates `projects` or any project
 * within it. Projects that are already canonical (`Server`, `Jenkins`,
 * `PMP`, ...) — or that already have `config.targetOS` set — pass through
 * with only a shallow clone, so re-running this is always a no-op.
 */
function migrateProjectProviders(projects) {
  return (projects || []).map((project) => {
    if (project.provider !== 'SSH' && project.provider !== 'WinRM') {
      return { ...project };
    }

    const config = project.config || {};
    const targetOS = config.targetOS || (project.provider === 'WinRM' ? 'windows' : 'linux');

    return {
      ...project,
      provider: 'Server',
      config: { ...config, targetOS },
    };
  });
}

module.exports = { isServerProvider, migrateProjectProviders, SERVER_PROVIDER_NAMES };
