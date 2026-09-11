'use strict';

/**
 * GitHub Actions REST client for the CI Pipeline provider.
 *
 * Implements the CI client interface used by CiPipelineAdapter:
 *   verify(), trigger(), getRun(), listSteps(), readStepLog(), flushPending(), cancel().
 *
 * API base: `{baseUrl}/repos/{owner}/{repo}` — `https://api.github.com` or
 * `https://HOST/api/v3` for GitHub Enterprise Server. "Steps" at the adapter
 * level are workflow JOBS; each job additionally exposes its own `steps[]`
 * as `substeps` for progress lines. GitHub has no live log API: a job's log
 * is downloaded once, after the job completes.
 */

const {
  ciFetch,
  readBody,
  drain,
  toHttpError,
  CiHttpError,
  isTransientError,
  LOG_NOT_AVAILABLE_BUDGET_MS,
} = require('./http');

const TERMINAL_JOB_PHASES = new Set(['succeeded', 'failed', 'cancelled', 'skipped']);
const LOG_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /;
const MAX_JOB_LOG_LINES = 10_000;
const JOB_LOG_TIMEOUT_MS = 60_000;
const DEFAULT_CORRELATION_INTERVAL_MS = 3_000;
const DEFAULT_CORRELATION_TIMEOUT_MS = 60_000;
/** Heuristic 204 fallback: clock-skew allowance for "created after our dispatch started". */
const DISPATCH_CLOCK_SKEW_MS = 2_000;
/** Run ids remembered per repository; the oldest claims are dropped beyond this. */
const MAX_CLAIMED_RUNS_PER_REPO = 500;

const enc = encodeURIComponent;

/**
 * `baseUrl/owner/repo` -> ids (as strings) of the runs deploys in this process
 * already resolved. The 204 heuristic never picks one of them, so two deploys
 * of the same workflow and ref cannot end up watching (and cancelling) the
 * same run.
 * @type {Map<string, Set<string>>}
 */
const claimedRuns = new Map();

function claimedRunsFor(repoKey) {
  let claimed = claimedRuns.get(repoKey);
  if (!claimed) {
    claimed = new Set();
    claimedRuns.set(repoKey, claimed);
  }
  return claimed;
}

function claimRun(repoKey, runId) {
  const claimed = claimedRunsFor(repoKey);
  claimed.add(String(runId));
  // Sets iterate in insertion order: drop the oldest claims first.
  while (claimed.size > MAX_CLAIMED_RUNS_PER_REPO) claimed.delete(claimed.values().next().value);
}

/** Test seam: forget every claimed run. */
function resetClaimedRuns() {
  claimedRuns.clear();
}

/** Web page listing the workflow's runs: github.com, or the GHES host (API base minus `/api/v3`). */
function actionsWebUrl({ baseUrl, owner, repo, pipeline }) {
  let web = 'https://github.com';
  try {
    const url = new URL(baseUrl);
    if (url.hostname !== 'api.github.com') {
      web = `${url.origin}${url.pathname.replace(/\/api\/v3\/?$/i, '').replace(/\/+$/, '')}`;
    }
  } catch (_err) {
    // Keep github.com — this URL is only a hint in an error message.
  }
  // The web UI addresses workflows by file name, not by numeric id.
  const page = /^\d+$/.test(pipeline) ? 'actions' : `actions/workflows/${enc(pipeline)}`;
  return `${web}/${enc(owner)}/${enc(repo)}/${page}`;
}

function check(name, ok, detail) {
  return { name, ok, detail };
}

/** Maps a workflow run's status/conclusion onto the adapter's run phases. */
function mapRunStatus(status, conclusion) {
  switch (status) {
    case 'queued':
    case 'requested':
    case 'pending':
      return { phase: 'queued', detail: status };
    case 'waiting':
      return { phase: 'waiting', detail: status };
    case 'in_progress':
      return { phase: 'running', detail: status };
    case 'completed':
      if (conclusion === 'success') return { phase: 'succeeded', detail: 'success' };
      if (conclusion === 'cancelled') return { phase: 'cancelled', detail: 'cancelled' };
      // failure, timed_out, action_required, startup_failure, stale, skipped, neutral, null
      return { phase: 'failed', detail: conclusion || 'unknown' };
    default:
      return { phase: 'running', detail: status || 'unknown' };
  }
}

/** Jobs/steps: unlike a whole run, a skipped job is just skipped, not a failure. */
function mapJobPhase(status, conclusion) {
  if (status === 'completed') {
    if (conclusion === 'success') return 'succeeded';
    if (conclusion === 'skipped') return 'skipped';
    if (conclusion === 'cancelled') return 'cancelled';
    return 'failed';
  }
  if (status === 'in_progress') return 'running';
  if (status === 'waiting') return 'waiting';
  return 'queued';
}

/** Strips GitHub's per-line ISO timestamp and keeps at most the last MAX_JOB_LOG_LINES lines. */
function parseJobLog(text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.replace(LOG_TIMESTAMP_PREFIX, ''))
    .filter((line) => line.trim() !== '');
  if (lines.length <= MAX_JOB_LOG_LINES) return lines;
  const omitted = lines.length - MAX_JOB_LOG_LINES;
  return [`… ${omitted} earlier line(s) omitted — see the full log in GitHub.`, ...lines.slice(-MAX_JOB_LOG_LINES)];
}

/**
 * Picks the run a 204 dispatch created. With a correlation id: the run whose
 * `display_title` carries it (exact). Without one: the only run created since
 * the dispatch started (minus DISPATCH_CLOCK_SKEW_MS) that no other deploy in
 * this process has claimed. Several such candidates are reported as
 * ambiguous — never guessed.
 *
 * @param {object[]} runs - `workflow_runs` of the runs listing.
 * @param {{ correlationId?: string|null, dispatchStartedAt: number, claimed?: Set<string> }} options
 * @returns {{ run: object|null, ambiguous: boolean }}
 */
function pickDispatchedRun(runs, { correlationId, dispatchStartedAt, claimed = new Set() } = {}) {
  if (!Array.isArray(runs)) return { run: null, ambiguous: false };
  if (correlationId) {
    const run = runs.find((item) => item && typeof item.display_title === 'string' && item.display_title.includes(correlationId));
    return { run: run || null, ambiguous: false };
  }
  const cutoff = dispatchStartedAt - DISPATCH_CLOCK_SKEW_MS;
  const candidates = runs.filter((item) => item && !claimed.has(String(item.id)) && Date.parse(item.created_at) >= cutoff);
  if (candidates.length > 1) return { run: null, ambiguous: true };
  return { run: candidates[0] || null, ambiguous: false };
}

function decorateDispatchError(err) {
  if (err.status === 422 && /unexpected inputs/i.test(err.providerMessage)) {
    err.message += ' Every IDP variable must be declared under on.workflow_dispatch.inputs in the workflow file.';
  } else if (err.status === 404) {
    err.message += " Check the owner, repository and workflow file name, and that the token has 'Actions: Read and write'.";
  } else if (err.status === 403 && !err.transient) {
    err.message += " The token needs the 'Actions: Read and write' permission.";
  }
  return err;
}

function describeAccessError(err, repoName) {
  if (err.status === 401) return 'Authentication failed (HTTP 401) — check the token.';
  if (err.status === 403) return `Access to ${repoName} was denied (HTTP 403)${err.providerMessage ? `: ${err.providerMessage}` : '.'}`;
  if (err.status === 404) {
    return `Repository ${repoName} was not found (HTTP 404) — check the owner and repository name, or the token cannot see it.`;
  }
  return err.message;
}

class GitHubActionsClient {
  /**
   * @param {object} ciConfig - normalized ciConfig (see ci/config.js).
   * @param {object} options
   * @param {string} options.token - fine-grained or classic PAT.
   * @param {Function} options.fetchImpl
   * @param {AbortSignal} [options.signal] - aborts polling requests (never dispatch/cancel/run lookup).
   * @param {number} [options.requestTimeoutMs]
   * @param {(ms: number) => Promise<void>} [options.sleep] - used between 204-fallback lookups.
   * @param {{ intervalMs?: number, timeoutMs?: number }} [options.correlation]
   */
  constructor(ciConfig, { token, fetchImpl, signal, requestTimeoutMs, sleep, correlation } = {}) {
    this.platform = 'github';
    this.runLabel = 'GitHub workflow';
    this.cfg = ciConfig;
    this._fetch = fetchImpl;
    this._signal = signal;
    this._timeoutMs = requestTimeoutMs;
    this._authorization = `Bearer ${token}`;
    this._repoBase = `${ciConfig.baseUrl}/repos/${enc(ciConfig.owner)}/${enc(ciConfig.repo)}`;
    this._workflowBase = `${this._repoBase}/actions/workflows/${enc(ciConfig.pipeline)}`;
    this._repoKey = `${ciConfig.baseUrl}/${ciConfig.owner}/${ciConfig.repo}`.toLowerCase();
    this._sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this._correlation = {
      intervalMs: (correlation && correlation.intervalMs) ?? DEFAULT_CORRELATION_INTERVAL_MS,
      timeoutMs: (correlation && correlation.timeoutMs) ?? DEFAULT_CORRELATION_TIMEOUT_MS,
    };
  }

  /** Drops the credential; any later request fails fast. */
  releaseCredentials() {
    this._authorization = null;
  }

  /** GitHub's 5000 req/h PAT budget is ample for polling; no near-limit signal. */
  consumeNearLimit() {
    return false;
  }

  async _send(url, { method = 'GET', body, headers = {}, label, abortable = true, timeoutMs } = {}) {
    if (!this._authorization) throw new CiHttpError('CI credentials were already released for this deployment.');
    return ciFetch(this._fetch, url, {
      method,
      headers: {
        Authorization: this._authorization,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'IDP-CI-Pipeline',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: abortable ? this._signal : undefined,
      timeoutMs: timeoutMs || this._timeoutMs,
      label,
    });
  }

  _json(response, label) {
    return readBody(response, 'json', { label, signal: this._signal });
  }

  /** Read-only pre-flight: repository access, workflow existence/state, workflow_dispatch trigger. */
  async verify() {
    const { owner, repo, ref, pipeline } = this.cfg;
    const repoName = `${owner}/${repo}`;
    const checks = [];

    try {
      const response = await this._send(this._repoBase, { label: 'Repository lookup' });
      if (response.ok) {
        await drain(response);
        checks.push(check('GitHub Repository', true, `Access to ${repoName} confirmed.`));
      } else {
        checks.push(check('GitHub Repository', false, describeAccessError(await toHttpError(response, 'Repository lookup'), repoName)));
      }
    } catch (err) {
      checks.push(check('GitHub Repository', false, err.message));
    }

    if (checks[0].ok !== true) {
      checks.push(check('GitHub Workflow', null, 'Not tested — the repository check above failed.'));
      checks.push(check('Workflow Dispatch Trigger', null, 'Not tested — the repository check above failed.'));
      return { checks };
    }

    let workflow = null;
    try {
      const response = await this._send(this._workflowBase, { label: 'Workflow lookup' });
      if (response.ok) {
        workflow = await this._json(response, 'Workflow lookup');
        const state = workflow && workflow.state;
        checks.push(state === 'active'
          ? check('GitHub Workflow', true, `Workflow '${workflow.name || pipeline}' exists and is active.`)
          : check('GitHub Workflow', false, `Workflow '${pipeline}' is ${state || 'not active'} — enable it in GitHub.`));
      } else {
        const err = await toHttpError(response, 'Workflow lookup');
        checks.push(check('GitHub Workflow', false, err.status === 404
          ? `Workflow '${pipeline}' was not found (HTTP 404) — use the workflow file name (e.g. deploy.yml) or its numeric id.`
          : describeAccessError(err, repoName)));
      }
    } catch (err) {
      checks.push(check('GitHub Workflow', false, err.message));
    }

    checks.push(await this._checkDispatchTrigger(workflow, ref));
    return { checks };
  }

  /** Best-effort: false only when the file was read and has no workflow_dispatch trigger. */
  async _checkDispatchTrigger(workflow, ref) {
    const name = 'Workflow Dispatch Trigger';
    if (!workflow || typeof workflow.path !== 'string' || !workflow.path) {
      return check(name, null, 'Not tested — the workflow check above failed.');
    }
    const path = workflow.path;
    try {
      const url = `${this._repoBase}/contents/${path.split('/').map(enc).join('/')}?ref=${enc(ref)}`;
      const response = await this._send(url, { label: 'Workflow file lookup' });
      if (!response.ok) {
        await drain(response);
        return check(name, null, `Could not read ${path} at '${ref}' (HTTP ${response.status}) — not verified.`);
      }
      const file = await this._json(response, 'Workflow file lookup');
      if (!file || typeof file.content !== 'string' || file.content === '') {
        return check(name, null, `Could not read ${path} at '${ref}' — not verified.`);
      }
      const source = Buffer.from(file.content, 'base64').toString('utf8');
      return /\bworkflow_dispatch\b/.test(source)
        ? check(name, true, `${path} declares a workflow_dispatch trigger at '${ref}'.`)
        : check(name, false, `${path} at '${ref}' has no workflow_dispatch trigger — IDP cannot start it.`);
    } catch (err) {
      return check(name, null, `Could not read ${path} — not verified (${err.message})`);
    }
  }

  _dispatch(body) {
    return this._send(`${this._workflowBase}/dispatches`, {
      method: 'POST',
      body,
      label: 'Workflow dispatch',
      abortable: false,
    });
  }

  /**
   * Dispatches the workflow and resolves the run it created. Not abortable
   * on purpose (see BitbucketPipelinesClient#trigger); the adapter cancels
   * the run afterwards if an abort arrived meanwhile.
   *
   * @param {{ variables: Record<string, string>, correlationId: string }} args
   * @returns {Promise<{ runId: number, runNumber: number|null, webUrl: string|null, matchedBy: 'direct'|'correlation'|'heuristic' }>}
   */
  async trigger({ variables, correlationId }) {
    const { ref, correlationInput } = this.cfg;
    const inputs = { ...(variables || {}) };
    if (correlationInput) inputs[correlationInput] = correlationId;

    // Recorded right before each POST: the 204 heuristic only accepts runs created after it.
    let dispatchStartedAt = Date.now();
    let response = await this._dispatch({ ref, inputs, return_run_details: true });
    if (response.status === 422) {
      const err = await toHttpError(response, 'Workflow dispatch');
      // Older GHES versions reject the parameter; retry once without it (→ 204 path).
      if (!/return_run_details/i.test(err.providerMessage)) throw decorateDispatchError(err);
      dispatchStartedAt = Date.now();
      response = await this._dispatch({ ref, inputs });
    }

    if (response.status === 200) {
      const data = await readBody(response, 'json', { label: 'Workflow dispatch' });
      if (data && data.workflow_run_id) {
        claimRun(this._repoKey, data.workflow_run_id);
        const details = await this._runDetails(data.workflow_run_id);
        return {
          runId: data.workflow_run_id,
          runNumber: details.runNumber,
          webUrl: data.html_url || details.webUrl,
          matchedBy: 'direct',
        };
      }
      return this._findDispatchedRun({ correlationId, dispatchStartedAt });
    }
    if (response.status === 204) {
      await drain(response);
      return this._findDispatchedRun({ correlationId, dispatchStartedAt });
    }
    throw decorateDispatchError(await toHttpError(response, 'Workflow dispatch'));
  }

  /** The 200 dispatch response has no run_number; fetch it (best-effort). */
  async _runDetails(runId) {
    try {
      const response = await this._send(`${this._repoBase}/actions/runs/${enc(runId)}`, {
        label: 'Workflow run lookup',
        abortable: false,
      });
      if (!response.ok) {
        await drain(response);
        return { runNumber: null, webUrl: null };
      }
      const raw = await readBody(response, 'json', { label: 'Workflow run lookup' });
      return { runNumber: (raw && raw.run_number) ?? null, webUrl: (raw && raw.html_url) || null };
    } catch (_err) {
      return { runNumber: null, webUrl: null };
    }
  }

  async _findDispatchedRun({ correlationId, dispatchStartedAt }) {
    const { ref, correlationInput } = this.cfg;
    const branch = ref.replace(/^refs\/(heads|tags)\//, '');
    const url = `${this._workflowBase}/runs?event=workflow_dispatch&branch=${enc(branch)}&per_page=20`;
    const deadline = Date.now() + this._correlation.timeoutMs;
    let lastError = null;

    for (;;) {
      let ambiguous = false;
      try {
        const response = await this._send(url, { label: 'Workflow run lookup', abortable: false });
        if (!response.ok) throw await toHttpError(response, 'Workflow run lookup');
        const data = await readBody(response, 'json', { label: 'Workflow run lookup' });
        const pick = pickDispatchedRun(data && data.workflow_runs, {
          correlationId: correlationInput ? correlationId : null,
          dispatchStartedAt,
          claimed: claimedRunsFor(this._repoKey),
        });
        if (pick.run) {
          claimRun(this._repoKey, pick.run.id);
          return {
            runId: pick.run.id,
            runNumber: pick.run.run_number ?? null,
            webUrl: pick.run.html_url || null,
            matchedBy: correlationInput ? 'correlation' : 'heuristic',
          };
        }
        ambiguous = pick.ambiguous;
      } catch (err) {
        if (!isTransientError(err)) throw err;
        lastError = err;
      }
      if (ambiguous) {
        // Guessing could latch onto another deploy's run — and aborting this deploy would then cancel it.
        throw new CiHttpError(
          'The workflow was dispatched, but its run could not be identified unambiguously: several ' +
            `workflow_dispatch runs of '${this.cfg.pipeline}' on '${branch}' started at the same time. ` +
            'Configure a "Correlation input" for exact matching. IDP is not watching or cancelling any run — ' +
            `check GitHub manually before re-running: ${actionsWebUrl(this.cfg)}`
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this._sleep(Math.min(this._correlation.intervalMs, remaining));
    }

    const seconds = Math.round(this._correlation.timeoutMs / 1000);
    const reason = correlationInput
      ? `no run with the correlation id in its title appeared within ${seconds}s — make sure the workflow sets ` +
        `'run-name' using \${{ inputs.${correlationInput} }}.`
      : `its run could not be identified within ${seconds}s.`;
    throw new CiHttpError(
      `The workflow was dispatched, but ${reason} Check GitHub before re-running.` +
        (lastError ? ` Last error: ${lastError.message}` : '')
    );
  }

  /** @returns {Promise<{ phase: string, detail: string, raw: object }>} */
  async getRun(runId) {
    const response = await this._send(`${this._repoBase}/actions/runs/${enc(runId)}`, { label: 'Workflow run status' });
    if (!response.ok) throw await toHttpError(response, 'Workflow run status');
    const raw = await this._json(response, 'Workflow run status');
    return { ...mapRunStatus(raw && raw.status, raw && raw.conclusion), raw };
  }

  /** Jobs of the run, each with its steps exposed as `substeps`. */
  async listSteps(runId) {
    const response = await this._send(`${this._repoBase}/actions/runs/${enc(runId)}/jobs?per_page=100`, {
      label: 'Workflow jobs',
    });
    if (!response.ok) throw await toHttpError(response, 'Workflow jobs');
    const data = await this._json(response, 'Workflow jobs');
    const jobs = data && Array.isArray(data.jobs) ? data.jobs : [];
    return jobs.map((job) => ({
      id: job.id,
      name: job.name || `Job ${job.id}`,
      phase: mapJobPhase(job.status, job.conclusion),
      startedAt: job.started_at || null,
      completedAt: job.completed_at || null,
      substeps: (Array.isArray(job.steps) ? job.steps : []).map((step) => ({
        number: step.number,
        name: step.name || `Step ${step.number}`,
        phase: mapJobPhase(step.status, step.conclusion),
        startedAt: step.started_at || null,
        completedAt: step.completed_at || null,
      })),
    }));
  }

  /**
   * Downloads a job's log once, after the job completed (302 → storage, followed).
   * @returns {Promise<{ lines: string[], cursor: object, done: boolean }>}
   */
  async readStepLog(runId, job, cursor) {
    const state = cursor || { fetched: false, notFoundSince: null };
    if (state.fetched) return { lines: [], cursor: state, done: true };
    if (!TERMINAL_JOB_PHASES.has(job.phase)) return { lines: [], cursor: state, done: false };
    if (job.phase === 'skipped') return { lines: [], cursor: { ...state, fetched: true }, done: true };

    const response = await this._send(`${this._repoBase}/actions/jobs/${enc(job.id)}/logs`, {
      label: 'Job log',
      timeoutMs: JOB_LOG_TIMEOUT_MS,
    });
    if (response.status === 404 || response.status === 410) {
      await drain(response);
      // Time-based, not attempt-based: the final flush may re-read within milliseconds.
      const notFoundSince = state.notFoundSince ?? Date.now();
      if (response.status === 404 && Date.now() - notFoundSince < LOG_NOT_AVAILABLE_BUDGET_MS) {
        return { lines: [], cursor: { ...state, notFoundSince }, done: false };
      }
      return {
        lines: [`⚠ Logs not available for job '${job.name}' (HTTP ${response.status}).`],
        cursor: { ...state, fetched: true },
        done: true,
      };
    }
    if (!response.ok) throw await toHttpError(response, 'Job log');
    const text = await readBody(response, 'text', { label: 'Job log', signal: this._signal });
    return { lines: parseJobLog(text), cursor: { ...state, fetched: true }, done: true };
  }

  /** Job logs are downloaded whole, so there is never a buffered partial line. */
  flushPending() {
    return [];
  }

  /** Cancels the run. 202 → accepted; 409 → already completed (treated as ok). */
  async cancel(runId) {
    const response = await this._send(`${this._repoBase}/actions/runs/${enc(runId)}/cancel`, {
      method: 'POST',
      label: 'Workflow cancel',
      abortable: false,
    });
    if (response.ok || response.status === 409) {
      await drain(response);
      return;
    }
    throw await toHttpError(response, 'Workflow cancel');
  }
}

module.exports = GitHubActionsClient;
module.exports.mapRunStatus = mapRunStatus;
module.exports.mapJobPhase = mapJobPhase;
module.exports.parseJobLog = parseJobLog;
module.exports.pickDispatchedRun = pickDispatchedRun;
module.exports.actionsWebUrl = actionsWebUrl;
module.exports.resetClaimedRuns = resetClaimedRuns;
