'use strict';

/**
 * Role-based authorization (T-52 / SEC-09).
 *
 * Before this module existed, every authenticated user was an implicit
 * full admin — `requireAuth` in server.js only checked "is there a
 * session", never "is this session allowed to do X". Any logged-in
 * viewer could edit a project's `scriptContent` and trigger a deploy,
 * which is arbitrary command execution on every target server.
 *
 * `userStore.js` already persists a `role` field
 * (`'admin' | 'deployer' | 'viewer'`); this module is what actually
 * enforces it.
 *
 * Design: a small, explicit action → minimum-role table plus a linear
 * role hierarchy (`admin > deployer > viewer`). Both `can()` and the two
 * middleware factories below are FAIL-CLOSED — an unknown role or an
 * unknown/unlisted action is never granted, it's simply denied. There is
 * no "default allow" path anywhere in this file.
 */

/** @typedef {'admin'|'deployer'|'viewer'} Role */
/**
 * @typedef {'project:read'|'project:write'|'project:delete'|'deploy:trigger'|
 *   'deploy:abort'|'vpn:manage'|'audit:read'|'user:manage'} Action
 */

const ROLES = Object.freeze({
  ADMIN: 'admin',
  DEPLOYER: 'deployer',
  VIEWER: 'viewer',
});

/** Linear hierarchy: higher number = more privilege. */
const ROLE_RANK = Object.freeze({
  [ROLES.VIEWER]: 1,
  [ROLES.DEPLOYER]: 2,
  [ROLES.ADMIN]: 3,
});

/**
 * Minimum role required to perform each action.
 *   viewer   → read projects, deployment history/logs, the audit trail
 *   deployer → + trigger/abort deploys, submit MFA
 *   admin    → + create/edit/delete projects, manage VPN sessions, manage users
 */
const ACTION_MIN_ROLE = Object.freeze({
  'project:read': ROLES.VIEWER,
  'audit:read': ROLES.VIEWER,
  'deploy:trigger': ROLES.DEPLOYER,
  'deploy:abort': ROLES.DEPLOYER,
  'project:write': ROLES.ADMIN,
  'project:delete': ROLES.ADMIN,
  'vpn:manage': ROLES.ADMIN,
  'user:manage': ROLES.ADMIN,
});

/**
 * @param {string} role
 * @param {string} action
 * @returns {boolean}
 */
function can(role, action) {
  const roleRank = ROLE_RANK[role];
  const requiredRole = ACTION_MIN_ROLE[action];
  // Fail-closed: an unrecognized role (typo, stale/tampered session, future
  // role value nobody wired up yet) or an unrecognized action never passes.
  if (!roleRank || !requiredRole) return false;
  return roleRank >= ROLE_RANK[requiredRole];
}

/**
 * Express middleware: requires the session's user to hold at least
 * `minRole` in the hierarchy. Prefer `requirePermission(action)` for
 * route protection — this is the coarser building block it's built on,
 * exposed for the rare case a route wants "any admin", not a named action.
 * @param {Role} minRole
 */
function requireRole(minRole) {
  const minRank = ROLE_RANK[minRole];
  if (!minRank) {
    throw new Error(`requireRole: unknown role "${minRole}"`);
  }
  return function requireRoleMiddleware(req, res, next) {
    const user = req.session && req.session.user;
    if (!user) {
      // Not the same failure as "wrong role" — no identity at all yet.
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const rank = ROLE_RANK[user.role];
    if (!rank || rank < minRank) {
      return res.status(403).json({
        error: `Bu işlem için en az '${minRole}' rolü gereklidir.`,
      });
    }
    return next();
  };
}

/**
 * Express middleware: requires the session's user to be permitted to
 * perform `action`. This is the primary route guard used throughout
 * server.js / routes/deploy.js.
 *
 * Identity vs. authorization are deliberately distinguished in the
 * response: no session → 401 (who are you), authenticated but
 * insufficient role → 403 (I know who you are, you can't do this).
 * @param {Action} action
 */
function requirePermission(action) {
  if (!(action in ACTION_MIN_ROLE)) {
    throw new Error(`requirePermission: unknown action "${action}"`);
  }
  return function requirePermissionMiddleware(req, res, next) {
    const user = req.session && req.session.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!can(user.role, action)) {
      return res.status(403).json({
        error: `Bu işlem için yetkiniz yok ('${action}' izni gerekir). Mevcut rolünüz: ${user.role}.`,
      });
    }
    return next();
  };
}

module.exports = {
  ROLES,
  ROLE_RANK,
  ACTION_MIN_ROLE,
  can,
  requireRole,
  requirePermission,
};
