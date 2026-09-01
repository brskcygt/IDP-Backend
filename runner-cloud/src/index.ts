import enrollmentScript from "../windows/enroll-runner.ps1";
import heartbeatScript from "../windows/test-heartbeat.ps1";
import runnerScript from "../windows/idp-runner.ps1";
import uninstallRunnerScript from "../windows/uninstall-runner.ps1";
import upgradeRunnerScript from "../windows/upgrade-runner.ps1";
import taskInstallerScript from "../windows/install-runner-task.ps1";
import bundleInstallerScript from "../windows/install-runner-bundle.ps1";
import privatePkiScript from "../windows/release/New-IDPPrivatePKI.ps1";
import signedBundleScript from "../windows/release/New-IDPSignedRunnerBundle.ps1";
import runnerInstallerBuilderScript from "../windows/release/New-IDPRunnerInstaller.ps1";
import publishRunnerInstallerScript from "../windows/release/Publish-IDPRunnerInstaller.ps1";
import buildPublishRunnerScript from "../windows/release/Build-And-Publish-IDPRunner.ps1";
import { AgentAuthError, authenticateAgent } from "./agentAuth";
import { parsePublicSigningKey, signJobPayload, type ScriptJobPayload } from "./jobSigning";

interface Env {
  DB: D1Database;
  ADMIN_API_KEY: string;
  JOB_SIGNING_PRIVATE_JWK: string;
  JOB_SIGNING_PUBLIC_JWK: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
// Script jobs accept 64 KiB of UTF-8 PowerShell plus their JSON envelope.
const MAX_BODY_BYTES = 72 * 1024;
const ENROLLMENT_TTL_SECONDS = 10 * 60;
const RELEASE_UPLOAD_TTL_SECONDS = 10 * 60;
const MAX_RELEASE_BODY_BYTES = 2 * 1024 * 1024;
const MDP_ROOT_THUMBPRINT = "7773C207C03F1E888E26AB0B29D458BCA6F8ECB6";
const MDP_PUBLISHER_THUMBPRINT = "F995D43C136CD3DA167E6FBA56057069B35A72EA";
const BOOTSTRAP_TTL_SECONDS = 10 * 60;

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

type EnrollRequest = {
  token: string;
  agentName: string;
  signingPublicKey: string;
  exchangePublicKey: string;
  version?: string;
  osVersion?: string;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: JSON_HEADERS });
}

function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function randomUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function secretsEqual(candidate: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(candidate), sha256(expected)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice(7).trim() || null;
}

async function requireAdmin(request: Request, env: Env): Promise<void> {
  const supplied = bearerToken(request);
  if (!supplied || !env.ADMIN_API_KEY || !(await secretsEqual(supplied, env.ADMIN_API_KEY))) {
    throw new ApiError(401, "unauthorized", "A valid administrator credential is required.");
  }
}

async function readJsonWithRaw(request: Request): Promise<{ raw: string; value: unknown }> {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "body_too_large", "Request body exceeds 32 KiB.");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "body_too_large", "Request body exceeds 32 KiB.");
  }
  try {
    return { raw, value: JSON.parse(raw) as unknown };
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

async function readJson(request: Request): Promise<unknown> {
  return (await readJsonWithRaw(request)).value;
}

async function readLargeJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_RELEASE_BODY_BYTES) throw new ApiError(413, "body_too_large", "Release upload is too large.");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_RELEASE_BODY_BYTES) throw new ApiError(413, "body_too_large", "Release upload is too large.");
  try { return JSON.parse(raw) as unknown; } catch { throw new ApiError(400, "invalid_json", "Request body must be valid JSON."); }
}

function decodeBase64(value: string): Uint8Array {
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch { throw new ApiError(400, "invalid_base64", "Release artifact is not valid base64."); }
}

async function digestHex(algorithm: "SHA-1" | "SHA-256", bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, new Uint8Array(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validAgentName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(value);
}

function validPublicKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 8192;
}

function optionalShortString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= 128);
}

function optionalReleaseId(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && /^[0-9]{8}-[0-9]{6}$/u.test(value));
}

function parseAgentName(value: unknown): string {
  if (!isRecord(value) || !validAgentName(value.agentName)) {
    throw new ApiError(400, "invalid_request", "agentName must be 3-64 safe characters.");
  }
  return value.agentName;
}

function parseEnrollRequest(value: unknown): EnrollRequest {
  if (!isRecord(value) || typeof value.token !== "string" || value.token.length < 32 ||
    value.token.length > 256 || !validAgentName(value.agentName) ||
    !validPublicKey(value.signingPublicKey) || !validPublicKey(value.exchangePublicKey) ||
    !optionalShortString(value.version) || !optionalShortString(value.osVersion)) {
    throw new ApiError(400, "invalid_request", "Enrollment payload is invalid.");
  }
  return {
    token: value.token,
    agentName: value.agentName,
    signingPublicKey: value.signingPublicKey,
    exchangePublicKey: value.exchangePublicKey,
    version: value.version,
    osVersion: value.osVersion,
  };
}

async function createEnrollmentToken(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const agentName = parseAgentName(await readJson(request));
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ENROLLMENT_TTL_SECONDS;
  const id = crypto.randomUUID();
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO enrollment_tokens (id, token_hash, agent_name, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, await sha256(token), agentName, expiresAt, now),
    env.DB.prepare("INSERT INTO audit_events (actor_type, actor_id, action, target_id, metadata, created_at) VALUES ('desktop', 'admin-api', 'ENROLLMENT_TOKEN_CREATED', ?, ?, ?)")
      .bind(id, JSON.stringify({ agentName, expiresAt }), now),
  ]);
  return json({ ok: true, enrollmentToken: token, agentName, expiresAt }, 201);
}

async function createBootstrapSession(request: Request, env: Env): Promise<Response> {
  const agentName = parseAgentName(await readJson(request));
  const now = Math.floor(Date.now() / 1000);
  const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM runner_bootstrap_sessions WHERE agent_name = ? AND used_at IS NULL AND expires_at >= ?")
    .bind(agentName, now).first<{ count: number }>();
  if ((active?.count ?? 0) >= 5) throw new ApiError(429, "too_many_bootstrap_sessions", "Too many active bootstrap sessions exist for this agent name.");
  const id = crypto.randomUUID();
  const pollSecret = randomToken();
  const userCode = randomUserCode();
  const expiresAt = now + BOOTSTRAP_TTL_SECONDS;
  await env.DB.prepare("INSERT INTO runner_bootstrap_sessions (id, poll_secret_hash, user_code, agent_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, await sha256(pollSecret), userCode, agentName, now, expiresAt).run();
  return json({ ok: true, sessionId: id, pollSecret, userCode, agentName, expiresAt, pollAfterSeconds: 3 }, 201);
}

async function approveBootstrapSession(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const value = await readJson(request);
  if (!isRecord(value) || typeof value.userCode !== "string" || !/^[A-Z2-9]{8}$/u.test(value.userCode)) {
    throw new ApiError(400, "invalid_request", "A valid bootstrap user code is required.");
  }
  const now = Math.floor(Date.now() / 1000);
  const session = await env.DB.prepare("UPDATE runner_bootstrap_sessions SET approved_at = ? WHERE user_code = ? AND approved_at IS NULL AND used_at IS NULL AND expires_at >= ? RETURNING id, agent_name")
    .bind(now, value.userCode, now).first<{ id: string; agent_name: string }>();
  if (!session) throw new ApiError(404, "bootstrap_session_not_found", "Bootstrap session was not found, expired, or already approved.");
  await env.DB.prepare("INSERT INTO audit_events (actor_type, actor_id, action, target_id, metadata, created_at) VALUES ('desktop', 'admin-api', 'BOOTSTRAP_SESSION_APPROVED', ?, ?, ?)")
    .bind(session.id, JSON.stringify({ agentName: session.agent_name }), now).run();
  return json({ ok: true, sessionId: session.id, agentName: session.agent_name, approved: true });
}

async function bootstrapSessionStatus(request: Request, env: Env, sessionId: string): Promise<Response> {
  const value = await readJson(request);
  if (!isRecord(value) || typeof value.pollSecret !== "string") throw new ApiError(400, "invalid_request", "Bootstrap poll secret is required.");
  const now = Math.floor(Date.now() / 1000);
  const session = await env.DB.prepare("SELECT poll_secret_hash, approved_at, used_at, expires_at FROM runner_bootstrap_sessions WHERE id = ? LIMIT 1")
    .bind(sessionId).first<{ poll_secret_hash: string; approved_at: number | null; used_at: number | null; expires_at: number }>();
  if (!session || !(await secretsEqual(await sha256(value.pollSecret), session.poll_secret_hash))) throw new ApiError(401, "invalid_bootstrap_session", "Bootstrap session credential is invalid.");
  if (session.expires_at < now) throw new ApiError(410, "bootstrap_session_expired", "Bootstrap session expired.");
  return json({ ok: true, approved: session.approved_at !== null, used: session.used_at !== null, expiresAt: session.expires_at, pollAfterSeconds: 3 });
}

async function createReleaseUploadToken(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();
  const token = randomToken();
  const expiresAt = now + RELEASE_UPLOAD_TTL_SECONDS;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO runner_release_upload_tokens (id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(id, await sha256(token), expiresAt, now),
    env.DB.prepare("INSERT INTO audit_events (actor_type, actor_id, action, target_id, metadata, created_at) VALUES ('desktop', 'admin-api', 'RELEASE_UPLOAD_TOKEN_CREATED', ?, ?, ?)")
      .bind(id, JSON.stringify({ expiresAt }), now),
  ]);
  return json({ ok: true, uploadToken: token, expiresAt }, 201);
}

async function uploadRunnerRelease(request: Request, env: Env): Promise<Response> {
  const value = await readLargeJson(request);
  if (!isRecord(value) || typeof value.token !== "string" || typeof value.releaseId !== "string" ||
      !/^[0-9]{8}-[0-9]{6}$/u.test(value.releaseId) || typeof value.installerBase64 !== "string" ||
      typeof value.rootCertBase64 !== "string" || typeof value.publisherCertBase64 !== "string") {
    throw new ApiError(400, "invalid_request", "Release upload payload is invalid.");
  }
  const now = Math.floor(Date.now() / 1000);
  const uploadToken = await env.DB.prepare("SELECT id FROM runner_release_upload_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ? LIMIT 1")
    .bind(await sha256(value.token), now).first<{ id: string }>();
  if (!uploadToken) throw new ApiError(401, "invalid_upload_token", "Release upload token is invalid or expired.");

  const installer = decodeBase64(value.installerBase64);
  const root = decodeBase64(value.rootCertBase64);
  const publisher = decodeBase64(value.publisherCertBase64);
  if (installer.byteLength < 1024 || installer.byteLength > 1024 * 1024 || root.byteLength > 16384 || publisher.byteLength > 16384) {
    throw new ApiError(413, "invalid_artifact_size", "Release artifact size is invalid.");
  }
  const [installerSha256, rootThumbprint, publisherThumbprint] = await Promise.all([
    digestHex("SHA-256", installer), digestHex("SHA-1", root), digestHex("SHA-1", publisher),
  ]);
  if (rootThumbprint !== MDP_ROOT_THUMBPRINT || publisherThumbprint !== MDP_PUBLISHER_THUMBPRINT) {
    throw new ApiError(400, "unexpected_publisher", "Release certificates do not match the pinned MDP Group identity.");
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE runner_release_upload_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now, uploadToken.id),
    env.DB.prepare("UPDATE runner_releases SET active = 0 WHERE active = 1"),
    env.DB.prepare("INSERT INTO runner_releases (id, installer_base64, installer_sha256, root_cert_base64, root_thumbprint, publisher_cert_base64, publisher_thumbprint, created_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)")
      .bind(value.releaseId, value.installerBase64, installerSha256, value.rootCertBase64, rootThumbprint, value.publisherCertBase64, publisherThumbprint, now),
    env.DB.prepare("INSERT INTO audit_events (actor_type, actor_id, action, target_id, metadata, created_at) VALUES ('system', 'release-upload', 'RUNNER_RELEASE_PUBLISHED', ?, ?, ?)")
      .bind(value.releaseId, JSON.stringify({ installerSha256, rootThumbprint, publisherThumbprint }), now),
  ]);
  return json({ ok: true, releaseId: value.releaseId, installerSha256, rootThumbprint, publisherThumbprint }, 201);
}

async function getActiveRunnerRelease(env: Env, artifact?: "installer" | "root" | "publisher"): Promise<Response> {
  const release = await env.DB.prepare("SELECT id, installer_base64, installer_sha256, root_cert_base64, root_thumbprint, publisher_cert_base64, publisher_thumbprint, created_at FROM runner_releases WHERE active = 1 ORDER BY created_at DESC LIMIT 1")
    .first<Record<string, string | number>>();
  if (!release) throw new ApiError(404, "release_not_found", "No active runner release is available.");
  if (!artifact) return json({ ok: true, releaseId: release.id, installerSha256: release.installer_sha256, rootThumbprint: release.root_thumbprint, publisherThumbprint: release.publisher_thumbprint, createdAt: release.created_at });
  const encoded = String(artifact === "installer" ? release.installer_base64 : artifact === "root" ? release.root_cert_base64 : release.publisher_cert_base64);
  return new Response(new Uint8Array(decodeBase64(encoded)).buffer, { headers: { "content-type": artifact === "installer" ? "application/vnd.microsoft.portable-executable" : "application/pkix-cert", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

async function listRunnerReleases(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const releases = await env.DB.prepare("SELECT id, installer_sha256, root_thumbprint, publisher_thumbprint, created_at, active FROM runner_releases ORDER BY created_at DESC LIMIT 50")
    .all<{ id: string; installer_sha256: string; root_thumbprint: string; publisher_thumbprint: string; created_at: number; active: number }>();
  return json({ ok: true, releases: releases.results.map((release) => ({
    releaseId: release.id, installerSha256: release.installer_sha256,
    rootThumbprint: release.root_thumbprint, publisherThumbprint: release.publisher_thumbprint,
    createdAt: release.created_at, active: release.active === 1,
  })) });
}

async function activateRunnerRelease(request: Request, env: Env, releaseId: string): Promise<Response> {
  await requireAdmin(request, env);
  const release = await env.DB.prepare("SELECT id FROM runner_releases WHERE id = ? LIMIT 1").bind(releaseId).first<{ id: string }>();
  if (!release) throw new ApiError(404, "release_not_found", "Runner release was not found.");
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("UPDATE runner_releases SET active = CASE WHEN id = ? THEN 1 ELSE 0 END").bind(releaseId),
    env.DB.prepare("INSERT INTO audit_events (actor_type, actor_id, action, target_id, metadata, created_at) VALUES ('desktop', 'admin-api', 'RUNNER_RELEASE_ACTIVATED', ?, '{}', ?)").bind(releaseId, now),
  ]);
  return json({ ok: true, releaseId, active: true });
}

async function enrollAgent(request: Request, env: Env): Promise<Response> {
  const input = parseEnrollRequest(await readJson(request));
  const now = Math.floor(Date.now() / 1000);
  const tokenHash = await sha256(input.token);
  const token = await env.DB.prepare("SELECT id, agent_name FROM enrollment_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ? LIMIT 1")
    .bind(tokenHash, now).first<{ id: string; agent_name: string }>();
  if (!token || token.agent_name !== input.agentName) {
    throw new ApiError(401, "invalid_enrollment_token", "Enrollment token is invalid or expired.");
  }

  const credential = randomToken(48);
  const agentId = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE enrollment_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at >= ?")
        .bind(now, token.id, now),
      env.DB.prepare("INSERT INTO agents (id, name, signing_public_key, exchange_public_key, credential_hash, version, os_version, last_seen_at, enrolled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(agentId, input.agentName, input.signingPublicKey, input.exchangePublicKey,
          await sha256(credential), input.version ?? null, input.osVersion ?? null, now, now),
      env.DB.prepare("INSERT INTO audit_events (actor_type, actor_id, action, target_id, metadata, created_at) VALUES ('agent', ?, 'AGENT_ENROLLED', ?, ?, ?)")
        .bind(agentId, agentId, JSON.stringify({ agentName: input.agentName }), now),
    ]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed: agents.name")) {
      throw new ApiError(409, "agent_name_exists", "An agent with this name already exists.");
    }
    throw error;
  }
  return json({ ok: true, agentId, agentName: input.agentName, credential }, 201);
}

async function enrollBootstrapAgent(request: Request, env: Env, sessionId: string): Promise<Response> {
  const value = await readJson(request);
  if (!isRecord(value) || typeof value.pollSecret !== "string" ||
      !validPublicKey(value.signingPublicKey) || !validPublicKey(value.exchangePublicKey) ||
      !optionalShortString(value.version) || !optionalShortString(value.osVersion)) {
    throw new ApiError(400, "invalid_request", "Bootstrap enrollment payload is invalid.");
  }
  const now = Math.floor(Date.now() / 1000);
  const session = await env.DB.prepare("SELECT poll_secret_hash, agent_name, approved_at, used_at, expires_at FROM runner_bootstrap_sessions WHERE id = ? LIMIT 1")
    .bind(sessionId).first<{ poll_secret_hash: string; agent_name: string; approved_at: number | null; used_at: number | null; expires_at: number }>();
  if (!session || !(await secretsEqual(await sha256(value.pollSecret), session.poll_secret_hash))) throw new ApiError(401, "invalid_bootstrap_session", "Bootstrap session credential is invalid.");
  if (session.expires_at < now) throw new ApiError(410, "bootstrap_session_expired", "Bootstrap session expired.");
  if (session.approved_at === null) throw new ApiError(409, "bootstrap_not_approved", "Bootstrap session has not been approved.");
  if (session.used_at !== null) throw new ApiError(409, "bootstrap_already_used", "Bootstrap session was already used.");
  const existing = await env.DB.prepare("SELECT id FROM agents WHERE name = ? LIMIT 1").bind(session.agent_name).first();
  if (existing) throw new ApiError(409, "agent_name_exists", "An agent with this name already exists.");

  const credential = randomToken(48);
  const agentId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("UPDATE runner_bootstrap_sessions SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now, sessionId),
    env.DB.prepare("INSERT INTO agents (id, name, signing_public_key, exchange_public_key, credential_hash, version, os_version, last_seen_at, enrolled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(agentId, session.agent_name, value.signingPublicKey, value.exchangePublicKey, await sha256(credential), value.version ?? null, value.osVersion ?? null, now, now),
    env.DB.prepare("INSERT INTO audit_events (actor_type, actor_id, action, target_id, metadata, created_at) VALUES ('agent', ?, 'AGENT_ENROLLED_DEVICE_FLOW', ?, ?, ?)")
      .bind(agentId, agentId, JSON.stringify({ agentName: session.agent_name, bootstrapSessionId: sessionId }), now),
  ]);
  return json({ ok: true, agentId, agentName: session.agent_name, credential }, 201);
}

async function heartbeat(request: Request, env: Env): Promise<Response> {
  const { raw, value } = await readJsonWithRaw(request);
  const agent = await authenticateAgent(request, env, raw);
  if (!isRecord(value) || !optionalShortString(value.version) || !optionalShortString(value.osVersion) || !optionalReleaseId(value.releaseId)) {
    throw new ApiError(400, "invalid_request", "Heartbeat payload is invalid.");
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE agents SET last_seen_at = ?, version = COALESCE(?, version), os_version = COALESCE(?, os_version), installed_release_id = COALESCE(?, installed_release_id) WHERE id = ?",
  ).bind(now, value.version ?? null, value.osVersion ?? null, value.releaseId ?? null, agent.id).run();
  return json({ ok: true, agentId: agent.id, serverTime: now, pollAfterSeconds: 15 });
}

type LeasedJob = {
  id: string;
  project_id: string;
  payload: string;
  payload_signature: string;
  timeout_seconds: number;
  lease_expires_at: number;
};

async function recoverStaleJobs(env: Env, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE jobs SET status = 'timed_out', completed_at = ?, error_code = 'JOB_EXPIRED' WHERE status = 'pending' AND expires_at < ?")
      .bind(now, now),
    env.DB.prepare("UPDATE jobs SET status = 'pending', leased_at = NULL, lease_expires_at = NULL WHERE status = 'leased' AND lease_expires_at < ? AND expires_at >= ?")
      .bind(now, now),
    env.DB.prepare("UPDATE jobs SET status = 'timed_out', completed_at = ?, error_code = 'LEASE_EXPIRED' WHERE status = 'leased' AND lease_expires_at < ? AND expires_at < ?")
      .bind(now, now, now),
    env.DB.prepare("UPDATE jobs SET status = 'timed_out', completed_at = ?, exit_code = 124, error_code = 'RUNNER_LOST' WHERE status = 'running' AND started_at + timeout_seconds + 90 < ?")
      .bind(now, now),
  ]);
}

async function leaseJob(request: Request, env: Env): Promise<Response> {
  const { raw, value } = await readJsonWithRaw(request);
  const agent = await authenticateAgent(request, env, raw);
  if (!isRecord(value) || !optionalShortString(value.version) || !optionalShortString(value.osVersion) || !optionalReleaseId(value.releaseId)) {
    throw new ApiError(400, "invalid_request", "Lease payload is invalid.");
  }

  const now = Math.floor(Date.now() / 1000);
  const leaseExpiresAt = now + 60;
  await recoverStaleJobs(env, now);
  await env.DB.prepare(
    "UPDATE agents SET last_seen_at = ?, version = COALESCE(?, version), os_version = COALESCE(?, os_version), installed_release_id = COALESCE(?, installed_release_id) WHERE id = ?",
  ).bind(now, value.version ?? null, value.osVersion ?? null, value.releaseId ?? null, agent.id).run();

  const job = await env.DB.prepare(`
    UPDATE jobs
       SET status = 'leased', leased_at = ?, lease_expires_at = ?
     WHERE id = (
       SELECT id FROM jobs
        WHERE agent_id = ? AND status = 'pending' AND expires_at >= ?
        ORDER BY created_at ASC
        LIMIT 1
     )
       AND status = 'pending'
    RETURNING id, project_id, payload, payload_signature, timeout_seconds, lease_expires_at
  `).bind(now, leaseExpiresAt, agent.id, now).first<LeasedJob>();

  if (!job) {
    return json({ ok: true, job: null, serverTime: now, pollAfterSeconds: 15 });
  }
  return json({
    ok: true,
    job: {
      id: job.id,
      projectId: job.project_id,
      payload: job.payload,
      payloadSignature: job.payload_signature,
      timeoutSeconds: job.timeout_seconds,
      leaseExpiresAt: job.lease_expires_at,
    },
    serverTime: now,
  });
}

async function createDiagnosticJob(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const value = await readJson(request);
  if (!isRecord(value) || typeof value.agentId !== "string" || !/^[a-f0-9-]{36}$/iu.test(value.agentId)) {
    throw new ApiError(400, "invalid_request", "A valid agentId is required.");
  }
  const agent = await env.DB.prepare("SELECT id FROM agents WHERE id = ? AND enabled = 1 LIMIT 1")
    .bind(value.agentId).first<{ id: string }>();
  if (!agent) throw new ApiError(404, "agent_not_found", "Agent was not found or is disabled.");

  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();
  const payload = JSON.stringify({ type: "diagnostic", action: "hostname", version: 1 });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO jobs (id, agent_id, project_id, requested_by, payload, payload_signature, timeout_seconds, created_at, expires_at) VALUES (?, ?, 'runner-diagnostic', 'admin-api', ?, 'allowlisted-diagnostic-v1', 60, ?, ?)")
      .bind(id, agent.id, payload, now, now + 600),
    env.DB.prepare("INSERT INTO audit_events (actor_type, actor_id, action, target_id, metadata, created_at) VALUES ('desktop', 'admin-api', 'DIAGNOSTIC_JOB_CREATED', ?, ?, ?)")
      .bind(id, JSON.stringify({ agentId: agent.id }), now),
  ]);
  return json({ ok: true, jobId: id, status: "pending", expiresAt: now + 600 }, 201);
}

async function listAdminAgents(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const now = Math.floor(Date.now() / 1000);
  const activeRelease = await env.DB.prepare("SELECT id FROM runner_releases WHERE active = 1 LIMIT 1").first<{ id: string }>();
  const agents = await env.DB.prepare(`
    SELECT a.id, a.name, a.enabled, a.version, a.os_version, a.installed_release_id, a.last_seen_at, a.enrolled_at,
           (SELECT j.id FROM jobs j WHERE j.agent_id = a.id AND j.status IN ('leased', 'running') ORDER BY j.created_at DESC LIMIT 1) AS current_job_id,
           (SELECT j.status FROM jobs j WHERE j.agent_id = a.id AND j.status IN ('leased', 'running') ORDER BY j.created_at DESC LIMIT 1) AS current_job_status
      FROM agents a
     WHERE a.enabled = 1
     ORDER BY a.name ASC
     LIMIT 200
  `).all<{
    id: string; name: string; enabled: number; version: string | null; os_version: string | null;
    installed_release_id: string | null; last_seen_at: number | null; enrolled_at: number; current_job_id: string | null; current_job_status: string | null;
  }>();

  return json({
    ok: true,
    serverTime: now,
    agents: agents.results.map((agent) => {
      const secondsSinceSeen = agent.last_seen_at === null ? null : Math.max(0, now - agent.last_seen_at);
      const health = secondsSinceSeen !== null && secondsSinceSeen <= 45 ? "online" : secondsSinceSeen !== null && secondsSinceSeen <= 180 ? "degraded" : "offline";
      return {
        id: agent.id,
        name: agent.name,
        enabled: agent.enabled === 1,
        version: agent.version,
        osVersion: agent.os_version,
        lastSeenAt: agent.last_seen_at,
        enrolledAt: agent.enrolled_at,
        secondsSinceSeen,
        health,
        online: agent.enabled === 1 && health === "online",
        installedReleaseId: agent.installed_release_id,
        activeReleaseId: activeRelease?.id ?? null,
        updateAvailable: Boolean(activeRelease?.id && agent.installed_release_id !== activeRelease.id),
        currentJob: agent.current_job_id ? { id: agent.current_job_id, status: agent.current_job_status } : null,
      };
    }),
  });
}

async function retireAdminAgent(request: Request, env: Env, agentId: string): Promise<Response> {
  await requireAdmin(request, env);
  const agent = await env.DB.prepare("SELECT id, name, enabled FROM agents WHERE id = ? LIMIT 1")
    .bind(agentId).first<{ id: string; name: string; enabled: number }>();
  if (!agent) throw new ApiError(404, "agent_not_found", "Agent was not found.");
  if (agent.enabled !== 1) throw new ApiError(409, "agent_already_retired", "Agent is already retired.");

  const activeJob = await env.DB.prepare(
    "SELECT id, status FROM jobs WHERE agent_id = ? AND status IN ('leased', 'running') LIMIT 1",
  ).bind(agentId).first<{ id: string; status: string }>();
  if (activeJob) {
    throw new ApiError(409, "agent_has_active_job", `Agent has an active ${activeJob.status} job (${activeJob.id}).`);
  }

  const now = Math.floor(Date.now() / 1000);
  const retiredName = `${agent.name.slice(0, 43)}--retired--${agent.id.slice(0, 8)}`;
  await env.DB.batch([
    env.DB.prepare("UPDATE agents SET enabled = 0, revoked_at = ?, name = ? WHERE id = ? AND enabled = 1")
      .bind(now, retiredName, agentId),
    env.DB.prepare("INSERT INTO audit_events (actor_type, actor_id, action, target_id, metadata, created_at) VALUES ('desktop', 'admin-api', 'AGENT_RETIRED', ?, ?, ?)")
      .bind(agentId, JSON.stringify({ originalName: agent.name, retiredName }), now),
  ]);
  return json({ ok: true, agentId, retired: true });
}

async function createScriptJob(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const value = await readJson(request);
  if (!isRecord(value) || typeof value.agentId !== "string" ||
    !/^[a-f0-9-]{36}$/iu.test(value.agentId) || typeof value.script !== "string" ||
    value.script.length === 0 || new TextEncoder().encode(value.script).byteLength > 64 * 1024 ||
    !Number.isInteger(value.timeoutSeconds) || Number(value.timeoutSeconds) < 1 || Number(value.timeoutSeconds) > 3600) {
    throw new ApiError(400, "invalid_request", "agentId, a script up to 64 KiB, and timeoutSeconds (1-3600) are required.");
  }
  const agent = await env.DB.prepare("SELECT id FROM agents WHERE id = ? AND enabled = 1 LIMIT 1")
    .bind(value.agentId).first<{ id: string }>();
  if (!agent) throw new ApiError(404, "agent_not_found", "Agent was not found or is disabled.");

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 600;
  const payload: ScriptJobPayload = {
    version: 1,
    type: "powershell",
    script: value.script,
    timeoutSeconds: Number(value.timeoutSeconds),
    createdAt: now,
    expiresAt,
  };
  const signed = await signJobPayload(payload, env.JOB_SIGNING_PRIVATE_JWK);
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO jobs (id, agent_id, project_id, requested_by, payload, payload_signature, timeout_seconds, created_at, expires_at) VALUES (?, ?, 'runner-script', 'admin-api', ?, ?, ?, ?, ?)")
      .bind(id, agent.id, signed.payload, signed.signature, payload.timeoutSeconds, now, expiresAt),
    env.DB.prepare("INSERT INTO audit_events (actor_type, actor_id, action, target_id, metadata, created_at) VALUES ('desktop', 'admin-api', 'SCRIPT_JOB_CREATED', ?, ?, ?)")
      .bind(id, JSON.stringify({ agentId: agent.id, timeoutSeconds: payload.timeoutSeconds }), now),
  ]);
  return json({ ok: true, jobId: id, status: "pending", expiresAt }, 201);
}

async function getAdminJob(request: Request, env: Env, jobId: string): Promise<Response> {
  await requireAdmin(request, env);
  await recoverStaleJobs(env, Math.floor(Date.now() / 1000));
  const job = await env.DB.prepare(
    "SELECT id, agent_id, status, timeout_seconds, created_at, expires_at, leased_at, started_at, completed_at, exit_code, error_code, cancel_requested_at FROM jobs WHERE id = ? LIMIT 1",
  ).bind(jobId).first<Record<string, string | number | null>>();
  if (!job) throw new ApiError(404, "job_not_found", "Job was not found.");

  const logs = await env.DB.prepare(
    "SELECT sequence, stream, content, created_at FROM job_log_chunks WHERE job_id = ? ORDER BY sequence ASC",
  ).bind(jobId).all<{ sequence: number; stream: string; content: string; created_at: number }>();

  return json({ ok: true, job, logs: logs.results });
}

async function cancelAdminJob(request: Request, env: Env, jobId: string): Promise<Response> {
  await requireAdmin(request, env);
  const now = Math.floor(Date.now() / 1000);
  const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = ? LIMIT 1")
    .bind(jobId).first<{ status: string }>();
  if (!job) throw new ApiError(404, "job_not_found", "Job was not found.");
  if (["succeeded", "failed", "cancelled", "timed_out"].includes(job.status)) {
    throw new ApiError(409, "job_already_terminal", `Job is already ${job.status}.`);
  }

  if (job.status === "running") {
    await env.DB.prepare("UPDATE jobs SET cancel_requested_at = ?, error_code = 'CANCEL_REQUESTED' WHERE id = ? AND status = 'running'")
      .bind(now, jobId).run();
  } else {
    await env.DB.prepare("UPDATE jobs SET status = 'cancelled', cancel_requested_at = ?, completed_at = ?, error_code = 'CANCELLED' WHERE id = ? AND status IN ('pending', 'leased')")
      .bind(now, now, jobId).run();
  }
  await env.DB.prepare("INSERT INTO audit_events (actor_type, actor_id, action, target_id, metadata, created_at) VALUES ('desktop', 'admin-api', 'JOB_CANCEL_REQUESTED', ?, ?, ?)")
    .bind(jobId, JSON.stringify({ previousStatus: job.status }), now).run();
  return json({ ok: true, jobId, status: job.status === "running" ? "running" : "cancelled", cancelRequested: true });
}

function adminJobIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/admin\/jobs\/([a-f0-9-]{36})$/iu);
  return match?.[1] ?? null;
}

function jobIdFromPath(pathname: string, action: string): string | null {
  const match = pathname.match(new RegExp(`^/v1/agents/jobs/([a-f0-9-]{36})/${action}$`, "iu"));
  return match?.[1] ?? null;
}

async function mutateLeasedJob(request: Request, env: Env, action: "start" | "logs" | "complete" | "status", jobId: string): Promise<Response> {
  const { raw, value } = await readJsonWithRaw(request);
  const agent = await authenticateAgent(request, env, raw);
  if (!isRecord(value)) throw new ApiError(400, "invalid_request", "Job update payload is invalid.");
  const now = Math.floor(Date.now() / 1000);

  if (action === "status") {
    const job = await env.DB.prepare("SELECT status, cancel_requested_at FROM jobs WHERE id = ? AND agent_id = ? LIMIT 1")
      .bind(jobId, agent.id).first<{ status: string; cancel_requested_at: number | null }>();
    if (!job) throw new ApiError(404, "job_not_found", "Job was not found for this agent.");
    return json({ ok: true, jobId, status: job.status, cancelRequested: job.cancel_requested_at !== null });
  }

  if (action === "start") {
    const result = await env.DB.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND agent_id = ? AND status = 'leased' AND lease_expires_at >= ?")
      .bind(now, jobId, agent.id, now).run();
    if ((result.meta.changes ?? 0) !== 1) throw new ApiError(409, "job_not_leased", "Job is not leased to this agent.");
    return json({ ok: true, jobId, status: "running" });
  }

  if (action === "logs") {
    const sequence = value.sequence;
    const stream = value.stream;
    const content = value.content;
    if (!Number.isInteger(sequence) || Number(sequence) < 0 || Number(sequence) > 10000 ||
      !["stdout", "stderr", "system"].includes(String(stream)) || typeof content !== "string" || content.length > 16384) {
      throw new ApiError(400, "invalid_request", "Log chunk is invalid.");
    }
    const job = await env.DB.prepare("SELECT id FROM jobs WHERE id = ? AND agent_id = ? AND status = 'running' LIMIT 1")
      .bind(jobId, agent.id).first();
    if (!job) throw new ApiError(409, "job_not_running", "Job is not running on this agent.");
    await env.DB.prepare("INSERT OR IGNORE INTO job_log_chunks (job_id, sequence, stream, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(jobId, sequence, stream, content, now).run();
    return json({ ok: true, jobId, sequence });
  }

  const exitCode = value.exitCode;
  if (!Number.isInteger(exitCode) || Number(exitCode) < -2147483648 || Number(exitCode) > 2147483647) {
    throw new ApiError(400, "invalid_request", "A valid exitCode is required.");
  }
  const current = await env.DB.prepare("SELECT cancel_requested_at FROM jobs WHERE id = ? AND agent_id = ? AND status = 'running' LIMIT 1")
    .bind(jobId, agent.id).first<{ cancel_requested_at: number | null }>();
  if (!current) throw new ApiError(409, "job_not_running", "Job is not running on this agent.");
  const status = current.cancel_requested_at !== null ? "cancelled" : (exitCode === 0 ? "succeeded" : "failed");
  const errorCode = status === "cancelled" ? "CANCELLED" : (status === "failed" ? "JOB_FAILED" : null);
  const result = await env.DB.prepare("UPDATE jobs SET status = ?, completed_at = ?, exit_code = ?, error_code = ? WHERE id = ? AND agent_id = ? AND status = 'running'")
    .bind(status, now, exitCode, errorCode, jobId, agent.id).run();
  if ((result.meta.changes ?? 0) !== 1) throw new ApiError(409, "job_not_running", "Job is not running on this agent.");
  await env.DB.prepare("INSERT INTO audit_events (actor_type, actor_id, action, target_id, metadata, created_at) VALUES ('agent', ?, 'JOB_COMPLETED', ?, ?, ?)")
    .bind(agent.id, jobId, JSON.stringify({ status, exitCode }), now).run();
  return json({ ok: true, jobId, status, exitCode });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/downloads/enroll-runner.ps1") {
    return new Response(enrollmentScript, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": "attachment; filename=\"enroll-runner.ps1\"",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/downloads/test-heartbeat.ps1") {
    return new Response(heartbeatScript, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": "attachment; filename=\"test-heartbeat.ps1\"",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/downloads/idp-runner.ps1") {
    return new Response(runnerScript, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": "attachment; filename=\"idp-runner.ps1\"",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/downloads/uninstall-runner.ps1") {
    return new Response(uninstallRunnerScript, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": "attachment; filename=\"uninstall-runner.ps1\"", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }
  if (request.method === "GET" && url.pathname === "/downloads/install-runner-task.ps1") {
    return new Response(taskInstallerScript, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": "attachment; filename=\"install-runner-task.ps1\"",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/downloads/install-runner-bundle.ps1") {
    return new Response(bundleInstallerScript, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": "attachment; filename=\"install-runner-bundle.ps1\"",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/downloads/release/New-IDPPrivatePKI.ps1") {
    return new Response(privatePkiScript, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": "attachment; filename=\"New-IDPPrivatePKI.ps1\"",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/downloads/upgrade-runner.ps1") {
    return new Response(upgradeRunnerScript, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }
  if (request.method === "GET" && url.pathname === "/downloads/release/New-IDPSignedRunnerBundle.ps1") {
    return new Response(signedBundleScript, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": "attachment; filename=\"New-IDPSignedRunnerBundle.ps1\"",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/downloads/release/New-IDPRunnerInstaller.ps1") {
    return new Response(runnerInstallerBuilderScript, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": "attachment; filename=\"New-IDPRunnerInstaller.ps1\"",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/downloads/release/Publish-IDPRunnerInstaller.ps1") {
    return new Response(publishRunnerInstallerScript, {
      headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": "attachment; filename=\"Publish-IDPRunnerInstaller.ps1\"", "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  }
  if (request.method === "GET" && url.pathname === "/downloads/release/Build-And-Publish-IDPRunner.ps1") {
    return new Response(buildPublishRunnerScript, {
      headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": "attachment; filename=\"Build-And-Publish-IDPRunner.ps1\"", "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  }
  if (request.method === "GET" && url.pathname === "/health") {
    try {
      await env.DB.prepare("SELECT 1 AS ready").first();
      return json({ ok: true, service: "idp-runner-api", version: "0.3.0", database: "ready", timestamp: new Date().toISOString() });
    } catch {
      return json({ ok: false, service: "idp-runner-api", database: "unavailable" }, 503);
    }
  }
  if (request.method === "GET" && url.pathname === "/v1/policy/job-signing-key") {
    return json({ ok: true, algorithm: "ECDSA_P256_SHA256", key: parsePublicSigningKey(env.JOB_SIGNING_PUBLIC_JWK) });
  }
  if (request.method === "POST" && url.pathname === "/v1/admin/enrollment-tokens") {
    return createEnrollmentToken(request, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/admin/bootstrap-sessions/approve") {
    return approveBootstrapSession(request, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/bootstrap/sessions") {
    return createBootstrapSession(request, env);
  }
  const bootstrapStatusMatch = url.pathname.match(/^\/v1\/bootstrap\/sessions\/([a-f0-9-]{36})\/status$/iu);
  if (request.method === "POST" && bootstrapStatusMatch?.[1]) return bootstrapSessionStatus(request, env, bootstrapStatusMatch[1]);
  const bootstrapEnrollMatch = url.pathname.match(/^\/v1\/bootstrap\/sessions\/([a-f0-9-]{36})\/enroll$/iu);
  if (request.method === "POST" && bootstrapEnrollMatch?.[1]) return enrollBootstrapAgent(request, env, bootstrapEnrollMatch[1]);
  if (request.method === "POST" && url.pathname === "/v1/admin/release-upload-tokens") {
    return createReleaseUploadToken(request, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/releases/upload") {
    return uploadRunnerRelease(request, env);
  }
  if (request.method === "GET" && url.pathname === "/v1/admin/releases") return listRunnerReleases(request, env);
  const activateReleaseMatch = url.pathname.match(/^\/v1\/admin\/releases\/([0-9]{8}-[0-9]{6})\/activate$/u);
  if (request.method === "POST" && activateReleaseMatch?.[1]) return activateRunnerRelease(request, env, activateReleaseMatch[1]);
  if (request.method === "GET" && url.pathname === "/v1/releases/current") return getActiveRunnerRelease(env);
  if (request.method === "GET" && url.pathname === "/v1/releases/current/installer") return getActiveRunnerRelease(env, "installer");
  if (request.method === "GET" && url.pathname === "/v1/releases/current/root.cer") return getActiveRunnerRelease(env, "root");
  if (request.method === "GET" && url.pathname === "/v1/releases/current/publisher.cer") return getActiveRunnerRelease(env, "publisher");
  if (request.method === "POST" && url.pathname === "/v1/admin/jobs/diagnostic") {
    return createDiagnosticJob(request, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/admin/jobs/script") {
    return createScriptJob(request, env);
  }
  if (request.method === "GET" && url.pathname === "/v1/admin/agents") {
    return listAdminAgents(request, env);
  }
  const retireAgentMatch = url.pathname.match(/^\/v1\/admin\/agents\/([a-f0-9-]{36})\/retire$/iu);
  if (request.method === "POST" && retireAgentMatch?.[1]) {
    return retireAdminAgent(request, env, retireAgentMatch[1]);
  }
  const adminJobId = adminJobIdFromPath(url.pathname);
  if (request.method === "GET" && adminJobId) {
    return getAdminJob(request, env, adminJobId);
  }
  const cancelMatch = url.pathname.match(/^\/v1\/admin\/jobs\/([a-f0-9-]{36})\/cancel$/iu);
  if (request.method === "POST" && cancelMatch?.[1]) {
    return cancelAdminJob(request, env, cancelMatch[1]);
  }
  if (request.method === "POST" && url.pathname === "/v1/agents/enroll") {
    return enrollAgent(request, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/agents/heartbeat") {
    return heartbeat(request, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/agents/jobs/lease") {
    return leaseJob(request, env);
  }
  for (const action of ["start", "logs", "complete", "status"] as const) {
    const jobId = jobIdFromPath(url.pathname, action);
    if (request.method === "POST" && jobId) return mutateLeasedJob(request, env, action, jobId);
  }
  return json({ ok: false, error: "not_found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof ApiError) {
        return json({ ok: false, error: error.code, message: error.message }, error.status);
      }
      if (error instanceof AgentAuthError) {
        return json({ ok: false, error: error.code, message: error.message }, error.status);
      }
      console.error(JSON.stringify({ event: "request_failed", error: error instanceof Error ? error.message : "unknown" }));
      return json({ ok: false, error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
