export type ScriptJobPayload = {
  version: 1;
  type: "powershell";
  script: string;
  timeoutSeconds: number;
  createdAt: number;
  expiresAt: number;
};

const encoder = new TextEncoder();

export function canonicalJobPayload(payload: ScriptJobPayload): string {
  return JSON.stringify({
    version: payload.version,
    type: payload.type,
    script: payload.script,
    timeoutSeconds: payload.timeoutSeconds,
    createdAt: payload.createdAt,
    expiresAt: payload.expiresAt,
  });
}

export async function signJobPayload(payload: ScriptJobPayload, privateJwkText: string): Promise<{ payload: string; signature: string }> {
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(privateJwkText) as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const canonical = canonicalJobPayload(payload);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(canonical),
  );
  return {
    payload: canonical,
    signature: btoa(String.fromCharCode(...new Uint8Array(signature))),
  };
}

export function parsePublicSigningKey(publicJwkText: string): JsonWebKey {
  const key = JSON.parse(publicJwkText) as JsonWebKey;
  if (key.kty !== "EC" || key.crv !== "P-256" || !key.x || !key.y) {
    throw new Error("JOB_SIGNING_PUBLIC_JWK is not a P-256 public key.");
  }
  return { kty: key.kty, crv: key.crv, x: key.x, y: key.y };
}
