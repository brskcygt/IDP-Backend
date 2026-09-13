#!/usr/bin/env node
'use strict';

/** Provider-independent CI uploader for the IDP local artifact store. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.tar\.gz$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMPONENT = /^[a-z][a-z0-9-]{0,31}$/;
const OS_VALUES = new Set(['win-x64', 'linux-x64', 'any']);

function usage() {
  return [
    'Usage: node scripts/upload-artifacts.js --project-id <id> --version <version> --manifest <file> [--base-url <url>] [--allow-http]',
    '',
    'Environment:',
    '  IDP_URL                         IDP backend origin (unless --base-url is used)',
    '  IDP_ARTIFACT_UPLOAD_TOKEN       CI upload bearer token (required; never pass on the command line)',
    '  IDP_ARTIFACT_UPLOAD_TIMEOUT_MS  Per-request timeout in milliseconds (default: 1800000)',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { allowHttp: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--allow-http') {
      options.allowHttp = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') return { help: true };
    const key = { '--project-id': 'projectId', '--version': 'version', '--manifest': 'manifestPath', '--base-url': 'baseUrl' }[arg];
    if (!key) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function normalizeBaseUrl(value, allowHttp = false) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('IDP URL must be an absolute http(s) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('IDP URL must be an http(s) origin/path without credentials, query or fragment.');
  }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp && !allowHttp) {
    throw new Error('Plain HTTP exposes the upload token; use HTTPS or pass --allow-http explicitly for a trusted private network.');
  }
  return url.toString().replace(/\/$/, '');
}

async function hashFile(filePath) {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error(`Artifact is empty, symbolic, or not a regular file: ${filePath}`);
  }
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return { size: stat.size, sha256: hash.digest('hex') };
}

function validateManifestShape(manifest, version) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Manifest must be a JSON object.');
  if (manifest.schema !== 1) throw new Error('Manifest schema must be 1.');
  if (manifest.version !== version) throw new Error(`Manifest version '${manifest.version}' does not match '${version}'.`);
  if (!PROJECT.test(manifest.project || '')) throw new Error('Manifest project is missing or invalid.');
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length < 1 || manifest.artifacts.length > 40) {
    throw new Error('Manifest must contain between 1 and 40 artifacts.');
  }
  const names = new Set();
  const componentOs = new Set();
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new Error('Each manifest artifact must be an object.');
    if (!COMPONENT.test(artifact.component || '')) throw new Error(`Invalid artifact component: ${artifact.component}`);
    if (!OS_VALUES.has(artifact.os)) throw new Error(`Invalid artifact OS: ${artifact.os}`);
    if (!FILE_NAME.test(artifact.file || '') || path.basename(artifact.file) !== artifact.file) {
      throw new Error(`Invalid artifact file name: ${artifact.file}`);
    }
    if (!SHA256.test(artifact.sha256 || '')) throw new Error(`Invalid SHA-256 for ${artifact.file}.`);
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) throw new Error(`Invalid size for ${artifact.file}.`);
    if (names.has(artifact.file)) throw new Error(`Duplicate artifact file: ${artifact.file}`);
    const pair = `${artifact.component}/${artifact.os}`;
    if (componentOs.has(pair)) throw new Error(`Duplicate component/OS pair: ${pair}`);
    names.add(artifact.file);
    componentOs.add(pair);
  }
}

async function loadAndVerifyManifest(manifestPath, version) {
  const absoluteManifest = path.resolve(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(await fs.promises.readFile(absoluteManifest, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read manifest ${absoluteManifest}: ${err.message}`);
  }
  validateManifestShape(manifest, version);
  const directory = path.dirname(absoluteManifest);
  const files = [];
  for (const artifact of manifest.artifacts) {
    const filePath = path.join(directory, artifact.file);
    const actual = await hashFile(filePath);
    if (actual.size !== artifact.size || actual.sha256 !== artifact.sha256) {
      throw new Error(`Local artifact does not match manifest: ${artifact.file}`);
    }
    files.push({ artifact, filePath });
  }
  return { manifest, files };
}

async function responseError(response, secrets = []) {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 2048).replace(/\s+/g, ' ').trim();
  } catch {
    // The status is sufficient when an error response cannot be read.
  }
  let message = `${response.status} ${response.statusText || ''}${detail ? `: ${detail}` : ''}`.trim();
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[REDACTED]');
  }
  return message;
}

async function uploadRelease(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Node 24 with global fetch is required.');
  if (!options.projectId || /[\x00-\x20/\\]/.test(options.projectId)) throw new Error('A valid --project-id is required.');
  if (!VERSION.test(options.version || '')) throw new Error('A valid --version is required.');
  if (!options.manifestPath) throw new Error('--manifest is required.');
  const token = options.token;
  if (typeof token !== 'string' || token.length < 32 || /\s/.test(token)) {
    throw new Error('IDP_ARTIFACT_UPLOAD_TOKEN must be at least 32 non-whitespace characters.');
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl, options.allowHttp);
  const timeoutMs = Number(options.timeoutMs || 1_800_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 2_147_483_647) {
    throw new Error('Upload timeout must be an integer between 1000 and 2147483647 ms.');
  }
  const { manifest, files } = await loadAndVerifyManifest(options.manifestPath, options.version);
  const releasePath = `${encodeURIComponent(options.projectId)}/${encodeURIComponent(options.version)}`;

  for (const { artifact, filePath } of files) {
    const response = await fetchImpl(`${baseUrl}/api/artifact-uploads/${releasePath}/${encodeURIComponent(artifact.file)}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/gzip',
        'content-length': String(artifact.size),
        'x-artifact-sha256': artifact.sha256,
      },
      body: fs.createReadStream(filePath),
      duplex: 'half',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Upload failed for ${artifact.file}: ${await responseError(response, [token])}`);
    process.stdout.write(`uploaded ${artifact.file}\n`);
  }

  const response = await fetchImpl(`${baseUrl}/api/artifact-uploads/${releasePath}/finalize`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(manifest),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Finalize failed: ${await responseError(response, [token])}`);
  process.stdout.write(`finalized ${manifest.project}@${manifest.version}\n`);
  return response.json().catch(() => ({}));
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  await uploadRelease({
    ...parsed,
    baseUrl: parsed.baseUrl || env.IDP_URL,
    token: env.IDP_ARTIFACT_UPLOAD_TOKEN,
    timeoutMs: env.IDP_ARTIFACT_UPLOAD_TIMEOUT_MS,
  });
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`upload-artifacts: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, normalizeBaseUrl, hashFile, validateManifestShape, loadAndVerifyManifest, uploadRelease, main };
