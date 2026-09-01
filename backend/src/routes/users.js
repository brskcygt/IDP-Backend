/**
 * User Management routes (T-52 / SEC-09) — admin-only.
 *
 * Extracted out of server.js to match the existing router-per-concern
 * pattern already used for deploy (routes/deploy.js) and MFA
 * (routes/mfa.js), rather than growing server.js further.
 *
 * userStore.getUsers() / addUser() / updateUserRole() / updateUserPassword()
 * / removeUser() / getUserById() never return a passwordHash — every
 * response below is already the "safe" shape, straight from userStore.
 */
const express = require('express');
const router = express.Router();
const userStore = require('../auth/userStore');
const auditLogger = require('../services/AuditLogger');
const { requirePermission } = require('../auth/permissions');
const { validate } = require('../validation/schema');
const { userSchema, userUpdateSchema } = require('../validation/projectSchemas');

/** Maps a userStore error `.code` to its HTTP status + a stable body. */
function userStoreErrorResponse(err) {
  switch (err.code) {
    case 'USERNAME_TAKEN':
    case 'LAST_ADMIN':
      return { status: 409, body: { error: err.message } };
    case 'NOT_FOUND':
      return { status: 404, body: { error: err.message } };
    case 'INVALID_USERNAME':
    case 'INVALID_PASSWORD':
    case 'INVALID_ROLE':
      return { status: 400, body: { error: err.message } };
    default:
      return { status: 500, body: { error: 'Unexpected error managing users.' } };
  }
}

router.get('/', requirePermission('user:manage'), (req, res) => {
  res.json(userStore.getUsers());
});

router.post('/', requirePermission('user:manage'), (req, res) => {
  const result = validate(req.body || {}, userSchema);
  if (!result.valid) {
    return res.status(400).json({ error: 'Invalid user data.', details: result.errors });
  }
  const { username, password, role } = result.value;
  try {
    const created = userStore.addUser({ username, password, role });
    auditLogger.log(
      req.session?.user?.username,
      'USER_CREATED',
      `Created user: ${created.username} (${created.role})`,
      { userId: created.id }
    );
    return res.status(201).json(created);
  } catch (err) {
    const { status, body } = userStoreErrorResponse(err);
    return res.status(status).json(body);
  }
});

router.patch('/:id', requirePermission('user:manage'), (req, res) => {
  const { id } = req.params;
  const body = req.body || {};

  if (body.role === undefined && body.password === undefined) {
    return res.status(400).json({ error: 'Provide at least one of: role, password.' });
  }

  const result = validate(body, userUpdateSchema);
  if (!result.valid) {
    return res.status(400).json({ error: 'Invalid user data.', details: result.errors });
  }
  const { role, password } = result.value;

  try {
    let updated = null;
    if (role !== undefined) {
      updated = userStore.updateUserRole(id, role);
      auditLogger.log(
        req.session?.user?.username,
        'USER_ROLE_CHANGED',
        `Changed role for user ${updated.username} to ${updated.role}`,
        { userId: id }
      );
    }
    if (password !== undefined) {
      updated = userStore.updateUserPassword(id, password);
      auditLogger.log(
        req.session?.user?.username,
        'USER_PASSWORD_RESET',
        `Reset password for user ${updated.username}`,
        { userId: id }
      );
    }
    return res.json(updated);
  } catch (err) {
    const { status, body } = userStoreErrorResponse(err);
    return res.status(status).json(body);
  }
});

router.delete('/:id', requirePermission('user:manage'), (req, res) => {
  const { id } = req.params;
  const target = userStore.getUserById(id);

  try {
    userStore.removeUser(id);
    auditLogger.log(
      req.session?.user?.username,
      'USER_DELETED',
      `Deleted user: ${target ? target.username : id}`,
      { userId: id }
    );
    return res.json({ success: true });
  } catch (err) {
    const { status, body } = userStoreErrorResponse(err);
    return res.status(status).json(body);
  }
});

module.exports = router;
