'use strict';

/**
 * Shared helpers for the T-73 "Test Connection" checks (core/diagnostics/).
 * See connectionTest.js for the overall design notes.
 */

/** @returns {{ name: string, ok: boolean|null, detail: string }} */
function makeCheck(name, ok, detail) {
  return { name, ok, detail };
}

/**
 * Races `promise` against a timeout, rejecting with a friendly message
 * (never a raw timer/stack) when the timeout wins.
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** Strips a `http(s)://` prefix and a trailing `:port` off a host field, mirroring the adapters' own cleanup. */
function cleanHostPort(rawHost, fallbackPort) {
  let host = (rawHost || '').trim();
  let port = fallbackPort;
  if (host.startsWith('http://')) host = host.slice(7);
  if (host.startsWith('https://')) host = host.slice(8);
  if (host.includes(':')) {
    const idx = host.indexOf(':');
    const parsedPort = parseInt(host.slice(idx + 1), 10);
    host = host.slice(0, idx);
    if (!Number.isNaN(parsedPort)) port = parsedPort;
  }
  return { host, port };
}

/** Raw TCP reachability probe — protocol-agnostic, used ahead of the SSH handshake. */
function tcpProbe(netConnect, host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let socket;

    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      try {
        socket && socket.destroy();
      } catch (_err) {
        // socket already gone — nothing to clean up
      }
      resolve({ ok, detail });
    };

    try {
      socket = netConnect({ host, port, timeout: timeoutMs });
    } catch (err) {
      finish(false, `Could not reach ${host}:${port}: ${err.message}`);
      return;
    }

    socket.on('connect', () => finish(true, `Reached ${host}:${port}.`));
    socket.on('timeout', () =>
      finish(false, `Connection to ${host}:${port} timed out after ${timeoutMs}ms. Check network/firewall rules.`)
    );
    socket.on('error', (err) => {
      if (err && err.code === 'ECONNREFUSED') {
        finish(
          false,
          `Connection to ${host}:${port} was refused. Check the host/port in project settings and that the service is running.`
        );
      } else if (err && (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN')) {
        finish(false, `Could not resolve host '${host}'. Check the hostname in project settings.`);
      } else {
        finish(false, `Could not reach ${host}:${port}: ${err && err.message ? err.message : 'unknown error'}.`);
      }
    });
  });
}

module.exports = { makeCheck, withTimeout, cleanHostPort, tcpProbe };
