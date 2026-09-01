'use strict';

/** T-73 Server/SSH (linux) checks: TCP, handshake, host key policy, auth. */

const fs = require('node:fs');
const path = require('node:path');

const { makeCheck, withTimeout, cleanHostPort, tcpProbe } = require('./shared');

async function testSsh({ config, netConnect, createHostVerifier, timeoutMs, NodeSSHImpl, defaultHostKeyPolicy }) {
  const { host, port } = cleanHostPort(config.host, config.port || 22);
  const username = config.username;

  if (!host || !username) {
    return [makeCheck('SSH Handshake', false, 'Host and username are required — configure them in project settings.')];
  }

  const tcpResult = await tcpProbe(netConnect, host, port, timeoutMs);
  const checks = [makeCheck('TCP Reachability', tcpResult.ok, tcpResult.detail)];
  if (!tcpResult.ok) {
    checks.push(makeCheck('SSH Handshake', null, 'Not tested — host is unreachable.'));
    checks.push(makeCheck('Host Key Policy', null, 'Not tested — host is unreachable.'));
    checks.push(makeCheck('Authentication', null, 'Not tested — host is unreachable.'));
    return checks;
  }

  let resolvedKeyPath = null;
  let hasPrivateKey = false;
  if (config.privateKeyPath) {
    resolvedKeyPath = path.resolve(config.privateKeyPath.replace(/^~/, process.env.HOME || '/root'));
    hasPrivateKey = fs.existsSync(resolvedKeyPath);
  }
  const hasPassword = !!config.password;
  // A PMP-vault-authenticated project has neither at test time — the real
  // password is fetched fresh from the vault only during an actual deploy
  // (see deploymentService.js). Connecting anyway still exercises TCP +
  // handshake + host key verification; only the auth check gets a "not
  // tested" note instead of a false failure.
  const hasCredentials = hasPassword || hasPrivateKey;

  const hostKeyPolicy = config.hostKeyPolicy || defaultHostKeyPolicy;
  const hostKeyLog = [];
  let hostKeyOutcome = null;
  const baseVerifier = createHostVerifier({
    host,
    port,
    policy: hostKeyPolicy,
    onLog: (line) => hostKeyLog.push(line),
  });
  const hostVerifier = (keyBuffer) => {
    hostKeyOutcome = baseVerifier(keyBuffer);
    return hostKeyOutcome;
  };

  const sshConfig = {
    host,
    port,
    username,
    readyTimeout: Math.min(timeoutMs, 15000),
    tryKeyboard: true,
    onKeyboardInteractive: (name, instructions, lang, prompts, finish) => {
      if (hasPassword && prompts.length > 0 && /password/i.test(prompts[0].prompt)) {
        finish([config.password]);
      } else {
        finish([]);
      }
    },
    hostVerifier,
  };
  if (hasPrivateKey) {
    sshConfig.privateKeyPath = resolvedKeyPath;
  } else if (hasPassword) {
    sshConfig.password = config.password;
  }

  const ssh = new NodeSSHImpl();
  let handshakeOk = null;
  let handshakeDetail = '';
  let authOk = null;
  let authDetail = '';

  try {
    await withTimeout(ssh.connect(sshConfig), timeoutMs, 'SSH connection');
    handshakeOk = true;
    handshakeDetail = 'SSH protocol handshake completed.';
    authOk = hasCredentials ? true : null;
    authDetail = hasCredentials
      ? `Authenticated as '${username}'.`
      : 'Not tested — no password or private key configured for this project.';
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (/verification failed|Host denied/i.test(msg)) {
      handshakeOk = true;
      handshakeDetail = 'SSH protocol handshake completed.';
      authOk = null;
      authDetail = 'Not tested — the connection was refused at host key verification.';
    } else if (/ECONNREFUSED/i.test(msg)) {
      handshakeOk = false;
      handshakeDetail = `Connection refused by ${host}:${port}. Check that the SSH service is running.`;
      authOk = null;
      authDetail = 'Not tested — the SSH handshake did not complete.';
    } else if (/timed out|timeout/i.test(msg)) {
      handshakeOk = false;
      handshakeDetail = `SSH handshake timed out after ${timeoutMs}ms. Check network/firewall rules.`;
      authOk = null;
      authDetail = 'Not tested — the SSH handshake did not complete.';
    } else if (/Authentication failed|All configured authentication methods failed/i.test(msg)) {
      handshakeOk = true;
      handshakeDetail = 'SSH protocol handshake completed.';
      if (!hasCredentials) {
        authOk = null;
        authDetail = 'Not tested — no password or private key configured for this project.';
      } else {
        authOk = false;
        authDetail = 'Authentication failed — check the username or the credential in project settings.';
      }
    } else {
      handshakeOk = false;
      handshakeDetail = `SSH connection error: ${msg}`;
      authOk = null;
      authDetail = 'Not tested — the SSH handshake did not complete.';
    }
  } finally {
    try {
      ssh.dispose();
    } catch (_err) {
      // never connected / already disposed — nothing to clean up
    }
  }

  checks.push(makeCheck('SSH Handshake', handshakeOk, handshakeDetail));

  let hostKeyCheckOk;
  let hostKeyDetail;
  if (hostKeyOutcome === null) {
    hostKeyCheckOk = null;
    hostKeyDetail = handshakeOk
      ? 'Host key verification was not exercised.'
      : 'Not tested — the SSH handshake did not complete.';
  } else {
    hostKeyCheckOk = hostKeyOutcome;
    const lastLine = hostKeyLog[hostKeyLog.length - 1] || '';
    hostKeyDetail = lastLine
      ? lastLine.replace(/^\[SSH\]\s*/, '').split('\n')[0]
      : hostKeyOutcome
        ? `Host key accepted under the '${hostKeyPolicy}' policy.`
        : `Host key rejected under the '${hostKeyPolicy}' policy.`;
  }
  checks.push(makeCheck('Host Key Policy', hostKeyCheckOk, hostKeyDetail));
  checks.push(makeCheck('Authentication', authOk, authDetail));

  return checks;
}

module.exports = { testSsh };
