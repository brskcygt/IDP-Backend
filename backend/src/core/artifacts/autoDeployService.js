'use strict';

/**
 * Installs a release CI built on its own (a push to e.g. `test`, not a build
 * IDP started) on the targets that asked for it.
 *
 * Opt-in on both ends: CI only uploads pushes of the branches it was told to
 * (see the app's Jenkinsfile), and only targets with `autoDeploy` on and the
 * same `ref` take the build. Production never does — `targetAutoDeployErrors`
 * keeps it off when saving, and it is checked again here because a project's
 * environment can change after the target was saved.
 *
 * Nothing here throws back into the upload: the release IS ready, a target
 * that cannot take it (offline agent, a deploy already running) is audited and
 * skipped.
 */
const { normalizeArtifactDeployConfig, isProdTarget } = require('./contracts');

const AUTO_DEPLOY_USER = 'ci-auto-deploy';

function createAutoDeployService({ repository, auditLogger, getProject, deployRelease }) {
  /** Components of `release` the target runs: the ones this upload can install there. */
  function componentsFor(target, project, release) {
    const config = normalizeArtifactDeployConfig(project.config && project.config.artifactDeploy);
    const projectNames = (config ? config.components : []).map((component) => component.name);
    const targetNames = Array.isArray(target.components) && target.components.length > 0
      ? target.components.map((component) => component.name)
      : projectNames;
    const built = new Set(repository.listArtifacts(release.id).map((artifact) => artifact.component));
    return targetNames.filter((name) => built.has(name));
  }

  return {
    /**
     * Branches whose push builds some target of the project installs. CI asks
     * this (upload context) to decide whether a push is worth a release, so the
     * list lives in one place: the targets' "install on push" settings.
     */
    autoDeployBranches(projectId) {
      const project = getProject(projectId);
      const refs = repository.listTargets(projectId)
        .filter((target) => target.autoDeploy && target.ref && !isProdTarget(target, project))
        .map((target) => target.ref);
      return [...new Set(refs)].sort();
    },

    async onCiReleaseReady({ projectId, release, ref }) {
      const project = getProject(projectId);
      const targets = repository.listTargets(projectId).filter((target) => target.autoDeploy && target.ref === ref);
      const results = [];
      for (const target of targets) {
        const meta = { projectId, targetId: target.id, targetName: target.name, releaseId: release.id, version: release.version, ref };
        if (isProdTarget(target, project)) {
          auditLogger.log(AUTO_DEPLOY_USER, 'RELEASE_AUTO_DEPLOY_SKIPPED',
            `Skipped automatic install of ${release.version} on production target '${target.name}'`, meta, { outcome: 'failure' });
          results.push({ targetId: target.id, status: 'skipped', reason: 'production' });
          continue;
        }
        const components = componentsFor(target, project, release);
        if (components.length === 0) {
          auditLogger.log(AUTO_DEPLOY_USER, 'RELEASE_AUTO_DEPLOY_SKIPPED',
            `Release ${release.version} has no component that target '${target.name}' runs`, meta, { outcome: 'failure' });
          results.push({ targetId: target.id, status: 'skipped', reason: 'no-components' });
          continue;
        }
        try {
          const run = await deployRelease({ targetId: target.id, releaseId: release.id, components, triggeredBy: AUTO_DEPLOY_USER });
          auditLogger.log(AUTO_DEPLOY_USER, 'RELEASE_AUTO_DEPLOY_STARTED',
            `Installing ${release.version} (${ref}) on target '${target.name}' automatically`,
            { ...meta, components, deploymentId: (run && run.deploymentId) || null });
          results.push({ targetId: target.id, status: 'started', deploymentId: (run && run.deploymentId) || null });
        } catch (err) {
          auditLogger.log(AUTO_DEPLOY_USER, 'RELEASE_AUTO_DEPLOY_FAILED',
            `Automatic install of ${release.version} on target '${target.name}' could not start: ${err.message}`,
            { ...meta, components, error: String(err.message || err).slice(0, 500) }, { outcome: 'failure' });
          results.push({ targetId: target.id, status: 'failed', error: err.message });
        }
      }
      return results;
    },
  };
}

module.exports = { createAutoDeployService, AUTO_DEPLOY_USER };
