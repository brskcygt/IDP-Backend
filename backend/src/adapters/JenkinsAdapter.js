const DeploymentAdapter = require('./DeploymentAdapter');
const { assertTriggerResult } = DeploymentAdapter;
const { jenkinsJobPath } = require('./jenkinsPaths');
const axios = require('axios');

/**
 * JenkinsAdapter — Production-grade Jenkins CI integration.
 * 
 * Capabilities:
 * 1. Trigger a parameterized build via POST /job/{name}/buildWithParameters
 * 2. Poll the Jenkins Queue to resolve the actual Build Number
 * 3. Stream real-time console output via /logText/progressiveText
 * 4. Abort a running build via /stop
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

    // (T-57) JenkinsAdapter is the one adapter with a genuine, separate
    // post-trigger log stream (Jenkins' progressiveText API) — see
    // streamLogs() below.
    this.supportsLogStreaming = true;
    this.logPrefix = '[Jenkins]';

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
    const jobPath = jenkinsJobPath(this.config.jobName);
    this.log(`Triggering job "${this.config.jobName}" with params: ${JSON.stringify(params)}`);

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
      this.log(`✓ Build #${this.buildNumber} started.`);

      return assertTriggerResult({ buildNumber: this.buildNumber, status: 'started' }, 'JenkinsAdapter');
    } catch (err) {
      if (err.response?.status === 404) {
        throw new Error(`Jenkins job "${this.config.jobName}" not found. Check the job name.`);
      }
      throw new Error(`Failed to trigger Jenkins build: ${err.message}`);
    }
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
          const jobPath = jenkinsJobPath(this.config.jobName);
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

    const jobPath = jenkinsJobPath(this.config.jobName);
    let textOffset = 0;

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
          const lines = text.toString().split('\n').filter(l => l.length > 0);
          for (const line of lines) {
            callback(`[Jenkins] ${line}`);
          }
          textOffset = newOffset;
        }

        // 2. Fetch build status
        const statusRes = await this.client.get(`${jobPath}/${this.buildNumber}/api/json`);
        const buildInfo = statusRes.data;

        // If the build is no longer running and no more data is available in the progressive log stream
        if (buildInfo.building === false && !moreData) {
          if (buildInfo.result === 'SUCCESS') {
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

    if (this.buildNumber) {
      const jobPath = jenkinsJobPath(this.config.jobName);
      try {
        await this.client.post(`${jobPath}/${this.buildNumber}/stop`);
        this.log(`✓ Build #${this.buildNumber} abort signal sent to Jenkins.`);
      } catch (err) {
        this.log(`⚠ Failed to abort build on Jenkins: ${err.message}`);
      }
    } else {
      this.log(`Build aborted (no active build number).`);
    }
  }

  /** Utility: promisified sleep */
  _sleep(ms) {
    return new Promise(resolve => {
      this._pollTimer = setTimeout(resolve, ms);
    });
  }
}

module.exports = JenkinsAdapter;
