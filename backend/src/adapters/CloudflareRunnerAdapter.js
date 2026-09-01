const DeploymentAdapter = require('./DeploymentAdapter');
const { assertTriggerResult } = DeploymentAdapter;
const { fetch } = require('undici');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const DEFAULT_API_URL = 'https://idp-runner-api.bariskoc-249.workers.dev';

class CloudflareRunnerAdapter extends DeploymentAdapter {
  constructor(config) {
    super(config);
    this.apiBaseUrl = String(config.runnerApiBaseUrl || process.env.IDP_RUNNER_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
    this.adminApiKey = config.runnerAdminApiKey || process.env.IDP_RUNNER_ADMIN_API_KEY;
    this.agentId = config.runnerAgentId;
    this.timeoutSeconds = Number(config.runnerTimeoutSeconds || 900);
    this.script = config.scriptContent;
    this.pollIntervalMs = Number(config.runnerPollIntervalMs || 2000);
    this.aborted = false;
    this.jobId = null;
    this.lastSequence = -1;
    this.logPrefix = '[Runner]';
  }

  async connect() {
    if (!this.adminApiKey) throw new Error('Cloudflare runner administrator credential is not configured in secure storage.');
    if (!/^[a-f0-9-]{36}$/i.test(String(this.agentId || ''))) throw new Error('A valid Cloudflare runner Agent ID is required.');
    if (!this.script || !this.script.trim()) throw new Error('PowerShell deploy script is empty.');
    if (!Number.isInteger(this.timeoutSeconds) || this.timeoutSeconds < 1 || this.timeoutSeconds > 3600) {
      throw new Error('Runner timeout must be between 1 and 3600 seconds.');
    }
    const response = await fetch(`${this.apiBaseUrl}/health`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Runner API health check failed (${response.status}).`);
    this.log(`Cloudflare runner API connected; target agent ${this.agentId}.`);
  }

  async trigger() {
    const created = await this._request('/v1/admin/jobs/script', {
      method: 'POST',
      body: JSON.stringify({ agentId: this.agentId, script: this.script, timeoutSeconds: this.timeoutSeconds }),
    });
    this.jobId = created.jobId;
    this.log(`Job ${this.jobId} queued.`);
    if (this.aborted) {
      await this._cancelRemoteJob();
      throw new Error('Runner deployment aborted by user.');
    }

    const deadline = Date.now() + (this.timeoutSeconds + 90) * 1000;
    while (!this.aborted && Date.now() < deadline) {
      const state = await this._request(`/v1/admin/jobs/${this.jobId}`);
      this._emitNewLogs(state.logs || []);
      const status = state.job?.status;
      if (TERMINAL.has(status)) {
        if (status !== 'succeeded' || state.job.exit_code !== 0) {
          throw new Error(`Runner job ${status} (exit code ${state.job.exit_code ?? 'unknown'}, ${state.job.error_code || 'no error code'}).`);
        }
        this.log(`Job ${this.jobId} completed successfully.`);
        return assertTriggerResult({ status: 'Succeeded' }, 'CloudflareRunnerAdapter');
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    if (this.aborted) throw new Error('Runner deployment aborted by user.');
    throw new Error(`Runner job status was not finalized within ${this.timeoutSeconds + 90} seconds.`);
  }

  _emitNewLogs(logs) {
    for (const entry of logs) {
      if (entry.sequence <= this.lastSequence) continue;
      this.lastSequence = entry.sequence;
      const tag = entry.stream === 'stderr' ? '[Runner:stderr]' : '[Runner:stdout]';
      for (const line of String(entry.content || '').split(/\r?\n/)) {
        if (line) this.log(`${tag} ${line}`);
      }
    }
  }

  async _request(path, options = {}) {
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${this.adminApiKey}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Runner API ${response.status}: ${body.message || body.error || 'request failed'}`);
    return body;
  }

  async abort() {
    if (this.aborted) return;
    this.aborted = true;
    if (this.jobId) {
      await this._cancelRemoteJob();
      this.log(`Cancellation requested for runner job ${this.jobId}.`);
    } else {
      this.log('Runner deployment aborted before queueing.');
    }
  }

  async _cancelRemoteJob() {
    try {
      await this._request(`/v1/admin/jobs/${this.jobId}/cancel`, { method: 'POST', body: '{}' });
    } catch (error) {
      if (!/job_already_terminal/.test(error.message)) throw error;
    }
  }
}

module.exports = CloudflareRunnerAdapter;
