/**
 * DeploymentAdapter — Abstract base class for all deployment providers.
 *
 * Every adapter must implement: connect(), trigger(), abort(). streamLogs()
 * is optional — see below.
 * The `log()` helper emits timestamped messages to a registered callback
 * (set by the server/socket handler before calling adapter methods).
 */

/**
 * (T-57) Statuses a `trigger()` implementation must never communicate via
 * its return value — they MUST be signaled by throwing instead. See
 * `assertTriggerResult()` below.
 */
const FAILURE_STATUSES = new Set(['Failed', 'Aborted', 'Error']);

/**
 * Guard the return value of an adapter's `trigger()` call against the
 * silent-failure class of bug this file's JSDoc contract forbids (T-57).
 *
 * Every concrete adapter's `trigger()` is expected to route its `return`
 * statement through this helper: `return assertTriggerResult(result, 'Xyz')`.
 * If `result` looks like a failure/abort report (`{ status: 'Failed' }`,
 * `{ status: 'Aborted' }`, ...) this throws instead of letting it flow back
 * to the caller as a normal resolved value — callers (server.js) only ever
 * treat a resolved `trigger()` promise as "the deployment succeeded", so a
 * failure reported via return value would otherwise surface as a false
 * success. This exists so a future regression of the throw-on-failure
 * contract fails loudly (a thrown Error) instead of silently.
 *
 * @param {unknown} result - The value `trigger()` is about to return.
 * @param {string} adapterName - Human-readable adapter name for the error message.
 * @returns {unknown} `result`, unchanged, when it does not report a failure.
 */
function assertTriggerResult(result, adapterName) {
  if (result && typeof result === 'object' && FAILURE_STATUSES.has(result.status)) {
    throw new Error(
      `${adapterName}.trigger() reported failure via return value (status: '${result.status}'); ` +
      'the contract requires throwing, not returning a failure status. This error means the ' +
      'adapter itself is violating the DeploymentAdapter contract — see trigger() JSDoc below.'
    );
  }
  return result;
}

class DeploymentAdapter {
  constructor(config) {
    this.config = config || {};
    this._logCallback = null;

    /**
     * (T-57) Whether this adapter's streamLogs() does anything beyond the
     * base no-op. Adapters whose deployment output is already fully
     * captured during trigger() (e.g. SSH, WinRM, PMP — all stream inline)
     * leave this `false` and rely on the inherited no-op streamLogs()
     * below. Adapters that expose a genuine post-trigger log stream (e.g.
     * JenkinsAdapter) set this to `true` in their constructor.
     *
     * This flag is documentation/introspection only — the server always
     * calls `await adapter.streamLogs(cb)` unconditionally after trigger(),
     * so it does not gate that call site.
     */
    this.supportsLogStreaming = false;

    /**
     * (T-57) Subsystem tag automatically prepended by log() to any message
     * that doesn't already start with its own bracket tag. Subclasses set
     * this once in their constructor (e.g. `this.logPrefix = '[SSH]'`)
     * instead of hand-writing the same literal prefix at every call site.
     * Leave as '' for a subclass that has no single subsystem identity.
     */
    this.logPrefix = '';
  }

  /**
   * Register a callback that receives log lines.
   * Called by the server before invoking adapter methods.
   */
  onLog(callback) {
    this._logCallback = callback;
  }

  /**
   * Emit a log line. If a callback is registered, use it.
   * Always also print to stdout for server-side debugging.
   *
   * (T-57) `this.logPrefix`, when set, is prepended automatically — but
   * only when `message` doesn't already start with its own `[...]` tag
   * (e.g. `[SSH:Bash]`, `[WinRM ERROR]`). This lets a subclass keep
   * emitting distinct sub-tags for specific sub-streams (stdout vs
   * stderr, error categories, ...) without ending up double-prefixed.
   */
  log(message) {
    const withPrefix = (this.logPrefix && !/^\[/.test(message))
      ? `${this.logPrefix} ${message}`
      : message;
    const timestamped = `[${new Date().toISOString()}] ${withPrefix}`;
    if (this._logCallback) {
      this._logCallback(timestamped);
    }
    console.log(timestamped);
  }

  async connect() {
    throw new Error('connect() not implemented.');
  }

  /**
   * Trigger the deployment.
   *
   * CONTRACT: On failure this method MUST throw (or reject with) an Error.
   * Reporting a failed deployment via a return value (e.g. `{ status: 'Failed' }`)
   * is FORBIDDEN — callers only treat a resolved promise as success, so a
   * silent return on failure would surface as a false "deployment succeeded"
   * to the user. Only ever return normally when the deployment truly succeeded.
   *
   * Başarısızlık durumunda MUTLAKA throw etmelidir; hata durumunu return ile
   * bildirmek yasaktır.
   *
   * (T-57) This is enforced at runtime: route your `return` statement
   * through `assertTriggerResult(result, adapterName)` (exported below) so
   * a future violation of this contract throws instead of silently
   * succeeding.
   */
  async trigger(params) {
    throw new Error('trigger() not implemented.');
  }

  /**
   * (T-57) Stream additional deployment logs after trigger() resolves.
   *
   * Optional: the default implementation is a silent no-op. Only override
   * this when the adapter has a genuine, separate log stream to expose
   * (and set `supportsLogStreaming = true` when you do) — do NOT override
   * it just to emit an explanatory "log streaming isn't supported here"
   * line; that's noise the base no-op already avoids for you.
   */
  async streamLogs(callback) {
    // Intentionally empty: most adapters stream their output inline during
    // trigger() and have nothing left to report here.
  }

  async abort() {
    throw new Error('abort() not implemented.');
  }
}

module.exports = DeploymentAdapter;
module.exports.assertTriggerResult = assertTriggerResult;
module.exports.FAILURE_STATUSES = FAILURE_STATUSES;
