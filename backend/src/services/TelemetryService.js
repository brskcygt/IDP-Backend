const { NodeSSH } = require('node-ssh');
const { runCommand } = require('nodejs-winrm');
const PmpService = require('./vault/PmpService');
const { isServerProvider } = require('../utils/providerUtils');

/**
 * How long a vault-resolved telemetry credential stays reusable.
 *
 * Without this, every telemetry poll hit ManageEngine PMP for a fresh password.
 * With the dashboard open that is one vault read per project per poll, which
 * floods the vault's audit trail and can trip account-lockout or rate limits.
 * Health checks are not deployments; they do not need a fresh secret each time.
 */
const CREDENTIAL_CACHE_TTL_MS = 10 * 60 * 1000;

class TelemetryService {
  constructor() {
    /** @type {Map<string, { password: string, expiresAt: number }>} */
    this._credentialCache = new Map();
  }

  /**
   * Resolve a PMP credential for telemetry, reusing a cached value when fresh.
   * Deployments deliberately do NOT use this cache — they always read the vault
   * directly so the audit trail records a real credential checkout per deploy.
   */
  async _resolveCachedPmpPassword(projectId, pmpConfig) {
    const cached = this._credentialCache.get(projectId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.password;
    }

    const password = await PmpService.fetchPassword(pmpConfig, {
      projectId,
      // Distinct from the deployment reason so the vault audit log does not
      // report a health check as an "automated deployment".
      reason: `IDP Health Check - Project #${projectId}`,
    });

    this._credentialCache.set(projectId, {
      password,
      expiresAt: Date.now() + CREDENTIAL_CACHE_TTL_MS,
    });
    return password;
  }

  /** Drop a cached credential — call when a project's PMP settings change. */
  invalidateCredential(projectId) {
    this._credentialCache.delete(projectId);
  }
  /**
   * Fetch telemetry data for a server project (SSH/WinRM).
   *
   * T-18b: telemetry is opt-in per project (`config.telemetryEnabled`,
   * default `false`) — every poll used to open a real SSH/WinRM session
   * (and, for PMP-authed projects, resolve a vault credential) every 5
   * minutes for every Server project whether anyone was looking at it or
   * not. This check runs BEFORE anything else in this method — no socket,
   * no vault read — so a disabled project truly opens no connection.
   * Defense in depth: `projectService.getProjectTelemetry()` already
   * short-circuits on this same flag before even resolving secrets; this
   * check covers any other caller of this method directly.
   */
  async getTelemetry(project) {
    if (!isServerProvider(project.provider)) {
      return { status: 'unknown' };
    }

    const config = project.config || {};

    if (config.telemetryEnabled !== true) {
      return { status: 'disabled' };
    }
    const isWindows = (config.targetOS || (project.provider === 'WinRM' ? 'windows' : 'linux')) === 'windows';
    
    let host = config.host || '';
    let port = config.port || (isWindows ? 5985 : 22);
    let username = config.username;
    let password = config.password;

    // Resolve PMP Credentials
    if (config.authType === 'pmp' && config.pmpConfig) {
      try {
        password = await this._resolveCachedPmpPassword(project.id, config.pmpConfig);
        // Ensure the target server connection uses the exact account name fetched from PMP
        username = config.pmpConfig.accountName;
      } catch (err) {
        return { status: 'offline', error: 'PMP Auth Failed' };
      }
    }

    if (!host || !username) return { status: 'offline' };

    // Clean host
    if (host.startsWith('http://')) host = host.substring(7);
    if (host.startsWith('https://')) host = host.substring(8);
    if (host.includes(':')) {
      const parts = host.split(':');
      host = parts[0];
      port = parseInt(parts[1], 10) || port;
    }

    try {
      if (isWindows) {
        return await this._getWindowsTelemetry(host, port, username, password);
      } else {
        return await this._getLinuxTelemetry(host, port, username, password, config.privateKeyPath);
      }
    } catch (err) {
      return { status: 'offline', error: err.message };
    }
  }

  async _getWindowsTelemetry(host, port, username, password) {
    if (!password) throw new Error('Password required for WinRM telemetry');

    const script = `
      $mem = Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory
      $cpu = Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average | Select-Object Average
      $totalMb = [math]::Round($mem.TotalVisibleMemorySize / 1024)
      $freeMb = [math]::Round($mem.FreePhysicalMemory / 1024)
      $usedMb = $totalMb - $freeMb
      
      Write-Output "CPU:$($cpu.Average)"
      Write-Output "RAM_USED:$usedMb"
      Write-Output "RAM_TOTAL:$totalMb"
    `;

    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    const commandStr = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedScript}`;
    
    // Attempt command with 5s timeout
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000));
    const runPromise = runCommand(commandStr, host, username, password, port);
    
    const result = await Promise.race([runPromise, timeoutPromise]);
    if (result instanceof Error) throw result;

    return this._parseTelemetryOutput(result);
  }

  async _getLinuxTelemetry(host, port, username, password, privateKeyPath) {
    const ssh = new NodeSSH();
    const sshConfig = {
      host,
      port,
      username,
      readyTimeout: 5000,
      tryKeyboard: true,
      onKeyboardInteractive: (name, instructions, instructionsLang, prompts, finish) => {
        if (prompts.length > 0 && prompts[0].prompt.toLowerCase().includes('password')) {
          finish([password]);
        } else {
          finish([]);
        }
      }
    };

    if (privateKeyPath) {
      const resolvedPath = require('path').resolve(privateKeyPath.replace(/^~/, process.env.HOME || '/root'));
      if (require('fs').existsSync(resolvedPath)) {
        sshConfig.privateKeyPath = resolvedPath;
      } else if (password) {
        sshConfig.password = password;
      }
    } else if (password) {
      sshConfig.password = password;
    } else {
      throw new Error('No authentication method available');
    }

    try {
      await ssh.connect(sshConfig);
      const command = `
        top -bn1 | grep "Cpu(s)" | awk '{print "CPU:" $2 + $4}'
        free -m | awk '/Mem:/ {print "RAM_USED:" $3 "\\nRAM_TOTAL:" $2}'
      `;
      const result = await ssh.execCommand(command);
      ssh.dispose();
      return this._parseTelemetryOutput(result.stdout);
    } catch (err) {
      ssh.dispose();
      throw err;
    }
  }

  _parseTelemetryOutput(output) {
    const lines = output.toString().split('\n');
    let cpu = 0;
    let ramUsed = 0;
    let ramTotal = 0;

    for (const line of lines) {
      const cleanLine = line.trim();
      if (cleanLine.startsWith('CPU:')) cpu = parseFloat(cleanLine.split(':')[1]) || 0;
      if (cleanLine.startsWith('RAM_USED:')) ramUsed = parseInt(cleanLine.split(':')[1], 10) || 0;
      if (cleanLine.startsWith('RAM_TOTAL:')) ramTotal = parseInt(cleanLine.split(':')[1], 10) || 0;
    }

    return {
      status: 'online',
      cpu: Math.round(cpu),
      ramUsed,
      ramTotal,
      ramPercent: ramTotal > 0 ? Math.round((ramUsed / ramTotal) * 100) : 0
    };
  }
}

module.exports = new TelemetryService();
