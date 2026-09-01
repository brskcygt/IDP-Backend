/**
 * Tests for the injectable SAML sign-in window provider (T-94).
 *
 * Background: `AzureAdMfaHandler.fetchHeadlessCookie()` used to always drive
 * a headless Playwright/Chromium instance with fixed selectors
 * (`input[type="email"]`, `#richDisplaySignId`, ...) to complete Azure AD
 * SAML/SSO and hand the resulting VPN session cookie back to `VpnManager`.
 * That's fragile (breaks silently whenever Microsoft changes its login UI),
 * required disabling TLS verification in some configurations, and forced
 * the user's VPN password into this process.
 *
 * `backend/src/services/vpn/samlWindowProvider.js` adds a registry for an
 * injectable provider function. The fork in `fetchHeadlessCookie()` is
 * credential-driven: when the project has a saved VPN username + password,
 * the headless-Playwright auto-fill runs everywhere (desktop included) and
 * the interactive window is only a fallback if that automation fails. When
 * no credentials are saved, a registered provider (the desktop Electron
 * app — see `desktop/main/saml/samlWindow.js`) opens a real BrowserWindow
 * the user signs into themselves, so the password never enters this
 * process.
 *
 * These tests never launch a real Chromium: `playwright`'s `chromium.launch`
 * is replaced with a spy via `require.cache` BEFORE `AzureAdMfaHandler` is
 * required, so requiring `playwright` from inside the handler resolves to
 * the spy. `getSamlLoginUrl` (a real network call to
 * `<host>/global-protect/prelogin.esp`) is stubbed directly on the exported
 * singleton for the same reason.
 *
 * Run with: npm test
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  setSamlWindowProvider,
  getSamlWindowProvider,
  SAML_COOKIE_NAMES,
} = require('../src/services/vpn/samlWindowProvider');

// --- Spy on 'playwright' BEFORE requiring AzureAdMfaHandler -----------------
// AzureAdMfaHandler does `const { chromium } = require('playwright');` at
// module load time, so the fake must already be in require.cache by the time
// that `require()` runs. `fakeChromium.launch` is reassignable per-test so
// individual tests can control what "launching Chromium" does without ever
// touching a real browser binary.
const playwrightPath = require.resolve('playwright');
let chromiumLaunchCallCount = 0;

const THROW_ON_LAUNCH = async () => {
  chromiumLaunchCallCount++;
  throw new Error('MOCK_PLAYWRIGHT_LAUNCH_CALLED');
};

const fakeChromium = { launch: THROW_ON_LAUNCH };

require.cache[playwrightPath] = {
  id: playwrightPath,
  filename: playwrightPath,
  loaded: true,
  exports: { chromium: fakeChromium },
};

const azureAdMfaHandler = require('../src/services/vpn/AzureAdMfaHandler');
const deploymentManager = require('../src/services/DeploymentManager');

// Avoid a real network call to `https://<host>/global-protect/prelogin.esp`
// in every test — the SAML-URL-lookup step is orthogonal to which of the two
// cookie-acquisition paths gets chosen, which is what these tests cover.
azureAdMfaHandler.getSamlLoginUrl = async () => 'https://login.microsoftonline.com/fake-saml-request';

function resetChromiumSpy() {
  chromiumLaunchCallCount = 0;
  fakeChromium.launch = THROW_ON_LAUNCH;
}

test.beforeEach(() => {
  setSamlWindowProvider(null);
  resetChromiumSpy();
});

test.afterEach(() => {
  setSamlWindowProvider(null);
  resetChromiumSpy();
});

test('no provider registered by default', () => {
  assert.equal(getSamlWindowProvider(), null);
});

test('setSamlWindowProvider rejects non-function, non-null values', () => {
  assert.throws(() => setSamlWindowProvider('not a function'), TypeError);
  assert.throws(() => setSamlWindowProvider(42), TypeError);
});

test('when a provider is registered and NO credentials are saved, fetchHeadlessCookie uses the provider and never touches Playwright', async () => {
  const providerCalls = [];
  const provider = async (params) => {
    providerCalls.push(params);
    return { name: 'portal-userauthcookie', value: 'abc123' };
  };
  setSamlWindowProvider(provider);

  const logs = [];
  const cookie = await azureAdMfaHandler.fetchHeadlessCookie(
    'vpn.example.com',
    undefined, // username not required on the provider path
    undefined, // password not required on the provider path
    'dep-1',
    (line) => logs.push(line)
  );

  assert.equal(cookie, 'portal-userauthcookie=abc123');
  assert.equal(providerCalls.length, 1, 'provider should be invoked exactly once');
  assert.equal(providerCalls[0].host, 'vpn.example.com');
  assert.equal(providerCalls[0].samlUrl, 'https://login.microsoftonline.com/fake-saml-request');
  assert.deepEqual(providerCalls[0].cookieNames, SAML_COOKIE_NAMES);
  assert.equal(typeof providerCalls[0].onLog, 'function');

  assert.equal(chromiumLaunchCallCount, 0, 'Playwright must never be launched on the credential-less provider path');
  assert.ok(
    logs.some((l) => l.includes('No saved credentials')),
    'should log which path was chosen'
  );
});

test('without a registered provider, fetchHeadlessCookie uses the headless Playwright path', async () => {
  assert.equal(getSamlWindowProvider(), null);

  const logs = [];
  await assert.rejects(
    () =>
      azureAdMfaHandler.fetchHeadlessCookie('vpn.example.com', 'user', 'pass', 'dep-2', (line) =>
        logs.push(line)
      ),
    /MOCK_PLAYWRIGHT_LAUNCH_CALLED/
  );

  assert.equal(chromiumLaunchCallCount, 1, 'headless path must launch Playwright chromium exactly once');
  assert.ok(
    logs.some((l) => l.includes('Saved credentials found')),
    'should log which path was chosen'
  );
});

test('without a provider, missing username/password fails fast (never launches Playwright)', async () => {
  await assert.rejects(
    () => azureAdMfaHandler.fetchHeadlessCookie('vpn.example.com', '', '', 'dep-2b', () => {}),
    /Username and Password are required/
  );
  assert.equal(chromiumLaunchCallCount, 0);
});

test('a provider that resolves null produces a clear, actionable error', async () => {
  setSamlWindowProvider(async () => null);

  await assert.rejects(
    () => azureAdMfaHandler.fetchHeadlessCookie('vpn.example.com', undefined, undefined, 'dep-3', () => {}),
    /did not return a session cookie/
  );
  assert.equal(chromiumLaunchCallCount, 0);
});

test('a provider that rejects propagates a clear error and is logged', async () => {
  setSamlWindowProvider(async () => {
    throw new Error('Authentication window was closed before sign-in completed.');
  });

  const logs = [];
  await assert.rejects(
    () =>
      azureAdMfaHandler.fetchHeadlessCookie('vpn.example.com', undefined, undefined, 'dep-3b', (l) =>
        logs.push(l)
      ),
    /window was closed before sign-in completed/
  );
  assert.ok(logs.some((l) => l.includes('SAML window provider failed')));
});

test('the provider path and the legacy Playwright path search the same cookie name list', async () => {
  // Provider path: assert the exact list passed through.
  let seenByProvider = null;
  setSamlWindowProvider(async ({ cookieNames }) => {
    seenByProvider = cookieNames;
    return { name: SAML_COOKIE_NAMES[0], value: 'v' };
  });
  await azureAdMfaHandler.fetchHeadlessCookie('vpn.example.com', undefined, undefined, 'dep-4', () => {});
  assert.deepEqual(seenByProvider, SAML_COOKIE_NAMES);

  // Legacy path: prove the Playwright cookie search recognizes every name in
  // the SAME shared list, not a second hand-copied one, by driving a fake
  // browser/context whose only cookie is the last entry in the list.
  setSamlWindowProvider(null);
  const targetName = SAML_COOKIE_NAMES[SAML_COOKIE_NAMES.length - 1];
  const fakePage = {
    goto: async () => {},
    fill: async () => {},
    click: async () => {},
    // The password-field wait must succeed (it's not wrapped in a try/catch
    // in the real flow); only the MFA number-matching wait is allowed to
    // "time out", mirroring a login that skips straight to success.
    waitForSelector: async (selector) => {
      if (selector === 'input[type="password"]') return {};
      throw new Error('no MFA number-matching prompt in this fake flow');
    },
    waitForTimeout: async () => {},
    $: async () => null,
  };
  const fakeContext = {
    newPage: async () => fakePage,
    cookies: async () => [{ name: targetName, value: 'legacy-session-value', domain: 'vpn.example.com' }],
  };
  const fakeBrowser = {
    newContext: async () => fakeContext,
    close: async () => {},
  };
  fakeChromium.launch = async () => {
    chromiumLaunchCallCount++;
    return fakeBrowser;
  };

  const cookie = await azureAdMfaHandler.fetchHeadlessCookie(
    'vpn.example.com',
    'user',
    'pass',
    'dep-5',
    () => {}
  );

  assert.equal(cookie, `${targetName}=legacy-session-value`);
  assert.equal(chromiumLaunchCallCount, 1);
});

test('with a provider registered AND saved credentials, headless auto-fill wins and the interactive window never opens', async () => {
  let providerCalls = 0;
  setSamlWindowProvider(async () => {
    providerCalls++;
    return { name: 'portal-userauthcookie', value: 'from-provider' };
  });

  const targetName = SAML_COOKIE_NAMES[0];
  const fakePage = {
    goto: async () => {},
    fill: async () => {},
    click: async () => {},
    // Same convention as the shared-cookie-list test above: the password
    // wait succeeds; the MFA number-match wait "times out".
    waitForSelector: async (selector) => {
      if (selector === 'input[type="password"]') return {};
      throw new Error('no MFA number-matching prompt in this fake flow');
    },
    waitForTimeout: async () => {},
    $: async () => null,
  };
  fakeChromium.launch = async () => {
    chromiumLaunchCallCount++;
    return {
      newContext: async () => ({
        newPage: async () => fakePage,
        cookies: async () => [{ name: targetName, value: 'headless-cookie', domain: 'vpn.example.com' }],
      }),
      close: async () => {},
    };
  };

  const logs = [];
  const cookie = await azureAdMfaHandler.fetchHeadlessCookie(
    'vpn.example.com',
    'user',
    'pass',
    'dep-6',
    (l) => logs.push(l)
  );

  assert.equal(cookie, `${targetName}=headless-cookie`);
  assert.equal(chromiumLaunchCallCount, 1, 'headless auto-fill must run when credentials are saved');
  assert.equal(providerCalls, 0, 'interactive window must NOT open when credentials are saved');
  assert.ok(logs.some((l) => l.includes('Saved credentials found')));
});

test('when headless automation fails and a provider is registered, it falls back to the interactive window', async () => {
  let providerCalls = 0;
  setSamlWindowProvider(async () => {
    providerCalls++;
    return { name: 'portal-userauthcookie', value: 'from-provider' };
  });
  // The default fake (THROW_ON_LAUNCH) simulates a hard automation failure,
  // e.g. a missing browser binary on the user's machine.

  const logs = [];
  const cookie = await azureAdMfaHandler.fetchHeadlessCookie(
    'vpn.example.com',
    'user',
    'pass',
    'dep-7',
    (l) => logs.push(l)
  );

  assert.equal(cookie, 'portal-userauthcookie=from-provider');
  assert.equal(chromiumLaunchCallCount, 1, 'headless path is attempted first');
  assert.equal(providerCalls, 1, 'interactive window opens as fallback');
  assert.ok(logs.some((l) => l.includes('Headless SSO automation failed')));
  assert.ok(logs.some((l) => l.includes('Falling back to the interactive sign-in window')));
});

test('when headless automation fails and NO provider is registered, the error propagates (web/server path unchanged)', async () => {
  await assert.rejects(
    () => azureAdMfaHandler.fetchHeadlessCookie('vpn.example.com', 'user', 'pass', 'dep-8', () => {}),
    /MOCK_PLAYWRIGHT_LAUNCH_CALLED/
  );
  assert.equal(chromiumLaunchCallCount, 1);
});

test('aborting the deployment rejects a pending interactive-window wait promptly (even if the provider never settles)', async () => {
  let providerGotSignal = null;
  setSamlWindowProvider(async ({ signal }) => {
    providerGotSignal = signal;
    return new Promise(() => {}); // never settles — simulates a window left open
  });

  const deploymentId = deploymentManager.createSession('proj-abort-1', { abort: async () => {} });

  const promise = azureAdMfaHandler.fetchHeadlessCookie(
    'vpn.example.com',
    undefined, // no credentials → interactive provider path
    undefined,
    deploymentId,
    () => {}
  );
  const assertion = assert.rejects(promise, /Deployment aborted by user/);

  setTimeout(() => deploymentManager.abort(deploymentId), 20);

  await assertion;
  assert.ok(providerGotSignal instanceof AbortSignal, 'provider should receive the deployment AbortSignal');
  assert.equal(chromiumLaunchCallCount, 0);
});

test('aborting during the headless phone-approval wait rejects and does NOT fall back to the provider', async () => {
  let providerCalls = 0;
  setSamlWindowProvider(async () => {
    providerCalls++;
    return { name: 'portal-userauthcookie', value: 'from-provider' };
  });

  const deploymentId = deploymentManager.createSession('proj-abort-2', { abort: async () => {} });

  const fakePage = {
    goto: async () => {},
    fill: async () => {},
    click: async () => {},
    waitForSelector: async (selector) => {
      if (selector === 'input[type="password"]') return {};
      throw new Error('no MFA number-matching prompt in this fake flow');
    },
    // Small real delay so the abort lands while the loop is still polling.
    waitForTimeout: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    $: async () => null,
  };
  fakeChromium.launch = async () => {
    chromiumLaunchCallCount++;
    return {
      newContext: async () => ({
        newPage: async () => fakePage,
        cookies: async () => [], // no session cookie ever appears
      }),
      close: async () => {},
    };
  };

  const promise = azureAdMfaHandler.fetchHeadlessCookie('vpn.example.com', 'user', 'pass', deploymentId, () => {});
  const assertion = assert.rejects(promise, /Deployment aborted by user/);

  setTimeout(() => deploymentManager.abort(deploymentId), 30);

  await assertion;
  assert.equal(providerCalls, 0, 'no interactive fallback once the deployment was aborted');
});
