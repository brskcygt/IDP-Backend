/**
 * Tests for the remote-backend settings (backend on a separate Windows
 * server, Electron clients over plain HTTP on the internal network):
 * IDP_HOST, IDP_COOKIE_SECURE, GET /api/health, IDP_SECRETS_PATH and the
 * production SESSION_SECRET requirement.
 *
 * Three layers:
 *  1. validateHttpServerEnv() (config.js) — pure unit tests.
 *  2. In-process: FileSecretStore path resolution, and the Secure cookie
 *     attribute under a simulated TLS socket.
 *  3. The real src/server.js started as a child process on an OS-assigned
 *     port (PORT=0). server.js listens as an import side effect, so it is
 *     never require()d here (same reasoning as prod-confirmation.test.js).
 *
 * Every spawned server gets its own temp dir for DB/users/sessions/secrets
 * and an explicit value (possibly '') for every variable under test. dotenv
 * never overrides a variable that is already present, so backend/.env cannot
 * leak into these runs.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const session = require('express-session');

const { validateHttpServerEnv } = require('../src/config');
const FileSecretStore = require('../src/secrets/FileSecretStore');
const { ENVIRONMENTS, PROVIDERS } = require('../src/validation/projectSchemas');
const { version: PACKAGE_VERSION } = require('../package.json');

const BACKEND_DIR = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(BACKEND_DIR, 'src', 'server.js');
const STARTUP_TIMEOUT_MS = 20000;
const SAMPLE_SECRET = 'a'.repeat(64);

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 1. validateHttpServerEnv()
// ---------------------------------------------------------------------------

test('validateHttpServerEnv: with no new vars the old behavior holds (all interfaces, Secure only in production)', () => {
  const dev = validateHttpServerEnv({});
  assert.equal(dev.valid, true);
  assert.equal(dev.host, null);
  assert.equal(dev.cookieSecure, false);
  assert.deepEqual(dev.warnings, []);

  const prod = validateHttpServerEnv({ NODE_ENV: 'production', SESSION_SECRET: SAMPLE_SECRET });
  assert.equal(prod.valid, true);
  assert.equal(prod.host, null);
  assert.equal(prod.cookieSecure, true);
  assert.deepEqual(prod.warnings, []);
});

test('validateHttpServerEnv: IDP_HOST is trimmed, blank means unset', () => {
  assert.equal(validateHttpServerEnv({ IDP_HOST: ' 127.0.0.1 ' }).host, '127.0.0.1');
  assert.equal(validateHttpServerEnv({ IDP_HOST: '   ' }).host, null);
});

test('validateHttpServerEnv: IDP_COOKIE_SECURE overrides NODE_ENV in both directions', () => {
  const prodInsecure = validateHttpServerEnv({
    NODE_ENV: 'production',
    SESSION_SECRET: SAMPLE_SECRET,
    IDP_COOKIE_SECURE: 'false',
  });
  assert.equal(prodInsecure.valid, true);
  assert.equal(prodInsecure.cookieSecure, false);
  assert.equal(prodInsecure.warnings.length, 1, 'production + false must warn exactly once');
  assert.match(prodInsecure.warnings[0], /düz HTTP/);

  const devSecure = validateHttpServerEnv({ IDP_COOKIE_SECURE: 'true' });
  assert.equal(devSecure.cookieSecure, true);
  assert.deepEqual(devSecure.warnings, []);

  assert.equal(
    validateHttpServerEnv({ NODE_ENV: 'production', SESSION_SECRET: SAMPLE_SECRET, IDP_COOKIE_SECURE: ' TRUE ' })
      .cookieSecure,
    true
  );

  const devInsecure = validateHttpServerEnv({ IDP_COOKIE_SECURE: 'false' });
  assert.equal(devInsecure.cookieSecure, false);
  assert.deepEqual(devInsecure.warnings, [], 'the plain-HTTP warning is production-only');

  assert.equal(validateHttpServerEnv({ IDP_COOKIE_SECURE: '' }).cookieSecure, false, 'blank means unset');
});

test('validateHttpServerEnv: an unrecognised IDP_COOKIE_SECURE value is an error, never a guess', () => {
  for (const value of ['yes', '1', 'on', 'secure']) {
    const result = validateHttpServerEnv({ IDP_COOKIE_SECURE: value });
    assert.equal(result.valid, false, `"${value}" must be rejected`);
    assert.match(result.errors[0], /IDP_COOKIE_SECURE/);
  }
});

test('validateHttpServerEnv: SESSION_SECRET is required in production only', () => {
  for (const secret of [undefined, '', '   ']) {
    const prod = validateHttpServerEnv({ NODE_ENV: 'production', SESSION_SECRET: secret });
    assert.equal(prod.valid, false);
    assert.match(prod.errors[0], /SESSION_SECRET/);
  }
  assert.equal(validateHttpServerEnv({}).valid, true, 'development keeps the random-secret fallback');
  assert.equal(validateHttpServerEnv({ NODE_ENV: 'test' }).valid, true);
});

// ---------------------------------------------------------------------------
// 2. In-process
// ---------------------------------------------------------------------------

test('FileSecretStore writes to IDP_SECRETS_PATH, creating missing directories, when no filePath is given', async () => {
  const dir = makeTempDir('idp-secrets-path-');
  const target = path.join(dir, 'nested', 'data', 'secrets.enc.json');
  const previous = process.env.IDP_SECRETS_PATH;
  process.env.IDP_SECRETS_PATH = target;
  try {
    const store = new FileSecretStore({ key: crypto.randomBytes(32) });
    assert.ok(store.describe().includes(target));

    await store.set('db.password', 'hunter2');
    assert.ok(fs.existsSync(target), 'the store file must be created at IDP_SECRETS_PATH');
    assert.equal(await store.get('db.password'), 'hunter2');
    assert.ok(!fs.readFileSync(target, 'utf8').includes('hunter2'), 'never plaintext on disk');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(target).mode & 0o777, 0o600, 'the 0600 file mode is preserved');
    }

    // An explicit filePath still wins over the env var.
    const explicit = path.join(dir, 'explicit.enc.json');
    assert.ok(new FileSecretStore({ key: crypto.randomBytes(32), filePath: explicit }).describe().includes(explicit));
  } finally {
    if (previous === undefined) delete process.env.IDP_SECRETS_PATH;
    else process.env.IDP_SECRETS_PATH = previous;
  }
});

test('FileSecretStore keeps the old default path when IDP_SECRETS_PATH is unset or blank', () => {
  const previous = process.env.IDP_SECRETS_PATH;
  const defaultPath = path.join(BACKEND_DIR, 'src', 'secrets.enc.json');
  try {
    delete process.env.IDP_SECRETS_PATH;
    assert.ok(new FileSecretStore({ key: crypto.randomBytes(32) }).describe().includes(defaultPath));
    process.env.IDP_SECRETS_PATH = '  ';
    assert.ok(new FileSecretStore({ key: crypto.randomBytes(32) }).describe().includes(defaultPath));
  } finally {
    if (previous === undefined) delete process.env.IDP_SECRETS_PATH;
    else process.env.IDP_SECRETS_PATH = previous;
  }
});

/**
 * express-session never sends a Secure cookie over plain HTTP, so the only
 * way to observe the attribute itself without a TLS server is to mark the
 * socket as encrypted (exactly what express-session checks). The cookie
 * options mirror server.js; the `secure` value comes from the real
 * validateHttpServerEnv().
 */
async function loginCookieFromSessionApp(env) {
  const { cookieSecure } = validateHttpServerEnv(env);
  const app = express();
  app.use((req, _res, next) => {
    req.socket.encrypted = true;
    next();
  });
  app.use(
    session({
      secret: 'test-only',
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: cookieSecure },
    })
  );
  app.post('/login', (req, res) => {
    req.session.user = { username: 'admin' };
    res.json({ ok: true });
  });

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/login`, { method: 'POST' });
    return res.headers.getSetCookie().find((c) => c.startsWith('connect.sid='));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Secure cookie attribute: present with IDP_COOKIE_SECURE=true, absent with false (production)', async () => {
  const secureCookie = await loginCookieFromSessionApp({
    NODE_ENV: 'production',
    SESSION_SECRET: SAMPLE_SECRET,
    IDP_COOKIE_SECURE: 'true',
  });
  assert.ok(secureCookie, 'a session cookie is issued');
  assert.match(secureCookie, /;\s*Secure/i);

  const plainCookie = await loginCookieFromSessionApp({
    NODE_ENV: 'production',
    SESSION_SECRET: SAMPLE_SECRET,
    IDP_COOKIE_SECURE: 'false',
  });
  assert.ok(plainCookie);
  assert.doesNotMatch(plainCookie, /;\s*Secure/i);
});

// ---------------------------------------------------------------------------
// 3. Real src/server.js in a child process
// ---------------------------------------------------------------------------

function makeServerEnv(overrides = {}) {
  const dir = makeTempDir('idp-remote-server-');
  const adminPassword = crypto.randomBytes(12).toString('hex');
  const env = { ...process.env };
  // Not a test file: don't let it think it's a node:test child, and don't
  // hand it the parent's isolateDb ownership stamp.
  delete env.NODE_TEST_CONTEXT;
  delete env.IDP_DB_PATH_OWNER_PID;
  Object.assign(
    env,
    {
      PORT: '0',
      NODE_ENV: 'development',
      IDP_HOST: '',
      IDP_COOKIE_SECURE: '',
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      IDP_SECRET_KEY: crypto.randomBytes(32).toString('base64'),
      IDP_ADMIN_PASSWORD: adminPassword,
      IDP_DB_PATH: path.join(dir, 'idp.db'),
      IDP_USERS_PATH: path.join(dir, 'users.json'),
      IDP_SESSIONS_PATH: path.join(dir, 'sessions.json'),
      IDP_SECRETS_PATH: path.join(dir, 'secrets', 'secrets.enc.json'),
    },
    overrides
  );
  return { env, adminPassword };
}

const LISTEN_LINE = /Backend server running on \[?([^\]\s]+?)\]?:(\d+)/;

/** Starts src/server.js; `ready` resolves to { host, port } from the startup log. */
function startServer(overrides) {
  const { env, adminPassword } = makeServerEnv(overrides);
  const child = spawn(process.execPath, [SERVER_ENTRY], { cwd: BACKEND_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const ready = new Promise((resolve, reject) => {
    const fail = (why) => reject(new Error(`${why}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
    const timer = setTimeout(() => {
      child.kill();
      fail(`server did not start within ${STARTUP_TIMEOUT_MS}ms`);
    }, STARTUP_TIMEOUT_MS);
    child.stdout.on('data', () => {
      const match = stdout.match(LISTEN_LINE);
      if (match) {
        clearTimeout(timer);
        resolve({ host: match[1], port: Number(match[2]) });
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(`server exited early (code ${code})`);
    });
  });

  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });

  return { env, adminPassword, ready, stop, output: () => ({ stdout, stderr }) };
}

/** Runs src/server.js expecting it to exit on its own; resolves { code, stdout, stderr }. */
function runUntilExit(overrides) {
  const { env } = makeServerEnv(overrides);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_ENTRY], { cwd: BACKEND_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not exit within ${STARTUP_TIMEOUT_MS}ms\n${stdout}\n${stderr}`));
    }, STARTUP_TIMEOUT_MS);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, env });
    });
  });
}

async function login(baseUrl, password) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
}

function sessionCookieOf(res) {
  return res.headers.getSetCookie().find((c) => c.startsWith('connect.sid='));
}

function firstExternalIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address;
    }
  }
  return null;
}

test('real server: GET /api/health is 200 without auth, cookie or rate limit; other routes still need auth', async () => {
  const srv = startServer({ IDP_HOST: '127.0.0.1' });
  try {
    const { host, port } = await srv.ready;
    const base = `http://${host}:${port}`;

    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, service: 'idp-backend', version: PACKAGE_VERSION });
    assert.equal(res.headers.get('set-cookie'), null, 'a health probe must not create a session');

    // More than the strictest limiter (login: 10 per window) — none throttled.
    for (let i = 0; i < 15; i += 1) {
      assert.equal((await fetch(`${base}/api/health`)).status, 200);
    }

    assert.equal((await fetch(`${base}/api/projects`)).status, 401, 'regular API routes are still guarded');
    assert.equal((await fetch(`${base}/api/auth/me`)).status, 401);
  } finally {
    await srv.stop();
  }
});

test('real server: IDP_HOST binds only that address and the startup log names host:port', async () => {
  const srv = startServer({ IDP_HOST: '127.0.0.1' });
  try {
    const { host, port } = await srv.ready;
    assert.equal(host, '127.0.0.1');
    assert.ok(srv.output().stdout.includes(`Backend server running on 127.0.0.1:${port}\n`));
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);

    const external = firstExternalIPv4();
    if (external) {
      await assert.rejects(
        fetch(`http://${external}:${port}/api/health`, { signal: AbortSignal.timeout(3000) }),
        `must not be reachable on ${external} when bound to 127.0.0.1`
      );
    }
  } finally {
    await srv.stop();
  }
});

test('real server: without IDP_HOST it still listens on all interfaces (pre-existing behavior)', async () => {
  const srv = startServer({});
  try {
    const { host, port } = await srv.ready;
    assert.ok(['::', '0.0.0.0'].includes(host), `expected a wildcard address, got ${host}`);
    assert.match(srv.output().stdout, /\(all interfaces\)/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
  } finally {
    await srv.stop();
  }
});

test('real server: production + IDP_COOKIE_SECURE=false gives a non-Secure cookie and a working session over plain HTTP', async () => {
  const srv = startServer({ NODE_ENV: 'production', IDP_COOKIE_SECURE: 'false', IDP_HOST: '127.0.0.1' });
  try {
    const { host, port } = await srv.ready;
    const base = `http://${host}:${port}`;

    const res = await login(base, srv.adminPassword);
    assert.equal(res.status, 200);
    const cookie = sessionCookieOf(res);
    assert.ok(cookie, 'login over plain HTTP must issue a session cookie');
    assert.doesNotMatch(cookie, /;\s*Secure/i);
    assert.match(cookie, /;\s*HttpOnly/i);

    const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie.split(';')[0] } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.username, 'admin');

    const warnings = srv.output().stderr.split('\n').filter((l) => l.includes('düz HTTP'));
    assert.equal(warnings.length, 1, 'exactly one plain-HTTP warning at startup');
  } finally {
    await srv.stop();
  }
});

test('real server: production with IDP_COOKIE_SECURE=true or unset keeps Secure (no cookie is sent over plain HTTP)', async () => {
  for (const value of ['true', '']) {
    const srv = startServer({ NODE_ENV: 'production', IDP_COOKIE_SECURE: value, IDP_HOST: '127.0.0.1' });
    try {
      const { host, port } = await srv.ready;
      const res = await login(`http://${host}:${port}`, srv.adminPassword);
      assert.equal(res.status, 200, 'credentials are still accepted');
      assert.equal(sessionCookieOf(res), undefined, `IDP_COOKIE_SECURE="${value}": Secure cookie withheld over HTTP`);
      assert.doesNotMatch(srv.output().stderr, /düz HTTP/);
    } finally {
      await srv.stop();
    }
  }
});

test('real server: IDP_SECRETS_PATH receives the encrypted project credentials', async () => {
  const srv = startServer({ IDP_HOST: '127.0.0.1' });
  try {
    const { host, port } = await srv.ready;
    const base = `http://${host}:${port}`;
    const secretsPath = srv.env.IDP_SECRETS_PATH;
    assert.ok(srv.output().stdout.includes(`encrypted file (AES-256-GCM) at ${secretsPath}`));
    assert.equal(fs.existsSync(secretsPath), false, 'nothing written before a secret exists');

    const cookie = sessionCookieOf(await login(base, srv.adminPassword)).split(';')[0];
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };

    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Remote secrets', tenant: 't', environment: ENVIRONMENTS[0], provider: PROVIDERS[0] }),
    });
    assert.equal(created.status, 201);
    const { id } = await created.json();

    const plaintext = `pw-${crypto.randomBytes(8).toString('hex')}`;
    const saved = await fetch(`${base}/api/projects/${id}/settings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ password: plaintext }),
    });
    assert.equal(saved.status, 200);

    assert.ok(fs.existsSync(secretsPath), 'secrets file created under IDP_SECRETS_PATH (parent dir included)');
    const onDisk = fs.readFileSync(secretsPath, 'utf8');
    assert.ok(Object.keys(JSON.parse(onDisk)).includes(`secret://${id}/password`));
    assert.ok(!onDisk.includes(plaintext), 'credential is encrypted on disk');
  } finally {
    await srv.stop();
  }
});

test('real server: NODE_ENV=production without SESSION_SECRET exits with a clear error before touching data', async () => {
  const result = await runUntilExit({ NODE_ENV: 'production', SESSION_SECRET: '' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /SESSION_SECRET zorunlu/);
  assert.doesNotMatch(result.stdout, /Backend server running/);
  assert.equal(fs.existsSync(result.env.IDP_DB_PATH), false, 'exits before the database is opened');
});

test('real server: an invalid IDP_COOKIE_SECURE value aborts startup', async () => {
  const result = await runUntilExit({ IDP_COOKIE_SECURE: 'yes' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /IDP_COOKIE_SECURE geçersiz/);
});

test('real server: development without SESSION_SECRET still starts (random per-process secret, as before)', async () => {
  const srv = startServer({ SESSION_SECRET: '', IDP_HOST: '127.0.0.1' });
  try {
    await srv.ready;
    assert.match(srv.output().stderr, /SESSION_SECRET tanımlı değil/);
  } finally {
    await srv.stop();
  }
});
