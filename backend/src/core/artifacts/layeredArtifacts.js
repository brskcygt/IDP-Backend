'use strict';

/**
 * A component package with one layer merged in (docs/ARTIFACT-DEPLOY.md,
 * "Brand layer").
 *
 * One frontend build ships every customer's brand as its own layer artifact
 * (component `brand`, variant `koksan`, ...). A target must receive only its
 * own: so the agent is not sent the package and a layer separately — it would
 * swap the component directory and lose the layer — but ONE tarball, built
 * here: the package's entries, then the layer's entries (all under `dir/`),
 * then the end-of-archive marker. The agent is unchanged; it sees an ordinary
 * package that happens to contain `brand/`.
 *
 * The merge copies tar entries byte for byte — no header is rewritten — so
 * the layer tarball must already be rooted at `dir/` (`./brand/brand.js`).
 * Everything else in it is refused, so a layer can never overwrite the
 * package's own files. The package's own `dir/` entries, if any, are dropped:
 * the layer owns that folder.
 *
 * Merged files are cached under `<root>/layered/`, named by the hash of
 * (package sha256, layer sha256, dir): the deploy payload needs the merged
 * sha256 and size before the agent downloads it.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { isSafeSubdir } = require('./contracts');
const { ValidationError } = require('../errors');

const BLOCK = 512;
const END_OF_ARCHIVE = Buffer.alloc(BLOCK * 2);
/** Merged files kept in the cache; older ones are deleted. */
const KEEP_MERGED = 30;
const MAX_LAYER_ENTRIES = 20000;
/** Largest single tar entry body held in memory while copying. */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const FILE_TYPES = new Set(['0', '\0', '7']);
const DIRECTORY_TYPE = '5';
/** Headers that describe the next entry: PAX extended, GNU long name / long link. */
const PREFIX_TYPES = new Set(['x', 'L', 'K']);

/** Reads exact byte counts from an async-iterable byte stream. */
function createByteReader(stream) {
  const iterator = stream[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  let done = false;
  return {
    /** @returns {Promise<Buffer>} exactly `size` bytes, fewer only at the end of the stream. */
    async read(size) {
      while (buffered.length < size && !done) {
        const next = await iterator.next();
        if (next.done) done = true;
        else buffered = buffered.length === 0 ? Buffer.from(next.value) : Buffer.concat([buffered, next.value]);
      }
      const chunk = buffered.subarray(0, size);
      buffered = buffered.subarray(chunk.length);
      return chunk;
    },
    async close() {
      if (typeof iterator.return === 'function') await iterator.return();
    },
  };
}

function readString(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

/** Entry size: octal, or GNU base-256 when the high bit is set. */
function entrySize(header) {
  if (header[124] & 0x80) {
    let size = 0;
    for (let index = 125; index < 136; index += 1) size = size * 256 + header[index];
    return size;
  }
  const text = readString(header, 124, 12).trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

function isZeroBlock(block) {
  for (let index = 0; index < block.length; index += 1) if (block[index] !== 0) return false;
  return true;
}

function ustarName(header) {
  const name = readString(header, 0, 100);
  const isUstar = readString(header, 257, 6).startsWith('ustar');
  const prefix = isUstar ? readString(header, 345, 155) : '';
  return prefix ? `${prefix}/${name}` : name;
}

function paxPath(body) {
  const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
  return match ? match[1] : null;
}

/**
 * Yields each entry with every raw byte that belongs to it (preceding PAX /
 * GNU long-name headers, its header, its padded body), until the
 * end-of-archive marker or the end of the stream.
 * @returns {AsyncGenerator<{ raw: Buffer[], name: string, type: string }>}
 */
async function* tarEntries(reader, label) {
  let raw = [];
  let longName = null;
  let pax = null;
  for (;;) {
    const header = await reader.read(BLOCK);
    if (header.length === 0 && raw.length === 0) return;
    if (header.length < BLOCK) throw new ValidationError(`${label} is not a complete tar archive.`);
    if (isZeroBlock(header)) return;
    const size = entrySize(header);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES) {
      throw new ValidationError(`${label} has a tar entry that is too large or malformed.`);
    }
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const body = await reader.read(padded);
    if (body.length < padded) throw new ValidationError(`${label} is not a complete tar archive.`);
    const type = String.fromCharCode(header[156]);
    raw.push(header, body);
    if (type === 'x') {
      pax = paxPath(body.subarray(0, size)) ?? pax;
      continue;
    }
    if (type === 'L') {
      longName = readString(body, 0, size);
      continue;
    }
    if (PREFIX_TYPES.has(type)) continue;
    yield { raw, name: pax ?? longName ?? ustarName(header), type };
    raw = [];
    longName = null;
    pax = null;
  }
}

/** `./brand/a.js` → ['brand', 'a.js']; null for a path that leaves the archive root. */
function pathSegments(name) {
  const segments = name.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.');
  if (/^[A-Za-z]:/.test(name) || name.startsWith('/') || segments.includes('..')) return null;
  return segments;
}

function openGunzip(stream) {
  const gunzip = zlib.createGunzip();
  stream.on('error', (err) => gunzip.destroy(err));
  stream.pipe(gunzip);
  return gunzip;
}

/**
 * The uncompressed tar of `package + layer`, as a sequence of buffers. Each
 * source is opened only when its turn comes (a remote stream must not idle).
 * @param {{ openBase: () => Promise<import('node:stream').Readable>, openLayer: () => Promise<import('node:stream').Readable>, dir: string }} sources
 */
async function* mergedTar({ openBase, openLayer, dir }) {
  const baseReader = createByteReader(openGunzip(await openBase()));
  try {
    for await (const entry of tarEntries(baseReader, 'The package')) {
      const segments = pathSegments(entry.name);
      if (segments && segments[0] === dir) continue; // the layer owns dir/
      yield* entry.raw;
    }
  } finally {
    await baseReader.close();
  }

  const layerReader = createByteReader(openGunzip(await openLayer()));
  let count = 0;
  try {
    for await (const entry of tarEntries(layerReader, 'The layer')) {
      count += 1;
      if (count > MAX_LAYER_ENTRIES) throw new ValidationError(`The layer has more than ${MAX_LAYER_ENTRIES} entries.`);
      const segments = pathSegments(entry.name);
      if (segments === null) throw new ValidationError(`The layer has an entry outside its folder: ${entry.name.slice(0, 200)}`);
      // The archive root itself (`./`): the package already has it.
      if (segments.length === 0 && entry.type === DIRECTORY_TYPE) continue;
      if (segments[0] !== dir) {
        throw new ValidationError(`The layer may only contain ${dir}/; it has ${entry.name.slice(0, 200)}.`);
      }
      if (!FILE_TYPES.has(entry.type) && entry.type !== DIRECTORY_TYPE) {
        throw new ValidationError(`The layer has an unsupported entry type '${entry.type}': ${entry.name.slice(0, 200)}`);
      }
      yield* entry.raw;
    }
  } finally {
    await layerReader.close();
  }
  yield END_OF_ARCHIVE;
}

/**
 * @param {object} deps
 * @param {string} deps.root - artifact storage root; merged files go to `<root>/layered/`.
 * @param {(artifact: object, release: object) => Promise<{ stream: import('node:stream').Readable }>} deps.openArtifact
 * @param {number} [deps.keep]
 */
function createLayeredArtifacts({ root, openArtifact, keep = KEEP_MERGED }) {
  const cacheDir = path.join(root, 'layered');
  const inFlight = new Map();

  const cacheKey = (base, layer, dir) => crypto.createHash('sha256').update(`${base.sha256}:${layer.sha256}:${dir}`).digest('hex');
  const fileFor = (key) => path.join(cacheDir, `${key}.tar.gz`);
  const metaFor = (key) => path.join(cacheDir, `${key}.json`);

  async function readCached(key) {
    try {
      const meta = JSON.parse(await fs.promises.readFile(metaFor(key), 'utf8'));
      const stat = await fs.promises.stat(fileFor(key));
      if (stat.size !== meta.size) return null;
      const now = new Date();
      await fs.promises.utimes(metaFor(key), now, now).catch(() => {});
      return { key, file: fileFor(key), sha256: meta.sha256, size: meta.size };
    } catch {
      return null;
    }
  }

  async function prune() {
    let entries;
    try {
      entries = await fs.promises.readdir(cacheDir);
    } catch {
      return;
    }
    const metas = await Promise.all(entries.filter((name) => name.endsWith('.json')).map(async (name) => {
      try {
        return { key: name.slice(0, -5), mtime: (await fs.promises.stat(path.join(cacheDir, name))).mtimeMs };
      } catch {
        return null;
      }
    }));
    const sorted = metas.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
    for (const old of sorted.slice(keep)) {
      await fs.promises.rm(fileFor(old.key), { force: true }).catch(() => {});
      await fs.promises.rm(metaFor(old.key), { force: true }).catch(() => {});
    }
  }

  async function build({ release, base, layer, dir, key }) {
    await fs.promises.mkdir(cacheDir, { recursive: true });
    const temp = path.join(cacheDir, `.tmp-${key}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const opened = [];
    const open = (artifact) => async () => {
      const source = await openArtifact(artifact, release);
      opened.push(source.stream);
      return source.stream;
    };
    try {
      const gzip = zlib.createGzip({ level: 6 });
      gzip.on('data', (chunk) => {
        hash.update(chunk);
        size += chunk.length;
      });
      await pipeline(Readable.from(mergedTar({ openBase: open(base), openLayer: open(layer), dir })), gzip, fs.createWriteStream(temp));
      const sha256 = hash.digest('hex');
      await fs.promises.rename(temp, fileFor(key));
      await fs.promises.writeFile(metaFor(key), JSON.stringify({ sha256, size, base: base.id, layer: layer.id, dir }));
      await prune();
      return { key, file: fileFor(key), sha256, size };
    } catch (err) {
      for (const stream of opened) stream.destroy();
      await fs.promises.rm(temp, { force: true }).catch(() => {});
      throw err;
    }
  }

  return {
    /**
     * The merged tarball for (base, layer, dir), built on first use.
     * @returns {Promise<{ key: string, file: string, sha256: string, size: number }>}
     */
    async ensure({ release, base, layer, dir }) {
      if (!isSafeSubdir(dir)) throw new ValidationError(`Invalid layer folder '${dir}'.`);
      if (!layer.variant || base.releaseId !== layer.releaseId) throw new ValidationError('The layer is not part of this release.');
      const key = cacheKey(base, layer, dir);
      const cached = await readCached(key);
      if (cached) return cached;
      if (!inFlight.has(key)) {
        inFlight.set(key, build({ release, base, layer, dir, key }).finally(() => inFlight.delete(key)));
      }
      return inFlight.get(key);
    },

    /** Opens the merged tarball for download (rebuilt if it was pruned). */
    async open({ release, base, layer, dir }) {
      const merged = await this.ensure({ release, base, layer, dir });
      return {
        stream: fs.createReadStream(merged.file),
        contentLength: merged.size,
        sha256: merged.sha256,
        size: merged.size,
        fileName: base.fileName.replace(/\.tar\.gz$/, `+${dir}-${layer.variant}.tar.gz`),
      };
    },
  };
}

module.exports = { createLayeredArtifacts, mergedTar, tarEntries, createByteReader };
