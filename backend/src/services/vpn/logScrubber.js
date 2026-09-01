/**
 * Redacts known secret values from VPN log output (T-14 / SEC-06).
 *
 * The previous approach masked *arguments that looked like flags* — it checked
 * whether an argument started with `--passwd` or contained `-p`. That misses the
 * common shape where the flag and its value are separate argv entries:
 *
 *     ['openfortivpn', host, '-u', user, '-p', password, '--persistent=0']
 *
 * `-p` was masked; the password beside it was printed verbatim — into the SSE
 * stream, the browser, and the server's stdout.
 *
 * This module inverts the rule: instead of guessing which *positions* are
 * sensitive, it collects the actual secret *values* for a connection and removes
 * every occurrence of them from any line before it is logged. That also covers
 * secrets echoed back by the VPN binary itself, which positional masking could
 * never reach.
 */

/** Values shorter than this are too generic to redact without mangling output. */
const MIN_REDACTABLE_LENGTH = 4;

const REDACTED = '••••••••';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Walk a config object and collect every value that must never be logged.
 * Field names are matched loosely because VPN configs are free-form.
 */
function collectSecretValues(source, collected = new Set()) {
  if (!source || typeof source !== 'object') return collected;

  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object') {
      collectSecretValues(value, collected);
      continue;
    }
    if (typeof value !== 'string' || value.length < MIN_REDACTABLE_LENGTH) continue;

    if (/pass|secret|token|cookie|key|otp|passphrase/i.test(key)) {
      collected.add(value);
    }
  }
  return collected;
}

/**
 * Build a scrubbing function for a given set of secret values.
 *
 * @param {Iterable<string>} secrets
 * @returns {(text: string) => string}
 */
function createScrubber(secrets) {
  // Longest first, so a secret that contains another secret as a substring is
  // replaced whole rather than being partially rewritten first.
  const values = Array.from(new Set(Array.from(secrets).filter(
    (v) => typeof v === 'string' && v.length >= MIN_REDACTABLE_LENGTH
  ))).sort((a, b) => b.length - a.length);

  if (values.length === 0) return (text) => text;

  const pattern = new RegExp(values.map(escapeRegExp).join('|'), 'g');
  return (text) => (typeof text === 'string' ? text.replace(pattern, REDACTED) : text);
}

/**
 * Convenience: build a scrubber straight from a VPN config (plus any extra
 * runtime secrets such as a fetched SAML cookie or an OTP code).
 */
function createConfigScrubber(config, extraSecrets = []) {
  const values = collectSecretValues(config);
  for (const extra of extraSecrets) {
    if (typeof extra === 'string') values.add(extra);
  }
  return createScrubber(values);
}

/**
 * Wrap an onLog callback so every line passes through the scrubber first.
 */
function wrapLogger(onLog, scrub) {
  return (line) => onLog(scrub(line));
}

module.exports = {
  collectSecretValues,
  createScrubber,
  createConfigScrubber,
  wrapLogger,
  REDACTED,
  MIN_REDACTABLE_LENGTH,
};
