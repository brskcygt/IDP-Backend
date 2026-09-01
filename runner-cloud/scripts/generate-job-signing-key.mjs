import { webcrypto } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDirectory = path.resolve(".secrets");
const privatePath = path.join(outputDirectory, "job-signing-private.jwk");
const publicPath = path.join(outputDirectory, "job-signing-public.jwk");

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });

for (const filePath of [privatePath, publicPath]) {
  try {
    const existing = await open(filePath, "r");
    await existing.close();
    throw new Error(`Refusing to overwrite existing key file: ${filePath}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
    throw error;
  }
}

const pair = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const privateJwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);

await writeFile(privatePath, `${JSON.stringify(privateJwk)}\n`, { mode: 0o600, flag: "wx" });
await writeFile(publicPath, `${JSON.stringify(publicJwk)}\n`, { mode: 0o644, flag: "wx" });

console.log("Job-signing key pair created.");
console.log(`Private key: ${privatePath} (0600, never commit or share)`);
console.log(`Public key:  ${publicPath}`);
console.log("Back up the private file in the organization's password/secret manager before deleting the local copy.");
