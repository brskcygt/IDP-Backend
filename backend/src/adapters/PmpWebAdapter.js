const DeploymentAdapter = require('./DeploymentAdapter');
const { assertTriggerResult } = DeploymentAdapter;
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { validateSteps } = require('./pmp/stepSchema');
const { runSteps } = require('./pmp/StepRunner');

// SECURITY (SEC-18): error screenshots can contain portal content and session info.
// Anything older than this is purged before a new screenshot is written, so the
// errors/ directory never becomes an unbounded, ever-growing archive of past sessions.
const SCREENSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * PmpWebAdapter — Production-grade Playwright web automation adapter.
 *
 * Capabilities:
 * 1. Launch headless Chromium via Playwright
 * 2. Login to PMP portal with credentials
 * 3. Navigate to tenant deployment page and trigger deploy
 * 4. Full-page screenshot on error → saved to public/errors/
 * 5. Guaranteed browser.close() in finally block (no memory leaks)
 * 6. Configurable timeout for the entire automation flow
 *
 * SECURITY (SEC-03/T-12): custom automation runs as a whitelisted, JSON
 * `config.steps` list interpreted by StepRunner — never as free-form code.
 * The legacy `config.scriptContent` (`new Function(...)` over user input)
 * has been removed; see trigger() below.
 */
class PmpWebAdapter extends DeploymentAdapter {
  constructor(config) {
    super(config);
    this.browser = null;
    this.page = null;
    this.aborted = false;
    this._aborting = false;
    this.timeoutMs = config.timeoutMs || 30000;

    // (T-57) PMP logs are emitted inline during trigger() via this.log();
    // there is no separate post-trigger log stream, so streamLogs() relies
    // on the base no-op.
    this.logPrefix = '[PMP]';

    // SECURITY (SEC-18): screenshots may capture portal content/session info. Default
    // stays `true` to preserve existing behavior, but callers can opt out per-adapter.
    this.captureErrorScreenshots = config.captureErrorScreenshots !== false;

    // Where to save error screenshots
    this.errorDir = path.resolve(__dirname, '..', '..', 'public', 'errors');
    if (!fs.existsSync(this.errorDir)) {
      fs.mkdirSync(this.errorDir, { recursive: true });
    }
  }

  /**
   * SECURITY (SEC-18): deletes .png files in errorDir older than SCREENSHOT_MAX_AGE_MS.
   * Called before writing a new screenshot so the directory never accumulates stale
   * captures of past portal sessions indefinitely.
   */
  async _purgeOldScreenshots() {
    let entries;
    try {
      entries = await fs.promises.readdir(this.errorDir);
    } catch (err) {
      return; // directory missing or unreadable — nothing to purge
    }

    const now = Date.now();
    for (const entry of entries) {
      if (!entry.endsWith('.png')) continue;
      const entryPath = path.join(this.errorDir, entry);
      try {
        const stats = await fs.promises.stat(entryPath);
        if (now - stats.mtimeMs > SCREENSHOT_MAX_AGE_MS) {
          await fs.promises.unlink(entryPath);
        }
      } catch (err) {
        // File may have been removed concurrently, or stat/unlink failed — skip it.
      }
    }
  }

  /**
   * Phase 1: Launch Playwright headless browser.
   */
  async connect() {
    this.log(`Launching Playwright headless Chromium...`);

    try {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });

      const context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'IDP-PmpAdapter/1.0',
        ignoreHTTPSErrors: true, // Handle self-signed certs for web portal
      });

      this.page = await context.newPage();

      // Global navigation timeout
      this.page.setDefaultNavigationTimeout(this.timeoutMs);
      this.page.setDefaultTimeout(this.timeoutMs);

      this.log(`✓ Browser launched successfully.`);
    } catch (err) {
      // Ensure cleanup even if launch partially fails
      await this._ensureBrowserClosed();
      throw new Error(`Failed to launch Playwright browser: ${err.message}`);
    }
  }

  /**
   * Phase 2 & 3: Login to PMP and trigger deployment.
   * Entire flow wrapped in try/catch/finally for safety.
   */
  async trigger(params) {
    const portalUrl = this.config.url;
    const username = this.config.username;
    const password = this.config.password;
    const environment = params.environment || 'Dev';

    if (!portalUrl) {
      throw new Error('PMP portal URL is not configured. Set it in project settings or .env');
    }

    try {
      // ── Step 1: Navigate to login page ──
      this.log(`Navigating to PMP portal: ${portalUrl}`);
      await this.page.goto(portalUrl, { waitUntil: 'networkidle' });
      this.log(`✓ Portal loaded.`);

      if (this.aborted) return assertTriggerResult({ status: 'Aborted' }, 'PmpWebAdapter');

      // ── Step 2: Login ──
      if (username && password) {
        this.log(`Logging in as: ${username}`);

        // Try common login form selectors
        const usernameSelector = await this._findSelector([
          'input[name="username"]',
          'input[name="user"]',
          'input[name="email"]',
          'input[id="username"]',
          'input[type="email"]',
          '#login-username',
        ]);

        const passwordSelector = await this._findSelector([
          'input[name="password"]',
          'input[type="password"]',
          'input[id="password"]',
          '#login-password',
        ]);

        if (!usernameSelector) {
          throw new Error('Could not find username input on login page.');
        }
        if (!passwordSelector) {
          throw new Error('Could not find password input on login page.');
        }

        await this.page.fill(usernameSelector, username);
        await this.page.fill(passwordSelector, password);

        // Try common submit button selectors
        const submitSelector = await this._findSelector([
          'button[type="submit"]',
          'input[type="submit"]',
          'button:has-text("Login")',
          'button:has-text("Sign in")',
          'button:has-text("Log in")',
          'button:has-text("Giriş")',
          '#login-submit',
        ]);

        if (submitSelector) {
          await this.page.click(submitSelector);
        } else {
          // Fallback: press Enter
          await this.page.keyboard.press('Enter');
        }

        // Wait for navigation after login
        await this.page.waitForLoadState('networkidle');
        this.log(`✓ Login successful.`);
      } else {
        this.log(`⚠ No credentials provided. Skipping login.`);
      }

      if (this.aborted) return assertTriggerResult({ status: 'Aborted' }, 'PmpWebAdapter');

      // ── Step 3: Navigate to deployment page & trigger ──
      this.log(`Looking for deployment trigger for environment: ${environment}...`);

      // If a declarative step list is configured, run it through the
      // whitelisted StepRunner instead of the default deploy-button search.
      if (Array.isArray(this.config.steps)) {
        this.log(`Executing ${this.config.steps.length} configured PMP step(s)...`);

        const { valid, errors } = validateSteps(this.config.steps);
        if (!valid) {
          throw new Error(`Invalid PMP step configuration: ${errors.join('; ')}`);
        }

        await runSteps(
          this.page,
          this.config.steps,
          { username, password, environment },
          this.log.bind(this)
        );
        this.log(`✓ Step-based automation completed.`);
      } else if (this.config.scriptContent) {
        // SECURITY (SEC-03/T-12): free-form `scriptContent` used to be run via
        // `new Function('page', 'log', this.config.scriptContent)`, which let
        // anyone with project-settings access execute arbitrary Node.js code
        // (require('child_process'), require('fs'), ...) in this server
        // process. That execution path has been removed entirely — it is
        // never eval'd, interpreted, or silently skipped. Projects still
        // carrying an old scriptContent value must be converted to
        // `config.steps` (see stepSchema.js) before they can deploy again.
        throw new Error(
          'PMP "scriptContent" (free-form Playwright script) has been removed for security reasons ' +
          '(SEC-03/T-12: it allowed arbitrary Node.js code execution on the server). ' +
          'Convert this project\'s automation to the declarative step list in project settings ' +
          '(config.steps) before deploying again.'
        );
      } else {
        // Default: look for deploy/update button on the page
        const deploySelector = await this._findSelector([
          'button:has-text("Deploy")',
          'button:has-text("Update")',
          'button:has-text("Publish")',
          'button:has-text("Release")',
          'a:has-text("Deploy")',
          'a:has-text("Update")',
          '#deploy-button',
          '.deploy-btn',
          `[data-env="${environment}"]`,
        ]);

        if (deploySelector) {
          this.log(`Found deploy trigger: ${deploySelector}`);
          await this.page.click(deploySelector);
          await this.page.waitForLoadState('networkidle');
          this.log(`✓ Deploy button clicked. Waiting for confirmation...`);

          // Check for confirmation dialogs
          const confirmSelector = await this._findSelector([
            'button:has-text("Confirm")',
            'button:has-text("Yes")',
            'button:has-text("OK")',
            'button:has-text("Onayla")',
            '.confirm-btn',
          ]);

          if (confirmSelector) {
            await this.page.click(confirmSelector);
            await this.page.waitForLoadState('networkidle');
            this.log(`✓ Confirmation dialog accepted.`);
          }
        } else {
          this.log(`⚠ No deploy button found on page. Taking screenshot for debugging.`);
          await this._takeScreenshot('no_deploy_button');
        }
      }

      this.log(`✓ PMP deployment automation completed successfully.`);
      return assertTriggerResult({ status: 'Succeeded' }, 'PmpWebAdapter');

    } catch (err) {
      // ── CATCH: Screenshot on error ──
      this.log(`✗ PMP automation error: ${err.message}`);
      const screenshotPath = await this._takeScreenshot('error');
      if (screenshotPath) {
        this.log(`📸 Error screenshot saved: ${screenshotPath}`);
      }
      throw err;

    } finally {
      // ── FINALLY: Always close the browser ──
      await this._ensureBrowserClosed();
    }
  }

  /**
   * Try multiple CSS selectors and return the first one that exists on the page.
   * Returns null if none are found.
   */
  async _findSelector(selectors) {
    for (const selector of selectors) {
      try {
        const element = await this.page.$(selector);
        if (element) return selector;
      } catch {
        // Selector syntax might not be valid for this page, skip
      }
    }
    return null;
  }

  /**
   * Take a full-page screenshot and save it to public/errors/.
   */
  async _takeScreenshot(name) {
    if (!this.page) return null;

    if (!this.captureErrorScreenshots) {
      this.log(`Error screenshot capture is disabled (captureErrorScreenshots=false). Skipping.`);
      return null;
    }

    try {
      await this._purgeOldScreenshots();

      // SECURITY (SEC-18): the filename component must be unpredictable — a Date.now()
      // based name lets anyone with directory listing/guessing access enumerate recent
      // screenshots. crypto.randomUUID() replaces that predictable component.
      const filename = `pmp_${name}_${crypto.randomUUID()}.png`;
      const filepath = path.join(this.errorDir, filename);
      await this.page.screenshot({ path: filepath, fullPage: true });
      return filepath;
    } catch (err) {
      this.log(`⚠ Failed to take screenshot: ${err.message}`);
      return null;
    }
  }

  /**
   * Guarantee browser cleanup. Called from both catch and finally.
   */
  async _ensureBrowserClosed() {
    if (this.browser) {
      try {
        await this.browser.close();
        this.browser = null;
        this.page = null;
        this.log(`Browser closed.`);
      } catch (err) {
        this.log(`⚠ Error closing browser: ${err.message}`);
        // Force-kill the browser process as last resort
        try {
          this.browser.process()?.kill('SIGKILL');
        } catch { /* ignore */ }
        this.browser = null;
        this.page = null;
      }
    }
  }

  /**
   * Abort: flag the adapter and close the browser immediately.
   *
   * (T-57) Idempotent: a second call is a safe no-op — it must never throw.
   */
  async abort() {
    if (this._aborting) return;
    this._aborting = true;
    this.aborted = true;
    this.log(`Aborting PMP automation...`);
    await this._ensureBrowserClosed();
  }
}

module.exports = PmpWebAdapter;
