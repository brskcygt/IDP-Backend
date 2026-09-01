'use strict';

/**
 * Project CRUD, config, VPN-adjacent lookups and telemetry — the business
 * logic that used to live directly inside `src/server.js` route handlers
 * (T-58).
 *
 * Pure(ish) service module: takes plain arguments, returns plain values or
 * throws one of `core/errors.js`'s typed errors. Nothing here knows about
 * Express, `req`/`res`, cookies, or sessions — callers (the HTTP layer
 * today, an Electron IPC handler eventually) pass in an `actor` string for
 * audit logging instead of a request.
 *
 * Owns the in-memory `projects` cache that used to live as a bare `let
 * projects = []` in server.js. Synchronous `.find()`/`.findIndex()` lookups
 * throughout this module — and the object-identity mutations
 * `deploymentService.executeDeploy()` performs on a project handed back by
 * `getProject()` — depend on this staying a single shared array instance,
 * not a fresh copy per call.
 */
const projectRepository = require('../../store/projectRepository');
const { runMigration } = require('../../store/migrate');
const auditLogger = require('../../services/AuditLogger');
const TelemetryService = require('../../services/TelemetryService');
const { migrateProjectProviders, isServerProvider } = require('../../utils/providerUtils');
const { redactProject, mergeProjectConfig } = require('../../api/projectSerialization');
const {
  persistProjectSecrets,
  resolveProjectSecrets,
  deleteProjectSecrets,
} = require('../../secrets/projectSecrets');
const {
  listConfiguredEnvironments,
  hasEnvironmentOverrides,
} = require('../../utils/environmentConfig');
const secretStore = require('../secrets/secretStoreInstance');
const { NotFoundError } = require('../errors');

/** In-memory cache, backed by SQLite via projectRepository. */
let projects = [];

/**
 * One-time migration of legacy projects.json / audit_logs.json into SQLite,
 * legacy-provider migration, and startup
 * recovery of any project stuck in 'Deploying' from a previous run.
 *
 * Moved verbatim from server.js's `loadProjects()`. Must be called once at
 * process startup (see server.js) before any route depends on `projects`
 * being populated.
 */
function loadProjects() {
  // One-time migration of legacy projects.json / audit_logs.json into
  // SQLite. No-op after the first successful run (see store/migrate.js).
  runMigration();

  projects = projectRepository.findAll();

  // Migration (T-35/T-36): fold legacy 'SSH'/'WinRM' provider values into
  // the canonical 'Server' provider + config.targetOS. Pure helper — swap
  // in its result and persist only the rows that actually changed.
  const migratedProjects = migrateProjectProviders(projects);
  let migratedCount = 0;
  migratedProjects.forEach((migrated, i) => {
    if (migrated.provider !== projects[i].provider) {
      projectRepository.update(migrated.id, { provider: migrated.provider, config: migrated.config });
      migratedCount++;
    }
  });
  if (migratedCount > 0) {
    console.log(`Migrated ${migratedCount} project(s) from legacy SSH/WinRM provider to canonical Server provider.`);
    projects = migratedProjects;
  }

  // Recovery: a project left in 'Deploying' state can only mean the server
  // crashed or was restarted mid-deployment — no in-memory deploy is
  // actually running for it anymore. Reset it so the project isn't locked
  // out of future deploys forever.
  let recovered = 0;
  for (const project of projects) {
    if (project.status === 'Deploying') {
      project.status = 'Idle';
      projectRepository.updateStatus(project.id, 'Idle', project.lastDeploy);
      recovered++;
    }
  }
  if (recovered > 0) {
    console.log(`Recovered ${recovered} project(s) stuck in 'Deploying' state from a previous run.`);
  }
}

/** @returns {object|null} the raw (unredacted) project, or null if not found. */
function findProjectById(id) {
  return projects.find((p) => p.id === id) || null;
}

/** Same as `findProjectById`, but throws `NotFoundError` instead of returning null. */
function getProject(id) {
  const project = findProjectById(id);
  if (!project) {
    throw new NotFoundError('Project not found');
  }
  return project;
}

/** @returns {object[]} every project, redacted (no secrets) — safe to send to a client. */
function listProjects() {
  return projects.map(redactProject);
}

/**
 * @param {{ name: string, tenant: string, environment: string, provider: string }} input
 *   already-validated project fields (see validation/projectSchemas.js).
 * @param {string} actor - username for the audit log entry.
 * @returns {object} the created project, redacted.
 */
function createProject(input, actor) {
  const { name, tenant, environment, provider } = input;

  const newProject = {
    id: Date.now().toString(),
    name,
    tenant,
    environment,
    provider,
    status: 'Idle',
    lastDeploy: new Date().toISOString(),
    config: {},
  };

  projects.push(newProject);
  projectRepository.create(newProject);

  auditLogger.log(actor, 'PROJECT_CREATED', `Created new project: ${newProject.name}`, { projectId: newProject.id });

  return redactProject(newProject);
}

/**
 * Merge an incoming settings patch into a project's config, moving any
 * newly typed plaintext credential into the encrypted secret store first.
 *
 * @param {string} id
 * @param {object} incomingConfig - the raw (unvalidated-by-us; the caller
 *   already ran validateProjectConfig) settings patch.
 * @param {string} actor
 * @returns {Promise<object>} the updated project, redacted.
 */
async function updateProjectConfig(id, incomingConfig, actor) {
  const project = getProject(id);

  project.config = mergeProjectConfig(project.config, incomingConfig);

  // Any newly typed credential is plaintext at this point. Move it into the
  // encrypted store and leave a `secret://` reference behind before anything
  // touches disk.
  try {
    const persisted = await persistProjectSecrets(project, secretStore);
    project.config = persisted.config;
  } catch (err) {
    console.error('Failed to persist project secrets:', err.message);
    throw new Error('Could not securely store the provided credentials.');
  }

  projectRepository.update(id, { config: project.config });

  auditLogger.log(actor, 'PROJECT_UPDATED', `Updated settings for project: ${project.name}`, { projectId: id });

  return redactProject(project);
}

/**
 * @param {string} id
 * @param {string} actor
 * @returns {Promise<void>}
 */
async function deleteProject(id, actor) {
  const projectIndex = projects.findIndex((p) => p.id === id);
  if (projectIndex === -1) {
    throw new NotFoundError('Project not found');
  }

  const project = projects[projectIndex];
  projects.splice(projectIndex, 1);
  projectRepository.remove(id);

  // Don't let credentials outlive the project that used them. Pass the
  // project's config so any environment-override secrets (T-50) are
  // discovered and removed too, not just the base fields.
  try {
    await deleteProjectSecrets(id, secretStore, project.config);
  } catch (err) {
    console.error(`Failed to remove stored secrets for project ${id}:`, err.message);
  }

  auditLogger.log(actor, 'PROJECT_DELETED', `Deleted project: ${project.name}`, { projectId: id });
}

/**
 * T-50: tells the trigger UI which environments actually have a configured
 * override, so it can stop implying that Dev/Stage/Prod go to different
 * places when the project only has one shared config. No secrets in the
 * response — just names and a boolean.
 *
 * @param {string} id
 * @returns {{ configured: string[], hasOverrides: boolean }}
 */
function getProjectEnvironments(id) {
  const project = getProject(id);
  return {
    configured: listConfiguredEnvironments(project.config),
    hasOverrides: hasEnvironmentOverrides(project.config),
  };
}

/**
 * @param {string} id
 * @returns {Promise<object>} telemetry payload from TelemetryService.
 * @throws {NotFoundError} if the project doesn't exist.
 * @throws {Error} (untyped) if secret resolution or the telemetry probe
 *   itself fails — the caller (HTTP layer) maps this to a 500 with an
 *   `{ error, status: 'offline' }` body, distinct from the 404 above.
 */
async function getProjectTelemetry(id) {
  const project = getProject(id);

  // T-18b: telemetry is opt-in per Server/SSH/WinRM project, defaulting to
  // false. Short-circuit here — before resolving any secrets — so a
  // disabled project never even decrypts a stored credential, let alone
  // opens a socket to it. Non-server providers (Jenkins, PMP) never had
  // telemetry to begin with; leave those to TelemetryService's own
  // `{ status: 'unknown' }` fallback rather than reporting them 'disabled'.
  // TelemetryService.getTelemetry() carries the same telemetryEnabled check
  // independently (defense in depth for any other caller), but this avoids
  // the wasted secret-store round trip on the hot path.
  if (isServerProvider(project.provider) && project.config?.telemetryEnabled !== true) {
    return { status: 'disabled' };
  }

  // Same rule as the deploy path: resolve into a throwaway object so the
  // persisted project keeps its `secret://` references.
  const runtimeProject = await resolveProjectSecrets(project, secretStore);
  return TelemetryService.getTelemetry(runtimeProject);
}

module.exports = {
  loadProjects,
  findProjectById,
  getProject,
  listProjects,
  createProject,
  updateProjectConfig,
  deleteProject,
  getProjectEnvironments,
  getProjectTelemetry,
};
