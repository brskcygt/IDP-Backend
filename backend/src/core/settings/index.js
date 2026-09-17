'use strict';

/**
 * Settings service bound to the real repository and audit logger.
 * Mirrors the wiring pattern of core/artifacts/index.js.
 */

const repository = require('../../store/settingsRepository');
const auditLogger = require('../../services/AuditLogger');
const { createSettingsService, SettingsValidationError } = require('./settingsService');

const settingsService = createSettingsService({ repository, auditLogger });

module.exports = { settingsService, SettingsValidationError };
