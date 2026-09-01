/**
 * User store (T-11 / SEC-04).
 *
 * Persists users to backend/src/users.json as
 *   [{ id, username, passwordHash, role, createdAt }]
 *
 * Passwords are hashed with Node's built-in `crypto.scrypt` — no new npm
 * dependency. Stored format is `saltBase64:derivedKeyBase64`; comparison
 * uses `crypto.timingSafeEqual` to avoid leaking match length via timing.
 *
 * On first run (no users.json), a single bootstrap admin user is created.
 * Its plaintext password is available exactly once: from `IDP_ADMIN_PASSWORD`
 * when set (CI/automation), otherwise a random password is generated and
 * printed to the console a single time. Only the hash is ever written to disk.
 *
 * `role` is one of 'admin' | 'deployer' | 'viewer'. Only the field is
 * populated here (bootstrap admin gets 'admin') — enforcing role-based
 * authorization is T-52's job, not this module's.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
const GENERATED_PASSWORD_BYTES = 18;
const MIN_PASSWORD_LENGTH = 8;
const VALID_ROLES = ['admin', 'deployer', 'viewer'];

/**
 * @param {string} plain
 * @returns {string} `${saltBase64}:${derivedKeyBase64}`
 */
function hashPassword(plain) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derivedKey = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN);
  return `${salt.toString('base64')}:${derivedKey.toString('base64')}`;
}

/**
 * Verify a plaintext password against a stored `salt:derivedKey` hash.
 * Never throws — a malformed, empty, or missing stored hash just fails
 * verification instead of crashing the login route.
 * @param {string} plain
 * @param {string} stored
 * @returns {boolean}
 */
function verifyPassword(plain, stored) {
  try {
    if (typeof plain !== 'string' || typeof stored !== 'string') return false;
    const [saltB64, keyB64] = stored.split(':');
    if (!saltB64 || !keyB64) return false;

    const salt = Buffer.from(saltB64, 'base64');
    const storedKey = Buffer.from(keyB64, 'base64');
    if (salt.length === 0 || storedKey.length === 0) return false;

    const derivedKey = crypto.scryptSync(plain, salt, storedKey.length);
    return crypto.timingSafeEqual(derivedKey, storedKey);
  } catch (e) {
    return false;
  }
}

function printBootstrapNotice(password, usersFilePath) {
  const lines = [
    'IDP: first-run admin account created',
    '',
    '  username: admin',
    `  password: ${password}`,
    '',
    'This password is shown ONLY ONCE and is not stored anywhere in',
    'plaintext. Save it now — it cannot be recovered later. To reset it,',
    `delete ${usersFilePath} and restart the server.`,
  ];
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const border = '='.repeat(width);
  console.log(`\n${border}`);
  for (const line of lines) console.log(`  ${line}`);
  console.log(`${border}\n`);
}

/**
 * Creates a file-backed user store bound to `usersFilePath`. Exported as a
 * factory (rather than only a singleton) so tests can point it at a
 * throwaway directory instead of the real backend/src/users.json.
 * @param {string} usersFilePath
 */
function createUserStore(usersFilePath) {
  const DUMMY_HASH = hashPassword('placeholder-for-unknown-username-timing');
  let users = [];

  function loadUsersFile() {
    try {
      const parsed = JSON.parse(fs.readFileSync(usersFilePath, 'utf8'));
      return Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function saveUsersFile(list) {
    fs.mkdirSync(path.dirname(usersFilePath), { recursive: true });
    fs.writeFileSync(usersFilePath, JSON.stringify(list, null, 2), { mode: 0o600 });
  }

  function bootstrapAdmin() {
    const usedEnvPassword = Boolean(process.env.IDP_ADMIN_PASSWORD);
    const password = usedEnvPassword
      ? process.env.IDP_ADMIN_PASSWORD
      : crypto.randomBytes(GENERATED_PASSWORD_BYTES).toString('base64url');

    const admin = {
      id: '1',
      username: 'admin',
      passwordHash: hashPassword(password),
      role: 'admin',
      createdAt: new Date().toISOString(),
    };

    saveUsersFile([admin]);

    // Hand the generated password back to the caller as well. stdout is not a
    // channel a desktop user has: launching the packaged app from Finder shows
    // no console, so a password that only exists in a log line is a password
    // nobody can use.
    if (!usedEnvPassword) bootstrapPassword = password;

    if (usedEnvPassword) {
      console.log('IDP: first-run admin account created from IDP_ADMIN_PASSWORD (username: admin).');
    } else {
      printBootstrapNotice(password, usersFilePath);
    }

    return [admin];
  }

  const loaded = loadUsersFile();
  let bootstrapPassword = null;
  users = loaded && loaded.length > 0 ? loaded : bootstrapAdmin();

  function findByUsername(username) {
    return users.find((u) => u.username === username) || null;
  }

  function findById(id) {
    return users.find((u) => u.id === id) || null;
  }

  /** Number of users currently holding the 'admin' role. */
  function countAdmins() {
    return users.filter((u) => u.role === 'admin').length;
  }

  /** Strips passwordHash — the only shape that should ever leave this module for one user. */
  function toSafeUser(user) {
    if (!user) return null;
    const { id, username, role, createdAt } = user;
    return { id, username, role, createdAt };
  }

  /**
   * Verify credentials. Returns the safe session-ready user object
   * ({ id, username, role }) on success, or null on any failure —
   * unknown username and wrong password are indistinguishable to the
   * caller, on purpose (T-11 / SEC-04: don't leak account existence).
   */
  function verify(username, password) {
    const user = findByUsername(username);
    // Always run a real scrypt comparison, even for an unknown username,
    // so a timing side-channel can't reveal which usernames exist.
    const ok = verifyPassword(password, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !ok) return null;
    return { id: user.id, username: user.username, role: user.role };
  }

  function getUsers() {
    return users.map(({ id, username, role, createdAt }) => ({ id, username, role, createdAt }));
  }

  /**
   * Create a new user (T-52, admin-only route). Throws a plain `Error`
   * with a stable `.code` for the route layer to translate into the
   * right HTTP status — never returns a passwordHash.
   * @param {{ username: string, password: string, role: string }} input
   */
  function addUser({ username, password, role }) {
    if (typeof username !== 'string' || username.trim() === '') {
      const err = new Error('username is required');
      err.code = 'INVALID_USERNAME';
      throw err;
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      const err = new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      err.code = 'INVALID_PASSWORD';
      throw err;
    }
    if (!VALID_ROLES.includes(role)) {
      const err = new Error(`role must be one of: ${VALID_ROLES.join(', ')}`);
      err.code = 'INVALID_ROLE';
      throw err;
    }
    if (findByUsername(username)) {
      const err = new Error(`username '${username}' is already taken`);
      err.code = 'USERNAME_TAKEN';
      throw err;
    }

    const newUser = {
      id: `${Date.now()}${Math.random().toString(36).slice(2, 7)}`,
      username,
      passwordHash: hashPassword(password),
      role,
      createdAt: new Date().toISOString(),
    };

    users = [...users, newUser];
    saveUsersFile(users);
    return toSafeUser(newUser);
  }

  /**
   * Change a user's role. Refuses to demote the last remaining admin — that
   * would lock every admin-only capability (including undoing this very
   * change) behind a role nobody holds anymore.
   */
  function updateUserRole(id, role) {
    if (!VALID_ROLES.includes(role)) {
      const err = new Error(`role must be one of: ${VALID_ROLES.join(', ')}`);
      err.code = 'INVALID_ROLE';
      throw err;
    }
    const user = findById(id);
    if (!user) {
      const err = new Error(`user '${id}' not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (user.role === 'admin' && role !== 'admin' && countAdmins() <= 1) {
      const err = new Error('cannot demote the last remaining admin');
      err.code = 'LAST_ADMIN';
      throw err;
    }

    users = users.map((u) => (u.id === id ? { ...u, role } : u));
    saveUsersFile(users);
    return toSafeUser(findById(id));
  }

  /** Sets a new password for an existing user (admin-initiated reset). */
  function updateUserPassword(id, password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      const err = new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      err.code = 'INVALID_PASSWORD';
      throw err;
    }
    const user = findById(id);
    if (!user) {
      const err = new Error(`user '${id}' not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }

    users = users.map((u) => (u.id === id ? { ...u, passwordHash: hashPassword(password) } : u));
    saveUsersFile(users);
    return toSafeUser(findById(id));
  }

  /**
   * Delete a user. Refuses to delete the last remaining admin (409 at the
   * route layer) — without this an operator could lock every admin-only
   * capability out of the whole install with a single click.
   */
  function removeUser(id) {
    const user = findById(id);
    if (!user) {
      const err = new Error(`user '${id}' not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (user.role === 'admin' && countAdmins() <= 1) {
      const err = new Error('cannot delete the last remaining admin');
      err.code = 'LAST_ADMIN';
      throw err;
    }

    users = users.filter((u) => u.id !== id);
    saveUsersFile(users);
    return true;
  }

  function getUserById(id) {
    return toSafeUser(findById(id));
  }

  /**
   * Returns the password generated on this run's first-run bootstrap, exactly
   * once, then forgets it. `null` on every later call, and whenever the account
   * already existed or IDP_ADMIN_PASSWORD supplied the value.
   *
   * Read-once so the desktop app can show it to the operator without the value
   * lingering in memory for the rest of the process's life. stdout is not a
   * channel a desktop user has — an app launched from Finder shows no console,
   * so a password that only exists in a log line is a password nobody can use.
   */
  function takeBootstrapPassword() {
    const value = bootstrapPassword;
    bootstrapPassword = null;
    return value;
  }

  return {
    takeBootstrapPassword,
    verify,
    findByUsername,
    getUsers,
    addUser,
    updateUserRole,
    updateUserPassword,
    removeUser,
    getUserById,
    countAdmins,
  };
}

/**
 * Where the user file lives.
 *
 * `IDP_USERS_PATH` exists for the same reason as `IDP_DB_PATH`: in the packaged
 * desktop app the backend is loaded from inside the read-only `.app` bundle, so
 * the default (`backend/src/users.json`) would write user accounts INTO the
 * bundle — wiped on every update or reinstall, and blocked outright when macOS
 * translocates a quarantined app. The desktop main process points this at the
 * per-user data directory before requiring any backend module.
 */
function resolveUsersFile() {
  const override = process.env.IDP_USERS_PATH;
  return override && override.trim() !== ''
    ? override
    : path.join(__dirname, '..', 'users.json');
}

const DEFAULT_USERS_FILE = resolveUsersFile();
const defaultStore = createUserStore(DEFAULT_USERS_FILE);

module.exports = {
  hashPassword,
  verifyPassword,
  createUserStore,
  verify: defaultStore.verify,
  findByUsername: defaultStore.findByUsername,
  getUsers: defaultStore.getUsers,
  addUser: defaultStore.addUser,
  updateUserRole: defaultStore.updateUserRole,
  updateUserPassword: defaultStore.updateUserPassword,
  removeUser: defaultStore.removeUser,
  getUserById: defaultStore.getUserById,
  countAdmins: defaultStore.countAdmins,
  takeBootstrapPassword: defaultStore.takeBootstrapPassword,
};
