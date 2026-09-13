'use strict';

/** Provider-independent, immutable local artifact storage. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { ARTIFACT_FILE_PATTERN, SHA256_PATTERN, VERSION_PATTERN } = require('./contracts');
const { ValidationError, ConflictError, NotFoundError } = require('../errors');

const MANIFEST_FILE = 'manifest.json';
const DEFAULT_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function projectKey(projectId) {
  return crypto.createHash('sha256').update(String(projectId)).digest('hex').slice(0, 32);
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  const sink = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback();
    },
  });
  sink.resume();
  await pipeline(fs.createReadStream(filePath), sink);
  return { sha256: hash.digest('hex'), size };
}

function createLocalArtifactStore({ root, maxArtifactBytes }) {
  if (!path.isAbsolute(root)) throw new Error('Artifact storage root must be absolute.');
  if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes <= 0) throw new Error('Artifact max size must be a positive safe integer.');

  const stagingRoot = path.join(root, '.staging');
  const releasesRoot = path.join(root, 'releases');
  const stagingDir = (projectId, version) => path.join(stagingRoot, projectKey(projectId), version);
  const releaseDir = (projectId, version) => path.join(releasesRoot, projectKey(projectId), version);

  function validateLocation(version, fileName) {
    if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) throw new ValidationError('Invalid artifact version.');
    if (typeof fileName !== 'string' || !ARTIFACT_FILE_PATTERN.test(fileName)) {
      throw new ValidationError('Invalid artifact file name; a plain .tar.gz file name is required.');
    }
  }

  async function upload({ projectId, version, fileName, stream, expectedSha256, contentLength }) {
    validateLocation(version, fileName);
    if (!SHA256_PATTERN.test(String(expectedSha256 || ''))) {
      throw new ValidationError('X-Artifact-Sha256 must be a lowercase SHA-256 digest.');
    }
    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
      throw new ValidationError('Content-Length must be a non-negative integer.');
    }
    if (contentLength !== null && contentLength > maxArtifactBytes) {
      const err = new ValidationError(`Artifact exceeds the ${maxArtifactBytes} byte upload limit.`);
      err.code = 'ARTIFACT_TOO_LARGE';
      throw err;
    }

    const dir = stagingDir(projectId, version);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const finalPath = path.join(dir, fileName);
    const tempPath = path.join(dir, `.${fileName}.${crypto.randomBytes(12).toString('hex')}.tmp`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const verifier = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > maxArtifactBytes) {
          const err = new ValidationError(`Artifact exceeds the ${maxArtifactBytes} byte upload limit.`);
          err.code = 'ARTIFACT_TOO_LARGE';
          callback(err);
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(stream, verifier, fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
      const actualSha256 = hash.digest('hex');
      if (contentLength !== null && size !== contentLength) throw new ValidationError(`Artifact body size ${size} does not match Content-Length ${contentLength}.`);
      if (actualSha256 !== expectedSha256) throw new ValidationError('Artifact SHA-256 does not match X-Artifact-Sha256.');
      // link() is an atomic create-if-absent on the same filesystem. rename()
      // would overwrite an existing file on POSIX and break release immutability
      // when two CI jobs upload the same version concurrently.
      try {
        await fs.promises.link(tempPath, finalPath);
        await fs.promises.rm(tempPath, { force: true });
        return { fileName, sha256: actualSha256, size, staged: true, idempotent: false };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const existing = await fs.promises.lstat(finalPath);
        if (!existing.isFile() || existing.isSymbolicLink()) {
          throw new ConflictError('A non-regular staged artifact already uses this name.');
        }
        const digest = await hashFile(finalPath);
        if (digest.sha256 === actualSha256 && digest.size === size) {
          await fs.promises.rm(tempPath, { force: true });
          return { fileName, ...digest, staged: true, idempotent: true };
        }
        throw new ConflictError('A different staged artifact already uses this file name and version.');
      }
    } catch (err) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  async function verifyDirectory(dir, manifest) {
    const expectedNames = new Set(manifest.artifacts.map((artifact) => artifact.file));
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') throw new NotFoundError('No staged artifacts exist for this project and version.');
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name.endsWith('.tmp')) continue;
      if (entry.name === MANIFEST_FILE) continue;
      if (!entry.isFile() || !expectedNames.has(entry.name)) throw new ValidationError(`Unexpected staged artifact: ${entry.name}.`);
    }
    for (const artifact of manifest.artifacts) {
      const filePath = path.join(dir, artifact.file);
      let stat;
      try {
        stat = await fs.promises.lstat(filePath);
      } catch (err) {
        if (err.code === 'ENOENT') throw new ValidationError(`Manifest artifact is missing: ${artifact.file}.`);
        throw err;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ValidationError(`Manifest artifact is not a regular file: ${artifact.file}.`);
      const actual = await hashFile(filePath);
      if (actual.size !== artifact.size || actual.sha256 !== artifact.sha256) {
        throw new ValidationError(`Manifest verification failed for ${artifact.file}.`);
      }
    }
  }

  async function finalize({ projectId, version, manifest }) {
    const staged = stagingDir(projectId, version);
    const published = releaseDir(projectId, version);
    try {
      const existing = JSON.parse(await fs.promises.readFile(path.join(published, MANIFEST_FILE), 'utf8'));
      if (JSON.stringify(existing) !== JSON.stringify(manifest)) throw new ConflictError('This version was already published with a different manifest.');
      await verifyDirectory(published, manifest);
      await fs.promises.rm(staged, { recursive: true, force: true });
      return { directory: published, idempotent: true };
    } catch (err) {
      if (err instanceof ConflictError || err instanceof ValidationError) throw err;
      if (err.code !== 'ENOENT') throw err;
    }

    await verifyDirectory(staged, manifest);
    const manifestTemp = path.join(staged, `.${MANIFEST_FILE}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    await fs.promises.writeFile(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(manifestTemp, path.join(staged, MANIFEST_FILE));
    await fs.promises.mkdir(path.dirname(published), { recursive: true, mode: 0o700 });
    try {
      await fs.promises.rename(staged, published);
    } catch (err) {
      if (err.code === 'EEXIST' || err.code === 'ENOTEMPTY') throw new ConflictError('This version was published concurrently. Retry finalization.');
      throw err;
    }
    return { directory: published, idempotent: false };
  }

  async function open({ artifact, release }) {
    validateLocation(release.version, artifact.fileName);
    const filePath = path.join(releaseDir(release.projectId, release.version), artifact.fileName);
    let stat;
    try {
      stat = await fs.promises.lstat(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') throw new NotFoundError('The local artifact file is missing.');
      throw err;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new NotFoundError('The local artifact file is unavailable.');
    return { stream: fs.createReadStream(filePath), contentLength: stat.size };
  }

  function removeReleaseSync(projectId, version) {
    if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) throw new ValidationError('Invalid artifact version.');
    fs.rmSync(releaseDir(projectId, version), { recursive: true, force: true });
    fs.rmSync(stagingDir(projectId, version), { recursive: true, force: true });
  }

  /** Removes abandoned, unpublished upload directories on process startup. */
  function cleanupStagingSync(maxAgeMs = DEFAULT_STAGING_MAX_AGE_MS, now = Date.now()) {
    let removed = 0;
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new Error('Staging max age must be positive.');
    let projects = [];
    try { projects = fs.readdirSync(stagingRoot, { withFileTypes: true }); } catch (err) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }
    for (const project of projects) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      const projectDir = path.join(stagingRoot, project.name);
      for (const version of fs.readdirSync(projectDir, { withFileTypes: true })) {
        if (!version.isDirectory() || version.isSymbolicLink()) continue;
        const candidate = path.join(projectDir, version.name);
        if (now - fs.statSync(candidate).mtimeMs < maxAgeMs) continue;
        fs.rmSync(candidate, { recursive: true, force: true });
        removed += 1;
      }
      if (fs.readdirSync(projectDir).length === 0) fs.rmdirSync(projectDir);
    }
    return removed;
  }

  return { root, maxArtifactBytes, upload, finalize, open, removeReleaseSync, cleanupStagingSync, projectKey };
}

module.exports = { createLocalArtifactStore, projectKey };
