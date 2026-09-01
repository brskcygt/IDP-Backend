/**
 * Bridges project config and the SecretStore (T-10 / SEC-01).
 *
 * projects.json stores `secret://<projectId>/<fieldPath>` references instead of
 * plaintext credentials. Two directions:
 *
 *   persistProjectSecrets()  plaintext in config  →  store, refs left behind
 *   resolveProjectSecrets()  refs in config       →  plaintext, for adapter use
 *
 * Both return new objects; neither mutates its input.
 *
 * When no store is configured (IDP_SECRET_KEY unset) both are pass-throughs, so
 * an install that hasn't set up encryption keeps working exactly as before
 * rather than failing to deploy.
 */
const { makeRef, isRef, SECRET_FIELD_PATHS, getSecretFieldPaths } = require('./secretRef');

function getAtPath(obj, dottedPath) {
  return dottedPath.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), obj);
}

/** Returns a new object with `dottedPath` set. Never mutates `obj`. */
function setAtPath(obj, dottedPath, value) {
  const [head, ...rest] = dottedPath.split('.');
  if (rest.length === 0) {
    return { ...obj, [head]: value };
  }
  return { ...obj, [head]: setAtPath(obj[head] || {}, rest.join('.'), value) };
}

/**
 * Move any plaintext secrets in `project.config` into the store, replacing each
 * with a reference. Call this before persisting a project.
 *
 * A blank value clears the stored secret rather than writing an empty string,
 * so "delete this password" is expressible.
 *
 * @returns {Promise<object>} a new project object safe to write to disk
 */
async function persistProjectSecrets(project, store) {
  if (!store || !project) return project;

  let config = project.config || {};

  for (const fieldPath of getSecretFieldPaths(config)) {
    const value = getAtPath(config, fieldPath);

    // Already a reference, or nothing there — leave it alone.
    if (value === undefined || value === null || isRef(value)) continue;

    if (typeof value !== 'string' || value.trim() === '') continue;

    const ref = makeRef(project.id, fieldPath);
    await store.set(ref, value);
    config = setAtPath(config, fieldPath, ref);
  }

  return { ...project, config };
}

/**
 * Replace every `secret://` reference in `project.config` with its real value.
 * Call this immediately before building an adapter — never before sending a
 * project to the client.
 *
 * A reference that cannot be resolved (store wiped, key rotated) throws rather
 * than silently handing an adapter a `secret://...` string as a password, which
 * would surface as a confusing auth failure against the target server.
 *
 * @returns {Promise<object>} a new project object with plaintext credentials
 */
async function resolveProjectSecrets(project, store) {
  if (!store || !project) return project;

  let config = project.config || {};

  for (const fieldPath of getSecretFieldPaths(config)) {
    const value = getAtPath(config, fieldPath);
    if (!isRef(value)) continue;

    const plaintext = await store.get(value);
    if (plaintext === null) {
      throw new Error(
        `Stored credential missing for "${fieldPath}" on project ${project.id}. ` +
        `The reference ${value} has no entry in the secret store — it may have been ` +
        `cleared, or IDP_SECRET_KEY may have changed. Re-enter the credential in project settings.`
      );
    }
    config = setAtPath(config, fieldPath, plaintext);
  }

  return { ...project, config };
}

/**
 * Remove a project's secrets from the store. Call on project deletion so
 * credentials don't outlive the project that used them.
 *
 * `config` is optional (T-50): pass the project's config so any environment
 * override secrets (`environments.<name>.password`, etc.) get cleaned up
 * too. When omitted, falls back to the static `SECRET_FIELD_PATHS` — the
 * pre-T-50 behavior — so existing callers keep working unchanged.
 *
 * @param {string} projectId
 * @param {*} store
 * @param {object} [config] - the project's config, used to discover which
 *   environment-scoped secret paths actually exist.
 * @returns {Promise<number>} how many entries were removed
 */
async function deleteProjectSecrets(projectId, store, config) {
  if (!store) return 0;

  const fieldPaths = config === undefined ? SECRET_FIELD_PATHS : getSecretFieldPaths(config);

  let removed = 0;
  for (const fieldPath of fieldPaths) {
    if (await store.delete(makeRef(projectId, fieldPath))) removed++;
  }
  return removed;
}

module.exports = {
  persistProjectSecrets,
  resolveProjectSecrets,
  deleteProjectSecrets,
  // exported for tests
  getAtPath,
  setAtPath,
};
