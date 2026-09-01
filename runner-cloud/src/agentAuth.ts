export type AgentAuthEnv = {
  DB: D1Database;
};

export type AuthenticatedAgent = {
  id: string;
  name: string;
};

type AgentRow = AuthenticatedAgent & {
  signing_public_key: string;
  credential_hash: string;
  enabled: number;
};

export class AgentAuthError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function credentialMatches(candidate: string, storedHash: string): Promise<boolean> {
  const left = await sha256(candidate);
  const right = /^[a-f0-9]{64}$/u.test(storedHash) ? storedHash : "0".repeat(64);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new AgentAuthError(401, "invalid_signature", "Agent signature is invalid.");
  }
}

function cngP256PublicKey(value: string): Uint8Array<ArrayBuffer> {
  const blob = decodeBase64(value);
  if (blob.length !== 72) {
    throw new AgentAuthError(401, "invalid_agent_key", "Agent public key is invalid.");
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const coordinateLength = view.getUint32(4, true);
  if (coordinateLength !== 32) {
    throw new AgentAuthError(401, "invalid_agent_key", "Agent public key is invalid.");
  }
  const raw = new Uint8Array(65);
  raw[0] = 4;
  raw.set(blob.subarray(8), 1);
  return raw;
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim();
  if (!value) throw new AgentAuthError(401, "missing_agent_auth", `Missing ${name} header.`);
  return value;
}

function bearerCredential(request: Request): string {
  const authorization = requiredHeader(request, "authorization");
  if (!authorization.startsWith("Bearer ")) {
    throw new AgentAuthError(401, "missing_agent_auth", "Agent credential is required.");
  }
  return authorization.slice(7).trim();
}

export async function authenticateAgent(
  request: Request,
  env: AgentAuthEnv,
  rawBody: string,
): Promise<AuthenticatedAgent> {
  const agentId = requiredHeader(request, "x-idp-agent-id");
  const timestampText = requiredHeader(request, "x-idp-timestamp");
  const nonce = requiredHeader(request, "x-idp-nonce");
  const signatureText = requiredHeader(request, "x-idp-signature");
  const credential = bearerCredential(request);
  const timestamp = Number(timestampText);
  const now = Math.floor(Date.now() / 1000);

  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > 300) {
    throw new AgentAuthError(401, "stale_request", "Agent request timestamp is outside the allowed window.");
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(nonce)) {
    throw new AgentAuthError(401, "invalid_nonce", "Agent request nonce is invalid.");
  }

  const agent = await env.DB.prepare(
    "SELECT id, name, signing_public_key, credential_hash, enabled FROM agents WHERE id = ? LIMIT 1",
  ).bind(agentId).first<AgentRow>();
  if (!agent || agent.enabled !== 1 || !(await credentialMatches(credential, agent.credential_hash))) {
    throw new AgentAuthError(401, "invalid_agent", "Agent authentication failed.");
  }

  const path = new URL(request.url).pathname;
  const canonical = `${request.method}\n${path}\n${timestampText}\n${nonce}\n${await sha256(rawBody)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    cngP256PublicKey(agent.signing_public_key),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    decodeBase64(signatureText),
    new TextEncoder().encode(canonical),
  );
  if (!verified) {
    throw new AgentAuthError(401, "invalid_signature", "Agent signature is invalid.");
  }

  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM request_nonces WHERE expires_at < ?").bind(now),
      env.DB.prepare("INSERT INTO request_nonces (agent_id, nonce, expires_at) VALUES (?, ?, ?)")
        .bind(agent.id, nonce, now + 600),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      throw new AgentAuthError(409, "replayed_request", "Agent request nonce has already been used.");
    }
    throw error;
  }

  return { id: agent.id, name: agent.name };
}
