'use strict';

/** T-73 Server/WinRM (windows) checks: WS-Man Identify doubles as the auth probe. */

const { Agent } = require('undici');

const { makeCheck, withTimeout, cleanHostPort } = require('./shared');

function translateWinRmError(err, host, port) {
  const code = (err && (err.code || (err.cause && err.cause.code))) || '';
  const msg = (err && err.message) || String(err);
  if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
    return `Connection to ${host}:${port} was refused. Check that WinRM is enabled and the port is correct.`;
  }
  if (code === 'ENOTFOUND' || msg.includes('ENOTFOUND')) {
    return `Could not resolve host '${host}'. Check the hostname in project settings.`;
  }
  if (/timed out/i.test(msg)) {
    return `Connection to ${host}:${port} timed out. Check network/firewall rules.`;
  }
  if (/self.signed|DEPTH_ZERO_SELF_SIGNED_CERT/i.test(msg)) {
    return 'TLS certificate was rejected (self-signed). Enable "Allow Self-Signed" if this is expected, or trust the CA via NODE_EXTRA_CA_CERTS.';
  }
  return `Could not reach the WinRM endpoint: ${msg}`;
}

/**
 * A single WS-Man Identify request doubles as both checks: an unauthenticated
 * (or wrong-credential) request still tells us the endpoint is reachable
 * (a 401 response IS a response), so "reachable" and "authenticated" can be
 * read off the same round trip without a second one.
 */
async function testWinRm({ config, timeoutMs, fetchImpl }) {
  const { host, port: cleanedPort } = cleanHostPort(config.host, config.port ? Number(config.port) : undefined);
  const port = cleanedPort || 5985;
  const protocol = config.protocol || ([5986, 443].includes(port) ? 'https' : 'http');
  const username = config.username;
  const password = config.password;
  const allowInsecure = config.allowInsecure === true;

  if (!host || !username) {
    return [makeCheck('WS-Man Identify', false, 'Host and username are required — configure them in project settings.')];
  }

  const url = `${protocol}://${host}:${port}/wsman`;
  const identifySoap = `
    <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
                xmlns:wsmid="http://schemas.dmtf.org/wbem/wsman/identity/1/wsmanidentity.xsd">
      <s:Header/>
      <s:Body>
        <wsmid:Identify/>
      </s:Body>
    </s:Envelope>
  `.trim();

  const hasCredentials = !!password;
  const headers = { 'Content-Type': 'application/soap+xml;charset=UTF-8' };
  if (hasCredentials) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }

  const fetchOptions = { method: 'POST', headers, body: identifySoap };
  if (allowInsecure) {
    fetchOptions.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }

  let identifyOk;
  let identifyDetail;
  let authOk = null;
  let authDetail;

  try {
    const response = await withTimeout(fetchImpl(url, fetchOptions), timeoutMs, 'WS-Man Identify');
    if (response.status === 401) {
      identifyOk = true;
      identifyDetail = `WS-Man endpoint responded at ${protocol}://${host}:${port}/wsman.`;
      authOk = hasCredentials ? false : null;
      authDetail = hasCredentials
        ? 'Authentication failed — check the username or the credential in project settings.'
        : 'Not tested — no password configured for this project.';
    } else if (response.ok) {
      identifyOk = true;
      identifyDetail = 'WS-Man endpoint responded and credentials were accepted.';
      authOk = hasCredentials ? true : null;
      authDetail = hasCredentials
        ? `Authenticated as '${username}'.`
        : 'Not tested — no password configured for this project.';
    } else {
      identifyOk = false;
      identifyDetail = `WS-Man Identify failed with HTTP ${response.status}.`;
      authOk = null;
      authDetail = 'Not tested — the WS-Man endpoint did not respond as expected.';
    }
  } catch (err) {
    identifyOk = false;
    identifyDetail = translateWinRmError(err, host, port);
    authOk = null;
    authDetail = 'Not tested — could not reach the WS-Man endpoint.';
  }

  return [makeCheck('WS-Man Identify', identifyOk, identifyDetail), makeCheck('Authentication', authOk, authDetail)];
}

module.exports = { testWinRm };
