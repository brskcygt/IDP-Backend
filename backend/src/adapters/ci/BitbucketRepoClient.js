'use strict';

/**
 * Bitbucket Cloud repository operations for the release composer
 * (core/artifacts/composeService.js): list/resolve branches and tags, create
 * and delete branches and tags, open/merge/decline pull requests.
 *
 * API base: `{baseUrl}/repositories/{owner}/{repo}` (Bitbucket Cloud 2.0).
 * Auth exactly like BitbucketPipelinesClient: `Bearer <access token>` or
 * `Basic base64(email:api token)`. Writes need `repository:write` +
 * `pullrequest:write` (access token) or an API token with the write scopes.
 *
 * Every error leaving this module is a CiHttpError whose message went
 * through `scrub` (token and Basic credential removed) and never contains a
 * URL or header.
 */

const { ciFetch, readBody, drain, toHttpError, CiHttpError, DEFAULT_REQUEST_TIMEOUT_MS } = require('./http');

const PAGE_LENGTH = 100;
const DEFAULT_REF_LIMIT = 500;
const MAX_MESSAGE_LENGTH = 500;
const DEFAULT_MERGE_TIMEOUT_MS = 60_000;
const DEFAULT_MERGE_POLL_MS = 2_000;
const USER_AGENT = 'IDP-Release-Composer';

const enc = encodeURIComponent;

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Bitbucket's BBQL string literal: backslash and double quote escaped. */
function bbqlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function cleanMessage(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
}

/**
 * Branch/tag API object → RepoRef `{ name, sha, date, message }`. An
 * annotated tag carries its own date/message; a lightweight one (and every
 * branch) falls back to the target commit's.
 */
function toRepoRef(raw) {
  const target = (raw && raw.target) || {};
  return {
    name: String(raw && raw.name),
    sha: String(target.hash || ''),
    date: (raw && typeof raw.date === 'string' && raw.date) || (typeof target.date === 'string' ? target.date : null),
    message: cleanMessage(raw && raw.message) ?? cleanMessage(target.message),
  };
}

class BitbucketRepoClient {
  /**
   * @param {{ baseUrl: string, owner: string, repo: string, authType?: 'bearer'|'basic' }} source
   * @param {object} options
   * @param {string} options.token
   * @param {string} [options.username] - Atlassian email (basic auth only).
   * @param {Function} options.fetchImpl
   * @param {(text: string) => string} [options.scrub]
   * @param {number} [options.requestTimeoutMs]
   * @param {(ms: number) => Promise<void>} [options.sleep]
   * @param {{ mergeTimeoutMs?: number, mergePollMs?: number }} [options.timing]
   */
  constructor(source, { token, username, fetchImpl, scrub = (text) => text, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, sleep = defaultSleep, timing = {} }) {
    if (!/^https:\/\//i.test(String(source.baseUrl || ''))) {
      throw new Error('Bitbucket API base URL must use https:// — the token is never sent over plain HTTP.');
    }
    this.platform = 'bitbucket';
    this._baseUrl = source.baseUrl.replace(/\/+$/, '');
    this._repoBase = `${this._baseUrl}/repositories/${enc(source.owner)}/${enc(source.repo)}`;
    this._authorization = source.authType === 'basic'
      ? `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`
      : `Bearer ${token}`;
    this._fetch = fetchImpl;
    this._scrub = scrub;
    this._timeoutMs = requestTimeoutMs;
    this._sleep = sleep;
    this._mergeTimeoutMs = timing.mergeTimeoutMs ?? DEFAULT_MERGE_TIMEOUT_MS;
    this._mergePollMs = timing.mergePollMs ?? DEFAULT_MERGE_POLL_MS;
  }

  /** Drops the credential; any later request fails fast. */
  releaseCredentials() {
    this._authorization = null;
  }

  _error(err) {
    if (err instanceof CiHttpError) {
      err.message = this._scrub(err.message);
      err.providerMessage = this._scrub(err.providerMessage || '');
      return err;
    }
    return new CiHttpError(this._scrub(String((err && err.message) || err)));
  }

  async _send(url, { method = 'GET', body, label }) {
    if (!this._authorization) throw new CiHttpError('Repository credentials were already released.');
    try {
      return await ciFetch(this._fetch, url, {
        method,
        headers: {
          Authorization: this._authorization,
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        timeoutMs: this._timeoutMs,
        label,
      });
    } catch (err) {
      throw this._error(err);
    }
  }

  /** Sends and parses JSON; any status outside `ok` becomes a scrubbed CiHttpError. */
  async _json(url, { method = 'GET', body, label, ok = (status) => status >= 200 && status < 300 }) {
    const response = await this._send(url, { method, body, label });
    if (!ok(response.status)) throw this._error(await toHttpError(response, label));
    try {
      return { status: response.status, headers: response.headers, data: await readBody(response, 'json', { label }) };
    } catch (err) {
      throw this._error(err);
    }
  }

  _isSameOrigin(url) {
    try {
      return new URL(url).origin === new URL(this._baseUrl).origin;
    } catch {
      return false;
    }
  }

  async _listRefs(kind, { q, limit = DEFAULT_REF_LIMIT } = {}) {
    const params = new URLSearchParams({ pagelen: String(PAGE_LENGTH), sort: '-target.date' });
    if (q) params.set('q', `name ~ ${bbqlString(q)}`);
    const label = kind === 'branches' ? 'Branch listing' : 'Tag listing';
    const refs = [];
    let url = `${this._repoBase}/refs/${kind}?${params}`;
    while (url && refs.length < limit) {
      const { data } = await this._json(url, { label });
      for (const raw of (data && Array.isArray(data.values) ? data.values : [])) {
        if (refs.length >= limit) break;
        if (raw && typeof raw.name === 'string') refs.push(toRepoRef(raw));
      }
      // Pagination links carry our token: only ever follow them on the API origin.
      url = data && typeof data.next === 'string' && this._isSameOrigin(data.next) ? data.next : null;
    }
    return refs;
  }

  /** @returns {Promise<{ defaultBranch: string|null }>} */
  async getRepository() {
    const { data } = await this._json(this._repoBase, { label: 'Repository lookup' });
    const name = data && data.mainbranch && data.mainbranch.name;
    return { defaultBranch: typeof name === 'string' && name ? name : null };
  }

  /** @returns {Promise<object[]>} RepoRef[], newest commit first. */
  listBranches(options) {
    return this._listRefs('branches', options);
  }

  /** @returns {Promise<object[]>} RepoRef[], newest commit first. */
  listTags(options) {
    return this._listRefs('tags', options);
  }

  async _getRef(kind, name, label) {
    const response = await this._send(`${this._repoBase}/refs/${kind}/${enc(name)}`, { label });
    if (response.status === 404) {
      await drain(response);
      return null;
    }
    if (!response.ok) throw this._error(await toHttpError(response, label));
    try {
      return toRepoRef(await readBody(response, 'json', { label }));
    } catch (err) {
      throw this._error(err);
    }
  }

  /** @returns {Promise<object|null>} RepoRef, or null when there is no such branch. */
  getBranch(name) {
    return this._getRef('branches', name, 'Branch lookup');
  }

  /** @returns {Promise<object|null>} RepoRef, or null when there is no such tag. */
  getTag(name) {
    return this._getRef('tags', name, 'Tag lookup');
  }

  /** @returns {Promise<string|null>} the full hash, or null when the commit does not exist. */
  async getCommit(hash) {
    const response = await this._send(`${this._repoBase}/commit/${enc(hash)}`, { label: 'Commit lookup' });
    if (response.status === 404) {
      await drain(response);
      return null;
    }
    if (!response.ok) throw this._error(await toHttpError(response, 'Commit lookup'));
    const data = await readBody(response, 'json', { label: 'Commit lookup' }).catch((err) => { throw this._error(err); });
    return data && typeof data.hash === 'string' ? data.hash : null;
  }

  /** @returns {Promise<object>} RepoRef of the new branch. */
  async createBranch(name, hash) {
    const { data } = await this._json(`${this._repoBase}/refs/branches`, {
      method: 'POST',
      body: { name, target: { hash } },
      label: 'Branch creation',
    });
    return toRepoRef(data || { name, target: { hash } });
  }

  /** Deletes a branch; an already missing one counts as deleted. */
  async deleteBranch(name) {
    const response = await this._send(`${this._repoBase}/refs/branches/${enc(name)}`, { method: 'DELETE', label: 'Branch deletion' });
    if (response.ok || response.status === 404) {
      await drain(response);
      return;
    }
    throw this._error(await toHttpError(response, 'Branch deletion'));
  }

  /** @returns {Promise<object>} RepoRef of the new tag. */
  async createTag({ name, hash, message }) {
    const { data } = await this._json(`${this._repoBase}/refs/tags`, {
      method: 'POST',
      body: { name, target: { hash }, ...(message ? { message } : {}) },
      label: 'Tag creation',
    });
    return toRepoRef(data || { name, target: { hash }, message });
  }

  /** @returns {Promise<{ id: number }>} */
  async createPullRequest({ title, source, destination, description }) {
    const { data } = await this._json(`${this._repoBase}/pullrequests`, {
      method: 'POST',
      body: {
        title,
        ...(description ? { description } : {}),
        source: { branch: { name: source } },
        destination: { branch: { name: destination } },
        close_source_branch: false,
      },
      label: 'Pull request creation',
    });
    if (!data || data.id === undefined || data.id === null) throw new CiHttpError('Pull request creation returned no id.');
    return { id: data.id };
  }

  /**
   * Merges with a merge commit. Bitbucket answers 200 with the merged pull
   * request, or 202 with a task-status link when the merge runs in the
   * background; the task is polled up to `mergeTimeoutMs`.
   * A refusal (conflict, failed merge check) throws with `mergeFailed: true`.
   * @returns {Promise<{ mergeCommit: string|null }>}
   */
  async mergePullRequest(id, { message } = {}) {
    const label = 'Pull request merge';
    const response = await this._send(`${this._repoBase}/pullrequests/${enc(id)}/merge`, {
      method: 'POST',
      body: { type: 'pullrequest', merge_strategy: 'merge_commit', close_source_branch: false, ...(message ? { message } : {}) },
      label,
    });
    if (response.status === 202) {
      const data = await readBody(response, 'json', { label }).catch(() => null);
      const link = response.headers.get('location') || (data && data.links && data.links.self && data.links.self.href);
      if (!link || !this._isSameOrigin(new URL(link, this._baseUrl).href)) {
        throw new CiHttpError('Pull request merge was accepted but returned no task-status link to follow.');
      }
      return this._pollMergeTask(new URL(link, this._baseUrl).href);
    }
    if (!response.ok) {
      const err = this._error(await toHttpError(response, label));
      if (!err.transient) err.mergeFailed = true;
      throw err;
    }
    const data = await readBody(response, 'json', { label }).catch(() => null);
    return { mergeCommit: (data && data.merge_commit && data.merge_commit.hash) || null };
  }

  async _pollMergeTask(url) {
    const deadline = Date.now() + this._mergeTimeoutMs;
    for (;;) {
      const { data } = await this._json(url, { label: 'Merge task status' });
      const status = String((data && data.task_status) || '').toUpperCase();
      if (status === 'SUCCESS') {
        const result = data.merge_result || {};
        return { mergeCommit: (result.merge_commit && result.merge_commit.hash) || null };
      }
      if (status && status !== 'PENDING' && status !== 'IN_PROGRESS') {
        const detail = cleanMessage(data.merge_result && data.merge_result.error && data.merge_result.error.message)
          || cleanMessage(data.error && data.error.message);
        const err = new CiHttpError(this._scrub(`Pull request merge failed (task ${status})${detail ? `: ${detail}` : '.'}`), {
          providerMessage: this._scrub(detail || ''),
        });
        err.mergeFailed = true;
        throw err;
      }
      if (Date.now() >= deadline) {
        throw new CiHttpError(`Pull request merge did not finish within ${Math.round(this._mergeTimeoutMs / 1000)}s.`);
      }
      await this._sleep(this._mergePollMs);
    }
  }

  /** Declines an open pull request; one that is already closed is left alone. */
  async declinePullRequest(id) {
    const response = await this._send(`${this._repoBase}/pullrequests/${enc(id)}/decline`, { method: 'POST', label: 'Pull request decline' });
    if (response.ok || response.status === 400 || response.status === 404) {
      await drain(response);
      return;
    }
    throw this._error(await toHttpError(response, 'Pull request decline'));
  }
}

module.exports = BitbucketRepoClient;
module.exports.toRepoRef = toRepoRef;
module.exports.bbqlString = bbqlString;
