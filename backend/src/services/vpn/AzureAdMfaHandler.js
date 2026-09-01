const { chromium } = require('playwright');
const http = require('http');
const axios = require('axios');
const https = require('https');
const deploymentManager = require('../DeploymentManager');
const { getSamlWindowProvider, SAML_COOKIE_NAMES } = require('./samlWindowProvider');

/** Default budget for the injectable SAML window provider to complete sign-in. */
const DEFAULT_PROVIDER_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

class AzureAdMfaHandler {
  // SECURITY (SEC-07): TLS certificate verification must default to ON. Every method below
  // takes an explicit `allowInsecureTls` opt-in (default false) instead of hardcoding
  // rejectUnauthorized/ignoreHTTPSErrors to false/true. Disabling verification exposes the
  // SAML flow and VPN session cookie to MITM interception.
  //
  // If the real problem is an internal/enterprise CA (e.g. a self-signed corporate cert),
  // the correct fix is NOT to disable verification — it's to trust that CA properly by
  // pointing Node at its bundle via the NODE_EXTRA_CA_CERTS environment variable
  // (e.g. NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem). That keeps verification on while
  // trusting the org's CA.
  async getSamlLoginUrl(host, allowInsecureTls = false) {
    const preloginUrl = `https://${host}/global-protect/prelogin.esp`;
    const agent = new https.Agent({ rejectUnauthorized: !allowInsecureTls });
    const response = await axios.post(preloginUrl, '', { httpsAgent: agent, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const xml = response.data;
    const match = xml.match(/<saml-request>(.*?)<\/saml-request>/);
    if (!match || !match[1]) throw new Error('SAML Request URL not found. Is this a valid SAML GlobalProtect portal?');
    return Buffer.from(match[1], 'base64').toString('utf8');
  }

  /**
   * Resolve a GlobalProtect SAML session cookie for `host`.
   *
   * Path selection is credential-driven:
   *
   *   - Credentials saved on the project (`username` + `password`) → the
   *     headless-Playwright automation runs everywhere, including the desktop
   *     build: email + password are auto-filled and the only manual step left
   *     is approving the Authenticator number-match on the user's phone (the
   *     number is pushed to the UI via `MFA_NUMBER_MATCHING`). If automation
   *     fails AND a SAML window provider is registered (desktop), we fall
   *     back to the interactive window so the user can still complete
   *     sign-in by hand instead of the deployment hard-failing.
   *   - No credentials → the registered provider's interactive sign-in
   *     window (desktop path) is used; the password never enters this
   *     process (T-94's original security posture for credential-less
   *     projects).
   *   - No credentials AND no provider (web/server without config) → fail
   *     fast; there is nothing to automate with and no window to open.
   *
   * All paths search the same set of known session cookie names
   * (`SAML_COOKIE_NAMES`) so the list only lives in one place.
   */
  async fetchHeadlessCookie(host, username, password, deploymentId, onLog, allowInsecureTls = false) {
    const provider = getSamlWindowProvider();
    const hasCredentials = Boolean(username && password);

    if (!hasCredentials && !provider) {
      throw new Error('VPN Username and Password are required for headless Azure AD SAML SSO.');
    }

    // Cooperative cancellation: aborting the deployment must also tear down
    // an in-flight SAML flow (the headless wait loop AND the interactive
    // window), not just the later VPN phases. Same lazy session-signal
    // lookup pattern as VpnManager._waitForMarker — deploymentManager is
    // already imported at module scope here, so no require cycle.
    const signal = deploymentId
      ? deploymentManager.getSession(deploymentId)?.signal ?? null
      : null;

    if (allowInsecureTls) {
      onLog('[VPN] ⚠ TLS certificate verification is DISABLED for this connection. This exposes the SAML flow to interception.');
    }

    onLog('[VPN] Fetching GlobalProtect SAML Request URL...');
    let targetUrl;
    try {
      targetUrl = await this.getSamlLoginUrl(host, allowInsecureTls);
    } catch (err) {
      onLog(`[VPN] ✗ Failed to get SAML URL: ${err.message}`);
      throw err;
    }

    if (hasCredentials) {
      onLog('[VPN] Saved credentials found — running headless Azure AD SSO (auto-fill). Only the Authenticator number-match on your phone stays manual.');
      try {
        return await this._fetchCookieViaPlaywright(targetUrl, host, username, password, deploymentId, onLog, allowInsecureTls, signal);
      } catch (err) {
        // Never fall back once the deployment was aborted — the operator
        // asked to cancel, not for a second interactive attempt.
        if (!provider || signal?.aborted) throw err;
        onLog(`[VPN] ✗ Headless SSO automation failed: ${err.message}`);
        // Dismiss any pending number-match overlay in the UI — the challenge
        // is no longer being driven headlessly once the window takes over.
        deploymentManager.pushEvent(deploymentId, 'MFA_RESOLVED', {});
        onLog('[VPN] Falling back to the interactive sign-in window — please complete sign-in manually.');
        return this._resolveCookieFromProvider(provider, targetUrl, host, onLog, DEFAULT_PROVIDER_TIMEOUT_MS, signal);
      }
    }

    onLog('[VPN] No saved credentials — opening interactive sign-in window (desktop path, no Playwright).');
    return this._resolveCookieFromProvider(provider, targetUrl, host, onLog, DEFAULT_PROVIDER_TIMEOUT_MS, signal);
  }

  /**
   * Desktop path: delegate to the registered provider and normalize its
   * result into the same `name=value` cookie string the Playwright path
   * returns, so callers (`VpnManager.js`) don't need to know which path ran.
   *
   * `signal` (the deployment's AbortSignal) is forwarded to the provider so
   * it can tear down its window on abort; we additionally race the provider
   * promise against the signal so an abort rejects promptly even if a
   * provider were to ignore it.
   */
  async _resolveCookieFromProvider(provider, samlUrl, host, onLog, timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS, signal = null) {
    if (signal?.aborted) {
      throw new Error('Deployment aborted by user');
    }

    let result;
    try {
      const providerPromise = provider({ samlUrl, host, cookieNames: SAML_COOKIE_NAMES, timeoutMs, onLog, signal });
      if (signal) {
        // A late rejection after the abort race has settled must not surface
        // as an unhandled rejection.
        providerPromise.catch(() => {});
        result = await Promise.race([
          providerPromise,
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('Deployment aborted by user')), { once: true });
          }),
        ]);
      } else {
        result = await providerPromise;
      }
    } catch (err) {
      if (signal?.aborted) {
        onLog('[VPN] Deployment aborted — interactive sign-in cancelled.');
      } else {
        onLog(`[VPN] ✗ SAML window provider failed: ${err.message}`);
      }
      throw err;
    }

    if (!result || !result.name || !result.value) {
      const err = new Error('SAML window provider did not return a session cookie (sign-in window closed or timed out before completing).');
      onLog(`[VPN] ✗ ${err.message}`);
      throw err;
    }

    onLog(`[VPN] Successfully extracted SAML session cookie: ${result.name}`);
    return `${result.name}=${result.value}`;
  }

  /**
   * Automated path: headless Chromium, fixed selectors, the saved password
   * filled into the page by this process. Used whenever the project has
   * credentials saved — on web/server (no provider exists there) and on
   * desktop alike. Only the Authenticator phone approval stays manual.
   */
  async _fetchCookieViaPlaywright(targetUrl, host, username, password, deploymentId, onLog, allowInsecureTls, signal = null) {
    if (signal?.aborted) throw new Error('Deployment aborted by user');

    onLog('[VPN] Launching headless browser for automated Azure AD SSO...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: allowInsecureTls, userAgent: 'PAN GlobalProtect' });
    const page = await context.newPage();

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

      onLog('[VPN] Auto-filling Microsoft Email...');
      await page.fill('input[type="email"]', username);
      await page.click('input[type="submit"]');

      onLog('[VPN] Auto-filling Password...');
      await page.waitForSelector('input[type="password"]', { timeout: 10000 });
      await page.fill('input[type="password"]', password);

      // We might need a slight delay before clicking submit to prevent Microsoft spam protection
      await page.waitForTimeout(500);
      await page.click('input[type="submit"]');

      onLog('[VPN] Checking for Authenticator Number Matching screen...');

      // Wait for either the number display OR the success redirect
      try {
        const numberSelector = '#richDisplaySignId, .displaySign, div[data-testid="displaySign"]';
        const el = await page.waitForSelector(numberSelector, { timeout: 10000 });
        if (el) {
          const numberText = await el.innerText();
          onLog(`[VPN] Detected Authenticator Number: ${numberText.trim()}`);

          // Emit the event to the frontend
          deploymentManager.pushEvent(deploymentId, 'MFA_NUMBER_MATCHING', { number: numberText.trim() });
        }
      } catch (err) {
        // Maybe it didn't prompt for MFA or went straight to success
        onLog('[VPN] No number matching prompt detected (or it timed out). Continuing...');
      }

      onLog('[VPN] Waiting for successful redirect to VPN portal (approve on phone)...');

      let cookieValue = null;
      for (let i = 0; i < 60; i++) {
        // Aborting the deployment must break out of the phone-approval wait
        // promptly — otherwise the operator clicks Abort and the loop keeps
        // polling (and holds the project's concurrency lock) until timeout.
        if (signal?.aborted) throw new Error('Deployment aborted by user');

        const cookies = await context.cookies();
        const hostCookies = cookies.filter(c => c.domain.includes(host) || host.includes(c.domain));

        const authCookie = hostCookies.find(c => SAML_COOKIE_NAMES.includes(c.name));

        if (authCookie) {
          cookieValue = `${authCookie.name}=${authCookie.value}`;
          onLog(`[VPN] Successfully extracted SAML session cookie: ${authCookie.name}`);

          // Push event to close the frontend modal
          deploymentManager.pushEvent(deploymentId, 'MFA_NUMBER_MATCHING_SUCCESS', {});
          break;
        }

        // Keep session alive if there's an intermediate "Stay signed in?" prompt
        try {
          const staySignedInBtn = await page.$('input[value="Yes"]');
          if (staySignedInBtn) {
            await staySignedInBtn.click();
          }
        } catch (e) {}

        await page.waitForTimeout(1000);
      }

      if (!cookieValue) throw new Error('Timeout waiting for SAML authentication success redirect (did you approve on your phone?).');

      return cookieValue;
    } finally {
      await browser.close().catch(() => {});
    }
  }

  async handleExternalSamlUrl(targetUrl, username, password, deploymentId, onLog, allowInsecureTls = false) {
    if (!username || !password) {
      throw new Error('VPN Username and Password are required for headless Azure AD SAML SSO.');
    }

    // Cooperative cancellation, same pattern as fetchHeadlessCookie: the
    // 90s approval-wait loop below must notice an abort promptly instead of
    // polling on a deployment that is already dead.
    const signal = deploymentId
      ? deploymentManager.getSession(deploymentId)?.signal ?? null
      : null;

    if (allowInsecureTls) {
      onLog('[VPN] ⚠ TLS certificate verification is DISABLED for this connection. This exposes the SAML flow to interception.');
    }

    if (signal?.aborted) throw new Error('Deployment aborted by user');

    onLog(`[VPN] Launching headless browser for Checkpoint SAML URL: ${targetUrl.substring(0, 50)}...`);
    // Headless: the whole point of this flow is that only the phone approval
    // stays manual — there is nobody watching a visible browser window.
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: allowInsecureTls, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36' });
    let page = await context.newPage();
    let checkpointLoopbackRequest = null;

    // Chromium's Private Network Access protection can open Check Point's
    // one-shot localhost socket without ever completing the HTTP request.
    // Capture that navigation before Chromium consumes the socket; after the
    // SAML success marker appears we replay the exact request from Node.
    await context.route('**/*', async (route) => {
      let parsed;
      try { parsed = new URL(route.request().url()); } catch { return route.continue(); }
      if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1') {
        checkpointLoopbackRequest = {
          url: route.request().url(),
          method: route.request().method(),
          headers: route.request().headers(),
          body: route.request().postDataBuffer(),
        };
        await route.abort('aborted').catch(() => {});
        return;
      }
      await route.continue();
    });

    const deliverCheckpointLoopback = async () => {
      for (let i = 0; i < 50 && !checkpointLoopbackRequest; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!checkpointLoopbackRequest) {
        throw new Error('Check Point SAML succeeded, but no local client callback was generated.');
      }
      const captured = checkpointLoopbackRequest;
      const callbackUrl = new URL(captured.url);
      const transport = callbackUrl.protocol === 'https:' ? https : http;
      await new Promise((resolve, reject) => {
        let requestFinished = false;
        const headers = { ...captured.headers };
        delete headers.host;
        delete headers['content-length'];
        const req = transport.request(callbackUrl, {
          method: captured.method,
          headers,
          rejectUnauthorized: callbackUrl.protocol === 'https:' ? false : undefined,
        }, (res) => {
          res.resume();
          res.once('end', resolve);
          res.once('error', reject);
        });
        req.once('finish', () => { requestFinished = true; });
        req.once('error', (err) => {
          // Some Check Point versions accept the one-shot callback and close
          // the socket without an HTTP response. A reset after a fully written
          // request therefore means delivery, not failure.
          if (requestFinished && (err.code === 'ECONNRESET' || err.code === 'EPIPE')) resolve();
          else reject(err);
        });
        req.setTimeout(10000, () => req.destroy(new Error('Check Point local callback timed out')));
        if (captured.body) req.write(captured.body);
        req.end();
      });
    };

    try {
      // Keep ServiceProviderTabs intact. That outer page is not cosmetic: it
      // owns the completion bridge back to the local Check Point client. The
      // old code rewrote it to ServiceProvider, which made Azure login/MFA
      // succeed while `trac connect` waited forever for the result.
      const popupPromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      const popup = await popupPromise;
      if (popup) {
        page = popup;
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        onLog('[VPN] Check Point authentication popup captured in the headless browser context.');
      }

      onLog('[VPN] Auto-filling Microsoft Email...');
      const emailSelectors = 'input[name="loginfmt"], input[type="email"], input[name="UserName"], input[name="user"]';
      try {
        await page.waitForSelector(emailSelectors, { timeout: 10000 });
        const emailInput = await page.$(emailSelectors);
        if (emailInput) {
          await emailInput.fill(username);
          await page.waitForTimeout(500);
          await emailInput.press('Enter').catch(() => {});
        }
      } catch (err) {
        onLog('[VPN] Email input not found. Dumping HTML for debugging...');
        const html = await page.content();
        require('fs').writeFileSync('/tmp/ms_login_dump.html', html);
        onLog('[VPN] HTML dumped to /tmp/ms_login_dump.html.');
      }

      onLog('[VPN] Auto-filling Password...');
      const passSelectors = 'input[name="passwd"], input[type="password"]';
      try {
        await page.waitForSelector(passSelectors, { timeout: 15000 });
        const passwordInput = await page.$(passSelectors);
        if (passwordInput) {
          await passwordInput.fill(password);
          await page.waitForTimeout(1000); // Wait for MS animation to finish
          await passwordInput.press('Enter').catch(() => {});

          // Fallback: explicitly click the submit button just in case Enter is ignored
          await page.waitForTimeout(500);
          await page.click('input[type="submit"], button[type="submit"], #idSIButton9').catch(() => {});
        }
      } catch (err) {
        onLog(`[VPN] ✗ Password input not found: ${err.message}`);
      }

      onLog('[VPN] Checking for Authenticator Number Matching screen...');

      try {
        const numberSelector = '#richDisplaySignId, .displaySign, div[data-testid="displaySign"]';
        const el = await page.waitForSelector(numberSelector, { timeout: 10000 });
        if (el) {
          const numberText = await el.innerText();
          onLog(`[VPN] Detected Authenticator Number: ${numberText.trim()}`);
          deploymentManager.pushEvent(deploymentId, 'MFA_NUMBER_MATCHING', { number: numberText.trim() });
        }
      } catch (err) {
        onLog('[VPN] No number matching prompt detected (or it timed out). Continuing...');
      }

      onLog('[VPN] Waiting for successful authentication redirect (approve on phone)...');

      let checkpointResponseDelivered = false;
      for (let i = 0; i < 90; i++) {
        if (signal?.aborted) throw new Error('Deployment aborted by user');

        // After Azure completes, Check Point may close the popup and update
        // the original ServiceProviderTabs page. Always follow the newest
        // still-open page instead of polling a popup that has already closed.
        const openPages = context.pages().filter((candidate) => !candidate.isClosed());
        if (page.isClosed() && openPages.length) page = openPages[openPages.length - 1];

        let checkpointSuccessElement = Boolean(await page.$('#success').catch(() => null));
        let bodyText = await page.innerText('body').catch(() => '');
        let lowerBody = bodyText.toLowerCase();

        // The completion UI can be rendered in the original tabs page while
        // the Azure popup is still alive. Search every page in the headless
        // context and switch to the one that owns the success/Allow UI.
        for (const candidate of openPages) {
          if (candidate === page) continue;
          const candidateSuccess = Boolean(await candidate.$('#success').catch(() => null));
          const candidateBody = await candidate.innerText('body').catch(() => '');
          const candidateLower = candidateBody.toLowerCase();
          if (candidateSuccess ||
              candidateLower.includes('authentication succeed') ||
              candidateLower.includes('authentication successful') ||
              candidateLower.includes('safely close this window') ||
              candidateLower.includes('authenticated by your identity') ||
              candidateLower.includes('kimlik doğrulama başarılı') ||
              candidateLower.includes('oturum açma başarılı')) {
            page = candidate;
            bodyText = candidateBody;
            lowerBody = candidateLower;
            checkpointSuccessElement = candidateSuccess;
            break;
          }
        }

        // Checkpoint success indicators
        const authenticationSucceeded = checkpointSuccessElement || lowerBody.includes('authentication succeeded') || lowerBody.includes('safely close this window') || lowerBody.includes('authentication successful') || lowerBody.includes('authenticated by your identity') || lowerBody.includes('kimlik doğrulama başarılı') || lowerBody.includes('oturum açma başarılı') || lowerBody.includes('bu pencereyi güvenle kapatabilirsiniz');
        if (authenticationSucceeded) {

          if (checkpointSuccessElement) {
            // ServiceProviderTabs itself uses this exact element as the
            // authoritative success signal, then keeps the page alive for
            // five seconds before closing it. Honour the same protocol; no
            // separate Allow button exists on this gateway's flow.
            onLog('[VPN] Check Point SAML success signal detected; allowing the client callback to settle...');
            deploymentManager.pushEvent(deploymentId, 'MFA_NUMBER_MATCHING_SUCCESS', {});
            await deliverCheckpointLoopback();
            await new Promise((resolve) => setTimeout(resolve, 1000));
            onLog('[VPN] SAML response delivered to Check Point; waiting for trac to establish the tunnel...');
            return;
          }

          // Check Point's success page carries an "İzin ver" (Allow) button
          // that authorizes the VPN client — clicking it is what delivers the
          // SAML response to the gateway and lets the waiting `trac connect`
          // proceed. Nobody is watching a visible browser anymore, so the
          // headless flow must click it itself.
          try {
            const clickedLabel = await page.evaluate(() => {
              const wanted = ['izin ver', 'allow', 'onayla', 'continue'];
              const candidates = [...document.querySelectorAll('a, button, input[type="submit"], input[type="button"], div[role="button"], span[role="button"]')];
              const el = candidates.find((e) => {
                const t = String(e.innerText || e.value || '').trim().toLowerCase();
                return t && wanted.some((k) => t === k || (t.length <= 25 && t.includes(k)));
              });
              if (el) {
                el.click();
                return String(el.innerText || el.value || '').trim();
              }
              return null;
            });
            if (clickedLabel) {
              onLog(`[VPN] Clicked "${clickedLabel}" (Allow) automatically — delivering SAML response to the gateway...`);
              await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
              await page.waitForTimeout(2000);
              checkpointResponseDelivered = true;
            }
          } catch (e) {
            onLog(`[VPN] ⚠ Could not auto-click the Allow button: ${e.message}`);
          }

          // Do not equate the IdP success page with a VPN connection. The
          // final Allow action posts the SAML response back to Check Point;
          // closing Chromium before that is exactly why the same flow works
          // manually but leaves `trac` disconnected when automated.
          if (checkpointResponseDelivered) {
            onLog('[VPN] SAML response delivered to Check Point; waiting for trac to establish the tunnel...');
            deploymentManager.pushEvent(deploymentId, 'MFA_NUMBER_MATCHING_SUCCESS', {});
            return;
          }

          if (i % 10 === 0) {
            onLog('[VPN] Identity provider approved authentication, but the Check Point Allow action is not available yet...');
          }
        }

        try {
          const bodyHtml = await page.content().catch(() => '');
          if (bodyHtml.includes('Kmsi') || bodyHtml.includes('Stay signed in') || bodyHtml.includes('açık kalsın mı')) {
            const staySignedInBtn = await page.$('#idSIButton9');
            if (staySignedInBtn) {
              onLog('[VPN] "Stay signed in?" prompt detected. Clicking Yes...');
              await staySignedInBtn.click();
            }
          }
        } catch (e) {}

        // Handle "Verify your identity" (Kimliğinizi doğrulayın) fallback screen
        try {
          const clickedAuth = await page.evaluate(() => {
            const elements = document.querySelectorAll('div[role="button"], .tile, .list-item, div[data-value]');
            for (const el of elements) {
              if (el.innerText && el.innerText.toLowerCase().includes('authenticator') && !el.innerText.toLowerCase().includes('kodu')) {
                el.click();
                return true;
              }
            }
            return false;
          });
          if (clickedAuth) {
            onLog('[VPN] "Verify your identity" screen detected. Clicked Authenticator option.');
            // A successful approval can close the Azure popup immediately.
            // That is progress, not an error; the next loop iteration will
            // switch back to the still-open ServiceProviderTabs page.
            await page.waitForTimeout(2000).catch(() => {});
          }
        } catch (e) {}

        // Microsoft closes its popup as soon as the approved SAML response is
        // posted. Never fail the whole flow merely because that close races
        // this polling delay.
        await page.waitForTimeout(1000).catch(() => {});
      }

      throw new Error('Timeout waiting for SAML authentication success redirect (did you approve on your phone?).');
    } finally {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = new AzureAdMfaHandler();
