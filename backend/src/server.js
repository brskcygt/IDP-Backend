const { loadConfig, loadHttpServerConfig } = require('./config');
const appConfig = loadConfig();
// HTTP-only settings (IDP_HOST, IDP_COOKIE_SECURE, production SESSION_SECRET
// requirement) — exits here on invalid/missing values, before any module with
// startup side effects (DB, session store) is loaded.
const serverConfig = loadHttpServerConfig();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const session = require('express-session');
const cookieParser = require('cookie-parser');

const deploymentManager = require('./services/DeploymentManager');
const deployRoutes = require('./routes/deploy');
const auditLogger = require('./services/AuditLogger');
const PmpService = require('./services/vault/PmpService');
const { createRateLimit } = require('./middleware/rateLimit');
const userStore = require('./auth/userStore');
const { requirePermission } = require('./auth/permissions');
const FileSessionStore = require('./auth/FileSessionStore');
const { requestContextMiddleware, setContextUser } = require('./middleware/requestContext');
const { validate } = require('./validation/schema');
const { createProjectSchema, deployTriggerSchema, validateProjectConfig } = require('./validation/projectSchemas');
const { checkProdConfirmation } = require('./validation/prodConfirmation');
const AgentGatewayClient = require('./services/agent/AgentGatewayClient');

// Transport-agnostic business logic (T-58). Nothing under src/core/** knows
// about Express, req/res, cookies, or sessions — see src/core/index.js and
// backend/scripts/check-core-boundaries.js.
const { projectService, deploymentService, vpnService, testProjectConnection, NotFoundError, ConflictError } = require('./core');
const { bootstrapCore } = require('./core/bootstrap');
const { sendError } = require('./http/errorMapper');

const app = express();
app.use(cors({ origin: 'http://localhost:5173', credentials: true })); // MUST enable credentials for sessions
// T-20 / SEC-15: cap request body size — previously unbounded, so a large
// or malformed body (e.g. a multi-MB scriptContent) was read and merged
// into project config in full before any validation ran.
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Health probe — unauthenticated, not rate-limited, and mounted BEFORE the
// session middleware so polling it never touches the session store or sets a
// cookie. See routes/health.js.
app.use('/api/health', require('./routes/health'));

/**
 * Resolves the express-session signing secret (T-11 / SEC-04).
 *
 * A hardcoded secret in source lets an attacker forge a valid session
 * cookie and skip login entirely, so this now requires `SESSION_SECRET`
 * from the environment. When it's unset, a random secret is generated for
 * this process instead of hardcoding a fallback — the server still starts
 * (per the T-38/T-13 decision that missing optional config must not block
 * the whole server), but every existing session is invalidated on the next
 * restart since the generated secret isn't persisted anywhere.
 *
 * That fallback is development-only: with NODE_ENV=production,
 * loadHttpServerConfig() (config.js) has already aborted startup when
 * SESSION_SECRET is missing, so production never reaches the random branch.
 */
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim() !== '') {
    return process.env.SESSION_SECRET;
  }
  console.warn(
    '⚠️  SESSION_SECRET tanımlı değil — geçici bir anahtar üretildi, ' +
    'sunucu yeniden başladığında tüm oturumlar düşecek.'
  );
  return crypto.randomBytes(32).toString('hex');
}

// Initialize Session
const sessionStore = new FileSessionStore();

app.use(session({
  store: sessionStore,
  secret: resolveSessionSecret(),
  resave: false,
  saveUninitialized: false,
  rolling: true, // extend the session on activity instead of a fixed absolute expiry
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    // IDP_COOKIE_SECURE overrides; unset keeps the old rule (Secure only in
    // production). express-session will not send a Secure cookie over plain
    // HTTP at all, hence the explicit opt-out for the internal-network install.
    secure: serverConfig.cookieSecure,
    maxAge: 8 * 60 * 60 * 1000 // 8 hours
  }
}));

// T-55 / SEC-12: per-request context (username, role, ip, requestId) via
// AsyncLocalStorage, read automatically by AuditLogger.log(). Must be
// mounted before every route below — including the auth routes, so a
// failed/succeeded login is itself captured with an ip and requestId.
app.use(requestContextMiddleware);

// Auth Middleware
const requireAuth = (req, res, next) => {
  if (req.session && req.session.user) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
};

// Rate limiters (T-19). Plain in-memory fixed-window limiters — see
// src/middleware/rateLimit.js. Each protects a specific endpoint against
// brute-force / spam abuse; keyed by source IP by default.
const loginRateLimit = createRateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const deployTriggerRateLimit = createRateLimit({ windowMs: 60 * 1000, max: 10 });
// T-73: each check dials a real target (Jenkins/SSH/WinRM/PMP vault) — cap
// at 10/minute per IP so "Test Connection" can't be hammered into a
// makeshift port scanner or vault-credential-checkout flood.
const testConnectionRateLimit = createRateLimit({ windowMs: 60 * 1000, max: 10 });

// Auth Routes
app.post('/api/auth/login', loginRateLimit, (req, res) => {
  const { username, password } = req.body || {};

  // userStore.verify() returns null both for an unknown username and for a
  // wrong password — same response either way below — so a failed login
  // never reveals whether the account exists (T-11 / SEC-04).
  const user = userStore.verify(username, password);

  if (!user) {
    auditLogger.log(username, 'LOGIN_FAILED', 'Failed login attempt', { ip: req.ip });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.user = user;
  // requestContextMiddleware ran before req.session.user existed for this
  // request, so it couldn't have captured who's logging in — backfill it
  // now, onto the same request context, so this LOGIN entry (and anything
  // else logged for the rest of this request) carries the right identity.
  setContextUser(user.username, user.role);
  auditLogger.log(user.username, 'LOGIN', 'User logged in successfully');
  return res.json({ success: true, user });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session && req.session.user) {
    auditLogger.log(req.session.user.username, 'LOGOUT', 'User logged out');
  }
  req.session.destroy();
  res.clearCookie('connect.sid');
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ user: req.session.user });
  }
  return res.status(401).json({ error: 'Not authenticated' });
});

// User Management routes (T-52 / SEC-09, admin-only) — see routes/users.js.
app.use('/api/users', require('./routes/users'));

// MFA Webhook Routes
app.use('/api/mfa', require('./routes/mfa'));

// Mount SSE deploy routes
app.use('/api/deploy', requireAuth, deployRoutes);

// Host key management routes (T-17b / SEC-10) — list/forget pinned SSH host keys.
app.use('/api/host-keys', requireAuth, require('./routes/hostKeys'));

// Projects: CRUD, config, environments, telemetry all live in
// core/projects/projectService.js — this file only wires HTTP in/out.
// bootstrapCore() (core/bootstrap.js, T-91) runs the same startup sequence
// Electron's IPC shell runs — DB migration, 'Deploying'→'Idle' recovery,
// DeploymentManager reconciliation, secret store resolution — so this stays
// byte-for-byte the same as before except the logic now also has an
// HTTP-independent caller.
bootstrapCore();

app.get('/api/projects', requirePermission('project:read'), (req, res) => {
  res.json(projectService.listProjects());
});

app.post('/api/projects/:id/vpn/clear-session', requirePermission('vpn:manage'), async (req, res) => {
  try {
    const result = await vpnService.clearProjectVpnSession(req.params.id, req.session?.user?.username);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/vpn/force-disconnect', requirePermission('vpn:manage'), async (req, res) => {
  const result = await vpnService.forceDisconnectAll(req.session?.user?.username);
  res.json(result);
});

app.get('/api/vpn/sessions', requirePermission('vpn:manage'), async (req, res) => {
  const activeSessions = await vpnService.listActiveVpnSessions();
  res.json(activeSessions);
});

app.get('/api/audit-logs', requirePermission('audit:read'), (req, res) => {
  res.json(auditLogger.getLogs(100));
});

app.get('/api/agents', requirePermission('project:read'), async (_req, res) => {
  try {
    res.json(await new AgentGatewayClient().listAgents());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Per-agent credentials: POST/DELETE /api/agents/:id/credentials — see
// routes/agents.js. Same permission as building an agent package
// ('project:write'); separately rate-limited because every POST rotates a
// live agent's secret on the gateway (and disconnects it).
const agentCredentialRateLimit = createRateLimit({ windowMs: 60 * 1000, max: 10 });
app.use('/api/agents', require('./routes/agents').createAgentsRouter({
  agentConfig: serverConfig.agentCredentials,
  auditLogger,
  rateLimit: agentCredentialRateLimit,
}));

app.post('/api/projects', requirePermission('project:write'), (req, res) => {
  const result = validate(req.body, createProjectSchema);
  if (!result.valid) {
    return res.status(400).json({ error: 'Invalid project data.', details: result.errors });
  }

  const newProject = projectService.createProject(result.value, req.session?.user?.username);
  res.status(201).json(newProject);
});

app.post('/api/projects/:id/settings', requirePermission('project:write'), async (req, res) => {
  const { id } = req.params;

  // T-20 / SEC-15: validate the shape/types of the settings patch before it
  // ever reaches projectService.updateProjectConfig(). The ORIGINAL req.body
  // (not the validated clone) is still what gets merged — mergeProjectConfig()'s
  // has*-stripping / empty-secret-preserving behavior (api/projectSerialization.js)
  // must stay byte-for-byte unchanged; validation here is purely a reject
  // gate for malformed/oversized input, never a transform of accepted input.
  const configValidation = validateProjectConfig(req.body);
  if (!configValidation.valid) {
    return res.status(400).json({ error: 'Invalid project settings.', details: configValidation.errors });
  }

  try {
    const updated = await projectService.updateProjectConfig(id, req.body, req.session?.user?.username);
    res.json(updated);
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/projects/:id', requirePermission('project:delete'), async (req, res) => {
  try {
    await projectService.deleteProject(req.params.id, req.session?.user?.username);
    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/projects/:id/telemetry', requirePermission('project:read'), async (req, res) => {
  try {
    const telemetry = await projectService.getProjectTelemetry(req.params.id);
    res.json(telemetry);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return sendError(res, err);
    }
    res.status(500).json({ error: err.message, status: 'offline' });
  }
});

/**
 * T-50: tells TriggerModal which environments actually have a configured
 * override, so it can stop implying that Dev/Stage/Prod go to different
 * places when the project only has one shared config. No secrets in the
 * response — just names and a boolean.
 */
app.get('/api/projects/:id/environments', requirePermission('project:read'), (req, res) => {
  try {
    res.json(projectService.getProjectEnvironments(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * T-73: "Test Connection" — verifies a project's deploy target is reachable
 * and its credentials are valid WITHOUT running a deploy. `project:read` is
 * enough (this is diagnostic, not a mutation) but it still dials a real
 * target, so it's separately rate-limited — see testConnectionRateLimit.
 * All the actual protocol work lives in core/diagnostics/connectionTest.js;
 * this route only fetches the project and maps the result/error onto HTTP.
 */
app.post(
  '/api/projects/:id/test-connection',
  requirePermission('project:read'),
  testConnectionRateLimit,
  async (req, res) => {
    let project;
    try {
      project = projectService.getProject(req.params.id);
    } catch (err) {
      return sendError(res, err);
    }

    try {
      const result = await testProjectConnection({
        project,
        appConfig,
        environment: req.body?.environment,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ----------------------------------------------------------------------------
// Deployment Orchestration
// ----------------------------------------------------------------------------

app.post('/api/deploy/trigger', requirePermission('deploy:trigger'), deployTriggerRateLimit, async (req, res) => {
  const bodyValidation = validate(req.body, deployTriggerSchema);
  if (!bodyValidation.valid) {
    return res.status(400).json({ error: 'Invalid deploy trigger request.', details: bodyValidation.errors });
  }
  const { projectId, parameters } = bodyValidation.value;

  let project;
  try {
    project = projectService.getProject(projectId);
  } catch (err) {
    return sendError(res, err);
  }

  // T-51: a Prod deploy must have the operator type the project's exact
  // name as `parameters.confirmation` — see validation/prodConfirmation.js
  // for the exact contract the frontend implements against.
  const confirmationError = checkProdConfirmation(project, parameters || {});
  if (confirmationError) {
    return res.status(400).json(confirmationError);
  }

  // Concurrency lock: refuse a second deploy for a project that's already
  // deploying. `project.status` alone isn't trustworthy after a crash (it's
  // persisted to disk and could be stuck on 'Deploying'), so it's backed by
  // deploymentService's in-memory lock, which only ever reflects deploys
  // actually running in this process.
  if (project.status === 'Deploying' || deploymentService.isProjectDeploying(project.id)) {
    return sendError(res, new ConflictError('Deployment already in progress for this project.'));
  }

  try {
    const deploymentId = await deploymentService.executeDeploy({
      project,
      parameters: parameters || {},
      triggeredBy: req.session?.user?.username,
      appConfig,
    });
    res.json({
      deploymentId,
      message: 'Deployment triggered. Stream logs via SSE.',
      sseUrl: `/api/deploy/logs/${deploymentId}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pmp/test-connection', requireAuth, async (req, res) => {
  const pmpConfig = req.body;
  if (!pmpConfig || !pmpConfig.baseUrl || !pmpConfig.authToken) {
    return res.status(400).json({ error: 'Missing PMP configuration.' });
  }
  const result = await PmpService.testConnection(pmpConfig);
  res.json(result);
});

// Periodic cleanup of old deployment sessions (every 30 minutes)
setInterval(() => {
  deploymentManager.cleanup();
}, 30 * 60 * 1000);

const PORT = appConfig.port;
// IDP_HOST set -> bind only that address; unset -> every interface (as before).
const listenArgs = serverConfig.host ? [PORT, serverConfig.host] : [PORT];
// Express 5 passes a listen error (EADDRINUSE, EADDRNOTAVAIL, ...) to this
// callback — previously it was ignored and the "running" line still printed.
const server = app.listen(...listenArgs, (err) => {
  if (err) {
    console.error(
      `❌ Backend server could not listen on ${serverConfig.host || '(all interfaces)'}:${PORT} — ${err.message}`
    );
    process.exit(1);
  }
  const { address, port } = server.address();
  const hostLabel = address.includes(':') ? `[${address}]` : address;
  console.log(`Backend server running on ${hostLabel}:${port}${serverConfig.host ? '' : ' (all interfaces)'}`);
});
