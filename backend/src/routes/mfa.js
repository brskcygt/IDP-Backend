const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const otpWebhookManager = require('../services/mfa/OtpWebhookManager');
const auditLogger = require('../services/AuditLogger');
const { createRateLimit } = require('../middleware/rateLimit');

// No hardcoded fallback — see T-13 / SEC-05. When this is unset the automated
// OTP webhook is simply disabled: the route fails closed and rejects every
// request, rather than blocking server startup for deployments that never use
// the feature. Deployments can still be approved through the UI's manual MFA
// prompt; only the SMS-forwarding shortcut is unavailable.
const WEBHOOK_API_KEY = process.env.MFA_WEBHOOK_API_KEY;

if (!WEBHOOK_API_KEY) {
  console.warn(
    '⚠️  MFA_WEBHOOK_API_KEY is not set — the automated OTP webhook ' +
    '(POST /api/mfa/webhook-otp) is disabled. Manual MFA entry still works.'
  );
}

// 20 requests/min per source IP — protects the public webhook from spam
// (see T-19).
const webhookRateLimit = createRateLimit({ windowMs: 60 * 1000, max: 20 });

/**
 * Constant-time string comparison. `crypto.timingSafeEqual` throws if the
 * two buffers differ in length, which would itself leak length information
 * via a thrown-vs-not-thrown timing difference — so both values are first
 * hashed to a fixed-length digest before comparing.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualStrings(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * POST /api/mfa/webhook-otp
 * Webhook endpoint for automated OTP forwarding.
 *
 * Required body fields:
 *   - apiKey: must match MFA_WEBHOOK_API_KEY (constant-time compared)
 *   - sessionId: must match the deploymentId currently waiting for an OTP
 *   - message (or text): raw SMS/notification text containing a 6-digit code
 */
router.post('/webhook-otp', webhookRateLimit, (req, res) => {
  // Fail closed: with no configured key there is no way to authenticate the
  // caller, so the endpoint must not process anything.
  if (!WEBHOOK_API_KEY) {
    console.log('[MFA] Webhook rejected: MFA_WEBHOOK_API_KEY is not configured on this server');
    return res.status(503).json({
      error: 'Automated OTP webhook is disabled: MFA_WEBHOOK_API_KEY is not configured on the server.',
    });
  }

  console.log(`[MFA] Incoming webhook payload:`, req.body);

  const apiKey = req.body.apiKey;

  // API key is mandatory — no bypass when absent, no hardcoded default.
  if (!apiKey || typeof apiKey !== 'string' || !timingSafeEqualStrings(apiKey, WEBHOOK_API_KEY)) {
    console.log(`[MFA] Webhook rejected: Invalid or missing API Key`);
    return res.status(401).json({ error: 'Unauthorized webhook request. Invalid or missing API Key.' });
  }

  // sessionId is OPTIONAL. A phone's SMS-forwarding app relays the message
  // text and nothing else — it cannot know a deployment id. When exactly one
  // deployment is waiting there is nothing to disambiguate, so the code can
  // only belong to it; OtpWebhookManager rejects an unlabelled code whenever
  // more than one is waiting. Sending sessionId is still supported and is the
  // right thing to do for any caller that knows it.
  const sessionId = typeof req.body.sessionId === 'string' ? req.body.sessionId : null;


  // Support both custom payload { message, apiKey } and default SMS Forwarder payload { text, from }
  const message = req.body.message || req.body.text;
  if (!message) {
    console.log(`[MFA] Webhook rejected: Missing message`);
    return res.status(400).json({ error: 'Missing message payload.' });
  }

  const resolved = otpWebhookManager.receiveOtp(sessionId, message);

  if (resolved) {
    console.log(`[MFA] Webhook successfully resolved pending OTP.`);
    auditLogger.log('System', 'OTP_WEBHOOK_RESOLVED', `Successfully resolved pending OTP for deployment via webhook.`, { sessionId });
    return res.json({ success: true, message: 'OTP processed successfully.' });
  } else {
    console.log(`[MFA] Webhook ignored: No active OTP wait or no 6-digit code found.`);
    return res.status(404).json({ error: 'No active OTP wait found for the given sessionId or no 6-digit code found in message.' });
  }
});

module.exports = router;
