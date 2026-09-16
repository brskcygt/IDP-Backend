'use strict';

/**
 * Reads a component's `.env.example` out of its release tarball so the target
 * runtime-config editor can suggest the keys the component actually supports.
 *
 * Best-effort by design: a missing file, a non-tar artifact or a malformed
 * example returns null — it must never fail a release.
 */
const zlib = require('node:zlib');
const { RUNTIME_CONFIG_KEY_PATTERN, MAX_RUNTIME_CONFIG_KEYS, MAX_RUNTIME_CONFIG_VALUE_LENGTH } = require('./contracts');

const ENV_EXAMPLE_NAME = '.env.example';
const MAX_EXAMPLE_BYTES = 64 * 1024;
const MAX_DESCRIPTION_LENGTH = 300;
/** Upper bound on decompressed bytes scanned while looking for the file. */
const MAX_SCAN_BYTES = 512 * 1024 * 1024;
const BLOCK = 512;

function readString(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function readOctal(buffer, start, length) {
  const text = readString(buffer, start, length).trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

/** Path from a PAX extended header body (`<len> path=<value>\n` records). */
function paxPath(body) {
  const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
  return match ? match[1] : null;
}

/** True for `.env.example` at the archive root or directly under one top-level folder. */
function isEnvExamplePath(name) {
  const parts = name.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.');
  return parts.length >= 1 && parts.length <= 2 && parts[parts.length - 1] === ENV_EXAMPLE_NAME;
}

/**
 * Streams a .tar.gz and resolves with the text of the first `.env.example`
 * entry (see isEnvExamplePath), or null when there is none.
 * @param {import('node:stream').Readable} source
 * @returns {Promise<string|null>}
 */
function readEnvExampleFromTarGz(source) {
  return new Promise((resolve) => {
    const gunzip = zlib.createGunzip();
    let buffered = Buffer.alloc(0);
    let scanned = 0;
    let skip = 0;
    let pending = null; // { kind: 'pax'|'longname'|'match', size, padded }
    let nextName = null;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      source.unpipe(gunzip);
      source.destroy();
      gunzip.destroy();
      resolve(value);
    };

    const consume = () => {
      for (;;) {
        if (skip > 0) {
          const n = Math.min(skip, buffered.length);
          buffered = buffered.subarray(n);
          skip -= n;
          if (skip > 0) return;
        }
        if (pending) {
          if (buffered.length < pending.padded) return;
          const body = buffered.subarray(0, pending.size);
          buffered = buffered.subarray(pending.padded);
          const { kind } = pending;
          pending = null;
          if (kind === 'match') return finish(body.toString('utf8'));
          nextName = kind === 'pax' ? paxPath(body) : readString(body, 0, body.length);
          continue;
        }
        if (buffered.length < BLOCK) return;
        const header = buffered.subarray(0, BLOCK);
        buffered = buffered.subarray(BLOCK);
        if (header.every((byte) => byte === 0)) return finish(null);
        const size = readOctal(header, 124, 12);
        if (!Number.isFinite(size) || size < 0) return finish(null);
        const padded = Math.ceil(size / BLOCK) * BLOCK;
        const type = String.fromCharCode(header[156] || 48);
        if (type === 'x' || type === 'L') {
          if (size > MAX_EXAMPLE_BYTES) return finish(null);
          pending = { kind: type === 'x' ? 'pax' : 'longname', size, padded };
          continue;
        }
        const prefix = readString(header, 345, 155);
        const rawName = readString(header, 0, 100);
        const name = nextName || (prefix ? `${prefix}/${rawName}` : rawName);
        nextName = null;
        const isFile = type === '0' || type === '\0';
        if (isFile && isEnvExamplePath(name) && size <= MAX_EXAMPLE_BYTES) {
          pending = { kind: 'match', size, padded };
          continue;
        }
        skip = padded;
      }
    };

    gunzip.on('data', (chunk) => {
      scanned += chunk.length;
      if (scanned > MAX_SCAN_BYTES) return finish(null);
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      consume();
    });
    gunzip.on('end', () => finish(null));
    gunzip.on('error', () => finish(null));
    source.on('error', () => finish(null));
    source.pipe(gunzip);
  });
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parses `.env.example` text into suggested keys. `#` comment lines directly
 * above a key become its description; a commented-out assignment
 * (`# KEY=value`) is listed as an optional key.
 * @param {string} text
 * @returns {{ key: string, defaultValue: string, description: string|null, optional: boolean }[]}
 */
function parseEnvExample(text) {
  const keys = [];
  const seen = new Set();
  let comments = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') {
      comments = [];
      continue;
    }
    let optional = false;
    let assignment = line;
    if (line.startsWith('#')) {
      const inner = line.replace(/^#+\s*/, '');
      const commented = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=/.exec(inner);
      if (!commented) {
        if (inner) comments.push(inner);
        continue;
      }
      optional = true;
      assignment = inner;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(assignment);
    if (!match) {
      comments = [];
      continue;
    }
    const [, key, value] = match;
    const description = comments.join(' ').slice(0, MAX_DESCRIPTION_LENGTH) || null;
    comments = [];
    if (!RUNTIME_CONFIG_KEY_PATTERN.test(key) || seen.has(key)) continue;
    seen.add(key);
    keys.push({ key, defaultValue: unquote(value).slice(0, MAX_RUNTIME_CONFIG_VALUE_LENGTH), description, optional });
    if (keys.length >= MAX_RUNTIME_CONFIG_KEYS) break;
  }
  return keys;
}

/**
 * Builds `{ [component]: { source, keys } }` for the given artifacts, or null
 * when no component ships a usable `.env.example`.
 * @param {{ component: string, file: string }[]} artifacts
 * @param {(artifact: { component: string, file: string }) => Promise<import('node:stream').Readable>} openArtifact
 */
async function buildConfigSchema(artifacts, openArtifact) {
  const schema = {};
  for (const artifact of artifacts) {
    if (schema[artifact.component]) continue;
    let text = null;
    try {
      text = await readEnvExampleFromTarGz(await openArtifact(artifact));
    } catch {
      text = null;
    }
    if (text === null) continue;
    const keys = parseEnvExample(text);
    if (keys.length > 0) schema[artifact.component] = { source: ENV_EXAMPLE_NAME, keys };
  }
  return Object.keys(schema).length > 0 ? schema : null;
}

module.exports = { readEnvExampleFromTarGz, parseEnvExample, buildConfigSchema, isEnvExamplePath };
