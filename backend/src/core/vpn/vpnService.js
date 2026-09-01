'use strict';

/**
 * VPN session management — extracted from server.js's
 * `/api/projects/:id/vpn/clear-session`, `/api/vpn/force-disconnect`, and
 * `/api/vpn/sessions` route handlers (T-58).
 */
const VpnManager = require('../../services/vpn/VpnManager');
const mfaVpnHandler = require('../../services/vpn/MfaVpnHandler');
const auditLogger = require('../../services/AuditLogger');
const projectService = require('../projects/projectService');
const { ValidationError } = require('../errors');

/**
 * @param {string} projectId
 * @param {string} actor
 * @returns {Promise<{ success: true, cleared: boolean }>}
 * @throws {NotFoundError} if the project doesn't exist.
 * @throws {ValidationError} if the project has no VPN configured.
 */
async function clearProjectVpnSession(projectId, actor) {
  const project = projectService.getProject(projectId);

  const vpnType = project.config?.vpnConfig?.type;
  if (!vpnType) {
    throw new ValidationError('No VPN configured for this project');
  }

  const cleared = await mfaVpnHandler.clearSession(projectId, vpnType);

  auditLogger.log(actor, 'VPN_SESSION_CLEARED', `Cleared VPN session cache for project: ${project.name}`, { projectId });

  return { success: true, cleared };
}

/**
 * @param {string} actor
 * @returns {Promise<{ success: true }>}
 */
async function forceDisconnectAll(actor) {
  await VpnManager.forceClearAll();
  auditLogger.log(actor, 'VPN_FORCE_DISCONNECTED', `Forcefully cleared all background VPN processes`);
  return { success: true };
}

/**
 * @returns {Promise<Array<{ projectId: string, projectName: string, provider: string, expiresAt: number }>>}
 */
async function listActiveVpnSessions() {
  const cache = await mfaVpnHandler.loadCache();

  const activeSessions = [];
  const now = Date.now();

  for (const [key, session] of Object.entries(cache)) {
    if (session.expiresAt > now) {
      // key format is: projectId_provider
      const lastUnderscoreIndex = key.lastIndexOf('_');
      if (lastUnderscoreIndex !== -1) {
        const projectId = key.substring(0, lastUnderscoreIndex);
        const provider = key.substring(lastUnderscoreIndex + 1);
        const project = projectService.findProjectById(projectId);

        activeSessions.push({
          projectId,
          projectName: project ? project.name : 'Unknown Project',
          provider,
          expiresAt: session.expiresAt
        });
      }
    }
  }

  return activeSessions;
}

module.exports = { clearProjectVpnSession, forceDisconnectAll, listActiveVpnSessions };
