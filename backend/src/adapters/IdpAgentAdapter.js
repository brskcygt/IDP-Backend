'use strict';

const DeploymentAdapter = require('./DeploymentAdapter');
const { assertTriggerResult } = DeploymentAdapter;
const AgentGatewayClient = require('../services/agent/AgentGatewayClient');

class IdpAgentAdapter extends DeploymentAdapter {
  constructor(config) {
    super(config);
    this.agentId = String(config.agentId || '').trim();
    this.timeoutMs = Number(config.agentCommandTimeoutSeconds || 180) * 1000;
    this.client = new AgentGatewayClient({
      baseUrl: config.agentApiBaseUrl,
      token: config.agentApiToken,
    });
    this.unsubscribe = null;
    this.finish = null;
    this.aborted = false;
    this.logPrefix = '[Agent]';
  }

  async connect() {
    if (!this.agentId) throw new Error('A target agent must be selected.');
    const agents = await this.client.listAgents();
    if (!agents.some((agent) => agent.id === this.agentId)) {
      throw new Error(`Agent ${this.agentId} is not connected.`);
    }
    this.log(`Connected agent selected: ${this.agentId}.`);
  }

  async trigger() {
    if (this.aborted) throw new Error('Agent deployment aborted by user.');

    return new Promise((resolve, reject) => {
      let commandSent = false;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.finish = null;
        if (error) reject(error);
        else resolve(assertTriggerResult({ status: 'Succeeded' }, 'IdpAgentAdapter'));
      };
      const timeout = setTimeout(() => finish(new Error('Agent update command timed out.')), this.timeoutMs);
      this.finish = finish;

      this.unsubscribe = this.client.subscribe(this.agentId, {
        onOpen: async () => {
          if (commandSent) return;
          commandSent = true;
          try {
            const commands = String(this.config.scriptContent || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
            for (const command of commands) {
              const safeCommand = command.replace(/((?:password|token|secret|api[_-]?key)\s*[=:]\s*)([^\s;]+)/ig, '$1[REDACTED]');
              this.log(`[Agent:Command] $ ${safeCommand}`);
            }
            await this.client.sendDeploy(this.agentId, this.config.scriptContent);
            this.log('Deployment command sent.');
          } catch (error) {
            finish(error);
          }
        },
        onMessage: (message) => {
          if (message.agentId && message.agentId !== this.agentId) return;
          const payload = typeof message.payload === 'object' && message.payload ? message.payload : {};
          if (message.process === 'download_file_progress') {
            this.log(`Download progress: ${payload.progress ?? payload.percentage ?? '?'}%`);
          } else if (message.process === 'app_logs') {
            const logs = Array.isArray(payload.logs) ? payload.logs : String(payload.logs || '').split(/\r?\n/);
            for (const line of logs) if (line) this.log(String(line));
          } else if (message.process === 'command_execution_result') {
            if (payload.output) this.log(String(payload.output));
            if (payload.success === false) finish(new Error(String(payload.output || 'Agent command failed.')));
            else finish();
          } else if (message.process === 'current_version') {
            this.log(`Application version: ${payload.version || 'unknown'}.`);
            finish();
          }
        },
        onError: (error) => finish(error instanceof Error ? error : new Error(String(error))),
        onClose: () => {
          if (!this.aborted) finish(new Error('Agent WebSocket connection closed before completion.'));
        },
      });
    });
  }

  async abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.finish?.(new Error('Agent deployment aborted by user.'));
    this.log('Local wait cancelled. The current agent protocol has no remote cancellation command.');
  }
}

module.exports = IdpAgentAdapter;
