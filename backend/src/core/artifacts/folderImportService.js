'use strict';

/**
 * Releases from a folder on the IDP server (`config.artifactDeploy.localFolder`).
 *
 * Some projects already have a CI job that copies its finished .tar.gz files to
 * this server; IDP neither triggers nor knows about those builds. This lists
 * the folder and turns the files an operator picks — one per component — into
 * an ordinary local release: each file is copied into the artifact store with
 * its sha256, and the manifest IDP would otherwise receive from CI is written
 * here. From then on the release no longer depends on the folder, so the CI
 * overwriting or deleting the file cannot change what a target installed or
 * break a rollback.
 *
 * Nothing in this path needs the project's repository settings: those are only
 * for builds IDP starts itself.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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
  const matches = componentNames.filter((name) => name.split('-').every((part) => words.has(part)));
  return matches.length === 1 ? matches[0] : null;
}

function guessVersion(fileName) {
  const match = fileName.replace(/\.tar\.gz$/i, '').match(VERSION_IN_NAME);
  if (!match) return null;
  const version = match[1].replace(/[._-]+$/, '');
  return VERSION_PATTERN.test(version) ? version : null;
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
      const entries = (await readFolder(folder)).filter((entry) => entry.isFile() && /\.tar\.gz$/i.test(entry.name));

      const files = [];
      for (const entry of entries) {
        let stat;
        try {
          stat = await fs.promises.stat(path.join(folder, entry.name));
        } catch {
          continue; // Removed between readdir and stat.
        }
        const validName = ARTIFACT_FILE_PATTERN.test(entry.name);
        files.push({
          name: entry.name,
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
        if (typeof file !== 'string' || !ARTIFACT_FILE_PATTERN.test(file)) throw new ValidationError(`Invalid file name: ${file}.`);
        if (seenFiles.has(file)) throw new ValidationError(`${file} is picked for two components.`);
        seenComponents.add(component);
        seenFiles.add(file);
      }

      const existing = repository.findReleaseByVersion(projectId, version);
      if (existing && existing.status === 'ready') throw new ConflictError(`Release ${version} already exists — pick another version.`);

      const artifacts = [];
      for (const { component, file } of files) {
        // The name pattern has no separators, so the file cannot leave the folder.
        const filePath = path.join(folder, file);
        let stat;
        try {
          stat = await fs.promises.stat(filePath);
        } catch {
          throw new NotFoundError(`${file} is no longer in the build folder.`);
        }
        if (!stat.isFile()) throw new ValidationError(`${file} is not a file.`);
        if (now() - stat.mtimeMs < SETTLE_MS) {
          throw new ConflictError(`${file} changed in the last few seconds and may still be being copied — try again shortly.`);
        }
        const { sha256, size } = await hashFile(filePath);
        // The store re-hashes while copying, so a file the CI replaces in the
        // meantime fails here instead of becoming a release that lies about its content.
        await uploadService.uploadArtifact({
          projectId,
          version,
          fileName: file,
          stream: fs.createReadStream(filePath),
          sha256,
          contentLength: size,
        });
        const os = components.get(component).os;
        artifacts.push({ component, os: ARTIFACT_OS_VALUES.includes(os) ? os : 'any', file, sha256, size });
      }

      const release = await uploadService.finalizeRelease({
        projectId,
        version,
        manifest: { schema: 1, project: config.artifactName, version, createdAt: new Date(now()).toISOString(), artifacts },
        createdBy: triggeredBy || 'build-folder',
      });
      auditLogger.log(triggeredBy, 'RELEASE_IMPORTED_FROM_FOLDER', `Release ${version} created from the build folder`, {
        projectId,
        releaseId: release.id,
        version,
        files: artifacts.map(({ component, file }) => `${component}:${file}`),
      });
      return release;
    },
  };
}

module.exports = { createFolderImportService, guessComponent, guessVersion, SETTLE_MS };
