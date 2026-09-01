const DeploymentAdapter = require('./DeploymentAdapter');
const { assertTriggerResult } = DeploymentAdapter;
const { NodeSSH } = require('node-ssh');
const fs = require('fs');
const path = require('path');
const { createHostVerifier, DEFAULT_POLICY: DEFAULT_HOST_KEY_POLICY } = require('../services/ssh/hostKeyVerifier');

/**
 * SshServerAdapter — Production-grade SSH deployment adapter.
 *
 * Capabilities:
 * 1. Connect via private key or password authentication
 * 2. Execute chained shell commands on a remote server
 * 3. Stream stdout/stderr in real-time via callback
 * 4. Strict timeout mechanism to kill hung sessions
 */
class SshServerAdapter extends DeploymentAdapter {
  constructor(config) {
    super(config);
    this.ssh = new NodeSSH();
    this.connected = false;
    this.aborted = false;
    this._aborting = false;
    this._timeoutTimer = null;
    this._currentExec = null;

    // (T-57) SSH streams stdout/stderr inline during trigger() via
    // onStdout/onStderr — there is no separate post-trigger log stream, so
    // supportsLogStreaming stays at the base class default (false) and
    // streamLogs() relies on the inherited no-op.
    this.logPrefix = '[SSH]';

    // Default timeout: 5 minutes
    this.timeoutMs = config.timeoutMs || 5 * 60 * 1000;
  }

  /**
   * Phase 1: Establish SSH connection using private key or password.
   * Private key takes priority over password auth.
   */
  async connect() {
    let host = this.config.host || '';
    let port = this.config.port || 22;
    const username = this.config.username;

    // Strip http:// or https:// if user accidentally added it
    if (host.startsWith('http://')) host = host.substring(7);
    if (host.startsWith('https://')) host = host.substring(8);

    // Handle user entering "127.0.0.1:2222" in the host field
    if (host && host.includes(':')) {
      const parts = host.split(':');
      host = parts[0];
      port = parseInt(parts[1], 10) || port;
    }

    this.log(`Initiating SSH connection to ${username}@${host}:${port}...`);

    if (!host || !username) {
      throw new Error('SSH connection requires at least host and username.');
    }

    // SECURITY (SEC-10 / T-17): verify the server's identity instead of
    // silently trusting whatever host key it presents. `hostKeyPolicy` is a
    // per-project setting (config.hostKeyPolicy); 'tofu' (trust-on-first-use)
    // is the default and pins the key on first connect, rejecting any later
    // connection whose key doesn't match. See services/ssh/hostKeyVerifier.js.
    const hostKeyPolicy = this.config.hostKeyPolicy || DEFAULT_HOST_KEY_POLICY;

    const sshConfig = {
      host,
      port,
      username,
      // Prevent the SSH library from hanging indefinitely
      readyTimeout: 15000,
      // Provide automatic keyboard-interactive handler to prevent hanging on stdin
      tryKeyboard: true,
      onKeyboardInteractive: (name, instructions, instructionsLang, prompts, finish) => {
        if (prompts.length > 0 && prompts[0].prompt.toLowerCase().includes('password')) {
          finish([sshConfig.password]);
        } else {
          finish([]);
        }
      },
      hostVerifier: createHostVerifier({
        host,
        port,
        policy: hostKeyPolicy,
        onLog: (line) => this.log(line),
      }),
    };

    // Determine auth method: private key > password
    if (this.config.privateKeyPath) {
      const keyPath = this.config.privateKeyPath.replace(/^~/, process.env.HOME || '/root');
      const resolvedPath = path.resolve(keyPath);

      if (fs.existsSync(resolvedPath)) {
        this.log(`Using private key authentication: ${resolvedPath}`);
        sshConfig.privateKeyPath = resolvedPath;
      } else {
        this.log(`⚠ Private key not found at ${resolvedPath}. Falling back to password auth.`);
        if (this.config.password) {
          sshConfig.password = this.config.password;
        } else {
          throw new Error(`SSH private key not found and no password provided.`);
        }
      }
    } else if (this.config.password) {
      this.log(`Using password authentication for user: ${username}`);
      sshConfig.password = this.config.password;
    } else {
      throw new Error('No SSH authentication method provided. Set privateKeyPath or password.');
    }

    try {
      await this.ssh.connect(sshConfig);
      this.connected = true;
      this.log(`✓ SSH connection established to ${host}.`);
    } catch (err) {
      if (err.message.includes('ECONNREFUSED')) {
        throw new Error(`SSH connection refused by ${host}:${port}. Is the SSH service running?`);
      }
      if (err.message.includes('Authentication failed') || err.message.includes('All configured authentication methods failed')) {
        throw new Error(`SSH authentication failed for ${username}@${host}. Check credentials.`);
      }
      if (err.message.includes('Timed out')) {
        throw new Error(`SSH connection timed out to ${host}:${port}. Check network/firewall.`);
      }
      if (err.message.includes('Host denied') || err.message.toLowerCase().includes('verification failed')) {
        throw new Error(`✗ SSH host key verification failed for ${host}:${port}. The server's identity could not be confirmed — see the log above for the expected vs. received fingerprint. Refusing to connect rather than risk exposing credentials to a machine-in-the-middle.`);
      }
      throw new Error(`SSH connection error: ${err.message}`);
    }
  }

  /**
   * Phase 2: Execute deployment commands on the remote server.
   *
   * Accepts params.commands (string or array) or falls back to a
   * standard deploy sequence: cd {dir} && git pull && npm install && npm run build
   */
  async trigger(params) {
    if (!this.connected) {
      throw new Error('SSH not connected. Call connect() first.');
    }

    const workDir = params.workDir || this.config.workDir || '/opt/app';
    const commands = this._buildCommandChain(params, workDir);

    this.log(`Executing on ${this.config.host} in ${workDir}:`);
    this.log(`$ ${commands}`);

    // Start the timeout watchdog
    this._startTimeout();

    try {
      const result = await this._execWithStreaming(commands);
      this._clearTimeout();

      if (result.code === 0) {
        this.log(`✓ Deployment completed successfully (exit code: 0).`);
        return assertTriggerResult({ status: 'Succeeded', code: result.code }, 'SshServerAdapter');
      } else {
        this.log(`✗ Deployment failed with exit code: ${result.code}`);

        // Never resolve as a success when the remote script failed — surface
        // the failure by throwing so the caller cannot mistake this for a
        // successful deployment.
        const stderrTail = (result.stderr || '')
          .split('\n')
          .filter(line => line.trim().length > 0)
          .slice(-5)
          .join('\n');

        const errorMessage = stderrTail
          ? `Deployment script failed with exit code ${result.code}. Last stderr output:\n${stderrTail}`
          : `Deployment script failed with exit code ${result.code}.`;

        throw new Error(errorMessage);
      }
    } catch (err) {
      this._clearTimeout();
      throw err;
    }
  }

  /**
   * Build a command chain from params or use defaults.
   */
  _buildCommandChain(params, workDir) {
    // If script content is provided via UI settings, execute it directly
    if (this.config.scriptContent && this.config.scriptContent.trim() !== '') {
      return this.config.scriptContent;
    }

    // If explicit commands were provided
    if (params.commands) {
      const cmds = Array.isArray(params.commands) ? params.commands : [params.commands];
      return `cd ${workDir} && ${cmds.join(' && ')}`;
    }

    // Default deployment sequence
    return [
      `cd ${workDir}`,
      'git pull origin main',
      'npm install --production',
      'npm run build',
      'pm2 restart all || systemctl restart app || echo "No process manager found"',
    ].join(' && ');
  }

  /**
   * Execute a command with real-time stdout/stderr streaming.
   */
  async _execWithStreaming(command) {
    return new Promise((resolve, reject) => {
      if (this.aborted) {
        reject(new Error('Execution aborted before start.'));
        return;
      }

      this.ssh.execCommand(command, {
        onStdout: (chunk) => {
          const lines = chunk.toString('utf8').split('\n').filter(l => l.length > 0);
          for (const line of lines) {
            this.log(`[SSH:Bash] ${line}`);
          }
        },
        onStderr: (chunk) => {
          const lines = chunk.toString('utf8').split('\n').filter(l => l.length > 0);
          for (const line of lines) {
            this.log(`[SSH:Bash:stderr] ${line}`);
          }
        },
      }).then((result) => {
        resolve(result);
      }).catch((err) => {
        reject(new Error(`SSH command execution failed: ${err.message}`));
      });
    });
  }

  /**
   * Start a timeout watchdog. If the command hasn't completed
   * within timeoutMs, forcefully disconnect.
   */
  _startTimeout() {
    this._timeoutTimer = setTimeout(() => {
      this.log(`✗ TIMEOUT: Command exceeded ${this.timeoutMs / 1000}s limit. Force disconnecting.`);
      this.abort();
    }, this.timeoutMs);
  }

  _clearTimeout() {
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = null;
    }
  }

  /**
   * Abort: dispose SSH connection and clean up timers.
   *
   * (T-57) Idempotent: a second call is a safe no-op — it must never throw.
   */
  async abort() {
    if (this._aborting) return;
    this._aborting = true;
    this.aborted = true;
    this._clearTimeout();

    if (this.connected) {
      try {
        this.ssh.dispose();
        this.connected = false;
        this.log(`SSH connection disposed.`);
      } catch (err) {
        this.log(`⚠ Error disposing SSH connection: ${err.message}`);
      }
    }
  }
}

module.exports = SshServerAdapter;
