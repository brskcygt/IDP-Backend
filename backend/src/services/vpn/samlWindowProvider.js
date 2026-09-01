'use strict';

/**
 * Registry for an injectable "SAML sign-in window" provider (T-94).
 *
 * `AzureAdMfaHandler` needs to obtain a VPN session cookie after a user
 * completes Azure AD SAML/SSO login. On the **desktop (Electron) build** this
 * should happen in a real, sandboxed `BrowserWindow` the user signs into
 * themselves — no form-filling, no fixed selectors, no password ever enters
 * this process. On the **web/server deployment** there is no Electron main
 * process to open a window in, so that flow keeps using the existing
 * headless-Playwright automation (see `AzureAdMfaHandler.js`).
 *
 * This module is the seam between the two: it holds nothing more than a
 * single optional callback. `backend/src/services/vpn/**` never imports
 * `electron` directly (that would break the web deployment, which doesn't
 * have it installed) — instead, `desktop/main/index.js` calls
 * `setSamlWindowProvider(...)` once at startup with an implementation backed
 * by `desktop/main/saml/samlWindow.js`. When nothing has registered a
 * provider (web/server, or tests), `getSamlWindowProvider()` returns `null`
 * and callers fall back to the legacy path.
 *
 * ## Provider contract
 *
 * ```
 * provider({ samlUrl, host, cookieNames, timeoutMs, onLog, signal }) => Promise<{ name, value } | null>
 * ```
 *
 * - `samlUrl` (`string`, required) — the Azure AD / SP login URL to load in
 *   the sign-in window.
 * - `host` (`string`, required) — the VPN gateway host the resulting cookie
 *   is scoped to; used to disambiguate cookies when the sign-in window's
 *   session holds more than one matching name.
 * - `cookieNames` (`string[]`, required) — the ordered list of session
 *   cookie names to look for (see `SAML_COOKIE_NAMES` below). The provider
 *   should resolve as soon as any one of them appears.
 * - `timeoutMs` (`number`, optional) — how long the provider may wait before
 *   giving up. Providers should apply their own sane default if omitted.
 * - `onLog` (`(line: string) => void`, optional) — progress/log sink. Must
 *   never be passed the resolved cookie's value (it is a secret — see
 *   `logScrubber.js`).
 * - `signal` (`AbortSignal | null`, optional) — the deployment's abort
 *   signal. When it fires, the provider should tear down its window and
 *   settle (reject) promptly; the caller additionally races the provider
 *   against the signal, so aborting works even if a provider ignores it.
 *
 * The returned promise resolves to `{ name, value }` for the cookie that was
 * found, or `null`/a rejection if sign-in did not complete (window closed by
 * the user, timeout, navigation error, etc). Callers must treat a falsy
 * resolution the same as a thrown error — never silently proceed without a
 * cookie.
 */

/** @type {((params: { samlUrl: string, host: string, cookieNames: string[], timeoutMs?: number, onLog?: (line: string) => void, signal?: AbortSignal | null }) => Promise<{ name: string, value: string } | null>) | null} */
let currentProvider = null;

/**
 * Register (or clear, with `null`) the SAML sign-in window provider.
 * Intended to be called exactly once, at application startup
 * (`desktop/main/index.js`). Passing `null` restores the "no provider
 * registered" state, which is also the default before anything registers.
 *
 * @param {Function | null} providerFn
 */
function setSamlWindowProvider(providerFn) {
  if (providerFn !== null && typeof providerFn !== 'function') {
    throw new TypeError('setSamlWindowProvider expects a function or null');
  }
  currentProvider = providerFn;
}

/**
 * @returns {Function | null} the registered provider, or `null` if none has
 *   been registered (or it was explicitly cleared).
 */
function getSamlWindowProvider() {
  return currentProvider;
}

/**
 * Session/auth cookie names GlobalProtect / Checkpoint SAML flows are known
 * to set. Shared by both the injectable-provider path and the legacy
 * Playwright path in `AzureAdMfaHandler.js` so the list only ever lives in
 * one place.
 */
const SAML_COOKIE_NAMES = Object.freeze([
  'portal-userauthcookie',
  'prelogin-cookie',
  'gateway-userauthcookie',
  'SAMLAuthCookie',
  'SESSID',
]);

module.exports = {
  setSamlWindowProvider,
  getSamlWindowProvider,
  SAML_COOKIE_NAMES,
};
