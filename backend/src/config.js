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
 * @returns {{ valid: boolean, errors: string[], warnings: string[], host: string|null, cookieSecure: boolean, trustProxy: number|false }}
 */
function validateHttpServerEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const isProduction = (env.NODE_ENV || 'development') === 'production';

  // IDP_HOST unset/blank -> null -> app.listen(PORT) on every interface (the
  // pre-existing behavior).
  const rawHost = env.IDP_HOST;
  const host = rawHost && rawHost.trim() !== '' ? rawHost.trim() : null;

  // Exact proxy-hop count keeps X-Forwarded-* headers untrusted for direct
  // clients while allowing TLS termination and real client IPs behind one or
  // more known reverse proxies. Blank/0 preserves Express's default `false`.
  let trustProxy = false;
  const rawTrustProxy = env.IDP_TRUST_PROXY;
  if (rawTrustProxy !== undefined && rawTrustProxy.trim() !== '') {
    const value = Number(rawTrustProxy.trim());
    if (!Number.isInteger(value) || value < 0 || value > 10) {
      errors.push('[SERVER] IDP_TRUST_PROXY gecersiz: 0 ile 10 arasinda bir tam sayi olmali.');
    } else if (value > 0) {
      trustProxy = value;
    }
  }

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

  const agentCredentials = validateAgentCredentialEnv(env);
  errors.push(...agentCredentials.errors);
  warnings.push(...agentCredentials.warnings);

  const artifactDeploy = validateArtifactPublicUrlEnv(env);
  warnings.push(...artifactDeploy.warnings);
  const artifactStorage = validateArtifactStorageEnv(env);
  errors.push(...artifactStorage.errors);
  warnings.push(...artifactStorage.warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    host,
    cookieSecure,
    trustProxy,
    agentCredentials: {
      publicUrl: agentCredentials.publicUrl,
      publicUrlError: agentCredentials.publicUrlError,
      cfAccess: agentCredentials.cfAccess,
    },
    artifactDeploy: {
      publicUrl: artifactDeploy.publicUrl,
      publicUrlError: artifactDeploy.publicUrlError,
      storageRoot: artifactStorage.storageRoot,
      maxArtifactBytes: artifactStorage.maxArtifactBytes,
      uploadToken: artifactStorage.uploadToken,
    },
  };
}

const DEFAULT_ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024;

/** Pure validation for local artifact storage and CI bearer uploads. */
function validateArtifactStorageEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const configuredRoot = (env.IDP_ARTIFACT_STORAGE_ROOT || '').trim();
  let storageRoot;
  if (configuredRoot) {
    if (!path.isAbsolute(configuredRoot)) errors.push('[SERVER] IDP_ARTIFACT_STORAGE_ROOT mutlak bir yol olmali.');
    storageRoot = path.resolve(configuredRoot);
  } else {
    const dbPath = (env.IDP_DB_PATH || '').trim();
    const dataRoot = dbPath && path.isAbsolute(dbPath) ? path.dirname(dbPath) : path.resolve(__dirname, '..', 'data');
    storageRoot = path.join(dataRoot, 'artifacts');
  }

  const uploadToken = (env.IDP_ARTIFACT_UPLOAD_TOKEN || '').trim() || null;
  if (uploadToken && (uploadToken.length < 32 || /\s/.test(uploadToken))) {
    errors.push('[SERVER] IDP_ARTIFACT_UPLOAD_TOKEN en az 32 karakter olmali ve bosluk icermemeli.');
  }

  let maxArtifactBytes = DEFAULT_ARTIFACT_MAX_BYTES;
  const rawMax = (env.IDP_ARTIFACT_MAX_BYTES || '').trim();
  if (rawMax) {
    const parsed = Number(rawMax);
    if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 20 * 1024 * 1024 * 1024) {
      errors.push('[SERVER] IDP_ARTIFACT_MAX_BYTES 1024 ile 21474836480 arasinda bir tam sayi olmali.');
    } else {
      maxArtifactBytes = parsed;
    }
  }
  return { errors, warnings, storageRoot, maxArtifactBytes, uploadToken };
}

/**
 * IDP_PUBLIC_URL: the backend's own public base URL (e.g. https://idp.example),
 * used to build artifact download URLs handed to agents
 * (`<IDP_PUBLIC_URL>/api/artifacts/<id>/download`, docs/ARTIFACT-DEPLOY.md).
 *
 * Optional: unset/invalid only disables artifact deploy (503), it never
 * blocks startup — same rule as IDP_AGENT_PUBLIC_URL. Must be http(s) with no
 * credentials, query or fragment; a path prefix (reverse proxy) is allowed.
 * With NODE_ENV=production only https:// is accepted, because agents send
 * their download token to this address.
 *
 * Pure (reads only `env`).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ warnings: string[], publicUrl: string|null, publicUrlError: string|null }}
 */
function validateArtifactPublicUrlEnv(env = process.env) {
  const warnings = [];
  const raw = (env.IDP_PUBLIC_URL || '').trim();
  if (!raw) {
    return { warnings, publicUrl: null, publicUrlError: 'IDP_PUBLIC_URL tanımlı değil.' };
  }
  const isProduction = (env.NODE_ENV || 'development') === 'production';
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }
  let publicUrlError = null;
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    publicUrlError = 'IDP_PUBLIC_URL geçersiz: http:// veya https:// ile başlayan bir adres olmalı.';
  } else if (parsed.username || parsed.password) {
    publicUrlError = 'IDP_PUBLIC_URL geçersiz: adres kullanıcı adı/parola içeremez.';
  } else if (parsed.search || parsed.hash) {
    publicUrlError = 'IDP_PUBLIC_URL geçersiz: sorgu (?) veya # parçası içeremez.';
  } else if (isProduction && parsed.protocol !== 'https:') {
    publicUrlError = "IDP_PUBLIC_URL geçersiz: NODE_ENV=production iken https:// olmalı (agent'lar indirme token'ını bu adrese gönderir).";
  }
  if (publicUrlError) {
    warnings.push(`${publicUrlError} Artifact deploy (POST /api/targets/:id/deploy) 503 döner.`);
    return { warnings, publicUrl: null, publicUrlError };
  }
  return { warnings, publicUrl: raw.replace(/\/+$/, ''), publicUrlError: null };
}

/**
 * Settings handed to an agent together with its per-agent credential
 * (POST /api/agents/:id/credentials, routes/agents.js):
 *
 *  - IDP_AGENT_PUBLIC_URL: the ws:// / wss:// address agents dial (e.g.
 *    wss://agent.<domain>). Optional: unset or invalid only disables the
 *    credential endpoint (503), it never blocks startup. Invalid is a warning.
 *  - IDP_AGENT_CF_ACCESS_CLIENT_ID / _SECRET: Cloudflare Access service token
 *    the agent sends in front of the gateway. Both or neither — exactly one
 *    set is a startup error, because it would silently hand out agents that
 *    Cloudflare Access rejects.
 *
 * Pure (reads only `env`). Never echoes a secret value in a message.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ errors: string[], warnings: string[], publicUrl: string|null, publicUrlError: string|null,
 *   cfAccess: { clientId: string, clientSecret: string }|null }}
 */
function validateAgentCredentialEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const isProduction = (env.NODE_ENV || 'development') === 'production';
  const allowInsecureWs = (env.IDP_ALLOW_INSECURE_AGENT_WS || '').trim().toLowerCase() === 'true';

  let publicUrl = null;
  let publicUrlError = 'IDP_AGENT_PUBLIC_URL tanımlı değil.';
  const rawPublicUrl = (env.IDP_AGENT_PUBLIC_URL || '').trim();
  if (rawPublicUrl) {
    let parsed = null;
    try {
      parsed = new URL(rawPublicUrl);
    } catch {
      parsed = null;
    }
    if (!parsed || !['ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname) {
      publicUrlError = 'IDP_AGENT_PUBLIC_URL geçersiz: ws:// veya wss:// ile başlayan bir adres olmalı.';
    } else if (parsed.username || parsed.password) {
      publicUrlError = 'IDP_AGENT_PUBLIC_URL geçersiz: adres kullanıcı adı/parola içeremez.';
    } else if (isProduction && parsed.protocol !== 'wss:' && !allowInsecureWs) {
      publicUrlError = 'IDP_AGENT_PUBLIC_URL geçersiz: NODE_ENV=production iken wss:// olmalı (yalnız kontrollü LAN testi için IDP_ALLOW_INSECURE_AGENT_WS=true).';
    } else {
      publicUrl = rawPublicUrl.replace(/\/+$/, '');
      publicUrlError = null;
    }
    if (publicUrlError) {
      warnings.push(`${publicUrlError} Agent kimliği üretimi (POST /api/agents/:id/credentials) 503 döner.`);
    }
  }

  const clientId = (env.IDP_AGENT_CF_ACCESS_CLIENT_ID || '').trim();
  const clientSecret = (env.IDP_AGENT_CF_ACCESS_CLIENT_SECRET || '').trim();
  let cfAccess = null;
  if (clientId && clientSecret) {
    cfAccess = { clientId, clientSecret };
  } else if (clientId || clientSecret) {
    errors.push(
      '[SERVER] IDP_AGENT_CF_ACCESS_CLIENT_ID ve IDP_AGENT_CF_ACCESS_CLIENT_SECRET birlikte verilmeli ' +
        `(şu an yalnızca ${clientId ? 'CLIENT_ID' : 'CLIENT_SECRET'} dolu). İkisini de doldurun ya da ikisini de silin.`
    );
  }

  return { errors, warnings, publicUrl, publicUrlError, cfAccess };
}

/**
 * Validates and returns the HTTP-shell settings, mirroring loadConfig():
 * warnings are logged, errors are logged and abort startup.
 * @returns {Readonly<{ host: string|null, cookieSecure: boolean, trustProxy: number|false,
 *   agentCredentials: { publicUrl: string|null, publicUrlError: string|null, cfAccess: object|null } }>}
 */
function loadHttpServerConfig() {
  const { valid, errors, warnings, host, cookieSecure, trustProxy, agentCredentials, artifactDeploy } = validateHttpServerEnv();

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

  return Object.freeze({
    host,
    cookieSecure,
    trustProxy,
    agentCredentials: Object.freeze({
      publicUrl: agentCredentials.publicUrl,
      publicUrlError: agentCredentials.publicUrlError,
      cfAccess: agentCredentials.cfAccess ? Object.freeze({ ...agentCredentials.cfAccess }) : null,
    }),
    artifactDeploy: Object.freeze({
      publicUrl: artifactDeploy.publicUrl,
      publicUrlError: artifactDeploy.publicUrlError,
      storageRoot: artifactDeploy.storageRoot,
      maxArtifactBytes: artifactDeploy.maxArtifactBytes,
      uploadToken: artifactDeploy.uploadToken,
    }),
  });
}

module.exports = {
  loadConfig,
  validateEnv,
  validateHttpServerEnv,
  validateAgentCredentialEnv,
  validateArtifactPublicUrlEnv,
  validateArtifactStorageEnv,
  loadHttpServerConfig,
};
