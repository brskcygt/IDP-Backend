const DeploymentAdapter = require('./DeploymentAdapter');
const { assertTriggerResult } = DeploymentAdapter;
const { jenkinsJobPath } = require('./jenkinsPaths');
const { consoleLines } = require('./jenkinsConsole');
const { buildPercent } = require('./jenkinsProgress');
const { formatEventLine, BUILD_PROGRESS_EVENT } = require('../core/deployment/progressEvents');
const axios = require('axios');

/**
 * JenkinsAdapter — Production-grade Jenkins CI integration.
 * 
 * Capabilities:
 * 1. Trigger a parameterized build via POST /job/{name}/buildWithParameters
 * 2. Poll the Jenkins Queue to resolve the actual Build Number
 * 3. Stream real-time console output via /logText/progressiveText
 * 4. Abort a running build via /stop
 *
 * With `jobType: 'multibranch'`, `jobName` is a Multibranch Pipeline and the
 * build runs in the child job of `branch` (falling back to `defaultBranch`,
 * then 'main'). A branch Jenkins has not discovered yet triggers a repository
 * scan first; see resolveBranchJob().
 */
class JenkinsAdapter extends DeploymentAdapter {
  constructor(config) {
    super(config);
    this.buildNumber = null;
    this.queueId = null;
    this.aborted = false;
    this._aborting = false;
    this._pollTimer = null;
    this._logTimer = null;
    /** Resolves the sleep in progress, if any (see _sleep / abort). */
    this._wake = null;

    // (T-57) JenkinsAdapter is the one adapter with a genuine, separate
    // post-trigger log stream (Jenkins' progressiveText API) — see
    // streamLogs() below.
    this.supportsLogStreaming = true;
    this.logPrefix = '[Jenkins]';

    // The job builds run in: the configured one, or for a multibranch job the
    // branch child that resolveBranchJob() picks.
    this.jobName = this.config.jobName;
    this.multibranch = this.config.jobType === 'multibranch';
    this.branchJobResolved = false;
    const timing = this.config.timing || {};
    this.scanTimeoutMs = timing.scanTimeoutMs ?? 120_000;
    this.scanPollMs = timing.scanPollMs ?? 3_000;

    // Build axios instance with Jenkins auth
    this.client = axios.create({
      baseURL: this.config.url,
      auth: (this.config.username && this.config.apiToken)
        ? { username: this.config.username, password: this.config.apiToken }
        : undefined,
      timeout: 15000,
      // Jenkins often uses self-signed certs in internal networks
      // In production, configure proper CA certs instead
    });
  }

  /**
   * Phase 1: Verify connectivity by hitting the Jenkins API root.
   */
  async connect() {
    this.log(`Connecting to Jenkins at ${this.config.url}...`);

    if (this.config.username && this.config.apiToken) {
      this.log(`Authenticating as user: ${this.config.username}`);
    } else {
      this.log(`⚠ WARNING: No credentials provided. Connecting anonymously.`);
    }

    try {
      const res = await this.client.get('/api/json', { timeout: 10000 });
      this.log(`✓ Connected to Jenkins v${res.data?.description || 'unknown'}`);
    } catch (err) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        throw new Error(`Cannot reach Jenkins at ${this.config.url}. Is it running?`);
      }
      if (err.response?.status === 401 || err.response?.status === 403) {
        throw new Error(`Jenkins authentication failed. Check username/apiToken.`);
      }
      // For other errors (e.g. 404 on /api/json), still allow — some setups don't expose this
      this.log(`⚠ Could not verify Jenkins API (${err.message}). Proceeding anyway.`);
    }
  }

  /**
   * Phase 2: Trigger a parameterized build and resolve the Build Number.
   * 
   * Jenkins flow:
   *   POST /job/{name}/buildWithParameters → 201 + Location header (queue URL)
   *   Poll queue URL/api/json until `executable.number` is present
   */
  async trigger(params) {
    if (this.multibranch && !this.branchJobResolved) {
      await this.resolveBranchJob(this.config.branch || this.config.defaultBranch || 'main');
    }
    const jobPath = this._jobPath();
    this.log(`Triggering job "${this.jobName}" with params: ${JSON.stringify(params)}`);

    try {
      // 1. Trigger the build
      const triggerUrl = `${jobPath}/buildWithParameters`;
      const res = await this.client.post(triggerUrl, null, {
        params: params || {},
        validateStatus: (status) => status < 400,
      });

      // Jenkins returns 201 with Location header pointing to queue item
      const locationHeader = res.headers?.location || '';
      const queueMatch = locationHeader.match(/\/queue\/item\/(\d+)/);

      if (queueMatch) {
        this.queueId = queueMatch[1];
        this.log(`Build queued. Queue ID: ${this.queueId}`);
      } else {
        // Fallback: try to extract from response
        this.log(`Build triggered (no queue ID in response). Falling back to latest build.`);
      }

      // 2. Poll to resolve Build Number
      this.buildNumber = await this._pollForBuildNumber();
      // Aborted while the queue item was turning into a build: abort() found
      // no build number then, so the build it was cancelling is stopped here.
      if (this.aborted) {
        await this._stopBuild();
        throw new Error(`Build #${this.buildNumber} was aborted.`);
      }
      this.log(`✓ Build #${this.buildNumber} started.`);

      return assertTriggerResult({ buildNumber: this.buildNumber, status: 'started' }, 'JenkinsAdapter');
    } catch (err) {
      if (err.response?.status === 404) {
        throw new Error(`Jenkins job "${this.jobName}" not found. Check the job name.`);
      }
      throw new Error(`Failed to trigger Jenkins build: ${err.message}`);
    }
  }

  /**
   * Multibranch: points this adapter at the child job of `ref`.
   *
   * Jenkins creates a child per branch (and per tag, when tag discovery is on)
   * only when it scans the repository, so a branch pushed a minute ago — a
   * composed preview branch, typically — has no job yet. Asking for a scan and
   * waiting for the child is what lets IDP build it without a trip to Jenkins.
   *
   * A new child also does not know its parameters until its Jenkinsfile has
   * run once (the `parameters { }` block registers them), and buildWithParameters
   * on a job without parameters fails. Jenkins builds a newly discovered branch
   * on its own; this waits for that run rather than starting a parameterless
   * build itself, which could publish something under the Jenkinsfile's defaults.
   */
  async resolveBranchJob(ref) {
    const parent = this.config.jobName;
    const parentPath = jenkinsJobPath(parent);

    let child = await this._findBranchJob(parentPath, ref);
    if (!child) {
      this.log(`No job for '${ref}' in "${parent}" yet — asking Jenkins to scan the repository...`);
      await this.client.post(`${parentPath}/build`, null, {
        params: { delay: '0' },
        validateStatus: (status) => status < 400,
      });
      child = await this._pollUntil(() => this._findBranchJob(parentPath, ref));
      if (!child) {
        throw new Error(
          `"${parent}" has no job for '${ref}' even after a repository scan. Check that the repository it scans has this branch, and for a tag that tag discovery is enabled.`
        );
      }
    }

    this.jobName = `${parent}/${child.name}`;
    this.log(`Building in "${parent}" » ${child.displayName || ref}.`);
    await this._waitForParameters(ref);
    this.branchJobResolved = true;
  }

  /** The child job of a multibranch project whose branch/tag is `ref`, or null. */
  async _findBranchJob(parentPath, ref) {
    const { data } = await this.client.get(`${parentPath}/api/json`, {
      params: { tree: '_class,jobs[name,displayName]' },
    });
    if (!/MultiBranch/i.test(String(data?._class || ''))) {
      throw new Error(`"${this.config.jobName}" is not a Multibranch Pipeline job — set the job type to standard in project settings.`);
    }
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    // Jenkins names the child with the branch URL-encoded (feature/x → feature%2Fx)
    // and shows the real name as its display name.
    return (
      jobs.find((job) => job.name === ref) ||
      jobs.find((job) => job.displayName === ref || safeDecode(job.name) === ref) ||
      null
    );
  }

  async _waitForParameters(ref) {
    let waitingLogged = false;
    const found = await this._pollUntil(async () => {
      const { data } = await this.client.get(`${this._jobPath()}/api/json`, {
        params: { tree: 'inQueue,lastBuild[number,building],property[parameterDefinitions[name]]' },
      });
      const definitions = (data?.property || []).flatMap((property) => property?.parameterDefinitions || []);
      if (definitions.length > 0) return true;
      const busy = data?.inQueue || data?.lastBuild?.building;
      if (!busy && data?.lastBuild) {
        throw new Error(
          `The job for '${ref}' declares no parameters — the Jenkinsfile on that branch needs a parameters { } block with VERSION.`
        );
      }
      if (!waitingLogged) {
        waitingLogged = true;
        this.log(`Waiting for the first run of '${ref}' so Jenkins learns its parameters...`);
      }
      return null;
    });
    if (!found) {
      throw new Error(
        `The job for '${ref}' has never run, so Jenkins does not know its parameters yet. Run it once in Jenkins (it stops at "VERSION parameter is required"), then build again.`
      );
    }
  }

  /** Calls `probe` until it returns something truthy or the scan timeout passes. */
  async _pollUntil(probe) {
    const deadline = Date.now() + this.scanTimeoutMs;
    for (;;) {
      if (this.aborted) throw new Error('Build aborted while waiting for Jenkins.');
      const result = await probe();
      if (result) return result;
      if (Date.now() >= deadline) return null;
      await this._sleep(this.scanPollMs);
    }
  }

  _jobPath() {
    return jenkinsJobPath(this.jobName);
  }

  /**
   * Poll the Jenkins queue until the build gets an executor and we have a build number.
   * Timeout after 60s to avoid infinite waiting.
   */
  async _pollForBuildNumber() {
    const maxAttempts = 30;
    const pollIntervalMs = 2000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.aborted) throw new Error('Build aborted while waiting in queue.');

      try {
        if (this.queueId) {
          const res = await this.client.get(`/queue/item/${this.queueId}/api/json`);
          const data = res.data;

          if (data.cancelled) {
            throw new Error('Build was cancelled in the Jenkins queue.');
          }

          if (data.executable?.number) {
            return data.executable.number;
          }

          // Log why we're still waiting
          const reason = data.why || 'Waiting for executor...';
          if (attempt % 5 === 0) {
            this.log(`⏳ Queue: ${reason} (attempt ${attempt}/${maxAttempts})`);
          }
        } else {
          // No queue ID — try fetching the latest build number
          const jobPath = this._jobPath();
          const res = await this.client.get(`${jobPath}/lastBuild/api/json`);
          if (res.data?.number) {
            return res.data.number;
          }
        }
      } catch (err) {
        // Queue item might not be ready yet, keep polling
        if (attempt % 5 === 0) {
          this.log(`⏳ Waiting for build to start... (attempt ${attempt}/${maxAttempts})`);
        }
      }

      await this._sleep(pollIntervalMs);
    }

    throw new Error(`Timed out waiting for Jenkins build number after ${maxAttempts * pollIntervalMs / 1000}s.`);
  }

  /**
   * Phase 3: Stream real-time console output using Jenkins' progressive text API.
   * 
   * Jenkins exposes /logText/progressiveText which returns text chunks and
   * an X-Text-Size header indicating where to resume from.
   */
  async streamLogs(callback) {
    if (!this.buildNumber) {
      callback('[Jenkins] No build number available — cannot stream logs.');
      return;
    }

    const jobPath = this._jobPath();
    let textOffset = 0;
    let reportedPercent = null;

    while (!this.aborted) {
      try {
        // 1. Fetch progressive text
        const res = await this.client.get(
          `${jobPath}/${this.buildNumber}/logText/progressiveText`,
          {
            params: { start: textOffset },
            headers: { Accept: 'text/plain' },
            responseType: 'text' // Prevent axios from parsing text as JSON
          }
        );

        const text = res.data || '';
        const newOffset = parseInt(res.headers['x-text-size'] || '0', 10);
        const moreData = res.headers['x-more-data'] === 'true';

        if (text && text.length > 0 && newOffset > textOffset) {
          // consoleLines drops Jenkins' ConsoleNote markers (see jenkinsConsole.js).
          for (const line of consoleLines(text.toString())) {
            callback(`[Jenkins] ${line}`);
          }
          textOffset = newOffset;
        }

        // 2. Fetch build status
        const statusRes = await this.client.get(`${jobPath}/${this.buildNumber}/api/json`);
        const buildInfo = statusRes.data;

        // 2b. Report an elapsed-vs-estimate percentage so the UI can show a
        // real bar instead of an indeterminate one. Only on change, otherwise
        // this would emit an event on every 1.5 s poll.
        const percent = buildPercent(buildInfo);
        if (percent !== null && percent !== reportedPercent) {
          reportedPercent = percent;
          callback(formatEventLine(BUILD_PROGRESS_EVENT, {
            stage: 'building',
            status: 'progress',
            progress: percent,
            message: `Build #${this.buildNumber} — estimated ${Math.round(buildInfo.estimatedDuration / 1000)}s`
          }));
        }

        // If the build is no longer running and no more data is available in the progressive log stream
        if (buildInfo.building === false && !moreData) {
          if (buildInfo.result === 'SUCCESS') {
            callback(formatEventLine(BUILD_PROGRESS_EVENT, {
              stage: 'building', status: 'done', progress: 100, message: `Build #${this.buildNumber} finished`
            }));
            callback(`[Jenkins] Build #${this.buildNumber} finished with status: SUCCESS`);
            return;
          } else {
            throw new Error(`Build #${this.buildNumber} finished with status: ${buildInfo.result || 'UNKNOWN'}`);
          }
        }

        // Wait before polling again
        await this._sleep(1500);

      } catch (err) {
        // If we threw the error because the build failed, bubble it up to mark deployment failed
        if (err.message.includes('finished with status')) {
          throw err;
        }
        
        callback(`[Jenkins] ⚠ Error streaming logs: ${err.message}. Retrying...`);
        await this._sleep(3000);
      }
    }

    if (this.aborted) {
      throw new Error(`Build #${this.buildNumber} was aborted.`);
    }
  }

  /**
   * Phase 4: Abort a running build.
   *
   * (T-57) Idempotent: a second call is a safe no-op — it must never throw,
   * and must not re-send the stop signal to Jenkins.
   */
  async abort() {
    if (this._aborting) return;
    this._aborting = true;
    this.aborted = true;

    if (this._pollTimer) clearTimeout(this._pollTimer);
    if (this._logTimer) clearTimeout(this._logTimer);
    // Wake whatever is sleeping between polls. Clearing the timer alone left
    // that promise pending forever: the deploy never finished, the project
    // stayed "running" and its lock was never released.
    this._wakeSleeper();

    if (this.buildNumber) {
      await this._stopBuild();
    } else if (this.queueId) {
      // Still queued: without this Jenkins starts the build anyway, later.
      try {
        await this.client.post('/queue/cancelItem', null, {
          params: { id: this.queueId },
          validateStatus: (status) => status < 500,
        });
        this.log(`✓ Queued build (queue item ${this.queueId}) cancelled on Jenkins.`);
      } catch (err) {
        this.log(`⚠ Failed to cancel the queued build on Jenkins: ${err.message}`);
      }
    } else {
      this.log(`Build aborted before it reached Jenkins.`);
    }
  }

  async _stopBuild() {
    try {
      await this.client.post(`${this._jobPath()}/${this.buildNumber}/stop`);
      this.log(`✓ Build #${this.buildNumber} abort signal sent to Jenkins.`);
    } catch (err) {
      this.log(`⚠ Failed to abort build on Jenkins: ${err.message}`);
    }
  }

  _wakeSleeper() {
    const wake = this._wake;
    this._wake = null;
    if (wake) wake();
  }

  /** Utility: promisified sleep that abort() cuts short. */
  _sleep(ms) {
    if (this.aborted) return Promise.resolve();
    return new Promise(resolve => {
      this._wake = resolve;
      this._pollTimer = setTimeout(() => this._wakeSleeper(), ms);
    });
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

module.exports = JenkinsAdapter;
