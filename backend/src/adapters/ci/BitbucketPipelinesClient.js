'use strict';

/**
 * Bitbucket Pipelines REST client for the CI Pipeline provider.
 *
 * Implements the CI client interface used by CiPipelineAdapter:
 *   verify(), trigger(), getRun(), listSteps(), readStepLog(), flushPending(), cancel().
 *
 * API base: `{baseUrl}/repositories/{owner}/{repo}` (Bitbucket Cloud 2.0).
 * Auth: `Bearer <access token>` (Repository/Project/Workspace Access Token)
 * or `Basic base64(email:api token)` — app passwords stopped working on
 * 2026-07-28. Pipeline/step UUIDs come wrapped in braces (`{...}`) and are
 * always URL-encoded when placed in a path.
 */

const { ciFetch, readBody, drain, toHttpError, CiHttpError, LOG_NOT_AVAILABLE_BUDGET_MS } = require('./http');

const MAX_STEP_PAGES = 5;
const TERMINAL_STEP_PHASES = new Set(['succeeded', 'failed', 'cancelled', 'skipped']);
const NEWLINE = 0x0a;

const enc = encodeURIComponent;

function check(name, ok, detail) {
  return { name, ok, detail };
}

/** Maps a pipeline `state` object onto the adapter's run phases. */
function mapPipelineState(state) {
  const name = state && state.name;
  if (name === 'PENDING') return { phase: 'queued', detail: 'PENDING' };
  if (name === 'IN_PROGRESS') {
    const stage = state.stage && state.stage.name;
    // PAUSED: a manual step or deployment concurrency is holding the run.
    if (stage === 'PAUSED' || stage === 'HALTED') return { phase: 'waiting', detail: stage };
    return { phase: 'running', detail: stage || 'IN_PROGRESS' };
  }
  if (name === 'COMPLETED') {
    const result = state.result && state.result.name;
    if (result === 'SUCCESSFUL') return { phase: 'succeeded', detail: 'SUCCESSFUL' };
    if (result === 'STOPPED') return { phase: 'cancelled', detail: 'STOPPED' };
    const errorMessage = state.result && state.result.error && state.result.error.message;
    return { phase: 'failed', detail: [result || 'UNKNOWN', errorMessage].filter(Boolean).join(': ') };
  }
  // Unknown/new states: keep watching rather than failing the deploy.
  return { phase: 'running', detail: name || 'UNKNOWN' };
}

function mapStepState(state) {
  const name = state && state.name;
  if (name === 'PENDING' || name === 'READY') return 'queued';
  if (name === 'IN_PROGRESS') return 'running';
  if (name === 'COMPLETED') {
    const result = state.result && state.result.name;
    if (result === 'SUCCESSFUL') return 'succeeded';
    if (result === 'STOPPED') return 'cancelled';
    if (result === 'NOT_RUN') return 'skipped';
    return 'failed';
  }
  return 'running';
}

/** `bytes 0-99/1234` -> 1234; `*` or missing -> null. */
function parseContentRangeTotal(header) {
  const match = /\/(\d+)\s*$/.exec(header || '');
  return match ? Number(match[1]) : null;
}

/**
 * Splits `pending + chunk` into complete lines, keeping any incomplete
 * trailing line (as raw bytes) for the next call. Splitting on the newline
 * BYTE is UTF-8 safe: 0x0A never occurs inside a multi-byte sequence, so a
 * character cut in half by a Range boundary stays intact in `pending`.
 */
function splitLogLines(pending, chunk, flush) {
  const buffer = chunk && chunk.length > 0 ? Buffer.concat([pending, chunk]) : pending;
  const lastNewline = buffer.lastIndexOf(NEWLINE);
  const lines = lastNewline === -1 ? [] : buffer.subarray(0, lastNewline).toString('utf8').split('\n');
  let rest = lastNewline === -1 ? buffer : buffer.subarray(lastNewline + 1);
  if (flush && rest.length > 0) {
    lines.push(rest.toString('utf8'));
    rest = Buffer.alloc(0);
  }
  return {
    lines: lines.map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== ''),
    pending: Buffer.from(rest),
  };
}

/** Heuristic: is `name` declared as a key under `pipelines: custom:`? */
function customPipelineDeclared(yaml, name) {
  const customMatch = /^\s*custom\s*:\s*$/m.exec(yaml);
  if (!customMatch) return false;
  const section = yaml.slice(customMatch.index + customMatch[0].length);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s+['"]?${escaped}['"]?\\s*:`, 'm').test(section);
}

class BitbucketPipelinesClient {
  /**
   * @param {object} ciConfig - normalized ciConfig (see ci/config.js).
   * @param {object} options
   * @param {string} options.token - access token or Atlassian API token.
   * @param {string} [options.username] - Atlassian account email (basic auth only).
   * @param {Function} options.fetchImpl
   * @param {AbortSignal} [options.signal] - aborts polling requests (never trigger/cancel).
   * @param {number} [options.requestTimeoutMs]
   */
  constructor(ciConfig, { token, username, fetchImpl, signal, requestTimeoutMs }) {
    this.platform = 'bitbucket';
    this.runLabel = 'Bitbucket pipeline';
    this.cfg = ciConfig;
    this._fetch = fetchImpl;
    this._signal = signal;
    this._timeoutMs = requestTimeoutMs;
    this._authorization = ciConfig.authType === 'basic'
      ? `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`
      : `Bearer ${token}`;
    this._repoBase = `${ciConfig.baseUrl}/repositories/${enc(ciConfig.owner)}/${enc(ciConfig.repo)}`;
    this._nearLimit = false;
  }

  /** Drops the credential; any later request fails fast. */
  releaseCredentials() {
    this._authorization = null;
  }

  /** @returns {boolean} whether a response since the last call carried `X-RateLimit-NearLimit: true`. */
  consumeNearLimit() {
    const value = this._nearLimit;
    this._nearLimit = false;
    return value;
  }

  async _send(url, { method = 'GET', body, headers = {}, label, abortable = true } = {}) {
    if (!this._authorization) throw new CiHttpError('CI credentials were already released for this deployment.');
    const response = await ciFetch(this._fetch, url, {
      method,
      headers: {
        Authorization: this._authorization,
        Accept: 'application/json',
        'User-Agent': 'IDP-CI-Pipeline',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: abortable ? this._signal : undefined,
      timeoutMs: this._timeoutMs,
      label,
    });
    if (String(response.headers.get('x-ratelimit-nearlimit')).toLowerCase() === 'true') {
      this._nearLimit = true;
    }
    return response;
  }

  _json(response, label) {
    return readBody(response, 'json', { label, signal: this._signal });
  }

  _pipelineUrl(runId, suffix = '') {
    return `${this._repoBase}/pipelines/${enc(runId)}${suffix}`;
  }

  /** Only follow pagination links on the configured API origin (they carry our token). */
  _isSameOrigin(url) {
    try {
      return new URL(url).origin === new URL(this.cfg.baseUrl).origin;
    } catch (_err) {
      return false;
    }
  }

  /** Read-only pre-flight: repository access, pipeline read scope, custom pipeline presence. */
  async verify() {
    const { owner, repo, ref, pipeline } = this.cfg;
    const repoName = `${owner}/${repo}`;
    const checks = [];

    try {
      const response = await this._send(this._repoBase, { label: 'Repository lookup' });
      if (response.ok) {
        await drain(response);
        checks.push(check('Bitbucket Repository', true, `Access to ${repoName} confirmed.`));
      } else {
        const err = await toHttpError(response, 'Repository lookup');
        checks.push(check('Bitbucket Repository', false, describeAccessError(err, repoName)));
      }
    } catch (err) {
      checks.push(check('Bitbucket Repository', false, err.message));
    }

    if (checks[0].ok !== true) {
      checks.push(check('Bitbucket Pipelines', null, 'Not tested — the repository check above failed.'));
      checks.push(check('Pipeline Definition', null, 'Not tested — the repository check above failed.'));
      return { checks };
    }

    try {
      const response = await this._send(`${this._repoBase}/pipelines/?pagelen=1`, { label: 'Pipelines lookup' });
      if (response.ok) {
        await drain(response);
        checks.push(check('Bitbucket Pipelines', true, 'The token can read pipelines.'));
      } else {
        const err = await toHttpError(response, 'Pipelines lookup');
        checks.push(check(
          'Bitbucket Pipelines',
          false,
          err.status === 401 || err.status === 403
            ? `The token cannot read pipelines (HTTP ${err.status}) — grant the pipeline read/write scopes.`
            : err.message
        ));
      }
    } catch (err) {
      checks.push(check('Bitbucket Pipelines', false, err.message));
    }

    checks.push(await this._checkPipelineDefinition(ref, pipeline));
    return { checks };
  }

  /** Best-effort: never fails the pre-flight, only reports true/null. */
  async _checkPipelineDefinition(ref, pipeline) {
    const name = 'Pipeline Definition';
    try {
      const response = await this._send(`${this._repoBase}/src/${enc(ref)}/bitbucket-pipelines.yml`, {
        label: 'Pipeline definition lookup',
        headers: { Accept: 'text/plain, */*' },
      });
      if (!response.ok) {
        await drain(response);
        return check(name, null, `Could not read bitbucket-pipelines.yml at '${ref}' (HTTP ${response.status}) — not verified.`);
      }
      const yaml = await readBody(response, 'text', { label: 'Pipeline definition lookup', signal: this._signal });
      if (customPipelineDeclared(yaml, pipeline)) {
        return check(name, true, `Custom pipeline '${pipeline}' is declared in bitbucket-pipelines.yml at '${ref}'.`);
      }
      return check(
        name,
        null,
        `Custom pipeline '${pipeline}' was not found in bitbucket-pipelines.yml at '${ref}' — it may come from a ` +
          'shared/imported configuration; the trigger will fail if it does not exist.'
      );
    } catch (err) {
      return check(name, null, `Could not read bitbucket-pipelines.yml — not verified (${err.message})`);
    }
  }

  /**
   * Starts the custom pipeline. Not abortable on purpose: aborting mid-POST
   * could create a run IDP never learns about and therefore cannot cancel.
   * @param {{ variables: Record<string, string> }} args
   * @returns {Promise<{ runId: string, runNumber: number|null, webUrl: string, matchedBy: string }>}
   */
  async trigger({ variables }) {
    const { refType, ref, pipeline, owner, repo } = this.cfg;
    const body = {
      target: {
        type: 'pipeline_ref_target',
        ref_type: refType,
        ref_name: ref,
        selector: { type: 'custom', pattern: pipeline },
      },
      variables: Object.entries(variables || {}).map(([key, value]) => ({ key, value })),
    };

    const response = await this._send(`${this._repoBase}/pipelines/`, {
      method: 'POST',
      body,
      label: 'Pipeline trigger',
      abortable: false,
    });
    if (response.status !== 201 && response.status !== 200) {
      throw await toHttpError(response, 'Pipeline trigger');
    }

    const data = await readBody(response, 'json', { label: 'Pipeline trigger' });
    if (!data || !data.uuid) throw new CiHttpError('Pipeline trigger returned no pipeline id.');

    const runNumber = data.build_number ?? null;
    return {
      runId: data.uuid,
      runNumber,
      // Undocumented but stable UI route; used as a log link only.
      webUrl: `https://bitbucket.org/${enc(owner)}/${enc(repo)}/pipelines/results/${runNumber ?? enc(data.uuid)}`,
      matchedBy: 'direct',
    };
  }

  /** @returns {Promise<{ phase: string, detail: string, raw: object }>} */
  async getRun(runId) {
    const response = await this._send(this._pipelineUrl(runId), { label: 'Pipeline status' });
    if (!response.ok) throw await toHttpError(response, 'Pipeline status');
    const raw = await this._json(response, 'Pipeline status');
    return { ...mapPipelineState(raw && raw.state), raw };
  }

  /** @returns {Promise<{ id: string, name: string, phase: string, startedAt: string|null, completedAt: string|null }[]>} */
  async listSteps(runId) {
    const steps = [];
    let url = this._pipelineUrl(runId, '/steps/?pagelen=100');
    for (let page = 0; url && page < MAX_STEP_PAGES; page += 1) {
      const response = await this._send(url, { label: 'Pipeline steps' });
      if (!response.ok) throw await toHttpError(response, 'Pipeline steps');
      const data = await this._json(response, 'Pipeline steps');
      for (const raw of (data && Array.isArray(data.values) ? data.values : [])) {
        steps.push({
          id: raw.uuid,
          name: raw.name || `Step ${steps.length + 1}`,
          phase: mapStepState(raw.state),
          startedAt: raw.started_on || null,
          completedAt: raw.completed_on || null,
        });
      }
      url = data && typeof data.next === 'string' && this._isSameOrigin(data.next) ? data.next : null;
    }
    return steps;
  }

  /**
   * Reads new bytes of a step's log using `Range: bytes=<offset>-`.
   * 206 → partial content; 200 → whole file (sliced from offset);
   * 416 → nothing new; 404 → log not available yet (not an error). A
   * finished step's log can briefly 404 while it moves to long-term storage,
   * so 404 only ends it after LOG_NOT_AVAILABLE_BUDGET_MS of 404s.
   *
   * @param {string} runId
   * @param {{ id: string, phase: string }} step
   * @param {{ offset: number, pending: Buffer, notFoundSince: number|null }|null} cursor - opaque, from the previous call.
   * @returns {Promise<{ lines: string[], cursor: object, done: boolean }>}
   */
  async readStepLog(runId, step, cursor) {
    const state = cursor || { offset: 0, pending: Buffer.alloc(0), notFoundSince: null };
    const terminal = TERMINAL_STEP_PHASES.has(step.phase);
    const response = await this._send(this._pipelineUrl(runId, `/steps/${enc(step.id)}/log`), {
      label: 'Step log',
      headers: { Range: `bytes=${state.offset}-`, Accept: 'application/octet-stream, text/plain, */*' },
    });

    let chunk = null;
    let offset = state.offset;
    let atEnd = false;
    let notFoundSince = null;
    if (response.status === 206) {
      chunk = await readBody(response, 'bytes', { label: 'Step log', signal: this._signal });
      offset += chunk.length;
      const total = parseContentRangeTotal(response.headers.get('content-range'));
      atEnd = total !== null && offset >= total;
    } else if (response.status === 200) {
      const whole = await readBody(response, 'bytes', { label: 'Step log', signal: this._signal });
      chunk = whole.subarray(Math.min(state.offset, whole.length));
      offset = whole.length;
      atEnd = true;
    } else if (response.status === 416) {
      await drain(response);
      atEnd = true;
    } else if (response.status === 404) {
      await drain(response);
      // A running step simply has no log yet; the budget only applies once it finished.
      if (terminal) {
        notFoundSince = state.notFoundSince ?? Date.now();
        atEnd = Date.now() - notFoundSince >= LOG_NOT_AVAILABLE_BUDGET_MS;
      }
    } else {
      throw await toHttpError(response, 'Step log');
    }

    const done = terminal && atEnd;
    const { lines, pending } = splitLogLines(state.pending, chunk, done);
    return { lines, cursor: { offset, pending, notFoundSince }, done };
  }

  /**
   * The incomplete last line still buffered in a cursor. The adapter emits it
   * when it gives up on a finished step's log, so the tail is not lost.
   * @param {{ pending?: Buffer }|null} cursor
   * @returns {string[]}
   */
  flushPending(cursor) {
    if (!cursor || !Buffer.isBuffer(cursor.pending) || cursor.pending.length === 0) return [];
    return splitLogLines(cursor.pending, null, true).lines;
  }

  /** Stops the pipeline. 204 → stopped; 400 → already completed (treated as ok). */
  async cancel(runId) {
    const response = await this._send(this._pipelineUrl(runId, '/stopPipeline'), {
      method: 'POST',
      label: 'Pipeline stop',
      abortable: false,
    });
    if (response.ok || response.status === 400) {
      await drain(response);
      return;
    }
    throw await toHttpError(response, 'Pipeline stop');
  }
}

function describeAccessError(err, repoName) {
  if (err.status === 401) {
    return 'Authentication failed (HTTP 401) — check the access token (and the Atlassian email when using an API token).';
  }
  if (err.status === 403) return `Access to ${repoName} was denied (HTTP 403) — the token lacks repository access.`;
  if (err.status === 404) {
    return `Repository ${repoName} was not found (HTTP 404) — check the workspace and repository slug, or the token cannot see it.`;
  }
  return err.message;
}

module.exports = BitbucketPipelinesClient;
module.exports.mapPipelineState = mapPipelineState;
module.exports.mapStepState = mapStepState;
module.exports.splitLogLines = splitLogLines;
module.exports.customPipelineDeclared = customPipelineDeclared;
