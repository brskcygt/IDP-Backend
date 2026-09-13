'use strict';

/**
 * Artifact source clients: where release artifacts + manifests live.
 *
 *   Bitbucket Downloads  GET {base}/repositories/{ws}/{repo}/downloads/{file}   (302 → storage)
 *   GitHub Releases      GET {base}/repos/{o}/{r}/releases/assets/{assetId}      (Accept: application/octet-stream, 302 → storage)
 *
 * Both expose the same interface:
 *   fetchManifest({ artifactName, version }) → { manifest, manifestRef, context }
 *   resolveArtifacts(artifacts, context)     → artifacts + `sourceRef` (Bitbucket file name / GitHub asset id)
 *   openArtifactStream(sourceRef, { signal }) → { stream: Readable, contentLength: number|null }
 *   releaseCredentials()
 *
 * Redirects are followed MANUALLY: the repository token is sent only to the
 * configured API origin, never to the storage host a 302 points at (those
 * URLs are pre-signed). Only https is ever contacted. Error messages never
 * contain URLs (signed redirect targets) and are scrubbed of the token.
 * Artifact bodies are streamed, never buffered.
 */

const { Readable } = require('node:stream');
const { fetch: undiciFetch } = require('undici');
const { createCiScrubber } = require('../../adapters/ci');
const { toHttpError, drain } = require('../../adapters/ci/http');
const { UpstreamError } = require('../errors');
const { DEFAULT_SOURCE_BASE_URLS, manifestFileName } = require('./contracts');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_LIST_PAGES = 20;
const USER_AGENT = 'IDP-Artifact-Deploy';
const enc = encodeURIComponent;

class ArtifactSourceError extends UpstreamError {
  /**
   * @param {string} message
   * @param {{ status?: number, notFound?: boolean, transient?: boolean, aborted?: boolean }} [info]
   */
  constructor(message, { status = 0, notFound = false, transient = false, aborted = false } = {}) {
    super(message);
    this.name = 'ArtifactSourceError';
    this.status = status;
    this.notFound = notFound;
    this.transient = transient;
    this.aborted = aborted;
  }
}

async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

class SourceClientBase {
  constructor({ baseUrl, authorization, apiHeaders, fetchImpl, requestTimeoutMs, scrub }) {
    this._baseUrl = baseUrl;
    this._apiOrigin = new URL(baseUrl).origin;
    this._authorization = authorization;
    this._apiHeaders = apiHeaders;
    this._fetch = fetchImpl;
    this._timeoutMs = requestTimeoutMs;
    this._scrub = scrub;
  }

  /** Drops the credential; any later request fails fast. */
  releaseCredentials() {
    this._authorization = null;
  }

  _error(message, info) {
    return new ArtifactSourceError(this._scrub(String(message)), info);
  }

  _isApiOrigin(url) {
    try {
      return new URL(url).origin === this._apiOrigin;
    } catch {
      return false;
    }
  }

  /**
   * Sends GET `url`, following up to MAX_REDIRECTS redirects by hand.
   * `Authorization` goes only to the API origin. The request timeout covers
   * the time until response headers of the final hop (and, with
   * `keepTimeout`, also the body read the caller does before `done()`).
   * @returns {Promise<{ response: Response, done: () => void }>}
   */
  async _get(url, { accept, label, signal, keepTimeout = false }) {
    if (!this._authorization) throw this._error('Artifact source credentials were already released.');
    if (signal && signal.aborted) throw this._error(`${label} aborted.`, { aborted: true });

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this._timeoutMs);
    timer.unref?.();
    const done = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    try {
      let current = url;
      for (let hop = 0; ; hop += 1) {
        const target = new URL(current);
        if (target.protocol !== 'https:') throw this._error(`${label} refused: only https:// is allowed.`);
        const toApi = target.origin === this._apiOrigin;
        const headers = toApi
          ? { ...this._apiHeaders, Accept: accept, Authorization: this._authorization }
          : { Accept: accept, 'User-Agent': USER_AGENT };

        let response;
        try {
          response = await this._fetch(current, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
        } catch (err) {
          if (signal && signal.aborted) throw this._error(`${label} aborted.`, { aborted: true });
          if (timedOut) throw this._error(`${label} timed out after ${Math.round(this._timeoutMs / 1000)}s.`, { transient: true });
          const cause = err && err.cause && (err.cause.code || err.cause.message);
          throw this._error(`${label} failed: ${cause || (err && err.message) || 'network error'}.`, { transient: true });
        }

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get('location');
          await drain(response);
          if (!location) throw this._error(`${label} failed: redirect without a Location header.`);
          if (hop >= MAX_REDIRECTS) throw this._error(`${label} failed: too many redirects.`);
          current = new URL(location, current).toString();
          continue;
        }
        if (!keepTimeout) clearTimeout(timer);
        return { response, done };
      }
    } catch (err) {
      done();
      throw err;
    }
  }

  async _getJson(url, { accept = 'application/json', label, notFoundMessage }) {
    const { response, done } = await this._get(url, { accept, label, keepTimeout: true });
    try {
      if (!response.ok) {
        if (response.status === 404) {
          await drain(response);
          throw this._error(notFoundMessage || `${label} failed (HTTP 404).`, { status: 404, notFound: true });
        }
        const err = await toHttpError(response, label);
        throw this._error(err.message, { status: err.status, transient: err.transient });
      }
      const body = await readCapped(response, MAX_JSON_BYTES);
      if (body === null) throw this._error(`${label} failed: response is larger than ${MAX_JSON_BYTES} bytes.`);
      try {
        return JSON.parse(body.toString('utf8'));
      } catch {
        throw this._error(`${label} returned invalid JSON.`);
      }
    } catch (err) {
      if (err instanceof ArtifactSourceError) throw err;
      throw this._error(`${label} failed while reading the response: ${err.message}.`, { transient: true });
    } finally {
      done();
    }
  }

  /** Opens a streaming GET for an artifact body; must answer 200. */
  async _openStream(url, { accept, label, signal }) {
    const { response, done } = await this._get(url, { accept, label, signal });
    if (response.status !== 200) {
      done();
      if (response.status === 404) {
        await drain(response);
        throw this._error(`${label} failed: the artifact no longer exists at the source (HTTP 404).`, { status: 404, notFound: true });
      }
      const err = await toHttpError(response, label);
      throw this._error(err.message, { status: err.status, transient: err.transient });
    }
    if (!response.body) {
      done();
      throw this._error(`${label} failed: empty response body.`);
    }
    const header = response.headers.get('content-length');
    const declared = header === null || header.trim() === '' ? Number.NaN : Number(header);
    const stream = Readable.fromWeb(response.body);
    stream.once('close', done);
    return { stream, contentLength: Number.isSafeInteger(declared) && declared >= 0 ? declared : null };
  }

  /** Throws when an artifact the manifest lists is missing at the source or has another size. */
  _matchArtifacts(artifacts, lookup, where) {
    const missing = [];
    const wrongSize = [];
    const resolved = artifacts.map((artifact) => {
      const entry = lookup(artifact.file);
      if (!entry) {
        missing.push(artifact.file);
        return null;
      }
      if (Number.isSafeInteger(entry.size) && entry.size !== artifact.size) wrongSize.push(artifact.file);
      return { ...artifact, sourceRef: String(entry.ref) };
    });
    if (missing.length > 0) throw this._error(`Artifacts listed in the manifest are missing from ${where}: ${missing.join(', ')}.`);
    if (wrongSize.length > 0) throw this._error(`Artifact size differs from the manifest: ${wrongSize.join(', ')}.`);
    return resolved;
  }
}

class BitbucketDownloadsClient extends SourceClientBase {
  constructor(source, options) {
    super(options);
    this.platform = 'bitbucket';
    this._where = `Bitbucket Downloads of ${source.owner}/${source.repo}`;
    this._repoBase = `${options.baseUrl}/repositories/${enc(source.owner)}/${enc(source.repo)}`;
  }

  _downloadUrl(fileName) {
    return `${this._repoBase}/downloads/${enc(fileName)}`;
  }

  async fetchManifest({ artifactName, version }) {
    const name = manifestFileName(artifactName, version);
    const manifest = await this._getJson(this._downloadUrl(name), {
      accept: 'application/octet-stream, application/json, */*',
      label: `Manifest download (${name})`,
      notFoundMessage: `${name} was not found in ${this._where}.`,
    });
    return { manifest, manifestRef: name, context: {} };
  }

  async resolveArtifacts(artifacts) {
    const wanted = new Set(artifacts.map((artifact) => artifact.file));
    const found = new Map();
    let url = `${this._repoBase}/downloads?pagelen=100`;
    for (let page = 0; url && page < MAX_LIST_PAGES && found.size < wanted.size; page += 1) {
      const data = await this._getJson(url, { label: 'Downloads listing' });
      for (const item of (data && Array.isArray(data.values) ? data.values : [])) {
        if (item && wanted.has(item.name) && !found.has(item.name)) {
          found.set(item.name, { ref: item.name, size: item.size });
        }
      }
      // Pagination links carry our token: only follow them on the API origin.
      url = data && typeof data.next === 'string' && this._isApiOrigin(data.next) ? data.next : null;
    }
    return this._matchArtifacts(artifacts, (file) => found.get(file), this._where);
  }

  openArtifactStream(sourceRef, { signal } = {}) {
    if (typeof sourceRef !== 'string' || !/^[A-Za-z0-9._-]+$/.test(sourceRef)) {
      throw this._error('Invalid Bitbucket download reference.');
    }
    return this._openStream(this._downloadUrl(sourceRef), {
      accept: 'application/octet-stream, */*',
      label: 'Artifact download',
      signal,
    });
  }
}

class GitHubReleasesClient extends SourceClientBase {
  constructor(source, options) {
    super(options);
    this.platform = 'github';
    this._repoName = `${source.owner}/${source.repo}`;
    this._repoBase = `${options.baseUrl}/repos/${enc(source.owner)}/${enc(source.repo)}`;
  }

  _assetUrl(assetId) {
    return `${this._repoBase}/releases/assets/${enc(assetId)}`;
  }

  async _findRelease(version) {
    for (const tag of [`v${version}`, version]) {
      try {
        return await this._getJson(`${this._repoBase}/releases/tags/${enc(tag)}`, {
          accept: 'application/vnd.github+json',
          label: 'Release lookup',
        });
      } catch (err) {
        if (!err.notFound) throw err;
      }
    }
    throw this._error(`No GitHub release tagged 'v${version}' or '${version}' in ${this._repoName}.`, { notFound: true });
  }

  async _listAssets(release) {
    const inline = Array.isArray(release.assets) ? release.assets : [];
    if (inline.length < 100 || !release.id) return inline;
    const assets = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const batch = await this._getJson(`${this._repoBase}/releases/${enc(release.id)}/assets?per_page=100&page=${page}`, {
        accept: 'application/vnd.github+json',
        label: 'Release assets listing',
      });
      if (!Array.isArray(batch) || batch.length === 0) break;
      assets.push(...batch);
      if (batch.length < 100) break;
    }
    return assets;
  }

  async fetchManifest({ artifactName, version }) {
    const release = await this._findRelease(version);
    const assets = await this._listAssets(release);
    const name = manifestFileName(artifactName, version);
    const asset = assets.find((item) => item && item.name === name);
    if (!asset) {
      throw this._error(`${name} is not an asset of the ${version} release in ${this._repoName}.`, { notFound: true });
    }
    const manifest = await this._getJson(this._assetUrl(asset.id), {
      accept: 'application/octet-stream',
      label: `Manifest download (${name})`,
      notFoundMessage: `${name} could not be downloaded from ${this._repoName}.`,
    });
    return { manifest, manifestRef: String(asset.id), context: { assets } };
  }

  async resolveArtifacts(artifacts, context = {}) {
    const byName = new Map();
    for (const asset of Array.isArray(context.assets) ? context.assets : []) {
      if (asset && typeof asset.name === 'string') byName.set(asset.name, { ref: asset.id, size: asset.size });
    }
    return this._matchArtifacts(artifacts, (file) => byName.get(file), `the GitHub release assets of ${this._repoName}`);
  }

  openArtifactStream(sourceRef, { signal } = {}) {
    if (typeof sourceRef !== 'string' || !/^\d{1,20}$/.test(sourceRef)) {
      throw this._error('Invalid GitHub asset reference.');
    }
    return this._openStream(this._assetUrl(sourceRef), {
      accept: 'application/octet-stream',
      label: 'Artifact download',
      signal,
    });
  }
}

/**
 * @param {{ platform: string, owner: string, repo: string, baseUrl?: string, authType?: string }} source
 *   normalized `artifactDeploy.source`.
 * @param {{ token: string, username?: string, fetchImpl?: Function, requestTimeoutMs?: number }} options
 */
function createArtifactSourceClient(source, { token, username, fetchImpl = undiciFetch, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const platform = source && source.platform;
  if (platform !== 'bitbucket' && platform !== 'github') {
    throw new Error("Unsupported artifact source platform — set artifactDeploy.source.platform to 'bitbucket' or 'github'.");
  }
  const baseUrl = String((source && source.baseUrl) || DEFAULT_SOURCE_BASE_URLS[platform] || '').replace(/\/+$/, '');
  if (!/^https:\/\//i.test(baseUrl)) {
    throw new Error('Artifact source API base URL must use https:// — the repository token is never sent over plain HTTP.');
  }
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error('Artifact source token is missing (artifactDeploy.source.token).');
  }
  const scrub = createCiScrubber({ token, username });
  const common = { baseUrl, fetchImpl, requestTimeoutMs, scrub };

  if (platform === 'bitbucket') {
    const authorization = source.authType === 'basic'
      ? `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`
      : `Bearer ${token}`;
    return new BitbucketDownloadsClient(source, {
      ...common,
      authorization,
      apiHeaders: { 'User-Agent': USER_AGENT },
    });
  }
  if (platform === 'github') {
    return new GitHubReleasesClient(source, {
      ...common,
      authorization: `Bearer ${token}`,
      apiHeaders: { 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': '2022-11-28' },
    });
  }
  throw new Error("Unsupported artifact source platform — set artifactDeploy.source.platform to 'bitbucket' or 'github'.");
}

module.exports = {
  createArtifactSourceClient,
  ArtifactSourceError,
  BitbucketDownloadsClient,
  GitHubReleasesClient,
  MAX_REDIRECTS,
};
