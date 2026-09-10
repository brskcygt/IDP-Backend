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

/**
 * HTTP-shell-only settings: IDP_HOST, IDP_COOKIE_SECURE and the production
 * SESSION_SECRET requirement.
 *
 * Deliberately NOT part of validateEnv()/loadConfig(): the Electron IPC shell
 * (desktop/main/ipc/backendModules.js) also calls loadConfig() but never opens
 * a port or issues a session cookie, so a missing SESSION_SECRET must not be
 * able to abort the desktop app. Only src/server.js calls this.
 *
 * Pure (reads only the `env` it's given) so it can be unit-tested.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ valid: boolean, errors: string[], warnings: string[], host: string|null, cookieSecure: boolean }}
 */
function validateHttpServerEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const isProduction = (env.NODE_ENV || 'development') === 'production';

  // IDP_HOST unset/blank -> null -> app.listen(PORT) on every interface (the
  // pre-existing behavior).
  const rawHost = env.IDP_HOST;
  const host = rawHost && rawHost.trim() !== '' ? rawHost.trim() : null;

  // IDP_COOKIE_SECURE unset/blank -> the pre-existing rule (Secure only in
  // production). An unrecognised value is fatal rather than guessed at: a
  // wrong guess either breaks login over plain HTTP or silently drops Secure.
  let cookieSecure = isProduction;
  const rawSecure = env.IDP_COOKIE_SECURE;
  if (rawSecure !== undefined && rawSecure.trim() !== '') {
    const normalized = rawSecure.trim().toLowerCase();
    if (normalized === 'true') {
      cookieSecure = true;
    } else if (normalized === 'false') {
      cookieSecure = false;
      if (isProduction) {
        warnings.push(
          "IDP_COOKIE_SECURE=false: oturum cookie'si düz HTTP üzerinden gidiyor, sadece güvenilir iç ağda kullanın."
        );
      }
    } else {
      errors.push(`[SERVER] IDP_COOKIE_SECURE geçersiz ("${rawSecure}"): sadece "true" veya "false" olabilir.`);
    }
  }

  // In development a missing SESSION_SECRET still falls back to a per-process
  // random secret (see resolveSessionSecret() in server.js). In production
  // that fallback silently logs every user out on each restart, so refuse.
  if (isProduction && (!env.SESSION_SECRET || env.SESSION_SECRET.trim() === '')) {
    errors.push(
      '[SERVER] NODE_ENV=production iken SESSION_SECRET zorunlu (yoksa her yeniden başlatmada tüm oturumlar düşer). ' +
        'Üret: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  return { valid: errors.length === 0, errors, warnings, host, cookieSecure };
}

/**
 * Validates and returns the HTTP-shell settings, mirroring loadConfig():
 * warnings are logged, errors are logged and abort startup.
 * @returns {Readonly<{ host: string|null, cookieSecure: boolean }>}
 */
function loadHttpServerConfig() {
  const { valid, errors, warnings, host, cookieSecure } = validateHttpServerEnv();

  for (const w of warnings) {
    console.warn(`⚠️  ${w}`);
  }

  if (!valid) {
    for (const e of errors) {
      console.error(`❌ ${e}`);
    }
    console.error('\n💀 Server startup aborted due to missing or invalid environment variables.');
    console.error('   Please create a .env file based on .env.example\n');
    process.exit(1);
  }

  return Object.freeze({ host, cookieSecure });
}

module.exports = { loadConfig, validateEnv, validateHttpServerEnv, loadHttpServerConfig };
