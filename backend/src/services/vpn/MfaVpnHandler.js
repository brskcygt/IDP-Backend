const fs = require('fs').promises;
const path = require('path');
const deploymentManager = require('../DeploymentManager');

class MfaVpnHandler {
  constructor() {
    this.cacheFile = path.join('/tmp', 'vpn_session_cache.json');
  }

  async loadCache() {
    try {
      const data = await fs.readFile(this.cacheFile, 'utf8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  async saveCache(cache) {
    await fs.writeFile(this.cacheFile, JSON.stringify(cache, null, 2));
  }

  async getCachedSession(projectId, provider) {
    const cache = await this.loadCache();
    const key = `${projectId}_${provider}`;
    const session = cache[key];
    
    if (session && session.expiresAt > Date.now()) {
      return session.cookie;
    }
    return null;
  }

  async saveSession(projectId, provider, cookie, expiresInHours = 8) {
    const cache = await this.loadCache();
    const key = `${projectId}_${provider}`;
    cache[key] = {
      cookie,
      expiresAt: Date.now() + expiresInHours * 3600 * 1000
    };
    await this.saveCache(cache);
  }

  async clearSession(projectId, provider) {
    const cache = await this.loadCache();
    const key = `${projectId}_${provider}`;
    if (cache[key]) {
      delete cache[key];
      await this.saveCache(cache);
      return true;
    }
    return false;
  }

  /**
   * Prompts the user via SSE for an MFA code and waits for the submission.
   */
  async requestUserMfa(deploymentId, mfaType, onLog) {
    onLog(`[VPN] Pausing deployment to request MFA from user (${mfaType})...`);
    deploymentManager.pushEvent(deploymentId, 'MFA_REQUIRED', { authType: mfaType });
    
    return new Promise((resolve, reject) => {
      // Set the resolver in DeploymentManager
      deploymentManager.setMfaResolver(
        deploymentId,
        (code) => {
          onLog(`[VPN] Received MFA input from user.`);
          resolve(code);
        },
        // Lets an abort cancel this wait instead of leaving the deployment
        // parked here until the timeout below fires.
        (err) => {
          onLog(`[VPN] MFA challenge cancelled: ${err.message}`);
          reject(err);
        }
      );

      // Timeout after 60s
      setTimeout(() => {
        deploymentManager.setMfaResolver(deploymentId, null);
        reject(new Error('MFA approval timed out after 60 seconds.'));
      }, 60000);
    });
  }

  /**
   * Helper to intercept CLI prompts for MFA and respond.
   */
  interceptStdout(deploymentId, line, mfaConfig, child, onLog) {
    // Prevent duplicated prompt requests by checking a flag on the child process
    if (child.mfaPrompted) return;

    // Common MFA trigger keywords from OpenConnect / SAML CLI
    if (line.match(/Challenge:|Password:|Enter passcode:|OTP:|Response:/i) && !line.includes('***')) {
      child.mfaPrompted = true;

      if (mfaConfig.type === 'push') {
        onLog('[VPN] MFA Push notification triggered. Please approve on your mobile device...');
        deploymentManager.pushEvent(deploymentId, 'MFA_REQUIRED', { authType: 'push' });
        
        // Timeout to kill process if they ignore the push notification
        setTimeout(() => {
          if (!child.killed) {
            onLog('[VPN] Push approval timed out after 60s.');
            child.kill('SIGTERM');
          }
        }, 60000);

      } else if (mfaConfig.type === 'totp') {
        this.requestUserMfa(deploymentId, 'totp', onLog).then(code => {
          child.stdin.write(`${code}\n`);
          child.mfaPrompted = false; // allow subsequent prompts if MFA fails
        }).catch(err => {
          onLog(`[VPN] ✗ ${err.message}`);
          child.kill('SIGTERM');
        });
      }
    }
  }

  /**
   * Helper to scrape cookies from stdout for caching.
   */
  scrapeCookie(projectId, provider, line, onLog) {
    // Example: extracting standard VPN webvpn cookies
    const cookieMatch = line.match(/(?:Set-Cookie:|Got HTTP response:.*cookie:)\s*(webvpn[a-zA-Z0-9_]*|portal-userauthcookie|DSID)=([^;]+)/i);
    if (cookieMatch) {
      const cookieName = cookieMatch[1];
      const cookieVal = cookieMatch[2];
      const fullCookie = `${cookieName}=${cookieVal}`;
      
      onLog(`[VPN] Successfully extracted VPN session cookie. Caching...`);
      this.saveSession(projectId, provider, fullCookie, 8).catch(console.error);
      return fullCookie;
    }
    return null;
  }
}

module.exports = new MfaVpnHandler();
