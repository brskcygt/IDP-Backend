'use strict';

/**
 * Server-wide settings. Today that is one document: the build parameters every
 * project's release build inherits.
 *
 * Why global defaults exist at all: values like a PostHog region host or an
 * error-tracking credential id are the same for every project on this server,
 * and copying them into each project is how they drift apart. A project can
 * still override any of them — its own parameters win (see
 * core/deployment/buildParameters.js#mergeBuildParameters).
 *
 * Secrets are rejected by construction rather than by policy: parameters travel
 * to the CI tool as a query string and land in its build log, so this document
 * may only ever hold references (a credential id), never the credential.
 */

const { normalizeBuildParameters, validateBuildParameters } = require('../deployment/buildParameters');

const BUILD_PARAMETERS_KEY = 'buildParameters';

class SettingsValidationError extends Error {
  /** @param {{ path: string, message: string }[]} details */
  constructor(message, details) {
    super(message);
    this.name = 'SettingsValidationError';
    this.details = details;
  }
}

/**
 * @param {{ repository: object, auditLogger: { log: Function } }} deps
 */
function createSettingsService({ repository, auditLogger }) {
  return {
    /**
     * @returns {{ parameters: Record<string, string>, updatedAt: string|null, updatedBy: string|null }}
     */
    getBuildParameters() {
      const row = repository.read(BUILD_PARAMETERS_KEY);
      return {
        parameters: normalizeBuildParameters(row?.value) || {},
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      };
    },

    /**
     * Used by the release service on every build; never throws, because a
     * malformed settings row must not be able to block every project's build.
     * @returns {Record<string, string>|null}
     */
    readBuildParametersForBuild() {
      try {
        return normalizeBuildParameters(repository.read(BUILD_PARAMETERS_KEY)?.value);
      } catch (err) {
        console.error('[settings] Could not read the global build parameters:', err.message);
        return null;
      }
    },

    /**
     * Replaces the whole document — an entry the operator removed has to
     * actually disappear, which a merge would never do.
     * @param {*} parameters
     * @param {string|null} actor
     */
    updateBuildParameters(parameters, actor = null) {
      const errors = validateBuildParameters(parameters, 'parameters');
      if (errors.length > 0) {
        throw new SettingsValidationError('Invalid build parameters.', errors);
      }
      const normalized = normalizeBuildParameters(parameters) || {};
      const row = repository.write(BUILD_PARAMETERS_KEY, normalized, actor);
      auditLogger.log(
        actor,
        'SETTINGS_UPDATED',
        `Updated the global build parameters (${Object.keys(normalized).length} key(s))`,
      );
      return { parameters: normalized, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
    },
  };
}

module.exports = { createSettingsService, SettingsValidationError, BUILD_PARAMETERS_KEY };
