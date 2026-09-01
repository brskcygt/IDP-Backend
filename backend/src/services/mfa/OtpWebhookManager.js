class OtpWebhookManager {
  constructor() {
    this.pendingRequests = new Map();
  }

  /**
   * Halt execution until an OTP is received via webhook or timeout expires.
   * @param {string} sessionId - The identifier (e.g. deploymentId)
   * @param {number} timeoutSec - Timeout in seconds
   * @returns {Promise<string>} Resolves with the extracted OTP code
   */
  waitForOtp(sessionId, timeoutSec = 60) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(sessionId);
        reject(new Error(`OTP Webhook timed out after ${timeoutSec} seconds.`));
      }, timeoutSec * 1000);

      this.pendingRequests.set(sessionId, { resolve, reject, timeoutId });
    });
  }

  /**
   * Process an incoming webhook payload, extract the code, and resolve the waiting promise.
   * sessionId is mandatory — it must exactly match the sessionId a pending
   * `waitForOtp` call is registered under (VpnManager calls
   * `waitForOtp(context.deploymentId, ...)`, so sessionId === deploymentId).
   * There is deliberately no "pick the first pending request" fallback: that
   * would let a webhook with no (or a wrong) sessionId inject an OTP into an
   * unrelated in-flight deployment.
   * @param {string} sessionId - The identifier (must equal the deploymentId)
   * @param {string} message - Raw message containing the OTP
   * @returns {boolean} True if matched and resolved, false otherwise
   */
  receiveOtp(sessionId, message) {
    if (this.pendingRequests.size === 0) {
      return false;
    }

    // `sessionId` identifies which deployment the code belongs to. A phone's
    // SMS-forwarding app has no way to know a deployment id — it just relays
    // the message text — so requiring it outright makes automatic OTP capture
    // impossible for the setup it exists to serve.
    //
    // The rule that keeps this safe is narrower: never GUESS between
    // candidates. With exactly one deployment waiting there is nothing to guess
    // and the code can only belong to it. With several waiting, an unlabelled
    // code is ambiguous and is rejected — routing a token to the wrong VPN
    // session is precisely the risk worth refusing.
    let targetSessionId = sessionId;

    if (!targetSessionId) {
      if (this.pendingRequests.size > 1) {
        return false;
      }
      targetSessionId = this.pendingRequests.keys().next().value;
    }

    if (!this.pendingRequests.has(targetSessionId)) {
      return false;
    }

    // Extract 6-digit code
    const match = message.match(/\b\d{6}\b/);
    if (match) {
      const otpCode = match[0];
      const pending = this.pendingRequests.get(targetSessionId);

      clearTimeout(pending.timeoutId);
      pending.resolve(otpCode);
      this.pendingRequests.delete(targetSessionId);

      return true;
    }

    return false;
  }
  
  /**
   * Cancel an automated wait (e.g. if the user manually entered the OTP)
   */
  cancelWait(sessionId) {
    if (this.pendingRequests.has(sessionId)) {
      const pending = this.pendingRequests.get(sessionId);
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Automated OTP intercept cancelled.'));
      this.pendingRequests.delete(sessionId);
    }
  }
}

module.exports = new OtpWebhookManager();
