/**
 * Minimal file-backed express-session Store (T-11 / SEC-04).
 *
 * Replaces the default MemoryStore, which express-session explicitly warns
 * is "not designed for a production environment": it leaks memory forever,
 * doesn't work across multiple processes, and drops every session on
 * restart. This store persists sessions to a single JSON file on disk
 * (backend/src/sessions.json, mode 0600) so sessions survive a restart,
 * with no new npm dependency.
 *
 * It is a dependency-free stopgap sized for a small, single-process
 * internal tool — not a substitute for a real store (Redis, a database)
 * under real concurrent multi-process load.
 */
const fs = require('fs');
const path = require('path');
const { Store } = require('express-session');

// `IDP_SESSIONS_PATH`: see the note on IDP_USERS_PATH in auth/userStore.js —
// the packaged desktop app must not write into its own read-only bundle.
const DEFAULT_FILE =
  process.env.IDP_SESSIONS_PATH && process.env.IDP_SESSIONS_PATH.trim() !== ''
    ? process.env.IDP_SESSIONS_PATH
    : path.join(__dirname, '..', 'sessions.json');
const DEFAULT_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

class FileSessionStore extends Store {
  constructor({ file = DEFAULT_FILE, cleanupIntervalMs = DEFAULT_CLEANUP_INTERVAL_MS } = {}) {
    super();
    this.file = file;
    this.sessions = this._load();

    // Periodically sweep expired sessions so the file doesn't grow forever
    // with abandoned/expired entries between logins.
    this._cleanupTimer = setInterval(() => this._sweep(), cleanupIntervalMs);
    if (typeof this._cleanupTimer.unref === 'function') this._cleanupTimer.unref();
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      return {};
    }
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.sessions), { mode: 0o600 });
    } catch (e) {
      console.error('FileSessionStore: failed to persist sessions file:', e.message);
    }
  }

  _sweep() {
    const now = Date.now();
    let changed = false;
    for (const [sid, entry] of Object.entries(this.sessions)) {
      if (entry.expires && entry.expires <= now) {
        delete this.sessions[sid];
        changed = true;
      }
    }
    if (changed) this._persist();
  }

  get(sid, callback) {
    const entry = this.sessions[sid];
    if (!entry) return callback(null, null);
    if (entry.expires && entry.expires <= Date.now()) {
      delete this.sessions[sid];
      this._persist();
      return callback(null, null);
    }
    return callback(null, entry.session);
  }

  set(sid, session, callback) {
    const maxAge = session && session.cookie && session.cookie.maxAge;
    const expires = typeof maxAge === 'number' ? Date.now() + maxAge : null;
    this.sessions[sid] = { session, expires };
    this._persist();
    if (callback) callback(null);
  }

  destroy(sid, callback) {
    delete this.sessions[sid];
    this._persist();
    if (callback) callback(null);
  }

  touch(sid, session, callback) {
    const entry = this.sessions[sid];
    if (entry) {
      const maxAge = session && session.cookie && session.cookie.maxAge;
      entry.expires = typeof maxAge === 'number' ? Date.now() + maxAge : entry.expires;
      this._persist();
    }
    if (callback) callback(null);
  }

  all(callback) {
    const result = {};
    for (const [sid, entry] of Object.entries(this.sessions)) result[sid] = entry.session;
    callback(null, result);
  }

  length(callback) {
    callback(null, Object.keys(this.sessions).length);
  }

  clear(callback) {
    this.sessions = {};
    this._persist();
    if (callback) callback(null);
  }

  // Test/shutdown hook, mirrors middleware/rateLimit.js's `.stop()` pattern.
  stop() {
    clearInterval(this._cleanupTimer);
  }
}

module.exports = FileSessionStore;
