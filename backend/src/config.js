/**
 * Config Loader & Validator
 * 
 * Loads environment variables from .env and validates required
 * fields per adapter. Exits the process if critical vars are missing.
 */
const path = require('path');
// `quiet: true` suppresses dotenv's startup banner. It prints one of eight
// randomly-chosen marketing "tips" on every load — two of which advertise
// products at AI-agent developers. Harmless in itself, but a random ad line on
// every boot buries the warnings that actually matter (missing SESSION_SECRET,
// disabled webhook, interrupted deployments).
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

/**
 * Schema definition for each provider's environment variables.
 * - `required`: Process will refuse to start if these are missing.
 * - `optional`: Logged as a warning if missing, but won't block startup.
 */
const CONFIG_SCHEMA = {
  server: {
    // MFA_WEBHOOK_API_KEY guards POST /api/mfa/webhook-otp. It is deliberately
    // NOT required: the automated-OTP webhook is an optional feature, and a
    // deployment that never uses it should still be able to start the server —
    // the same reasoning that removed the global JENKINS_URL requirement.
    // When unset, the route fails closed and rejects every request (see routes/mfa.js).
    required: [],
    optional: ['PORT', 'NODE_ENV', 'LOG_LEVEL', 'MFA_WEBHOOK_API_KEY'],
  },
  // NOTE: No provider env var is globally required. Every provider is configured
  // per-project from the UI; these env values are only fallback defaults. Making
  // JENKINS_URL globally required blocked startup for anyone who never uses Jenkins.
  // Provider config is validated at adapter creation time instead (see createAdapter).
  jenkins: {
    required: [],
    optional: ['JENKINS_URL', 'JENKINS_USER', 'JENKINS_API_TOKEN'],
  },
  ssh: {
    required: [],
    optional: ['SSH_HOST', 'SSH_PORT', 'SSH_USER', 'SSH_PRIVATE_KEY_PATH', 'SSH_PASSWORD'],
  },
  pmp: {
    required: [],
    optional: ['PMP_URL', 'PMP_USER', 'PMP_PASSWORD', 'PMP_TIMEOUT_MS'],
  },
};

/**
 * Validates environment variables against the schema.
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateEnv() {
  const errors = [];
  const warnings = [];

  for (const [provider, schema] of Object.entries(CONFIG_SCHEMA)) {
    for (const key of schema.required) {
      if (!process.env[key] || process.env[key].trim() === '') {
        errors.push(`[${provider.toUpperCase()}] Missing required env var: ${key}`);
      }
    }
    for (const key of schema.optional) {
      if (!process.env[key]) {
        warnings.push(`[${provider.toUpperCase()}] Optional env var not set: ${key}`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Returns a frozen config object sourced from environment variables.
 * Per-project config from the UI (Settings modal) will override these defaults
 * at runtime when available.
 */
function loadConfig() {
  const { valid, errors, warnings } = validateEnv();

  // Log warnings (non-fatal). Grouped into a single line — every provider var is
  // optional now, so listing them individually drowns out real startup output.
  if (warnings.length > 0) {
    const missing = warnings.map((w) => w.replace(/^\[.*?\] Optional env var not set: /, ''));
    console.warn(`⚠️  No global default for: ${missing.join(', ')} (per-project settings still apply)`);
  }

  // Log errors and exit if critical vars are missing
  if (!valid) {
    for (const e of errors) {
      console.error(`❌ ${e}`);
    }
    console.error('\n💀 Server startup aborted due to missing required environment variables.');
    console.error('   Please create a .env file based on .env.example\n');
    process.exit(1);
  }

  const config = Object.freeze({
    port: parseInt(process.env.PORT || '3001', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',

    jenkins: Object.freeze({
      url: process.env.JENKINS_URL || '',
      user: process.env.JENKINS_USER || '',
      apiToken: process.env.JENKINS_API_TOKEN || '',
    }),

    ssh: Object.freeze({
      host: process.env.SSH_HOST || '',
      port: parseInt(process.env.SSH_PORT || '22', 10),
      user: process.env.SSH_USER || '',
      privateKeyPath: process.env.SSH_PRIVATE_KEY_PATH || '',
      password: process.env.SSH_PASSWORD || '',
    }),

    pmp: Object.freeze({
      url: process.env.PMP_URL || '',
      user: process.env.PMP_USER || '',
      password: process.env.PMP_PASSWORD || '',
      timeoutMs: parseInt(process.env.PMP_TIMEOUT_MS || '30000', 10),
    }),
  });

  console.log('✅ Config loaded successfully.');
  return config;
}

module.exports = { loadConfig, validateEnv };
