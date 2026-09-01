'use strict';

/**
 * Injectable OS-elevation provider (T-93).
 *
 * `openfortivpn` (and, per the setup docs, `openconnect`) needs root to open
 * a tun/tap device and rewrite the route table. SEC-02 removed the old
 * `POST /api/vpn/grant-permissions` endpoint — it built a shell string by
 * concatenating a raw `sudoPassword` from the request body into
 * `sh -c '...'`, which is straightforward command injection, and it also
 * wrote a permanent NOPASSWD sudoers rule (SEC-08) so it only ever had to
 * do that once. Both problems came from treating "get root" as a runtime
 * HTTP endpoint at all.
 *
 * The replacement: sudo authorization is now a one-time manual setup step
 * (docs/SETUP.md) OR, in the desktop app, a per-connection OS-native
 * elevation dialog — `desktop/main/elevation/osElevation.js` on macOS,
 * registered here at app startup via `setElevationProvider(...)`. This
 * module is deliberately backend-only and Electron-agnostic: it just holds
 * a slot for "the function that knows how to elevate a command on this
 * platform" so `VpnManager` never has to know whether it's running inside
 * Electron or as the plain HTTP backend.
 *
 * Contract:
 *   provider({ command, args, reason, onLog }) => Promise<ChildProcess>
 *
 * The returned value must look enough like a Node `ChildProcess` for
 * `VpnManager`'s stdout/stderr marker-watching logic to work against it:
 * readable `.stdout` / `.stderr` streams, a `.stdin` (may be a no-op sink
 * if the elevated command takes no stdin input), `.on('exit' | 'error')`,
 * and `.kill(signal)`.
 *
 * When no provider is registered (no Electron shell around it, or the
 * browser-hosted deployment described in docs/03-ELECTRON-MIMARI.md),
 * `VpnManager` falls back to exactly its pre-T-93 behavior: spawning
 * `sudo <command> <args>` directly and relying on the sudoers rule from the
 * manual setup step. That fallback is what keeps `backend/src/server.js`
 * (no Electron, no OS dialog available) working unchanged.
 */

let currentProvider = null;

/**
 * @param {((opts: { command: string, args: string[], reason?: string, onLog?: (line: string) => void }) => Promise<import('child_process').ChildProcess>) | null} fn
 */
function setElevationProvider(fn) {
  if (fn !== null && typeof fn !== 'function') {
    throw new TypeError('setElevationProvider: provider must be a function or null');
  }
  currentProvider = fn;
}

function getElevationProvider() {
  return currentProvider;
}

module.exports = { setElevationProvider, getElevationProvider };
