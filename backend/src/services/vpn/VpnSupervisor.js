'use strict';

const { createConfigScrubber } = require('./logScrubber');

/**
 * VpnSupervisor — single active VPN tunnel across the whole app (T-56).
 *
 * VPN changes the machine's route table — it's a GLOBAL resource, not a
 * per-project or per-deployment one. Before this module existed,
 * `VpnManager.connect()` was called directly by every deployment that
 * needed a tunnel: two deployments with different VPN configs running at
 * the same time each raced to bring up their own tunnel, and whichever
 * `openconnect` / `openfortivpn` process won silently decided which
 * network *both* deployments actually talked to — with no error, no log,
 * nothing to indicate the second deployment's traffic went somewhere it
 * didn't ask for.
 *
 * This module sits in front of `VpnManager`'s real tunnel-establishment
 * logic (`VpnManager._establishTunnel` / `_teardownTunnel`) and is the
 * single choke point for `VpnManager.connect()` / `disconnect()`:
 *
 *   - a request for the SAME configuration (host + type + username) as the
 *     currently active tunnel SHARES it — refCount++, no new process;
 *   - a request for a DIFFERENT configuration QUEUES until the active
 *     tunnel is released;
 *   - the last release of a tunnel doesn't tear it down immediately — it
 *     LINGERS for `lingerMs` (default 30s) so a follow-up deploy against
 *     the same config doesn't pay reconnect cost, UNLESS something is
 *     already queued for a different config, in which case the handover
 *     happens immediately (making a *different* deployment wait out a
 *     linger for a tunnel nobody still wants isn't "avoiding churn", it's
 *     just added latency).
 *
 * `VpnManager.connect` / `disconnect` are the only intended callers outside
 * tests — see the bottom of `VpnManager.js`.
 */

const DEFAULT_LINGER_MS = 30000;

/** Overridable in tests via setTunnelDriver(); defaults to the real VpnManager. */
let tunnelDriver = null;

/**
 * Test hook: replace the underlying "actually spawn/tear down a tunnel"
 * implementation. Pass `null` to restore the default (real VpnManager).
 * @param {{ connect: Function, disconnect: Function } | null} driver
 */
function setTunnelDriver(driver) {
  tunnelDriver = driver;
}

function getTunnelDriver() {
  if (tunnelDriver) return tunnelDriver;
  // Required lazily: VpnManager requires this module at load time, so a
  // top-level require here would deadlock on the circular import. By the
  // time acquire()/release() actually run, both modules have finished
  // loading and this resolves fine.
  // eslint-disable-next-line global-require
  const VpnManager = require('./VpnManager');
  return {
    connect: (vpnConfig, onLog, projectId, deploymentId) =>
      VpnManager._establishTunnel(vpnConfig, onLog, projectId, deploymentId),
    disconnect: (session, onLog) => VpnManager._teardownTunnel(session, onLog),
  };
}

/** Two requests share a tunnel iff type + host + username all match. */
function configKey(vpnConfig) {
  return [vpnConfig?.type, vpnConfig?.host, vpnConfig?.username].join('::');
}

class VpnSupervisor {
  /**
   * The one tunnel currently up (or being brought up), or null.
   * Shape: { key, vpnConfig, refCount, lingerTimer, sessionPromise, torndown }
   */
  static _active = null;

  /** Requests waiting for a different config to free up. */
  static _queue = [];

  static lingerMs = DEFAULT_LINGER_MS;

  static setLingerMs(ms) {
    this.lingerMs = ms;
  }

  /**
   * Acquire a handle on the (possibly shared) active tunnel for `vpnConfig`.
   * Resolves once a tunnel is actually up and usable — immediately if
   * shared, after this config's own connect if it becomes the active one,
   * or after waiting in the queue.
   *
   * @param {object} vpnConfig
   * @param {{ onLog?: (line: string) => void, projectId?: string|null, deploymentId?: string|null }} opts
   * @returns {Promise<object>} the underlying session object plus a
   *   `__release(onLog?)` method — this IS what VpnManager.connect() returns
   *   to callers, and what must be passed back into VpnManager.disconnect().
   */
  static async acquire(vpnConfig, { onLog: rawOnLog = () => {}, projectId = null, deploymentId = null } = {}) {
    // Defense in depth (T-14 / SEC-06): every message THIS module logs
    // directly (sharing/queueing/linger notices) goes through a scrubber
    // built from the requesting config, same as VpnManager does for its
    // own log lines.
    const scrub = createConfigScrubber(vpnConfig);
    const onLog = (line) => rawOnLog(scrub(line));

    const key = configKey(vpnConfig);

    if (this._active && this._active.key === key) {
      return this._joinActive(onLog);
    }

    if (this._active) {
      return this._enqueue(key, vpnConfig, onLog, projectId, deploymentId);
    }

    return this._activate(key, vpnConfig, onLog, projectId, deploymentId);
  }

  static async _activate(key, vpnConfig, onLog, projectId, deploymentId) {
    const driver = getTunnelDriver();
    const entry = {
      key,
      vpnConfig,
      refCount: 0,
      lingerTimer: null,
      sessionPromise: null,
      torndown: false,
    };
    this._active = entry;

    entry.sessionPromise = Promise.resolve(driver.connect(vpnConfig, onLog, projectId, deploymentId)).catch((err) => {
      // Establishment failed — this config never really became "active".
      entry.torndown = true;
      if (this._active === entry) this._active = null;
      this._promoteQueue();
      throw err;
    });

    const session = await entry.sessionPromise;
    entry.refCount = 1;
    return this._makeHandle(entry, session, onLog);
  }

  static async _joinActive(onLog) {
    const entry = this._active;
    this._cancelLinger(entry);
    entry.refCount += 1;
    onLog(`[VPN] Sharing already-active tunnel to ${entry.vpnConfig?.host} with a new deployment (refs: ${entry.refCount}).`);
    const session = await entry.sessionPromise;
    return this._makeHandle(entry, session, onLog);
  }

  static _enqueue(key, vpnConfig, onLog, projectId, deploymentId) {
    return new Promise((resolve, reject) => {
      const waiter = { key, vpnConfig, onLog, projectId, deploymentId, resolve, reject };
      this._queue.push(waiter);
      const position = this._queue.length - 1;
      const activeHost = this._active?.vpnConfig?.host || 'unknown host';
      onLog(`[VPN] Waiting for the active tunnel to ${activeHost} to be released (${position} ahead in queue)`);
    });
  }

  static _makeHandle(entry, session, onLog) {
    let released = false;
    const release = async (releaseOnLog) => {
      // Idempotent — a second release() (defensive teardown code paths,
      // double-invocation, etc.) must never double-decrement refCount or
      // trigger a second teardown.
      if (released) return;
      released = true;
      await this._release(entry, releaseOnLog || onLog);
    };
    return { ...session, __release: release };
  }

  static async _release(entry, onLog) {
    if (entry.torndown) return;
    if (entry.refCount > 0) entry.refCount -= 1;

    if (entry.refCount > 0) {
      onLog(`[VPN] Released shared tunnel reference (${entry.refCount} remaining).`);
      return;
    }

    if (this._queue.length > 0) {
      // Someone is waiting for a DIFFERENT config — hand over now. No
      // linger: nothing benefits from delaying this teardown.
      await this._teardownAndPromote(entry, onLog);
      return;
    }

    onLog(`[VPN] Tunnel to ${entry.vpnConfig?.host} idle — will close in ${Math.round(this.lingerMs / 1000)}s if not reused.`);
    entry.lingerTimer = setTimeout(() => {
      entry.lingerTimer = null;
      this._teardownAndPromote(entry, onLog).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[VpnSupervisor] linger teardown failed:', err.message);
      });
    }, this.lingerMs);
    if (typeof entry.lingerTimer?.unref === 'function') entry.lingerTimer.unref();
  }

  static _cancelLinger(entry) {
    if (entry.lingerTimer) {
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = null;
    }
  }

  static async _teardownAndPromote(entry, onLog) {
    if (entry.torndown) {
      this._promoteQueue();
      return;
    }
    entry.torndown = true;
    if (this._active === entry) this._active = null;

    const driver = getTunnelDriver();
    try {
      const session = await entry.sessionPromise;
      await driver.disconnect(session, onLog);
    } finally {
      this._promoteQueue();
    }
  }

  static _promoteQueue() {
    if (this._active || this._queue.length === 0) return;
    const next = this._queue.shift();
    this._activate(next.key, next.vpnConfig, next.onLog, next.projectId, next.deploymentId)
      .then((handle) => next.resolve(handle))
      .catch((err) => next.reject(err));
  }

  /**
   * Removes a still-queued request (e.g. its deployment was aborted before
   * its turn came up). No-op (returns false) if it already started or was
   * never queued.
   */
  static cancelQueued(deploymentId) {
    const idx = this._queue.findIndex((w) => w.deploymentId != null && w.deploymentId === deploymentId);
    if (idx === -1) return false;
    const [waiter] = this._queue.splice(idx, 1);
    waiter.reject(new Error('VPN tunnel request was cancelled before it was acquired.'));
    return true;
  }

  /** @returns {{ active: { host: string, type: string, refCount: number } | null, queued: number, refCount: number }} */
  static listState() {
    return {
      active: this._active
        ? { host: this._active.vpnConfig?.host, type: this._active.vpnConfig?.type, refCount: this._active.refCount }
        : null,
      queued: this._queue.length,
      refCount: this._active ? this._active.refCount : 0,
    };
  }

  /**
   * SECURITY (SEC-17): used by VpnManager.forceClearAll(), which tears down
   * every session it actually tracks directly. This just makes sure the
   * supervisor's own bookkeeping doesn't keep believing a tunnel is active
   * (and doesn't later fire a linger-teardown against a session that's
   * already gone) once that happens — it does NOT itself touch any process.
   */
  static forceReleaseAll() {
    if (this._active) {
      this._cancelLinger(this._active);
      this._active.torndown = true;
      this._active = null;
    }
    const queued = this._queue;
    this._queue = [];
    for (const waiter of queued) {
      waiter.reject(new Error('VPN force-disconnected; queued request was cancelled.'));
    }
  }

  /** Test-only: fully reset state between test cases. */
  static _resetForTests() {
    this.forceReleaseAll();
    this.lingerMs = DEFAULT_LINGER_MS;
  }
}

module.exports = {
  VpnSupervisor,
  setTunnelDriver,
  getTunnelDriver,
  configKey,
  DEFAULT_LINGER_MS,
};
