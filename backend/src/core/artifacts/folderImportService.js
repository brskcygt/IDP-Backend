'use strict';

/**
 * Releases from a folder on the IDP server (`config.artifactDeploy.localFolder`).
 *
 * Some projects already have a CI job that copies its finished builds to this
 * server; IDP neither triggers nor knows about those builds. A build arrives
 * either as a .tar.gz or as a plain folder the CI overwrites on every run
 * (`front-build`, `jetsrm-backend`). This lists both and turns the entries an
 * operator picks — one per component — into an ordinary local release: a
 * .tar.gz is copied into the artifact store as is, a folder is first packed
 * (its contents at the archive root, like the CI's own `tar -C <dir> .`), and
 * the manifest IDP would otherwise receive from CI is written here. From then
 * on the release no longer depends on the folder, so the CI overwriting or
 * deleting it cannot change what a target installed or break a rollback.
 *
 * Nothing in this path needs the project's repository settings: those are only
 * for builds IDP starts itself.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { normalizeArtifactDeployConfig, ARTIFACT_FILE_PATTERN, ARTIFACT_OS_VALUES, VERSION_PATTERN } = require('./contracts');
const { ValidationError, ConflictError, NotFoundError } = require('../errors');

/** Newest files first; a build folder can hold years of them. */
const MAX_LISTED_FILES = 200;
/**
 * A file this fresh may still be being copied by the CI job. Listed with a
 * flag, refused on import, so a half-written archive never becomes a release.
 */
const SETTLE_MS = 15_000;
/** A folder name usable on Windows and in a path segment; '.'/'..' are refused separately. */
const FOLDER_NAME_PATTERN = /^[^\\/:*?"<>|\u0000-\u001f]{1,255}$/;
/** `jetsrm-backend-1.4.2-rc1.tar.gz` → `1.4.2-rc1`: digits with at least one dot, then anything version-like. */
const VERSION_IN_NAME = /(\d+(?:\.\d+)+[0-9A-Za-z._-]*)$/;

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

/** The component a file name points at, when exactly one configured name appears in it as a word. */
function guessComponent(fileName, componentNames) {
  const words = new Set(fileName.toLowerCase().replace(/\.tar\.gz$/i, '').split(/[^a-z0-9]+/).filter(Boolean));
  // A whole name (`backend`, `admin-panel`) or a clear abbreviation of it: `front-build` → frontend.
  const hasPart = (part) => words.has(part) || [...words].some((word) => word.length >= 4 && part.startsWith(word));
  const matches = componentNames.filter((name) => name.split('-').every(hasPart));
  return matches.length === 1 ? matches[0] : null;
}

function guessVersion(fileName) {
  const match = fileName.replace(/\.tar\.gz$/i, '').match(VERSION_IN_NAME);
  if (!match) return null;
  const version = match[1].replace(/[._-]+$/, '');
  return VERSION_PATTERN.test(version) ? version : null;
}

/** The `version` of a package.json at the folder root, when it is a usable release version. */
async function folderVersion(dirPath) {
  try {
    const { version } = JSON.parse(await fs.promises.readFile(path.join(dirPath, 'package.json'), 'utf8'));
    return typeof version === 'string' && VERSION_PATTERN.test(version) ? version : null;
  } catch {
    return null;
  }
}

/** Newest modification time anywhere under `dirPath` (symlinks not followed). */
async function newestMtime(dirPath) {
  let newest = (await fs.promises.stat(dirPath)).mtimeMs;
  const pending = [dirPath];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      const stat = await fs.promises.stat(entryPath);
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      if (entry.isDirectory()) pending.push(entryPath);
    }
  }
  return newest;
}

/** Windows ships bsdtar in System32; elsewhere tar is on PATH. */
function tarCommand() {
  if (process.platform === 'win32') return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return 'tar';
}

/** Packs the folder's contents (not the folder itself) into `outFile`. */
function packFolder(dirPath, outFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(tarCommand(), ['-czf', outFile, '-C', dirPath, '.'], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', (err) => reject(new Error(`Could not run tar: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Packing ${path.basename(dirPath)} failed (tar exit ${code}): ${stderr.trim()}`));
    });
  });
}

/**
 * @param {object} deps
 * @param {object} deps.repository - artifactDeployRepository.
 * @param {object} deps.uploadService - artifactUploadService (store copy + finalize).
 * @param {{ log: Function }} deps.auditLogger
 * @param {(id: string) => object} deps.getProject
 * @param {() => number} [deps.now]
 */
function createFolderImportService({ repository, uploadService, auditLogger, getProject, now = () => Date.now() }) {
  function requireFolderConfig(projectId) {
    const project = getProject(projectId);
    const config = normalizeArtifactDeployConfig(project.config && project.config.artifactDeploy);
    if (!config) throw new ValidationError('Artifact deploy is not configured for this project.');
    if (!config.localFolder) {
      throw new ValidationError('No build folder is set for this project — add it under Settings → Build and source.');
    }
    if (config.components.length === 0) {
      throw new ValidationError('This project has no components — define backend/frontend under Settings → Build and source.');
    }
    return { project, config, folder: path.resolve(config.localFolder) };
  }

  async function readFolder(folder) {
    try {
      return await fs.promises.readdir(folder, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        throw new NotFoundError(`Build folder not found on the IDP server: ${folder}`);
      }
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        throw new ValidationError(`The IDP service cannot read the build folder: ${folder}`);
      }
      throw err;
    }
  }

  return {
    /**
     * The .tar.gz files in the project's build folder, newest first, with a
     * guessed component and version for the picker to start from.
     */
    async listFolder(projectId) {
      const { config, folder } = requireFolderConfig(projectId);
      const componentNames = config.components.map((component) => component.name);
      const entries = (await readFolder(folder)).filter((entry) =>
        (entry.isFile() && /\.tar\.gz$/i.test(entry.name))
        || (entry.isDirectory() && !entry.name.startsWith('.') && !/\.tar\.gz$/i.test(entry.name)));

      const files = [];
      for (const entry of entries) {
        const entryPath = path.join(folder, entry.name);
        let stat;
        try {
          stat = await fs.promises.stat(entryPath);
        } catch {
          continue; // Removed between readdir and stat.
        }
        if (entry.isDirectory()) {
          files.push({
            name: entry.name,
            kind: 'directory',
            // Measuring a folder means walking it (node_modules…); the listing stays cheap.
            size: null,
            modifiedAt: stat.mtime.toISOString(),
            component: guessComponent(entry.name, componentNames),
            version: await folderVersion(entryPath),
            settling: now() - stat.mtimeMs < SETTLE_MS,
            problem: FOLDER_NAME_PATTERN.test(entry.name) ? null : 'Folder name contains characters IDP does not accept.',
          });
          continue;
        }
        const validName = ARTIFACT_FILE_PATTERN.test(entry.name);
        files.push({
          name: entry.name,
          kind: 'file',
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          component: guessComponent(entry.name, componentNames),
          version: guessVersion(entry.name),
          settling: now() - stat.mtimeMs < SETTLE_MS,
          // Spaces or other characters the artifact store does not accept.
          problem: validName ? null : 'File name may only contain letters, digits, ".", "_" and "-".',
        });
      }
      files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
      return { folder, components: componentNames, truncated: files.length > MAX_LISTED_FILES, files: files.slice(0, MAX_LISTED_FILES) };
    },

    /**
     * Creates release `version` from picked folder files.
     * @param {{ projectId: string, version: string, files: { component: string, file: string }[], triggeredBy?: string }} input
     */
    async importFromFolder({ projectId, version, files, triggeredBy = null }) {
      const { config, folder } = requireFolderConfig(projectId);
      if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
        throw new ValidationError('Invalid version: 1-64 characters, letters, digits, ".", "_" or "-", starting with a letter or digit.');
      }
      if (!config.artifactName) {
        throw new ValidationError('Set the artifact name under Settings → Build and source first.');
      }
      if (!Array.isArray(files) || files.length === 0) throw new ValidationError('Pick at least one file.');

      const components = new Map(config.components.map((component) => [component.name, component]));
      const seenComponents = new Set();
      const seenFiles = new Set();
      for (const { component, file } of files) {
        if (!components.has(component)) throw new ValidationError(`Unknown component: ${component}.`);
        if (seenComponents.has(component)) throw new ValidationError(`Component ${component} is picked twice.`);
        // A .tar.gz by the store's own rule, otherwise a folder name — never a path.
        const validEntry = typeof file === 'string' && (ARTIFACT_FILE_PATTERN.test(file)
          || (FOLDER_NAME_PATTERN.test(file) && file !== '.' && file !== '..' && !/\.tar\.gz$/i.test(file)));
        if (!validEntry) throw new ValidationError(`Invalid file name: ${file}.`);
        if (seenFiles.has(file)) throw new ValidationError(`${file} is picked for two components.`);
        seenComponents.add(component);
        seenFiles.add(file);
      }

      const existing = repository.findReleaseByVersion(projectId, version);
      if (existing && existing.status === 'ready') throw new ConflictError(`Release ${version} already exists — pick another version.`);

      const artifacts = [];
      const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'idp-folder-release-'));
      try {
        for (const { component, file } of files) {
          // Neither name rule allows separators, so the entry cannot leave the folder.
          const entryPath = path.join(folder, file);
          let stat;
          try {
            stat = await fs.promises.stat(entryPath);
          } catch {
            throw new NotFoundError(`${file} is no longer in the build folder.`);
          }

          let source = entryPath;
          let storedName = file;
          if (stat.isDirectory()) {
            // A folder changes file by file while the CI copies into it, and its
            // own mtime only notices entries added or removed directly in it.
            if (now() - (await newestMtime(entryPath)) < SETTLE_MS) {
              throw new ConflictError(`${file} changed in the last few seconds and may still be being copied — try again shortly.`);
            }
            storedName = `${config.artifactName}-${component}-${version}.tar.gz`;
            if (!ARTIFACT_FILE_PATTERN.test(storedName)) throw new ValidationError(`Cannot name the package for ${file}: ${storedName}.`);
            source = path.join(scratch, storedName);
            await packFolder(entryPath, source);
          } else if (stat.isFile()) {
            if (!ARTIFACT_FILE_PATTERN.test(file)) throw new ValidationError(`Invalid file name: ${file}.`);
            if (now() - stat.mtimeMs < SETTLE_MS) {
              throw new ConflictError(`${file} changed in the last few seconds and may still be being copied — try again shortly.`);
            }
          } else {
            throw new ValidationError(`${file} is neither a file nor a folder.`);
          }
          if (artifacts.some((artifact) => artifact.file === storedName)) {
            throw new ValidationError(`Two picks would both be stored as ${storedName}.`);
          }

          const { sha256, size } = await hashFile(source);
          // The store re-hashes while copying, so a file the CI replaces in the
          // meantime fails here instead of becoming a release that lies about its content.
          await uploadService.uploadArtifact({
            projectId,
            version,
            fileName: storedName,
            stream: fs.createReadStream(source),
            sha256,
            contentLength: size,
          });
          const componentOs = components.get(component).os;
          artifacts.push({ component, os: ARTIFACT_OS_VALUES.includes(componentOs) ? componentOs : 'any', file: storedName, sha256, size, picked: file });
        }
      } finally {
        await fs.promises.rm(scratch, { recursive: true, force: true });
      }

      const release = await uploadService.finalizeRelease({
        projectId,
        version,
        manifest: {
          schema: 1,
          project: config.artifactName,
          version,
          createdAt: new Date(now()).toISOString(),
          artifacts: artifacts.map(({ picked: _picked, ...artifact }) => artifact),
        },
        createdBy: triggeredBy || 'build-folder',
      });
      auditLogger.log(triggeredBy, 'RELEASE_IMPORTED_FROM_FOLDER', `Release ${version} created from the build folder`, {
        projectId,
        releaseId: release.id,
        version,
        files: artifacts.map(({ component, picked }) => `${component}:${picked}`),
      });
      return release;
    },
  };
}

module.exports = { createFolderImportService, guessComponent, guessVersion, SETTLE_MS };
