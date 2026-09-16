'use strict';

/**
 * Source-IP allowlist for the agent listener.
 *
 * An agent's credential is what authenticates it; this list is a second gate
 * in front of that, so an attacker who obtains a credential still has to come
 * from an approved network. It exists mainly so operators can manage that gate
 * from the IDP UI instead of editing Windows Firewall rules and cloud security
 * lists by hand for every new agent.
 *
 * **An empty list means no restriction.** Denying everything when the list is
 * empty would turn switching the feature on — or a save that happens to clear
 * it — into an outage for every agent at once. The network layer (cloud
 * security list, host firewall) remains the outer gate either way, and both
 * the UI and the startup log say plainly when the list is empty.
 *
 * Stored in its own file rather than inside `agents.json`: that file is a JSON
 * array, and an older gateway reading an object where it expects an array
 * drops every agent record on the floor (`Array.isArray(values) ? values : []`
 * in gateway.js) — which would lock out every agent on a rollback.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { normalizeRule, matchesAny } = require('./ipMatch');

/** Keeps one careless paste from growing the file without bound. */
const MAX_ENTRIES = 256;
const MAX_NOTE_LENGTH = 120;

class Allowlist {
  /**
   * @param {object} options
   * @param {string | null} options.filePath - null disables persistence (tests).
   * @param {{ warn: Function, info: Function }} options.logger
   */
  constructor({ filePath, logger }) {
    this.filePath = filePath || null;
    this.logger = logger;
    /** @type {Array<{ entry: string, note: string, addedAt: string, addedBy: string | null }>} */
    this.entries = [];
    this.load();
  }

  load() {
    if (!this.filePath) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const values = Array.isArray(parsed?.entries) ? parsed.entries : [];
      const seen = new Set();
      for (const item of values) {
        const entry = normalizeRule(item?.entry);
        if (!entry || seen.has(entry)) continue;
        seen.add(entry);
        this.entries.push({
          entry,
          note: typeof item.note === 'string' ? item.note.slice(0, MAX_NOTE_LENGTH) : '',
          addedAt: typeof item.addedAt === 'string' ? item.addedAt : new Date().toISOString(),
          addedBy: typeof item.addedBy === 'string' ? item.addedBy : null,
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Falling back to an empty list means "no restriction", which is the
        // same as having no file at all — never a silent lockout.
        this.logger.warn('[gateway] Agent allowlist could not be read; continuing with no restriction', { error: error.message });
      }
    }
  }

  /** Atomic write: temp file + rename, mirroring the agent registry. */
  persist() {
    if (!this.filePath) return;
    const tmpPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify({ entries: this.entries }, null, 2), { mode: 0o600 });
      fs.renameSync(tmpPath, this.filePath);
    } catch (error) {
      try { fs.unlinkSync(tmpPath); } catch { /* the temp file may not exist */ }
      throw error;
    }
  }

  /** @returns {boolean} whether the list is currently enforcing anything. */
  get enforcing() {
    return this.entries.length > 0;
  }

  list() {
    return this.entries.map((item) => ({ ...item }));
  }

  /**
   * @returns {boolean} whether `address` may connect. Always true while the
   *   list is empty — see the note at the top of this file.
   */
  allows(address) {
    if (!this.enforcing) return true;
    return matchesAny(this.entries.map((item) => item.entry), address);
  }

  /**
   * @param {string} rawEntry - an address or CIDR.
   * @param {{ note?: string, addedBy?: string | null }} [meta]
   * @returns {{ ok: true, entry: object } | { ok: false, reason: string }}
   */
  add(rawEntry, { note = '', addedBy = null } = {}) {
    const entry = normalizeRule(rawEntry);
    if (!entry) return { ok: false, reason: 'invalid_entry' };
    if (this.entries.some((item) => item.entry === entry)) return { ok: false, reason: 'duplicate' };
    if (this.entries.length >= MAX_ENTRIES) return { ok: false, reason: 'limit_reached' };

    const record = {
      entry,
      note: String(note || '').slice(0, MAX_NOTE_LENGTH),
      addedAt: new Date().toISOString(),
      addedBy: addedBy || null,
    };
    this.entries.push(record);
    try {
      this.persist();
    } catch (error) {
      this.entries.pop();
      throw error;
    }
    return { ok: true, entry: { ...record } };
  }

  /** @returns {boolean} whether an entry was actually removed. */
  remove(rawEntry) {
    const entry = normalizeRule(rawEntry);
    if (!entry) return false;
    const index = this.entries.findIndex((item) => item.entry === entry);
    if (index === -1) return false;

    const [removed] = this.entries.splice(index, 1);
    try {
      this.persist();
    } catch (error) {
      this.entries.splice(index, 0, removed);
      throw error;
    }
    return true;
  }
}

module.exports = { Allowlist, MAX_ENTRIES, MAX_NOTE_LENGTH };
