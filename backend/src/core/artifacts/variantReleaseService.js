'use strict';

/**
 * A release made from a build, one package per variant (a frontend per customer).
 *
 * CI uploads ONE package for a frontend that serves several customers: the
 * whole build plus `idp-variants.json`, which lists for each customer
 * component the files to delete and the files to write (the customer's brand
 * choice). The build is a "build" in the UI, never installed as it is. When an
 * operator makes a release from it, this service unpacks the build once and
 * produces each customer's package from it — copy, delete, write, pack — so a
 * customer's package never contains another customer's files, and every
 * package of the release comes from exactly the same build.
 *
 * The manifest of the build names the components it can produce
 * (`artifacts[].derives`); the variants file may not name any other.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { normalizeArtifactDeployConfig, ARTIFACT_FILE_PATTERN, ARTIFACT_OS_VALUES, COMPONENT_NAME_PATTERN, VERSION_PATTERN } = require('./contracts');
const { ValidationError, ConflictError, NotFoundError } = require('../errors');
const { hashFile, packFolder, tarCommand } = require('./folderImportService');
const { spawn } = require('node:child_process');

const VARIANTS_FILE = 'idp-variants.json';

/** A derived package's os: the component's pinned os when it has one (a pinned component never falls back to 'any'), else the source's. */
function derivedOs(config, componentName, source) {
  const pinned = (config.components ?? []).find((component) => component.name === componentName)?.os;
  if (pinned && pinned !== 'any' && ARTIFACT_OS_VALUES.includes(pinned)) return pinned;
  return ARTIFACT_OS_VALUES.includes(source.os) ? source.os : 'any';
}
const MAX_VARIANTS = 50;
const MAX_VARIANTS_BYTES = 8 * 1024 * 1024;
const MAX_WRITTEN_BYTES = 256 * 1024;

/** A path inside the package: relative, forward slashes, no `..`, no drive letter. */
function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 400) return false;
  if (value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value) || value.includes('\u0000')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Resolves `relative` under `root`; refuses anything that would leave it. */
function insideRoot(root, relative) {
  const full = path.resolve(root, ...relative.split('/'));
  if (full !== root && !full.startsWith(root + path.sep)) throw new ValidationError(`Path leaves the package: ${relative}.`);
  return full;
}

function extractTar(archive, destination) {
  return new Promise((resolve, reject) => {
    const child = spawn(tarCommand(), ['-xzf', archive, '-C', destination], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', (err) => reject(new Error(`Could not run tar: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking the build failed (tar exit ${code}): ${stderr.trim()}`))));
  });
}

/** Parses and checks `idp-variants.json`; returns the variants. */
function parseVariants(text, allowedComponents) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError(`${VARIANTS_FILE} is not valid JSON.`);
  }
  if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.variants) || parsed.variants.length === 0 || parsed.variants.length > MAX_VARIANTS) {
    throw new ValidationError(`${VARIANTS_FILE} must be {"schema":1,"variants":[...]} with 1-${MAX_VARIANTS} entries.`);
  }
  const seen = new Set();
  return parsed.variants.map((variant, index) => {
    const at = `${VARIANTS_FILE} variants[${index}]`;
    if (!variant || typeof variant.component !== 'string' || !COMPONENT_NAME_PATTERN.test(variant.component)) {
      throw new ValidationError(`${at} has an invalid component.`);
    }
    if (!allowedComponents.has(variant.component)) throw new ValidationError(`${at}: ${variant.component} is not among the components this build derives.`);
    if (seen.has(variant.component)) throw new ValidationError(`${at}: ${variant.component} is listed twice.`);
    seen.add(variant.component);
    const remove = variant.remove === undefined ? [] : variant.remove;
    if (!Array.isArray(remove) || remove.some((entry) => !isSafeRelativePath(entry))) throw new ValidationError(`${at}.remove must be a list of relative paths.`);
    const write = variant.write === undefined ? {} : variant.write;
    if (!write || typeof write !== 'object' || Array.isArray(write)) throw new ValidationError(`${at}.write must be an object of path → text.`);
    for (const [file, content] of Object.entries(write)) {
      if (!isSafeRelativePath(file) || typeof content !== 'string' || Buffer.byteLength(content) > MAX_WRITTEN_BYTES) {
        throw new ValidationError(`${at}.write has an invalid entry: ${file}.`);
      }
    }
    return { component: variant.component, remove, write };
  });
}

/**
 * @param {object} deps
 * @param {object} deps.repository
 * @param {object} deps.uploadService - uploadArtifact + finalizeRelease.
 * @param {(artifact: object, release: object) => Promise<{ stream: import('stream').Readable }>} deps.openArtifact
 * @param {{ log: Function }} deps.auditLogger
 * @param {(id: string) => object} deps.getProject
 * @param {() => number} [deps.now]
 */
function createVariantReleaseService({ repository, uploadService, openArtifact, auditLogger, getProject, now = () => Date.now() }) {
  return {
    /**
     * Creates release `version` with one package per component the build derives.
     * @param {{ projectId: string, buildReleaseId: string, version: string, triggeredBy?: string,
     *   onProgress?: (state: { percent: number, phase: string, component?: string, index?: number, total?: number }) => void }} input
     */
    async createFromBuild({ projectId, buildReleaseId, version, triggeredBy = null, onProgress = () => {} }) {
      const report = (percent, phase, extra = {}) => {
        try { onProgress({ percent: Math.min(99, Math.max(0, Math.round(percent))), phase, ...extra }); } catch { /* progress is best effort */ }
      };
      if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
        throw new ValidationError('Invalid version: 1-64 characters, letters, digits, ".", "_" or "-", starting with a letter or digit.');
      }
      const project = getProject(projectId);
      const config = normalizeArtifactDeployConfig(project.config && project.config.artifactDeploy);
      if (!config || !config.artifactName) throw new ValidationError('Set the artifact name under Settings → Build and source first.');

      const build = repository.findRelease(buildReleaseId);
      if (!build || build.projectId !== projectId) throw new NotFoundError('Build not found.');
      if (build.status !== 'ready') throw new ConflictError('This build is not ready.');
      const source = (build.manifest?.artifacts ?? []).find((artifact) => Array.isArray(artifact.derives) && artifact.derives.length > 0);
      if (!source) throw new ValidationError('Packages cannot be made from this build: it names no components to derive.');

      const existing = repository.findReleaseByVersion(projectId, version);
      if (existing && existing.status === 'ready') throw new ConflictError(`Release ${version} already exists — pick another version.`);

      const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'idp-variant-release-'));
      const artifacts = [];
      try {
        // The build's own package, checked against the hash CI declared before anything is made from it.
        report(2, 'reading');
        const archive = path.join(scratch, 'build.tar.gz');
        const opened = await openArtifact({ ...source, fileName: source.file }, build);
        await pipeline(opened.stream, fs.createWriteStream(archive));
        const { sha256 } = await hashFile(archive);
        if (sha256 !== source.sha256) throw new ConflictError('The stored build does not match its manifest (sha256).');
        report(10, 'unpacking');

        const base = path.join(scratch, 'base');
        await fs.promises.mkdir(base);
        await extractTar(archive, base);
        report(20, 'unpacking');
        const variantsPath = path.join(base, VARIANTS_FILE);
        const stat = await fs.promises.stat(variantsPath).catch(() => null);
        if (!stat || !stat.isFile()) throw new ValidationError(`The build has no ${VARIANTS_FILE}.`);
        if (stat.size > MAX_VARIANTS_BYTES) throw new ValidationError(`${VARIANTS_FILE} is too large.`);
        const variants = parseVariants(await fs.promises.readFile(variantsPath, 'utf8'), new Set(source.derives));
        await fs.promises.rm(variantsPath);

        // 20% is spent reading the build; the packages share 20..95, five steps each.
        const total = variants.length;
        const at = (position, step) => 20 + ((position - 1 + step / 5) / total) * 75;
        let index = 0;
        for (const variant of variants) {
          index += 1;
          const where = { component: variant.component, index, total };
          report(at(index, 0), 'package', where);
          const storedName = `${config.artifactName}-${variant.component}-${version}.tar.gz`;
          if (!ARTIFACT_FILE_PATTERN.test(storedName)) throw new ValidationError(`Cannot name the package for ${variant.component}: ${storedName}.`);
          const directory = path.join(scratch, `variant-${index}`);
          await fs.promises.cp(base, directory, { recursive: true });
          report(at(index, 1), 'package', where);
          for (const relative of variant.remove) await fs.promises.rm(insideRoot(directory, relative), { force: true });
          for (const [relative, content] of Object.entries(variant.write)) {
            const target = insideRoot(directory, relative);
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            await fs.promises.writeFile(target, content);
          }
          report(at(index, 2), 'package', where);
          const packed = path.join(scratch, `out-${index}.tar.gz`);
          await packFolder(directory, packed);
          await fs.promises.rm(directory, { recursive: true, force: true });
          report(at(index, 3), 'package', where);

          const digest = await hashFile(packed);
          await uploadService.uploadArtifact({
            projectId,
            version,
            fileName: storedName,
            stream: fs.createReadStream(packed),
            sha256: digest.sha256,
            contentLength: digest.size,
          });
          await fs.promises.rm(packed, { force: true });
          report(at(index, 5), 'package', where);
          artifacts.push({
            component: variant.component,
            os: derivedOs(config, variant.component, source),
            file: storedName,
            sha256: digest.sha256,
            size: digest.size,
          });
        }
      } finally {
        await fs.promises.rm(scratch, { recursive: true, force: true });
      }

      report(96, 'finalizing');
      const release = await uploadService.finalizeRelease({
        projectId,
        version,
        manifest: {
          schema: 1,
          project: config.artifactName,
          version,
          ...(build.commitSha ? { commit: build.commitSha } : {}),
          createdAt: new Date(now()).toISOString(),
          artifacts,
        },
        createdBy: triggeredBy || 'build-variants',
      });
      auditLogger.log(triggeredBy, 'RELEASE_CREATED_FROM_BUILD', `Release ${version} created from build ${build.version}`, {
        projectId,
        releaseId: release.id,
        version,
        buildReleaseId: build.id,
        buildVersion: build.version,
        components: artifacts.map((artifact) => artifact.component),
      });
      return release;
    },
  };
}

module.exports = { createVariantReleaseService, parseVariants, isSafeRelativePath, VARIANTS_FILE };
