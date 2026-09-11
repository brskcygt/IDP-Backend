'use strict';

const crypto = require('node:crypto');
const DeploymentAdapter = require('./DeploymentAdapter');
const { assertTriggerResult } = DeploymentAdapter;
const {
  createCiClient,
  createCiScrubber,
  normalizeCiConfig,
  findMissingCiFields,
  validateCiVariables,
  isPlainObject,
} = require('./ci');
const { isTransientError } = require('./ci/http');

/**
 * CiPipelineAdapter — "CI Pipeline" provider (`project.provider === 'Pipeline'`).
 *
 * Instead of connecting to a target server, IDP triggers a CI pipeline —
 * a Bitbucket Pipelines custom pipeline or a GitHub Actions workflow_dispatch
 * — with the project's variables, streams its step/job progress and logs into
 * the regular IDP log stream, and cancels the run when the deploy is aborted.
 * IDP stays the approval/RBAC/audit point; the pipeline does the deploying.
 *
 * Lifecycle (driven by core/deployment/deploymentService.js):
 *   1. connect()    read-only pre-flight (repo access, pipeline/workflow exists)
 *   2. trigger()    start the run, resolve its id/number/URL
 *   3. streamLogs() poll until the run finishes; throw unless it succeeded
 *   4. abort()      any time: stop watching and cancel the run
 *
 * Secrets: every string that leaves this adapter (log lines, stream lines,
 * thrown Error messages) passes through a scrubber that removes the token.
 * Only variable KEYS are ever logged, never values. Variables come only from
 * the project config; deploy parameters (`variables`, `environment`,
 * `confirmation`, …) are ignored — never sent or logged.
 */

const MAX_CONSECUTIVE_POLL_FAILURES = 5;
const MAX_POLL_DELAY_MS = 60_000;
/** While a step is running, fetch the run status only every Nth tick (rate-limit budget). */
const STATUS_EVERY_N_TICKS = 3;
const MAX_LOG_READS_PER_FINISHED_STEP = 20;
/** Final flush: wait between empty / not-yet-available log reads (the log may still be archiving). */
const LOG_RETRY_INTERVAL_MS = 3_000;
/** Final flush: total time spent waiting for logs, across all steps. */
const MAX_FINAL_LOG_WAIT_MS = 30_000;
const TERMINAL_PHASES = new Set(['succeeded', 'failed', 'cancelled', 'skipped']);

const PLATFORM_NAMES = { bitbucket: 'Bitbucket Pipelines', github: 'GitHub Actions' };
const WAITING_MESSAGES = {
  bitbucket: '⏸ Pipeline paused — a manual step or another deployment (concurrency) is blocking it. Approve/continue it in Bitbucket.',
  github: '⏸ Waiting for environment approval in GitHub.',
};

/** 12s · 2m 05s · 1h 03m */
function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function durationBetween(startedAt, completedAt) {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isNaN(start) || Number.isNaN(end) ? '' : formatDuration(end - start);
}

/** Transition line for a finished step (`verbose`) or a GitHub job step (compact). */
function finishedLine(name, phase, duration, verbose) {
  const suffix = duration ? ` (${duration})` : '';
  switch (phase) {
    case 'succeeded':
      return verbose ? `✓ ${name} succeeded${suffix}` : `✓ ${name}${suffix}`;
    case 'failed':
      return verbose ? `✗ ${name} failed${suffix}` : `✗ ${name}${suffix}`;
    case 'skipped':
      return verbose ? `⏭ ${name} skipped` : `⏭ ${name}`;
    default:
      return verbose ? `■ ${name} cancelled` : `■ ${name}`;
  }
}

class CiPipelineAdapter extends DeploymentAdapter {
  /**
   * @param {object} config
   * @param {object} config.ciConfig - `project.config.ciConfig` (environment overrides already merged).
   * @param {string} config.apiToken - resolved token (never a secret:// ref).
   * @param {string} [config.username] - Atlassian email (Bitbucket basic auth only).
   * @param {Function} [config.fetchImpl] - test seam; defaults to undici's fetch.
   * @param {object} [config.timing] - test seam: `{ pollIntervalMs, timeoutMs,
   *   correlationIntervalMs, correlationTimeoutMs, logRetryIntervalMs }` overriding
   *   the ciConfig values / built-in defaults.
   * @throws {Error} listing every missing setting when the config is incomplete.
   */
  constructor(config) {
    super(config);
    this.logPrefix = '[CI]';
    this.supportsLogStreaming = true;

    this.aborted = false;
    this._aborting = false;
    this._cancelRequested = false;
    this.runId = null;
    this.runNumber = null;
    this.webUrl = null;
    this._startedAt = null;
    /** Per-step progress: id -> { started, finished, logDone, cursor, logWarned, substeps } */
    this._steps = new Map();
    // Aborting this wakes the poll sleep and cancels in-flight polling requests.
    this._abortController = new AbortController();

    const { apiToken, username } = this.config;
    this._scrub = createCiScrubber({ token: apiToken, username });
    this.ciConfig = normalizeCiConfig(this.config.ciConfig);

    const missing = findMissingCiFields(this.ciConfig, { token: apiToken, username });
    if (missing.length > 0) {
      throw new Error(
        `CI Pipeline configuration is incomplete — missing: ${missing.join(', ')}. ` +
          "Set them in the project's CI Pipeline settings."
      );
    }

    const timing = isPlainObject(this.config.timing) ? this.config.timing : {};
    this._pollIntervalMs = timing.pollIntervalMs ?? this.ciConfig.pollIntervalSeconds * 1000;
    this._timeoutMs = timing.timeoutMs ?? this.ciConfig.timeoutMinutes * 60_000;
    this._logRetryIntervalMs = timing.logRetryIntervalMs ?? LOG_RETRY_INTERVAL_MS;
    /** Set by _finalFlush(): no more log-retry waits after this time. */
    this._finalLogWaitUntil = 0;

    this.client = createCiClient(this.ciConfig, {
      token: apiToken,
      username,
      fetchImpl: this.config.fetchImpl,
      signal: this._abortController.signal,
      correlation: { intervalMs: timing.correlationIntervalMs, timeoutMs: timing.correlationTimeoutMs },
    });
  }

  /** Every adapter log line is scrubbed of the token before it goes anywhere. */
  log(message) {
    super.log(this._scrub(String(message)));
  }

  /** Called by deploymentService once the deploy is over: forget the token. */
  releaseCredentials() {
    if (this.client && typeof this.client.releaseCredentials === 'function') this.client.releaseCredentials();
    if (this.config) this.config.apiToken = null;
  }

  /** Read-only pre-flight — throws when auth/access/not-found checks fail. */
  async connect() {
    const { platform, owner, repo, pipeline } = this.ciConfig;
    this.log(`Connecting to ${PLATFORM_NAMES[platform]} for ${owner}/${repo} — ${this.client.runLabel} '${pipeline}' on ${this._refText()}...`);

    let result;
    try {
      result = await this.client.verify();
    } catch (err) {
      throw this._error(`CI pre-flight check failed: ${err.message}`);
    }

    const checks = result && Array.isArray(result.checks) ? result.checks : [];
    for (const item of checks) {
      const icon = item.ok === true ? '✓' : item.ok === false ? '✗' : '⚠';
      this.log(`${icon} ${item.name}: ${item.detail}`);
    }
    const failed = checks.filter((item) => item.ok === false);
    if (failed.length > 0) {
      throw this._error(`CI pre-flight check failed — ${failed.map((item) => `${item.name}: ${item.detail}`).join(' | ')}`);
    }
  }

  /**
   * Starts the run with the project's own variables: `ciConfig.variables`,
   * environment override already merged. Every deploy parameter is ignored,
   * `variables` included — triggering a deploy is a deployer permission while
   * changing variables means editing the project (admin), so a deployer must
   * not be able to point a run elsewhere (e.g. `CUSTOMER=B`) at trigger time.
   *
   * @param {object} [_params] - deploy parameters; deliberately unused.
   */
  async trigger(_params) {
    if (this.aborted) throw this._error('Deployment was aborted before the pipeline was triggered.');

    const variables = { ...this.ciConfig.variables };
    const problems = validateCiVariables(variables);
    if (problems.length > 0) {
      throw this._error(`Invalid CI variables: ${problems.map((problem) => problem.message).join(' ')}`);
    }

    const keys = Object.keys(variables);
    this.log(
      `Triggering ${this.client.runLabel} '${this.ciConfig.pipeline}' on ${this._refText()} ` +
        `with variables: ${keys.length > 0 ? keys.join(', ') : '(none)'}`
    );

    let result;
    try {
      result = await this.client.trigger({ variables, correlationId: crypto.randomUUID() });
    } catch (err) {
      throw this._error(`Failed to trigger ${this.client.runLabel}: ${err.message}`);
    }

    this.runId = result.runId;
    this.runNumber = result.runNumber ?? null;
    this.webUrl = result.webUrl || null;
    this._startedAt = Date.now();

    if (result.matchedBy === 'heuristic') {
      this.log(
        '⚠ GitHub did not return the run id; matched the newest workflow_dispatch run created just now. ' +
          'Matching is heuristic — set a "Correlation input" for exact matching.'
      );
    }
    this.log(`Triggered ${this.client.runLabel} #${this._runRef()} on ${this.ciConfig.ref}: ${this.webUrl || '(no link)'}`);

    // abort() may have run while the (deliberately non-abortable) trigger was in flight.
    if (this.aborted) {
      await this._requestCancel();
      throw this._abortedError();
    }

    return assertTriggerResult(
      { runId: this.runId, runNumber: this.runNumber, url: this.webUrl, status: 'started' },
      'CiPipelineAdapter'
    );
  }

  /**
   * Polls the run until it finishes. Resolves only when it succeeded;
   * throws on failure, cancellation, abort, repeated errors, or timeout
   * (a timeout never cancels the run).
   *
   * @param {(line: string) => void} callback - receives raw CI log lines, `[CI] `-prefixed.
   */
  async streamLogs(callback) {
    if (!this.runId) throw this._error('No pipeline run to watch — trigger() did not complete.');

    const emit = (line) => callback(this._scrub(`[CI] ${line}`));
    const deadline = this._startedAt + this._timeoutMs;
    const episode = { queuedLogged: false, waitingLogged: false };
    let intervalMs = this._pollIntervalMs;
    let failures = 0;

    for (let tick = 0; ; tick += 1) {
      if (this.aborted) throw this._abortedError();

      let run = null;
      let delayMs = intervalMs;
      try {
        run = await this._pollOnce(emit, tick);
        failures = 0;
      } catch (err) {
        if (this.aborted || (err && err.aborted)) throw this._abortedError();
        if (!isTransientError(err)) {
          throw this._error(`Could not read the status of pipeline #${this._runRef()}: ${err.message}`);
        }
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          throw this._error(
            `Giving up on pipeline #${this._runRef()} after ${failures} consecutive errors (${err.message}). ` +
              `It was NOT cancelled: ${this.webUrl || ''}`.trim()
          );
        }
        delayMs = Math.min(intervalMs * 2 ** (failures - 1), MAX_POLL_DELAY_MS);
        if (err.retryAfterMs) delayMs = Math.max(delayMs, err.retryAfterMs);
        this.log(`⚠ Polling failed (${err.message}); retrying in ${formatDuration(delayMs)} (${failures}/${MAX_CONSECUTIVE_POLL_FAILURES}).`);
      }

      if (run && (await this._handleRunPhase(run, emit, episode)) === 'done') {
        // Never report success once abort() ran: DeploymentManager already marked the deploy aborted.
        if (this.aborted) throw this._abortedError();
        return;
      }

      if (this.client.consumeNearLimit() && intervalMs < MAX_POLL_DELAY_MS) {
        intervalMs = Math.min(intervalMs * 2, MAX_POLL_DELAY_MS);
        this.log(`⚠ API rate limit nearly reached — polling every ${formatDuration(intervalMs)} from now on.`);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const minutes = Math.round((this._timeoutMs / 60_000) * 100) / 100;
        throw this._error(
          `Pipeline #${this._runRef()} still running after ${minutes} min; IDP stopped watching but did NOT cancel it: ${this.webUrl || ''}`.trim()
        );
      }
      await this._sleep(Math.min(delayMs, remaining));
    }
  }

  /**
   * One poll tick: steps (+ their new log lines), then the run status — every
   * tick while no step is running, otherwise every STATUS_EVERY_N_TICKS-th.
   * @returns {Promise<object|null>} the run status, or null when skipped this tick.
   */
  async _pollOnce(emit, tick) {
    const steps = await this.client.listSteps(this.runId);
    await this._processSteps(steps, emit, false);
    const anyRunning = steps.some((step) => step.phase === 'running');
    if (anyRunning && tick % STATUS_EVERY_N_TICKS !== 0) return null;
    return this.client.getRun(this.runId);
  }

  /** @returns {Promise<'done'|undefined>} 'done' on success; throws on any other terminal phase. */
  async _handleRunPhase(run, emit, episode) {
    if (run.phase !== 'waiting') episode.waitingLogged = false;
    const ref = this._runRef();

    switch (run.phase) {
      case 'queued':
        if (!episode.queuedLogged) {
          episode.queuedLogged = true;
          this.log(`⏳ Pipeline #${ref} is queued — waiting for a runner.`);
        }
        return undefined;
      case 'waiting':
        if (!episode.waitingLogged) {
          episode.waitingLogged = true;
          this.log(WAITING_MESSAGES[this.ciConfig.platform]);
        }
        return undefined;
      case 'succeeded': {
        await this._finalFlush(emit);
        // _finalFlush() swallows an abort that lands during it; don't turn that into a success.
        if (this.aborted) throw this._abortedError();
        const duration = formatDuration(Date.now() - this._startedAt);
        this.log(`✓ Pipeline #${ref} succeeded (${duration}) ${this.webUrl || ''}`.trim());
        return 'done';
      }
      case 'failed':
        await this._finalFlush(emit);
        throw this._error(`Pipeline #${ref} finished with status: ${run.detail}`);
      case 'cancelled':
        await this._finalFlush(emit);
        throw this.aborted ? this._abortedError() : this._error(`Pipeline #${ref} was cancelled outside IDP.`);
      default:
        return undefined;
    }
  }

  /** Re-reads the steps once the run is over so no trailing log line is lost. */
  async _finalFlush(emit) {
    this._finalLogWaitUntil = Date.now() + MAX_FINAL_LOG_WAIT_MS;
    try {
      const steps = await this.client.listSteps(this.runId);
      await this._processSteps(steps, emit, true);
    } catch (err) {
      if (err && err.aborted) return;
      this.log(`⚠ Could not fetch the final pipeline logs: ${err.message}`);
    }
  }

  /** Emits step transitions and new log lines, in step order. */
  async _processSteps(steps, emit, final) {
    for (const step of steps) {
      const state = this._stepState(step.id);
      if (step.phase === 'running' && !state.started) {
        state.started = true;
        this.log(`▶ ${step.name} started`);
      }
      if (Array.isArray(step.substeps)) this._emitSubsteps(step, state);

      const terminal = TERMINAL_PHASES.has(step.phase);
      if (step.phase === 'skipped') state.logDone = true;
      if (!state.logDone && (terminal || step.phase === 'running')) {
        await this._readStepLogs(step, state, emit, final);
      }
      if (terminal && !state.finished && (state.logDone || final)) {
        state.finished = true;
        this.log(finishedLine(step.name, step.phase, durationBetween(step.startedAt, step.completedAt), true));
      }
    }
  }

  /** GitHub only: progress lines for each job step transition. */
  _emitSubsteps(step, state) {
    for (const sub of step.substeps) {
      const key = sub.number ?? sub.name;
      const seen = state.substeps.get(key) || { started: false, finished: false };
      const label = `${step.name} › ${sub.name}`;
      if (sub.phase === 'running' && !seen.started) {
        seen.started = true;
        this.log(`▶ ${label}`);
      }
      if (TERMINAL_PHASES.has(sub.phase) && !seen.finished) {
        seen.finished = true;
        this.log(finishedLine(label, sub.phase, durationBetween(sub.startedAt, sub.completedAt), false));
      }
      state.substeps.set(key, seen);
    }
  }

  /**
   * Reads new log lines for one step: a single read per tick while it runs,
   * until the end once it finished. In the final flush an empty or
   * not-yet-available read is retried after an (abortable) wait, since the
   * log may still be archiving; all waits of one flush share
   * MAX_FINAL_LOG_WAIT_MS. Log failures never fail the deploy — the run
   * status is what decides success.
   */
  async _readStepLogs(step, state, emit, final) {
    const terminal = TERMINAL_PHASES.has(step.phase);
    const maxReads = terminal ? MAX_LOG_READS_PER_FINISHED_STEP : 1;
    try {
      for (let read = 0; read < maxReads && !state.logDone && !this.aborted; read += 1) {
        const result = await this.client.readStepLog(this.runId, step, state.cursor);
        state.cursor = result.cursor;
        for (const line of result.lines) emit(line);
        if (result.done) {
          state.logDone = true;
        } else if (result.lines.length === 0) {
          // Nothing yet: retry next tick — or, in the final flush, after a short wait.
          if (!final || read + 1 >= maxReads || Date.now() >= this._finalLogWaitUntil) break;
          await this._sleep(this._logRetryIntervalMs);
        }
      }
    } catch (err) {
      if (this.aborted || (err && err.aborted)) throw err;
      if (!state.logWarned) {
        state.logWarned = true;
        this.log(`⚠ Could not read the log of '${step.name}': ${err.message}`);
      }
      if (!isTransientError(err)) this._finishLog(state, emit);
    }
    if (final && terminal && !state.logDone) this._finishLog(state, emit);
  }

  /** Gives up on a step's log without the client saying it ended: emit the buffered partial last line first. */
  _finishLog(state, emit) {
    state.logDone = true;
    for (const line of this.client.flushPending(state.cursor)) emit(line);
  }

  _stepState(id) {
    let state = this._steps.get(id);
    if (!state) {
      state = { started: false, finished: false, logDone: false, logWarned: false, cursor: null, substeps: new Map() };
      this._steps.set(id, state);
    }
    return state;
  }

  /**
   * Stops watching and cancels the run (if one was created). Idempotent,
   * always resolves, never throws — including when the cancel call fails.
   */
  async abort() {
    if (this._aborting) return;
    this._aborting = true;
    this.aborted = true;
    try {
      this._abortController.abort();
      if (this.runId) {
        await this._requestCancel();
      } else {
        this.log('Abort requested before a pipeline run was created.');
      }
    } catch (err) {
      // Defensive: abort() must never reject.
      console.error('[CI] Unexpected error during abort:', this._scrub(String(err && err.message)));
    }
  }

  /** Sends the cancel request at most once per deployment; failures are only logged. */
  async _requestCancel() {
    if (this._cancelRequested || !this.runId) return;
    this._cancelRequested = true;
    this.log(`■ Cancel requested for pipeline #${this._runRef()}`);
    try {
      await this.client.cancel(this.runId);
    } catch (err) {
      this.log(`⚠ Failed to cancel pipeline #${this._runRef()}: ${err.message}`);
    }
  }

  /**
   * Abortable sleep: resolves after `ms`, or immediately once abort() fires.
   * (Unlike a bare setTimeout whose timer gets cleared, it can never be left
   * pending forever — which would hang the deploy and its project lock.)
   */
  _sleep(ms) {
    const { signal } = this._abortController;
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  _refText() {
    const { platform, refType, ref } = this.ciConfig;
    return platform === 'bitbucket' ? `${refType} '${ref}'` : `'${ref}'`;
  }

  _runRef() {
    return this.runNumber ?? this.runId;
  }

  _abortedError() {
    return this._error(`Pipeline #${this._runRef() ?? '?'} was aborted.`);
  }

  _error(message) {
    return new Error(this._scrub(String(message)));
  }
}

module.exports = CiPipelineAdapter;
module.exports.formatDuration = formatDuration;
