const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const mfaVpnHandler = require('./MfaVpnHandler');
const azureAdMfaHandler = require('./AzureAdMfaHandler');
const { createConfigScrubber, createScrubber } = require('./logScrubber');
const { requireBinary, findBinary } = require('./binaryResolver');
const { VpnSupervisor } = require('./VpnSupervisor');
const { getElevationProvider } = require('./elevationProvider');

// SECURITY (SEC-17): app-private temp directory for VPN pid/conf/creds files, instead of
// dumping predictably-named `vpn_*` files straight into the shared /tmp. This closes off
// the symlink-attack surface on multi-user machines. Created with mode 0700 (owner-only);
// individual files written into it are created with mode 0600.
const VPN_TMP_DIR = path.join(os.tmpdir(), 'idp-vpn');

class VpnManager {
  // SECURITY (SEC-17): tracks every VPN session this process actually spawned, keyed by
  // vpnId. forceClearAll() only ever terminates processes/files recorded here — it must
  // NEVER fall back to a broad `pkill` or a directory scan, both of which can affect
  // processes/files this app didn't create (e.g. the user's personal VPN, or another
  // user's files on a shared machine).
  static _activeSessions = new Map();

  static async _ensureVpnTmpDir() {
    await fs.mkdir(VPN_TMP_DIR, { recursive: true, mode: 0o700 });
    return VPN_TMP_DIR;
  }

  /** Run a short-lived Check Point CLI command and collect its output. */
  static async _runCheckpointCommand(tracPath, args, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const process = spawn(tracPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const timer = setTimeout(() => {
        try { process.kill('SIGKILL'); } catch { /* already exited */ }
        reject(new Error(`trac ${args[0]} timed out`));
      }, timeoutMs);
      process.stdout.on('data', (data) => { output += data.toString(); });
      process.stderr.on('data', (data) => { output += data.toString(); });
      process.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      process.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(output);
        else reject(new Error(`trac ${args[0]} exited with code ${code}`));
      });
    });
  }

  /** `trac connect` can print a success-looking line before the tunnel is usable. */
  static isCheckpointInfoConnected(output) {
    const normalized = String(output || '').toLowerCase();
    if (/\b(disconnected|not connected|connection failed|tunnel[^\n]*(?:down|inactive))\b/.test(normalized)) return false;
    return /\bconnected\b/.test(normalized) || /\btunnel[^\n]*(?:up|active)\b/.test(normalized);
  }

  static async _verifyCheckpointConnection(tracPath, host, onLog, attempts = 12, intervalMs = 1000) {
    onLog('[VPN] Verifying Check Point tunnel state with trac info...');
    let lastOutput = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        lastOutput = await this._runCheckpointCommand(tracPath, ['info', '-s', host]);
        if (this.isCheckpointInfoConnected(lastOutput)) {
          onLog('[VPN] ✓ Check Point reports the tunnel as connected.');
          return;
        }
      } catch (err) {
        lastOutput = err.message;
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    const summary = lastOutput.replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new Error(`Check Point authentication completed but the VPN tunnel is not connected${summary ? `: ${summary}` : ''}`);
  }

  static async _closeCheckpointBrowserTab() {
    const script = `
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      set u to URL of t
      if u contains "/saml-vpn/spPortal/ServiceProvider" then
        close t
        return "closed"
      end if
    end repeat
  end repeat
end tell
if application "Safari" is running then
  tell application "Safari"
    repeat with w in windows
      repeat with t in tabs of w
        set u to URL of t
        if u contains "/saml-vpn/spPortal/ServiceProvider" then
          close t
          return "closed"
        end if
      end repeat
    end repeat
  end tell
end if
return ""
`;
    try {
      await this._runCheckpointCommand('/usr/bin/osascript', ['-e', script], 5000);
    } catch {
      // Closing the visible hand-off tab is best effort. Authentication can
      // still continue headlessly using the URL recorded by Check Point.
    }
  }

  /** Read the exact SAML URL which the Check Point GUI logs before browser hand-off. */
  static async _captureCheckpointSamlUrl(logPath, startOffset, timeoutMs = 150000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const file = await fs.open(logPath, 'r');
        try {
          const stat = await file.stat();
          if (stat.size > startOffset) {
            const buffer = Buffer.alloc(stat.size - startOffset);
            await file.read(buffer, 0, buffer.length, startOffset);
            const match = buffer.toString('utf8').match(/Trying to browse to (https:\/\/\S+\/saml-vpn\/spPortal\/ServiceProvider(?:Tabs)?\?\S+)/i);
            if (match) {
              const url = match[1].replace(/[.,]$/, '');
              await this._closeCheckpointBrowserTab();
              return url;
            }
          }
        } finally {
          await file.close();
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Check Point GUI did not produce a SAML sign-in URL within 150 seconds.');
  }

  /**
   * Sends SIGTERM to a child process and escalates to SIGKILL if it hasn't exited
   * within the grace period. Used by disconnect()/forceClearAll() so a stuck VPN
   * process can never survive a teardown request.
   */
  static async _terminateChildProcess(childProcess, graceMs = 3000) {
    if (!childProcess || childProcess.killed) return;
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const forceKillTimer = setTimeout(() => {
        try { childProcess.kill('SIGKILL'); } catch (e) { /* already dead */ }
        done();
      }, graceMs);
      childProcess.once('exit', () => {
        clearTimeout(forceKillTimer);
        done();
      });
      try {
        childProcess.kill('SIGTERM');
      } catch (e) {
        clearTimeout(forceKillTimer);
        done();
      }
    });
  }

  /**
   * Spawns a background process and waits for a specific stdout/stderr marker.
   */
  static async spawnAndWait(command, args, expectedMarker, onLog, options = {}, context = null) {
    // Resolve to an absolute path before spawning. A desktop app launched from
    // Finder gets the minimal system PATH, so every Homebrew-installed VPN tool
    // is invisible to a bare command name — see binaryResolver.js.
    command = requireBinary(command);
    // SECURITY (SEC-06 / T-14): redact by VALUE, not by argument position.
    // The old rule masked arguments that looked like password flags, which
    // missed `['-p', password]` — the flag was masked and the password beside
    // it was printed in full. Anything the caller marked secret (and the
    // stdin payload, which is usually the password) is scrubbed from every
    // line this function emits, including output produced by the VPN binary.
    // Defence in depth: connect() already wrapped `onLog` with a scrubber built
    // from the whole VPN config, but spawnAndWait can also be called directly,
    // and the stdin payload (usually the password) is only known here.
    // SECURITY (SEC-06/T-14 follow-up): `context.extraSecrets` covers values
    // that are only known at RUNTIME — a SAML/GlobalProtect session cookie
    // fetched via azureAdMfaHandler.fetchHeadlessCookie() or resumed via
    // mfaVpnHandler.getCachedSession() never appears in `vpnConfig` (it's
    // not a config field, it's a fetched credential), so the config-only
    // scrubber above misses it entirely. That cookie is functionally a VPN
    // credential — leaking it into `[VPN] Executing: ... --cookie <value>`
    // is the same class of bug T-14 fixed for passwords. connect() collects
    // every such runtime secret into `spawnCtx.extraSecrets` as soon as
    // it's fetched/resumed — see _establishTunnel().
    const scrub = createConfigScrubber(context?.vpnConfig, [options.stdinInput, ...(context?.extraSecrets || [])]);
    const safeLog = (line) => onLog(scrub(line));

    safeLog(`[VPN] Executing: ${command} ${args.join(' ')}`);

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options
    });

    return this._waitForMarker(child, expectedMarker, safeLog, onLog, options, context);
  }

  /**
   * SECURITY (T-93): same contract as spawnAndWait, but for commands that
   * need root (today: only the fortinet/openfortivpn branch of connect()).
   * Routes through whatever `elevationProvider` is registered
   * (`desktop/main/elevation/osElevation.js` on macOS, wired up in
   * `desktop/main/index.js`) instead of spawning `sudo` directly with a
   * password VpnManager itself would have to hold.
   *
   * SECURITY (SEC-02/SEC-08 legacy fallback): when no provider is
   * registered — the plain HTTP backend has no OS dialog to hand off to —
   * this falls back to EXACTLY the pre-T-93 behavior (`spawn('sudo', ...)`),
   * relying on the sudoers rule from the manual docs/SETUP.md step. Nothing
   * about that fallback path changes.
   */
  static async spawnElevatedAndWait(command, args, expectedMarker, onLog, options = {}, context = null, reason = null) {
    // Absolute path matters twice over here: the packaged app's PATH doesn't
    // include Homebrew, and handing an unqualified name to a shell that runs as
    // root would let PATH decide which binary gets those privileges.
    command = requireBinary(command);
    // SECURITY (SEC-06/T-14 follow-up) — see the matching comment in
    // spawnAndWait(): runtime-fetched secrets (SAML/GlobalProtect session
    // cookies) live in context.extraSecrets, not in vpnConfig.
    const scrub = createConfigScrubber(context?.vpnConfig, [options.stdinInput, ...(context?.extraSecrets || [])]);
    const safeLog = (line) => onLog(scrub(line));
    const provider = getElevationProvider();

    if (!provider) {
      safeLog(`[VPN] No OS elevation provider registered — falling back to sudo spawn for: ${command} ${args.join(' ')}`);
      const child = spawn('sudo', [command, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...options
      });
      return this._waitForMarker(child, expectedMarker, safeLog, onLog, options, context);
    }

    safeLog(`[VPN] Requesting administrator approval to run: ${command} ${args.join(' ')}`);
    const childPromise = Promise.resolve(
      provider({
        command,
        args,
        reason: reason || `IDP VPN needs administrator privileges to run ${command}`,
        onLog: safeLog,
      })
    ).catch((err) => {
      safeLog(`[VPN] ✗ Administrator approval failed: ${err.message}`);
      throw err;
    });

    return this._waitForMarker(childPromise, expectedMarker, safeLog, onLog, options, context);
  }

  /**
   * Wires up a child process (or a promise of one, for the elevated path
   * where obtaining it may require waiting on an OS approval dialog) and
   * resolves once `expectedMarker` shows up on stdout/stderr — same
   * OTP/SAML/MFA interception behavior as before T-93/T-56, now shared by
   * both spawnAndWait() and spawnElevatedAndWait().
   *
   * `rawOnLog` is kept separate from `safeLog` on purpose, matching the
   * pre-T-93/T-56 behavior: it's handed to mfaVpnHandler/azureAdMfaHandler,
   * which already receive a scrubbed logger from further up the call chain
   * (connect()'s own wrapping) — this just preserves exactly which logger
   * instance those two collaborators got before this refactor.
   */
  static async _waitForMarker(childOrPromise, expectedMarker, safeLog, rawOnLog, options, context) {
    const child = await childOrPromise;
    return new Promise((resolve, reject) => {
      let isConnected = false;
      let logs = '';

      // Aborting a deployment has to stop the VPN it is currently dialling.
      // Without this the deploy routine stays parked here until the 90s
      // watchdog fires — holding the project's concurrency lock the whole time,
      // so the operator sees "aborted" but cannot start another run. The
      // adapter's own abort() does not cover this: the VPN process is not the
      // deployment's adapter.
      let onAbortSignal = null;
      // Required lazily, like the other DeploymentManager uses in this file —
      // importing it at module scope would close a require cycle.
      const signal = (() => {
        if (!context?.deploymentId) return null;
        try {
          return require('../DeploymentManager').getSession(context.deploymentId)?.signal ?? null;
        } catch {
          return null;
        }
      })();

      const detachAbort = () => {
        if (onAbortSignal && signal) signal.removeEventListener('abort', onAbortSignal);
        onAbortSignal = null;
      };

      if (signal) {
        if (signal.aborted) {
          try { child.kill('SIGTERM'); } catch { /* already gone */ }
          reject(new Error('Deployment aborted by user'));
          return;
        }
        onAbortSignal = () => {
          safeLog('[VPN] Deployment aborted — stopping the VPN connection attempt.');
          try { child.kill('SIGTERM'); } catch { /* already gone */ }
          reject(new Error('Deployment aborted by user'));
        };
        signal.addEventListener('abort', onAbortSignal, { once: true });
      }

      // Timeout id is tracked locally so the watchdog works even when no
      // `context` is passed (e.g. openvpn/wireguard/ssh-jump). When a
      // context IS provided, we mirror the id onto it so the existing
      // OTP flow (which reads/clears context.timeoutId) keeps working.
      let timeoutId = null;

      const clearConnectionTimeout = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (context) {
          context.timeoutId = null;
        }
      };

      const handleOutput = (data) => {
        const str = data.toString();
        logs += str;

        // Interactive OTP Support
        if (str.match(/two-factor authentication|token:|otp:/i) && context && context.deploymentId) {
          if (!context._otpRequested) {
            context._otpRequested = true;
            safeLog(`[VPN:LOG] Two-Factor Authentication (OTP) required. Please enter code.`);

            // Extend timeout to 120s for OTP input
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            timeoutId = setTimeout(() => {
              if (!isConnected) {
                child.kill('SIGKILL');
                reject(new Error('VPN Connection timeout exceeded while waiting for OTP (120s)'));
              }
            }, 120000);
            context.timeoutId = timeoutId;

            const deploymentManager = require('../DeploymentManager');
            deploymentManager.pushEvent(context.deploymentId, 'MFA_REQUIRED', { authType: 'totp' });
            
            // Set manual resolver (UI)
            deploymentManager.setMfaResolver(context.deploymentId, (otpCode) => {
              if (child.stdin && child.stdin.writable) {
                child.stdin.write(otpCode + '\n');
                safeLog(`[VPN] Sent OTP to background process`);
                
                // Cancel automated webhook listener
                const otpWebhookManager = require('../mfa/OtpWebhookManager');
                otpWebhookManager.cancelWait(context.deploymentId);
              }
            });

            // Start automated webhook interceptor
            const otpWebhookManager = require('../mfa/OtpWebhookManager');
            safeLog('[MFA] Waiting for OTP code (listening via webhook)...');
            otpWebhookManager.waitForOtp(context.deploymentId, 60).then(otpCode => {
              safeLog(`[MFA] OTP code intercepted automatically via webhook. Proceeding with authentication...`);
              
              // 1. Animate frontend immediately
              deploymentManager.pushEvent(context.deploymentId, 'MFA_REQUIRED', { authType: 'totp', interceptedCode: otpCode });
              
              // 2. Wait 2 seconds to let the user see the animation
              setTimeout(() => {
                // 3. Clear the dialog
                deploymentManager.pushEvent(context.deploymentId, 'MFA_RESOLVED', {});
                
                // 4. Inject the code and let terminal operations continue
                if (child.stdin && child.stdin.writable) {
                  child.stdin.write(otpCode + '\n');
                  deploymentManager.resolveMfa(context.deploymentId, otpCode);
                }
              }, 2000);
            }).catch(err => {
              // Timeout or cancelled, do nothing.
            });
          }
        }

        const lines = str.split('\n');
        for (const line of lines) {
          if (line.trim()) safeLog(`[VPN:LOG] ${line.trim()}`);
          
          if (context && context.mfaConfig && context.deploymentId) {
            mfaVpnHandler.interceptStdout(context.deploymentId, line, context.mfaConfig, child, rawOnLog);
          }
          if (context && context.mfaConfig?.rememberSession) {
            mfaVpnHandler.scrapeCookie(context.projectId, context.vpnType, line, rawOnLog);
          }

          if (!isConnected && expectedMarker && line.includes(expectedMarker)) {
            isConnected = true;
            clearConnectionTimeout();
            safeLog(`[VPN] ✓ Connection established based on marker: "${expectedMarker}"`);
            resolve(child);
          }

          if (!isConnected && /connection could not be established|negotiation with site failed/i.test(line)) {
            clearConnectionTimeout();
            reject(new Error('Check Point rejected the tunnel after SAML authentication (negotiation with site failed). The SAML/IdP realm cannot be completed through the trac CLI flow.'));
          }

          // Checkpoint SAML Interactive URL
          // The old non-greedy expression stopped at the first colon after
          // `https://` (commonly the gateway's :443), silently truncating the
          // SAML URL. The prompt terminator is a colon at end-of-line.
          const samlMatch = line.match(/Enter\s+(https:\/\/\S+?)\s*:\s*$/i) || line.match(/Enter\s+(https:\/\/\S+)/i);
          if (samlMatch && samlMatch[1] && context && context.deploymentId) {
            if (!context._samlTriggered) {
              context._samlTriggered = true;
              safeLog(`[VPN] Checkpoint requested SAML authentication. Opening headless browser...`);

              // Give the user enough time to approve
              // MFA; the generic 90-second dial timeout is too short for the
              // full Azure + Check Point round trip.
              if (timeoutId) clearTimeout(timeoutId);
              timeoutId = setTimeout(() => {
                if (!isConnected) {
                  child.kill('SIGKILL');
                  reject(new Error('VPN Connection timeout exceeded while waiting for Check Point SAML (180s)'));
                }
              }, 180000);
              context.timeoutId = timeoutId;

              azureAdMfaHandler.handleExternalSamlUrl(samlMatch[1].trim(), context.vpnConfig.username, context.vpnConfig.password, context.deploymentId, rawOnLog, context.vpnConfig.allowInsecureTls === true)
                .then(() => safeLog('[VPN] Headless SAML flow completed. Waiting for the Check Point client to establish the tunnel...'))
                .catch(err => safeLog(`[VPN] ✗ Headless SAML flow error: ${err.message}`));
            }
          }
        }
      };

      child.stdout.on('data', handleOutput);
      child.stderr.on('data', handleOutput);

      child.on('error', (err) => {
        safeLog(`[VPN] ✗ Process spawn error: ${err.message}`);
        if (!isConnected) {
          clearConnectionTimeout();
          reject(err);
        }
      });

      child.on('exit', (code) => {
        safeLog(`[VPN] Process exited with code ${code}`);
        if (!expectedMarker) {
          // If no marker expected, process exit 0 means success (e.g., wg-quick)
          if (code === 0) {
            isConnected = true;
            clearConnectionTimeout();
            resolve(child);
          } else {
            if (!isConnected) {
              clearConnectionTimeout();
              const safeLogs = createConfigScrubber(context?.vpnConfig, context?.extraSecrets || [])(logs);
              reject(new Error(`VPN process exited prematurely with code ${code}. Logs: ${safeLogs}`));
            }
          }
        } else {
          if (!isConnected) {
            clearConnectionTimeout();
            const safeLogs = createConfigScrubber(context?.vpnConfig, context?.extraSecrets || [])(logs);
            reject(new Error(`VPN process exited prematurely with code ${code}. Logs: ${safeLogs}`));
          }
        }
      });

      // Timeout for connection. Kept in a local variable so this watchdog
      // works regardless of whether a `context` object was passed in;
      // mirrored onto context.timeoutId for the OTP flow above.
      timeoutId = setTimeout(() => {
        if (!isConnected) {
          child.kill('SIGKILL');
          reject(new Error('VPN Connection timeout exceeded (90s)'));
        }
      }, 90000);
      if (context) {
        context.timeoutId = timeoutId;
      }

      // Write password to stdin if needed
      if (options.stdinInput) {
        child.stdin.write(options.stdinInput + '\n');
      }
    });
  }

  /**
   * Public entry point (T-56): routes through VpnSupervisor instead of
   * spawning a tunnel directly, so two deployments never race to bring up
   * conflicting VPN tunnels at once. The actual spawn logic lives in
   * _establishTunnel() below, which is what the supervisor calls once it's
   * decided this request should actually bring up a (possibly shared) new
   * tunnel rather than share/queue behind an existing one.
   *
   * Signature is unchanged from before T-56 — callers (deploymentService.js)
   * don't need to know the supervisor exists.
   */
  static async connect(vpnConfig, onLog, projectId, deploymentId) {
    return VpnSupervisor.acquire(vpnConfig, { onLog, projectId, deploymentId });
  }

  /**
   * The real tunnel-establishment logic (pre-T-56 body of connect()).
   * Only ever called by VpnSupervisor — see connect() above.
   */
  static async _establishTunnel(vpnConfig, rawOnLog, projectId, deploymentId) {
    // SECURITY (SEC-06 / T-14): every line emitted anywhere in this flow — by us,
    // by spawnAndWait, by the SAML handler, by the VPN binary itself — goes
    // through a scrubber built from this connection's secrets. Wrapping once at
    // the entry point is what makes the guarantee hold; scrubbing at individual
    // call sites means the next added log line silently isn't covered.
    //
    // SECURITY (SEC-06/T-14 follow-up): a config-only scrubber isn't enough —
    // a SAML/GlobalProtect session cookie is fetched or resumed AT RUNTIME
    // (mfaVpnHandler.getCachedSession() / azureAdMfaHandler.fetchHeadlessCookie()
    // below) and never lives in `vpnConfig`, so it was invisible to the
    // scrubber even though it's functionally a VPN credential — it leaked
    // straight into `[VPN] Executing: ... --cookie <value> ...`. `runtimeSecrets`
    // collects every such value the moment it becomes known; `onLog` is
    // rebuilt from it on every call (not memoized once) specifically so
    // that a secret discovered mid-flow still redacts every line logged
    // AFTER that point — including the ones inside spawnAndWait, which
    // shares this same array via spawnCtx.extraSecrets below.
    const runtimeSecrets = [];
    const onLog = (line) => rawOnLog(createConfigScrubber(vpnConfig, runtimeSecrets)(line));

    onLog(`[VPN] Initiating VPN connection for type: ${vpnConfig.type}`);

    let cachedCookie = null;
    if (vpnConfig.mfaConfig?.rememberSession && projectId) {
      cachedCookie = await mfaVpnHandler.getCachedSession(projectId, vpnConfig.type);
      if (cachedCookie) {
        runtimeSecrets.push(cachedCookie);
        onLog(`[VPN] Found cached session cookie for ${vpnConfig.type}. Resuming session to bypass MFA...`);
      }
    }

    const vpnId = crypto.randomUUID();
    const vpnTmpDir = await this._ensureVpnTmpDir();
    const pidFile = path.join(vpnTmpDir, `vpn_${vpnId}.pid`);
    const confFile = path.join(vpnTmpDir, `vpn_${vpnId}.conf`);

    let child = null;
    let proxyUrl = null;
    let credsFile = null;
    // `extraSecrets: runtimeSecrets` is the SAME array reference, not a copy —
    // spawnAndWait/spawnElevatedAndWait read it fresh when they build their
    // own scrubber, so a cookie pushed here before the switch below is
    // already covered by the time any branch actually spawns a process.
    const spawnCtx = { mfaConfig: vpnConfig.mfaConfig || { type: 'none' }, deploymentId, projectId, vpnType: vpnConfig.type, vpnConfig, extraSecrets: runtimeSecrets };

    try {
      switch (vpnConfig.type) {
        case 'globalprotect':
          const gpArgs = ['--protocol=gp', '--user', vpnConfig.username, '--passwd-on-stdin', '--background', '--pid-file', pidFile];
          if (cachedCookie) gpArgs.push('--cookie', cachedCookie);
          gpArgs.push(vpnConfig.host);

          child = await this.spawnAndWait('openconnect', gpArgs, 'Connected to', onLog, { stdinInput: vpnConfig.password }, spawnCtx);
          break;

        case 'globalprotect-saml':
          let samlCookie = cachedCookie;
          if (!samlCookie) {
            samlCookie = await azureAdMfaHandler.fetchHeadlessCookie(vpnConfig.host, vpnConfig.username, vpnConfig.password, deploymentId, onLog, vpnConfig.allowInsecureTls === true);
            // SECURITY (SEC-06/T-14 follow-up): freshly fetched — cachedCookie's
            // branch above already pushed the cached case; this is the other one.
            if (samlCookie) runtimeSecrets.push(samlCookie);
            if (vpnConfig.mfaConfig?.rememberSession && projectId) {
              await mfaVpnHandler.saveSession(projectId, vpnConfig.type, samlCookie, 8);
            }
          }

          const gpSamlArgs = ['--protocol=gp', '--cookie', samlCookie, '--background', '--pid-file', pidFile, vpnConfig.host];
          child = await this.spawnAndWait('openconnect', gpSamlArgs, 'Connected to', onLog, {}, spawnCtx);
          break;

        case 'anyconnect':
          const acArgs = ['--protocol=anyconnect', '--user', vpnConfig.username, '--passwd-on-stdin', '--background', '--pid-file', pidFile];
          if (cachedCookie) acArgs.push('--cookie', cachedCookie);
          acArgs.push(vpnConfig.host);

          child = await this.spawnAndWait('openconnect', acArgs, 'Connected to', onLog, { stdinInput: vpnConfig.password }, spawnCtx);
          break;

        case 'openvpn':
          if (vpnConfig.configContent) {
            await fs.writeFile(confFile, vpnConfig.configContent, { mode: 0o600 });
          }
          const ovpnCredsFile = path.join(vpnTmpDir, `vpn_creds_${vpnId}.txt`);
          await fs.writeFile(ovpnCredsFile, `${vpnConfig.username}\n${vpnConfig.password}`, { mode: 0o600 });
          credsFile = ovpnCredsFile;

          child = await this.spawnAndWait(
            'openvpn',
            ['--config', vpnConfig.configContent ? confFile : vpnConfig.configPath, '--auth-user-pass', ovpnCredsFile, '--daemon', '--writepid', pidFile],
            'Initialization Sequence Completed',
            onLog,
            {},
            spawnCtx
          );
          break;

        case 'wireguard':
          if (vpnConfig.configContent) {
            await fs.writeFile(confFile, vpnConfig.configContent, { mode: 0o600 });
          }
          child = await this.spawnAndWait(
            'wg-quick',
            ['up', vpnConfig.configContent ? confFile : vpnConfig.interfaceName],
            null, // wg-quick up is synchronous
            onLog,
            {},
            spawnCtx
          );
          break;

        case 'fortinet': {
          const fortiHost = vpnConfig.host.includes(':')
            ? vpnConfig.host.split(':')[0]
            : vpnConfig.host;
          const fortiPort = vpnConfig.host.includes(':')
            ? vpnConfig.host.split(':')[1]
            : (vpnConfig.port || 443);

          // Credentials go in a 0600 config file, not on the command line.
          // openfortivpn itself warns about the latter ("You should not pass
          // the password on the command line"), and it is sound advice: argv is
          // readable by every user on the machine via `ps`.
          // Reuse the session's confFile path so the existing teardown removes
          // it — the file holds the gateway password in plain text and must not
          // outlive the tunnel.
          const fortiConfFile = confFile;
          await fs.writeFile(
            fortiConfFile,
            [
              `host = ${fortiHost}`,
              `port = ${fortiPort}`,
              `username = ${vpnConfig.username}`,
              `password = ${vpnConfig.password}`,
              '',
            ].join('\n'),
            { mode: 0o600 }
          );

          const fortiArgs = ['-c', fortiConfFile, '--persistent=0'];

          // The one-time token is deliberately NOT collected up front.
          //
          // On this kind of gateway the code is not read from an authenticator
          // app — the gateway SENDS it (SMS/push) once openfortivpn reaches the
          // authentication step. Asking the operator first means nothing has
          // triggered the code yet, so there is nothing to type. The token is
          // answered interactively instead, when the gateway actually asks:
          // spawnAndWait/_waitForMarker watches the output for the prompt,
          // raises the MFA dialog, and writes the reply to the process's stdin
          // (a FIFO on the elevated path — see desktop/main/elevation).

          // SECURITY (T-93): openfortivpn needs root. Route through the
          // injectable elevation provider (OS-native dialog on desktop)
          // instead of holding a sudo password ourselves — see
          // spawnElevatedAndWait() and elevationProvider.js.
          child = await this.spawnElevatedAndWait(
            'openfortivpn',
            fortiArgs,
            'Tunnel is up and running',
            onLog,
            {},
            spawnCtx,
            `IDP needs administrator privileges to open a VPN tunnel to "${vpnConfig.host}"`
          );
          break;
        }

        case 'checkpoint': {
          const tracPath = '/Library/Application Support/Checkpoint/Endpoint Connect/trac';
          const checkpointGuiLog = path.join(os.homedir(), 'Library/Logs/CheckPoint/Endpoint Connect/TrGUI.log');

          if (process.platform !== 'darwin') {
            throw new Error('Check Point GUI automation is currently supported only on macOS.');
          }

          try {
            // Force disconnect any stuck sessions before starting a new one
            const { execSync } = require('child_process');
            execSync(`"${tracPath}" disconnect`, { stdio: 'ignore' });
          } catch (e) {
            // Ignore error if nothing is connected
          }

          onLog('[VPN] Starting Check Point through its supported GUI connection flow...');
          await this._runCheckpointCommand('/usr/bin/open', ['-gj', '-a', 'Endpoint Security VPN'], 10000);
          let checkpointLogOffset = 0;
          try {
            checkpointLogOffset = (await fs.stat(checkpointGuiLog)).size;
          } catch (err) {
            if (err.code !== 'ENOENT') throw err;
          }
          await this._runCheckpointCommand(tracPath, ['connectgui', '-s', vpnConfig.host], 15000);

          onLog('[VPN] Waiting for Check Point to create the SAML hand-off; authentication will continue headlessly...');
          const samlUrl = await this._captureCheckpointSamlUrl(checkpointGuiLog, checkpointLogOffset);
          onLog('[VPN] Check Point SAML hand-off captured. Continuing authentication headlessly...');
          await azureAdMfaHandler.handleExternalSamlUrl(
            samlUrl,
            vpnConfig.username,
            vpnConfig.password,
            deploymentId,
            onLog,
            vpnConfig.allowInsecureTls === true
          );

          // connectgui returns immediately; the long-lived GUI client owns
          // the tunnel. Poll its authoritative status rather than waiting on
          // a CLI marker from the unsupported IdP/CLI path.
          await this._verifyCheckpointConnection(tracPath, vpnConfig.host, onLog, 90, 2000);
          break;
        }

        case 'ssh-jump': {
          const proxyPort = Math.floor(Math.random() * (65000 - 10000) + 10000);
          proxyUrl = `socks5://127.0.0.1:${proxyPort}`;

          // SECURITY (SEC-10 / T-17): the bastion's identity used to go
          // completely unverified (StrictHostKeyChecking=no + /dev/null
          // known_hosts), which lets a machine-in-the-middle impersonate the
          // bastion and harvest the SSH password / vault-issued credential.
          // Default to a real, app-private known_hosts file with
          // accept-new (ssh's own trust-on-first-use: a first-seen key is
          // pinned, a later *mismatch* is refused) — the ssh CLI equivalent
          // of the TOFU policy hostKeyVerifier.js implements for
          // SshServerAdapter's node-ssh connections. `hostKeyPolicy:
          // 'insecure'` on the VPN config opts back into the old
          // unverified behavior, loudly logged when used.
          let hostKeyArgs;
          if (vpnConfig.hostKeyPolicy === 'insecure') {
            onLog(`[VPN] ⚠ WARNING: SSH host key verification is DISABLED (hostKeyPolicy=insecure) for bastion ${vpnConfig.host}. This is unsafe against machine-in-the-middle attacks — do not use this setting in production.`);
            hostKeyArgs = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null'];
          } else {
            const knownHostsFile = path.join(VPN_TMP_DIR, 'known_hosts');
            hostKeyArgs = ['-o', `UserKnownHostsFile=${knownHostsFile}`, '-o', 'StrictHostKeyChecking=accept-new'];
          }

          let sshArgs = ['-D', proxyPort.toString(), '-N', ...hostKeyArgs, `${vpnConfig.username}@${vpnConfig.host}`];
          if (vpnConfig.password) {
            // Very basic support assuming sshpass is available for password SOCKS proxy
            sshArgs = ['-p', vpnConfig.password, 'ssh', ...sshArgs];
            child = await this.spawnAndWait('sshpass', sshArgs, 'Local connections to', onLog, {}, spawnCtx);
          } else {
            child = await this.spawnAndWait('ssh', sshArgs, 'Local connections to', onLog, {}, spawnCtx); // Might need -v to catch marker
          }
          break;
        }

        default:
          throw new Error(`Unknown VPN type: ${vpnConfig.type}`);
      }
      
      onLog(`[VPN] ✓ Tunnel successfully orchestrated (ID: ${vpnId})`);

      const session = {
        vpnId,
        type: vpnConfig.type,
        childProcess: child,
        pidFile,
        confFile,
        credsFile,
        proxyUrl,
        rawConfig: vpnConfig,
        // SECURITY (SEC-06/T-14 follow-up): carried through so disconnect()'s
        // own scrubber also redacts any runtime-fetched cookie, not just
        // config fields — defense in depth even though today's teardown
        // commands don't echo it back.
        extraSecrets: runtimeSecrets,
      };

      // SECURITY (SEC-17): register so forceClearAll() can find and tear this
      // down without resorting to a broad pkill of unrelated processes.
      this._activeSessions.set(vpnId, session);

      return session;

    } catch (err) {
      onLog(`[VPN] ✗ Failed to establish VPN: ${err.message}`);
      throw err;
    }
  }

  /**
   * Public entry point (T-56): `session` here is whatever connect() handed
   * back — which, since connect() now goes through VpnSupervisor, carries a
   * `__release()` closure instead of being a raw tunnel session. Delegating
   * to it is what turns this into "release my reference" (share-aware,
   * possibly a no-op if other deployments still hold the tunnel) rather
   * than "tear the tunnel down unconditionally", while keeping this
   * method's signature identical to before T-56.
   */
  static async disconnect(session, onLog) {
    if (!session) return;
    if (typeof session.__release === 'function') {
      return session.__release(onLog);
    }
    // Defensive fallback — shouldn't happen since every session handed out
    // by connect() carries __release, but never silently drop a real
    // tunnel teardown if it somehow doesn't.
    return this._teardownTunnel(session, onLog);
  }

  /**
   * The real teardown logic (pre-T-56 body of disconnect()). Only ever
   * called by VpnSupervisor (once a shared tunnel's last reference is
   * actually released) or forceClearAll() below.
   */
  static async _teardownTunnel(session, rawOnLog) {
    if (!session) return;
    // Teardown logs the config too (host, interface names) — scrub here as
    // well, including any runtime-fetched cookie carried on the session
    // (SEC-06/T-14 follow-up — see _establishTunnel()).
    const scrubDisconnect = createConfigScrubber(session.rawConfig, session.extraSecrets || []);
    const onLog = (line) => rawOnLog(scrubDisconnect(line));

    onLog(`[VPN] Tearing down VPN tunnel (ID: ${session.vpnId})...`);

    try {
      if (session.type === 'checkpoint') {
        const tracPath = '/Library/Application Support/Checkpoint/Endpoint Connect/trac';
        onLog(`[VPN] Running trac disconnect on ${session.rawConfig?.host || 'checkpoint'}`);
        const downProcess = spawn(tracPath, ['disconnect']);
        await new Promise(r => downProcess.on('exit', r));
      } else if (session.type === 'wireguard') {
        const interfacePath = session.rawConfig.configContent ? session.confFile : session.rawConfig.interfaceName;
        onLog(`[VPN] Running wg-quick down on ${interfacePath}`);
        // Same PATH problem as the connect path — resolve before spawning.
        // Teardown must not throw if the tool has since disappeared, so fall
        // back to the bare name and let the spawn error be handled below.
        const wgQuick = findBinary('wg-quick') || 'wg-quick';
        const downProcess = spawn(wgQuick, ['down', interfacePath]);
        await new Promise(r => downProcess.on('exit', r));
      } else if (session.childProcess && !session.childProcess.killed) {
        onLog(`[VPN] Sending SIGTERM to VPN process...`);
        await this._terminateChildProcess(session.childProcess);
      }

      // Cleanup files — only ones this session's connect() created.
      if (session.pidFile) {
        try {
          const pid = await fs.readFile(session.pidFile, 'utf8');
          onLog(`[VPN] Killing background daemon PID: ${pid.trim()}`);
          process.kill(parseInt(pid.trim(), 10), 'SIGTERM');
          await fs.unlink(session.pidFile);
        } catch (e) {
           // file might not exist
        }
      }

      if (session.confFile) {
        try { await fs.unlink(session.confFile); } catch(e){}
      }
      if (session.credsFile) {
        try { await fs.unlink(session.credsFile); } catch(e){}
      }

      onLog(`[VPN] ✓ VPN Teardown completed.`);
    } catch (err) {
      onLog(`[VPN] ⚠ Teardown warning: ${err.message}`);
    } finally {
      // Always drop the session from the registry, even if teardown above
      // partially failed — a session that no longer has processes worth
      // tracking shouldn't keep showing up as "active" to forceClearAll().
      this._activeSessions.delete(session.vpnId);
    }
  }

  /**
   * SECURITY (SEC-17): Tears down only the VPN sessions THIS process actually
   * established (tracked in `_activeSessions`). Deliberately does NOT `pkill`
   * by process name and does NOT scan /tmp for a `vpn_*` glob — both of those
   * could kill or delete a user's unrelated personal VPN connection/files on
   * a shared machine.
   *
   * Calls _teardownTunnel() directly (not disconnect()/VpnSupervisor) since
   * this is an unconditional "kill everything now" — it must not be
   * softened into a refcount decrement, and must not be skipped just
   * because another deployment still thinks it's holding a reference.
   * VpnSupervisor.forceReleaseAll() resets the supervisor's own bookkeeping
   * in lockstep so it doesn't keep believing a tunnel is active (or later
   * fire a linger-teardown against a session that's already gone) — it
   * does not touch any process itself.
   */
  static async forceClearAll() {
    try {
      const sessions = Array.from(this._activeSessions.values());
      VpnSupervisor.forceReleaseAll();

      if (sessions.length === 0) {
        return { cleared: 0, success: true };
      }

      const noopLog = () => {};
      let cleared = 0;
      for (const session of sessions) {
        try {
          await this._teardownTunnel(session, noopLog);
          cleared++;
        } catch (err) {
          console.error(`[VPN] forceClearAll: failed to clear session ${session.vpnId}:`, err.message);
          // Ensure it doesn't linger in the registry even if teardown threw.
          this._activeSessions.delete(session.vpnId);
        }
      }

      return { cleared, success: true };
    } catch (err) {
      console.error('Failed to force clear VPNs:', err);
      return false;
    }
  }
}

module.exports = VpnManager;
