const DeploymentAdapter = require('./DeploymentAdapter');
const { assertTriggerResult } = DeploymentAdapter;
const { runCommand } = require('nodejs-winrm');
const { Agent, fetch: undiciFetch } = require('undici');

// T-31b: nodejs-winrm's runCommand() never reads WinRM's rsp:ExitCode field
// (see node_modules/nodejs-winrm/src/command.js#doReceiveOutput — it only
// concatenates the stdout/stderr rsp:Stream elements) and it also never
// rejects on a protocol fault; it RESOLVES with an Error instance instead
// (see node_modules/nodejs-winrm/index.js#runCommand's catch branch). That
// means a PowerShell script that ends with `exit 1` and writes nothing to
// stdout gives this adapter no failure signal whatsoever — the exact same
// silent-success class of bug fixed on the SSH side in T-30.
//
// Since we cannot patch node_modules, we smuggle the real exit status back
// out through stdout by wrapping the user's script before it is sent.
const IDP_EXIT_MARKER_PREFIX = '__IDP_EXIT_CODE__:';

/**
 * Wrap a user-provided PowerShell script so its real exit status travels
 * back through stdout as a `__IDP_EXIT_CODE__:<n>` marker line — even when
 * the script terminates via a bare `exit N` statement.
 *
 * FOLLOW-UP FIX (same ticket, T-31b): the first version of this function
 * ran the user's script inline inside a `try { <script> } catch {...}`
 * block in the SAME PowerShell runspace as the marker-writing code. That
 * broke on the single most common case — a script that ends with a plain
 * `exit 0`/`exit 1` (e.g. most `pm2 restart` / `iisreset` deploy
 * templates). PowerShell's `exit` statement is not a catchable error; it
 * unwinds the entire host process immediately, so control never reached
 * the `Write-Output "__IDP_EXIT_CODE__:..."` line after the try/catch.
 * Every script ending in an explicit `exit` — success OR failure — came
 * back with no marker at all, and the caller (correctly, per its own
 * "ambiguous => failure" rule) reported a false failure. That is the
 * mirror image of the original silent-success bug and just as unacceptable
 * for real deploy scripts.
 *
 * FIX: run the user's script in a SEPARATE child `powershell.exe` process
 * instead of the current runspace. `exit` inside that child only
 * terminates the child; the parent (this wrapper) is a normal native-command
 * invocation via `&`, so PowerShell automatically captures the child's own
 * process exit code into `$LASTEXITCODE` once it returns — regardless of
 * whether the child exited via `exit N`, ran off the end of the script, or
 * died from an uncaught exception. The parent then ALWAYS reaches its own
 * `Write-Output` marker line, because nothing in the child can unwind the
 * parent's process.
 *
 * Two-stage encoding: the user's script (prefixed with its own
 * `$ErrorActionPreference = 'Stop'`, see below) is UTF-16LE/base64 encoded
 * and embedded as a `-EncodedCommand` argument to the child powershell.exe
 * invocation. The resulting outer wrapper text is then, as before,
 * UTF-16LE/base64 encoded again by trigger() for the actual WinRM
 * `-EncodedCommand` sent over the wire. The extra process spawn costs
 * roughly ~200ms and is an accepted trade-off for a correct exit signal.
 *
 * $ErrorActionPreference placement:
 *  - The OUTER wrapper (this function's return value) intentionally uses
 *    'Continue', NOT 'Stop'. It has nothing to catch — it only starts the
 *    child, reads $LASTEXITCODE, and always writes the marker.
 *  - The INNER/child script gets `$ErrorActionPreference = 'Stop'`
 *    prepended. This is what preserves the ORIGINAL fix's intent: it
 *    promotes the child's normally non-terminating errors (a failed cmdlet
 *    that would otherwise just print to stderr and let the script carry
 *    on) into terminating exceptions. An uncaught terminating exception
 *    makes powershell.exe itself exit with a non-zero code, which the
 *    parent then reads via $LASTEXITCODE — no `exit $LASTEXITCODE` needed
 *    at the end of the child, since a terminating error already yields a
 *    non-zero process exit code on its own. This remains a genuine,
 *    intentional behavior change for existing scripts (errors that used to
 *    pass silently now fail the deployment) — that is the whole point.
 *
 * Child stdout/stderr: invoking `powershell.exe` via the `&` call operator
 * runs it as a native child process whose OS-level stdout/stderr handles
 * are inherited from (i.e. flow straight through to) the parent
 * powershell.exe's own stdout/stderr — the same handles WinRM/WinRS
 * captures for the outer process. No extra piping is required.
 *
 * @param {string} script - The raw PowerShell script content to execute.
 * @returns {string} The outer wrapper script, still valid PowerShell,
 *   ready for its own UTF-16LE/base64 -EncodedCommand encoding.
 */
function wrapScriptWithExitMarker(script) {
  const innerScript = "$ErrorActionPreference = 'Stop'\n" + script;
  // Base64 alphabet (A-Z a-z 0-9 + / =) contains no single quotes, so this
  // is always safe to embed as-is inside a single-quoted PowerShell string.
  const innerEncoded = Buffer.from(innerScript, 'utf16le').toString('base64');

  return [
    "$ErrorActionPreference = 'Continue'",
    `$__idpInner = '${innerEncoded}'`,
    '& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $__idpInner',
    '$__idpExit = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { 0 }',
    `Write-Output "${IDP_EXIT_MARKER_PREFIX}$__idpExit"`,
  ].join('\n');
}

/**
 * Parse the `__IDP_EXIT_CODE__:<n>` marker out of raw WinRM command output
 * and strip every marker line from what gets shown to the user.
 *
 * If the marker appears more than once, the last occurrence wins — it is
 * the one written by our own wrapper once the user's script has actually
 * finished running. Missing marker => `exitCode: null`; callers MUST treat
 * that as an unknown/ambiguous status, never as success.
 *
 * @param {string} output - Raw stdout returned by nodejs-winrm's runCommand().
 * @returns {{ exitCode: number|null, cleanedOutput: string }}
 */
function parseExitMarker(output) {
  const lines = (output || '').split('\n');
  let exitCode = null;
  const cleanedLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(IDP_EXIT_MARKER_PREFIX)) {
      const raw = trimmed.slice(IDP_EXIT_MARKER_PREFIX.length).trim();
      const parsed = Number.parseInt(raw, 10);
      exitCode = Number.isNaN(parsed) ? null : parsed;
      continue;
    }
    cleanedLines.push(line);
  }

  return { exitCode, cleanedOutput: cleanedLines.join('\n') };
}

/**
 * WindowsAdapter — Production-grade WinRM automation adapter.
 *
 * Capabilities:
 * 1. Health check via WS-Management Identify SOAP request
 * 2. Execute PowerShell or cmd scripts via nodejs-winrm
 * 3. Log capturing and streaming
 */
class WindowsAdapter extends DeploymentAdapter {
  constructor(config) {
    super(config);
    this.host = config.host;
    this.port = config.port ? Number(config.port) : 5985;
    this.username = config.username;
    this.password = config.password;
    
    // Automatically determine protocol if not provided (5986 and 443 are HTTPS)
    this.protocol = config.protocol ? config.protocol : ([5986, 443].includes(this.port) ? 'https' : 'http');
    // SECURITY (SEC-07): default MUST be secure (verify TLS). Only skip verification when
    // the caller explicitly opts in via config.allowInsecure === true. For an internal CA
    // (e.g. a corporate/self-signed WinRM cert), the correct fix is to trust that CA via
    // the NODE_EXTRA_CA_CERTS environment variable rather than disabling verification.
    this.allowInsecure = config.allowInsecure === true;
    this.aborted = false;
    this._aborting = false;

    // (T-57) WinRM output is captured synchronously during trigger() — see
    // parseExitMarker() above; there is no separate post-trigger log
    // stream, so streamLogs() relies on the base no-op. Sub-tags like
    // `[WINRM:PowerShell]` and `[WinRM ERROR]` are distinct from this
    // adapter-wide prefix and stay hand-written at their call sites (log()
    // only auto-prepends logPrefix to messages that don't already start
    // with their own bracket tag).
    this.logPrefix = '[WinRM]';
  }

  async connect() {
    this.log(`Initiating connection to ${this.protocol}://${this.host}:${this.port}...`);
    
    if (!this.host || !this.username || !this.password) {
      throw new Error('Windows deployment requires host, username, and password.');
    }

    // Health check using WS-Management Identify
    const url = `${this.protocol}://${this.host}:${this.port}/wsman`;
    const authHeader = 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
    const identifySoap = `
      <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" 
                  xmlns:wsmid="http://schemas.dmtf.org/wbem/wsman/identity/1/wsmanidentity.xsd">
        <s:Header/>
        <s:Body>
          <wsmid:Identify/>
        </s:Body>
      </s:Envelope>
    `.trim();

    try {
      const fetchOptions = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/soap+xml;charset=UTF-8',
          'Authorization': authHeader
        },
        body: identifySoap
      };

      // 1. Self-Signed SSL Desteği (fetch / undici için)
      // Allow insecure self-signed certs (e.g., self-signed WinRM certificates)
      if (this.allowInsecure) {
        this.log(`⚠ TLS certificate verification is DISABLED for this connection. This exposes WinRM traffic to interception.`);
        fetchOptions.dispatcher = new Agent({
          connect: { rejectUnauthorized: false }
        });
      }

      // Use explicit undiciFetch instead of global fetch
      const response = await undiciFetch(url, fetchOptions);

      if (!response.ok) {
         if (response.status === 401) {
           throw Object.assign(new Error(`401 Unauthorized`), { code: '401_UNAUTHORIZED' });
         }
         const bodyText = await response.text().catch(() => '');
         throw new Error(`Identify failed with status ${response.status}. Body: ${bodyText.substring(0, 100)}`);
      }
      
      this.log(`✓ Connection established. Health check passed.`);
    } catch (err) {
      this._handleWinrmError(err, 'Connection');
      throw new Error(`WinRM Connection failed: ${err.message}`);
    }
  }

  async trigger(params) {
    if (this.aborted) return assertTriggerResult({ status: 'Aborted' }, 'WindowsAdapter');

    const scriptOrCommand = this.config.scriptContent || 'echo "WinRM Connected. Executing default script..."';
    this.log(`Executing script on Windows Server...`);

    // WinRM kütüphanesi (nodejs-winrm) eski node http kullanıyorsa ve HTTPS/SSL'e denk geliyorsa 
    // global TLS korumasını geçici olarak esnetiyoruz.
    const originalTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (this.allowInsecure) {
      this.log(`⚠ TLS certificate verification is DISABLED for this connection. This exposes WinRM traffic to interception.`);
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }

    try {
      // Wrap the script BEFORE base64/UTF-16LE encoding so the exit-marker
      // plumbing (see wrapScriptWithExitMarker above) travels with it.
      const wrappedScript = wrapScriptWithExitMarker(scriptOrCommand);

      // Encode script in UTF-16LE base64 to avoid multiline breaking in Windows cmd
      const encodedScript = Buffer.from(wrappedScript, 'utf16le').toString('base64');
      const commandStr = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedScript}`;

      const result = await runCommand(commandStr, this.host, this.username, this.password, this.port);

      // nodejs-winrm's runCommand() CATCHES its own errors and RESOLVES with
      // an Error object instead of rejecting/throwing (see its source: the
      // whole body is wrapped in try/catch and the catch branch `return`s
      // the error). If we don't check for this explicitly, a WinRM/WS-Man
      // protocol fault (bad shell, malformed request, etc.) would silently
      // fall through and be reported as a successful deployment — the exact
      // same class of bug fixed in SshServerAdapter. Keep this guard.
      if (result instanceof Error) {
        throw result;
      }

      // Defensive: runCommand() is only documented to resolve with a string
      // (command output) or an Error instance. Anything else is an
      // unexpected/unsupported response shape from the library — treat it
      // as a failure rather than silently reporting success.
      if (typeof result !== 'string') {
        throw new Error(`WinRM returned an unexpected response type (${typeof result}). Treating as failure.`);
      }

      const { exitCode, cleanedOutput } = parseExitMarker(result);

      if (cleanedOutput.trim()) {
        const lines = cleanedOutput.split('\n');
        lines.forEach(line => { if (line.trim()) this.log(`[WINRM:PowerShell] ${line.trim()}`) });
      }

      const outputTail = () => cleanedOutput.split('\n').filter(l => l.trim()).slice(-5).join('\n');

      // T-31b: nodejs-winrm gives us no protocol-level exit code (see the
      // guard above), so the __IDP_EXIT_CODE__ marker written by
      // wrapScriptWithExitMarker() is the ONLY source of truth for whether
      // the remote script actually succeeded. If it's missing — e.g. the
      // script called PowerShell's `exit` directly, which terminates the
      // process before our wrapper's own Write-Output line ever runs — the
      // outcome is genuinely unknown. Never resolve that ambiguity as
      // success; that is exactly the silent-success bug this patch fixes.
      if (exitCode === null) {
        const tail = outputTail();
        throw new Error(
          `WinRM execution status is unknown: the exit-code marker was not found in the command output ` +
          `(the script may have called PowerShell's 'exit' directly, bypassing our wrapper). ` +
          `Treating as a failure rather than assuming success.${tail ? ` Last output:\n${tail}` : ''}`
        );
      }

      if (exitCode !== 0) {
        const tail = outputTail();
        throw new Error(`WinRM script exited with code ${exitCode}.${tail ? ` Last output:\n${tail}` : ''}`);
      }

      this.log(`✓ Execution completed successfully.`);
      return assertTriggerResult({ status: 'Succeeded' }, 'WindowsAdapter');
    } catch (err) {
      this._handleWinrmError(err, 'Execution');
      throw new Error(`WinRM Execution failed: ${err.message}`);
    } finally {
      // Execution tamamlandığında global TLS ayarını eski haline getir.
      if (this.allowInsecure) {
        if (originalTlsReject === undefined) {
          delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        } else {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTlsReject;
        }
      }
    }
  }

  // 2. Hata Yakalama ve Loglama (Error Handling)
  _handleWinrmError(err, context) {
    const errorMsg = err.message || '';
    const errorCode = err.code || err.cause?.code || '';
    const causeMsg = err.cause ? (err.cause.message || JSON.stringify(err.cause)) : '';

    if (errorCode === 'ECONNREFUSED' || errorMsg.includes('ECONNREFUSED')) {
      this.log(`[WinRM ERROR] ✗ Sunucuya ulaşılamadı (ECONNREFUSED). ${this.host}:${this.port} portunun açık ve WinRM servisinin çalışır durumda olduğundan emin olun.`);
    } 
    else if (errorCode === 'ETIMEDOUT' || errorMsg.includes('ETIMEDOUT') || errorMsg.includes('timeout')) {
      this.log(`[WinRM ERROR] ✗ Bağlantı zaman aşımına uğradı (ETIMEDOUT). Güvenlik duvarı (Firewall) ayarlarını ve ağ erişimini kontrol edin.`);
    } 
    else if (errorCode === 'DEPTH_ZERO_SELF_SIGNED_CERT' || errorMsg.includes('self-signed certificate') || causeMsg.includes('self signed')) {
      this.log(`[WinRM ERROR] ✗ Self-signed (kendinden imzalı) SSL sertifikası reddedildi (DEPTH_ZERO_SELF_SIGNED_CERT). Detay: ${causeMsg || errorMsg}`);
    } 
    else if (errorCode === '401_UNAUTHORIZED' || errorMsg.includes('401') || errorMsg.includes('Unauthorized')) {
      this.log(`[WinRM ERROR] ✗ Kimlik doğrulama başarısız (401 Unauthorized). Kullanıcı adı, şifre veya WinRM Auth konfigürasyonu (Basic/Negotiate) hatalı olabilir.`);
    } 
    else {
      // Log raw details if none of the above match
      this.log(`[WinRM ERROR] ✗ ${context} hatası: ${errorCode ? `[${errorCode}] ` : ''}${errorMsg}`);
      if (causeMsg) {
        this.log(`[WinRM ERROR DETAY] ✗ ${causeMsg}`);
      }
    }
  }

  /**
   * (T-57) Idempotent: a second call is a safe no-op — it must never throw.
   */
  async abort() {
    if (this._aborting) return;
    this._aborting = true;
    this.aborted = true;
    this.log('Aborting execution...');
  }
}

// Exposed as static properties (rather than a separate module) so the pure
// wrap/parse logic can be unit-tested in isolation — see
// backend/test/winrm-exit-code.test.js — without touching any other file.
WindowsAdapter.wrapScriptWithExitMarker = wrapScriptWithExitMarker;
WindowsAdapter.parseExitMarker = parseExitMarker;

module.exports = WindowsAdapter;
