'use strict';

/**
 * Artifact deploy HTTP routes (docs/ARTIFACT-DEPLOY.md).
 *
 *   GET    /api/projects/:id/releases              project:read
 *   POST   /api/projects/:id/releases              release:create  {version, ref?, refType?}  → build (SSE)
 *   POST   /api/projects/:id/releases/import       release:create  {version}
 *   POST   /api/projects/:id/releases/compose      release:create  {base, branches, version?, components?, deployTo?} → build (SSE)
 *   GET    /api/projects/:id/repo/refs             project:read    ?q=&hidePreview=1
 *   POST   /api/projects/:id/repo/tags             release:tag (admin)  {name, from, message?}
 *   GET    /api/releases/:id                       project:read
 *   DELETE /api/releases/:id                       release:delete (admin; DB rows only)
 *   GET    /api/projects/:id/targets               project:read
 *   POST   /api/projects/:id/targets               project:write
 *   PUT    /api/targets/:id                        project:write
 *   DELETE /api/targets/:id                        project:write
 *   POST   /api/targets/:id/refresh-status         deploy:trigger
 *   POST   /api/targets/:id/deploy                 deploy:trigger  {releaseId, components?, confirmation?}
 *   POST   /api/targets/:id/rollback               deploy:trigger  {components?, confirmation?}
 *   POST   /api/targets/:id/apply-config           deploy:trigger  {confirmation?}
 *   GET    /api/deployments/:id/events             project:read
 *
 *   GET    /api/artifacts/:artifactId/download     NO session — `Authorization: Bearer <download token>` only
 *   PUT    /api/artifact-uploads/:projectId/:version/:fileName  CI bearer + raw .tar.gz
 *   POST   /api/artifact-uploads/:projectId/:version/finalize  CI bearer + manifest JSON
 *   GET    /api/artifact-uploads/context[?artifact=<name>]     CI bearer → its project + auto-deploy branches
 *
 * Cancel = the existing POST /api/deploy/:id/abort (deploy:abort).
 * Business logic lives in core/artifacts/*; this file maps HTTP in/out.
 */

const express = require('express');
const { pipeline } = require('node:stream/promises');
const { verifyArtifactUploadToken, verifyCiServerToken } = require('../auth/artifactUploadToken');
const { requirePermission } = require('../auth/permissions');
const { validate, string, array, object, optional } = require('../validation/schema');
const { sendError } = require('../http/errorMapper');
const { VERSION_PATTERN, COMPONENT_NAME_PATTERN, checkTargetConfirmation } = require('../core/artifacts/contracts');

const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{24}$/;

const versionRule = () => string({ min: 1, max: 64, pattern: VERSION_PATTERN });
const componentsRule = () => optional(array({ max: 10, of: string({ min: 1, max: 32, pattern: COMPONENT_NAME_PATTERN }) }));

const createReleaseSchema = object({
  // `components` narrows WHAT is built, not HOW: the names are validated against
  // the project's configured components, so a caller can only ever ask for a
  // subset of what an admin already declared. That is the same kind of choice as
  // picking the version, which is why it is allowed at release:create level
  // while free-form build inputs still are not.
  fields: {
    version: versionRule(),
    ref: optional(string({ max: 255 })),
    refType: optional(string({ enum: ['branch', 'tag'] })),
    components: componentsRule(),
  },
  allowUnknown: false,
});
const refTypeRule = (values) => string({ enum: values });
const composeReleaseSchema = object({
  fields: {
    base: object({ fields: { type: refTypeRule(['branch', 'tag']), name: string({ min: 1, max: 255 }) } }),
    branches: array({ max: 10, of: string({ min: 1, max: 255 }) }),
    version: optional(versionRule()),
    components: componentsRule(),
    deployTo: optional(object({ fields: { targetId: string({ min: 1, max: 64 }), components: componentsRule() } })),
  },
  allowUnknown: false,
});
const createTagSchema = object({
  fields: {
    name: versionRule(),
    from: object({ fields: { type: refTypeRule(['branch', 'commit']), name: string({ min: 1, max: 255 }) } }),
    message: optional(string({ max: 1000 })),
  },
  allowUnknown: false,
});
const importReleaseSchema = object({ fields: { version: versionRule() }, allowUnknown: false });
const folderReleaseSchema = object({
  fields: {
    version: versionRule(),
    files: array({
      min: 1,
      max: 10,
      of: object({
        fields: { component: string({ min: 1, max: 32, pattern: COMPONENT_NAME_PATTERN }), file: string({ min: 1, max: 255 }) },
        allowUnknown: false,
      }),
    }),
  },
  allowUnknown: false,
});
const buildAndDeploySchema = object({ fields: { components: componentsRule() }, allowUnknown: false });
const deploySchema = object({
  fields: {
    releaseId: string({ min: 1, max: 64 }),
    components: componentsRule(),
    confirmation: optional(string({ max: 200 })),
  },
  allowUnknown: false,
});
const rollbackSchema = object({
  fields: { components: componentsRule(), confirmation: optional(string({ max: 200 })) },
  allowUnknown: false,
});
const applyConfigSchema = object({
  fields: { confirmation: optional(string({ max: 200 })) },
  allowUnknown: false,
});

function bearerToken(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(req.get('authorization') || '').trim());
  return match ? match[1] : '';
}

/**
 * @param {object} deps
 * @param {{ releaseService: object, targetService: object, artifactDeployService: object, uploadService?: object, downloadService: object }} deps.services
 * @param {(id: string) => object} deps.getProject
 * @param {{ log: Function }} deps.auditLogger
 * @param {string|null} deps.publicUrl - IDP_PUBLIC_URL (validated), null = artifact deploy disabled.
 * @param {string|null} [deps.publicUrlError]
 * @param {{ token?: string|null, maxArtifactBytes?: number }} [deps.upload]
 * @param {{ trigger?: Function, download?: Function, upload?: Function }} [deps.rateLimits]
 * @returns {{ apiRouter: import('express').Router, downloadRouter: import('express').Router, uploadRouter: import('express').Router }}
 */
function createArtifactRoutes({ services, getProject, listProjects = () => [], auditLogger, publicUrl = null, publicUrlError = null, upload = {}, rateLimits = {} }) {
  if (!services) throw new Error('createArtifactRoutes: services are required.');
  if (!auditLogger) throw new Error('createArtifactRoutes: auditLogger is required.');
  const { releaseService, composeService, targetService, artifactDeployService, uploadService, autoDeployService, folderImportService, downloadService } = services;
  const trigger = rateLimits.trigger ? [rateLimits.trigger] : [];
  const actor = (req) => req.session?.user?.username;
  const invalid = (res, message, result) => res.status(400).json({ error: message, details: result.errors });

  // The project's own token, or the CI server token (any project).
  function validUploadBearer(req) {
    const received = bearerToken(req);
    return verifyArtifactUploadToken(upload.token, req.params.projectId, received) || verifyCiServerToken(upload.token, received);
  }

  const api = express.Router();

  // ---------------------------------------------------------------- releases

  api.get('/api/projects/:id/releases', requirePermission('project:read'), (req, res) => {
    try {
      res.json(releaseService.listReleases(req.params.id));
    } catch (err) {
      sendError(res, err);
    }
  });

  api.post('/api/projects/:id/releases', requirePermission('release:create'), ...trigger, async (req, res) => {
    const body = validate(req.body ?? {}, createReleaseSchema);
    if (!body.valid) return invalid(res, 'Invalid release request.', body);
    try {
      const { release, deploymentId } = await releaseService.createRelease({
        projectId: req.params.id,
        version: body.value.version,
        ref: body.value.ref,
        refType: body.value.refType,
        components: body.value.components,
        triggeredBy: actor(req),
      });
      res.status(202).json({ release, deploymentId, sseUrl: `/api/deploy/logs/${deploymentId}` });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Test-server flow: rebuild the target's branch and install it there, with no
  // version to invent. Refused for production targets — see releaseService.buildAndDeploy.
  api.post('/api/targets/:id/build-and-deploy', requirePermission('release:create'), ...trigger, async (req, res) => {
    const body = validate(req.body ?? {}, buildAndDeploySchema);
    if (!body.valid) return invalid(res, 'Invalid build request.', body);
    try {
      const { release, deploymentId } = await releaseService.buildAndDeploy({
        targetId: req.params.id,
        components: body.value.components,
        triggeredBy: actor(req),
      });
      res.status(202).json({ release, deploymentId, sseUrl: `/api/deploy/logs/${deploymentId}` });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Release composer: base + feature branches merged into a preview branch,
  // then the regular build. Business rules (unique branches, non-prod target,
  // Bitbucket only) live in core/artifacts/composeService.js.
  api.post('/api/projects/:id/releases/compose', requirePermission('release:create'), ...trigger, async (req, res) => {
    const body = validate(req.body ?? {}, composeReleaseSchema);
    if (!body.valid) return invalid(res, 'Invalid compose request.', body);
    try {
      const { release, deploymentId } = await composeService.compose({
        projectId: req.params.id,
        base: body.value.base,
        branches: body.value.branches,
        version: body.value.version,
        components: body.value.components,
        deployTo: body.value.deployTo,
        triggeredBy: actor(req),
      });
      res.status(202).json({ release, deploymentId, sseUrl: `/api/deploy/logs/${deploymentId}` });
    } catch (err) {
      sendError(res, err);
    }
  });

  api.get('/api/projects/:id/repo/refs', requirePermission('project:read'), async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    if (req.query.q !== undefined && q === undefined) return res.status(400).json({ error: 'q must be a single string.' });
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await composeService.listRefs({
        projectId: req.params.id,
        q,
        hidePreview: req.query.hidePreview === '1' || req.query.hidePreview === 'true',
      }));
    } catch (err) {
      sendError(res, err);
    }
  });

  api.post('/api/projects/:id/repo/tags', requirePermission('release:tag'), ...trigger, async (req, res) => {
    const body = validate(req.body ?? {}, createTagSchema);
    if (!body.valid) return invalid(res, 'Invalid tag request.', body);
    try {
      res.status(201).json(await composeService.createTag({
        projectId: req.params.id,
        name: body.value.name,
        from: body.value.from,
        message: body.value.message,
        triggeredBy: actor(req),
      }));
    } catch (err) {
      sendError(res, err);
    }
  });

  api.post('/api/projects/:id/releases/import', requirePermission('release:create'), ...trigger, async (req, res) => {
    const body = validate(req.body ?? {}, importReleaseSchema);
    if (!body.valid) return invalid(res, 'Invalid import request.', body);
    try {
      res.json(await releaseService.importRelease({ projectId: req.params.id, version: body.value.version, triggeredBy: actor(req) }));
    } catch (err) {
      sendError(res, err);
    }
  });

  // Build folder on this server: ready .tar.gz files another CI copied here.
  api.get('/api/projects/:id/build-folder', requirePermission('release:create'), async (req, res) => {
    try {
      res.json(await folderImportService.listFolder(req.params.id));
    } catch (err) {
      sendError(res, err);
    }
  });

  api.post('/api/projects/:id/releases/from-folder', requirePermission('release:create'), ...trigger, async (req, res) => {
    const body = validate(req.body ?? {}, folderReleaseSchema);
    if (!body.valid) return invalid(res, 'Invalid folder release request.', body);
    try {
      res.json(await folderImportService.importFromFolder({
        projectId: req.params.id,
        version: body.value.version,
        files: body.value.files,
        triggeredBy: actor(req),
      }));
    } catch (err) {
      sendError(res, err);
    }
  });

  api.get('/api/releases/:id', requirePermission('project:read'), (req, res) => {
    try {
      res.json(releaseService.getRelease(req.params.id));
    } catch (err) {
      sendError(res, err);
    }
  });

  api.delete('/api/releases/:id', requirePermission('release:delete'), (req, res) => {
    try {
      releaseService.deleteRelease(req.params.id, actor(req));
      res.status(204).end();
    } catch (err) {
      sendError(res, err);
    }
  });

  // ----------------------------------------------------------------- targets

  api.get('/api/projects/:id/targets', requirePermission('project:read'), async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await targetService.listTargets(req.params.id, {
        includeRuntimeConfig: req.session?.user?.role === 'admin',
      }));
    } catch (err) {
      sendError(res, err);
    }
  });

  api.post('/api/projects/:id/targets', requirePermission('project:write'), async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.status(201).json(await targetService.createTarget(req.params.id, req.body ?? {}, actor(req)));
    } catch (err) {
      sendError(res, err);
    }
  });

  api.put('/api/targets/:id', requirePermission('project:write'), async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await targetService.updateTarget(req.params.id, req.body ?? {}, actor(req)));
    } catch (err) {
      sendError(res, err);
    }
  });

  api.delete('/api/targets/:id', requirePermission('project:write'), async (req, res) => {
    try {
      await targetService.deleteTarget(req.params.id, actor(req));
      res.status(204).end();
    } catch (err) {
      sendError(res, err);
    }
  });

  api.post('/api/targets/:id/refresh-status', requirePermission('deploy:trigger'), ...trigger, async (req, res) => {
    try {
      res.json(await targetService.refreshStatus(req.params.id));
    } catch (err) {
      sendError(res, err);
    }
  });

  /** Prod targets: `confirmation` must equal the target name (same 400 body as T-51). */
  function confirmationError(target, confirmation) {
    return checkTargetConfirmation(target, getProject(target.projectId), confirmation);
  }

  api.post('/api/targets/:id/deploy', requirePermission('deploy:trigger'), ...trigger, async (req, res) => {
    if (!publicUrl) {
      return res.status(503).json({
        error:
          `${publicUrlError || 'IDP_PUBLIC_URL tanımlı değil.'} ` +
          "backend/.env içine backend'in agent'lardan erişilebilen HTTPS adresini (ör. https://idp.<alan>) yazıp backend'i yeniden başlatın.",
      });
    }
    const body = validate(req.body ?? {}, deploySchema);
    if (!body.valid) return invalid(res, 'Invalid deploy request.', body);
    try {
      const target = await targetService.getTarget(req.params.id);
      const rejection = confirmationError(target, body.value.confirmation);
      if (rejection) return res.status(400).json(rejection);
      const result = await artifactDeployService.deploy({
        targetId: target.id,
        releaseId: body.value.releaseId,
        components: body.value.components,
        triggeredBy: actor(req),
        publicUrl,
      });
      res.status(202).json({
        ...result,
        sseUrl: `/api/deploy/logs/${result.deploymentId}`,
        eventsUrl: `/api/deployments/${result.deploymentId}/events`,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  api.post('/api/targets/:id/rollback', requirePermission('deploy:trigger'), ...trigger, async (req, res) => {
    const body = validate(req.body ?? {}, rollbackSchema);
    if (!body.valid) return invalid(res, 'Invalid rollback request.', body);
    try {
      const target = await targetService.getTarget(req.params.id);
      const rejection = confirmationError(target, body.value.confirmation);
      if (rejection) return res.status(400).json(rejection);
      const result = await artifactDeployService.rollback({
        targetId: target.id,
        components: body.value.components,
        triggeredBy: actor(req),
      });
      res.status(202).json({
        ...result,
        sseUrl: `/api/deploy/logs/${result.deploymentId}`,
        eventsUrl: `/api/deployments/${result.deploymentId}/events`,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  api.post('/api/targets/:id/apply-config', requirePermission('deploy:trigger'), ...trigger, async (req, res) => {
    const body = validate(req.body ?? {}, applyConfigSchema);
    if (!body.valid) return invalid(res, 'Invalid config apply request.', body);
    try {
      const target = await targetService.getTarget(req.params.id);
      const rejection = confirmationError(target, body.value.confirmation);
      if (rejection) return res.status(400).json(rejection);
      const result = await artifactDeployService.applyConfig({
        targetId: target.id,
        triggeredBy: actor(req),
      });
      res.status(202).json({
        ...result,
        sseUrl: `/api/deploy/logs/${result.deploymentId}`,
        eventsUrl: `/api/deployments/${result.deploymentId}/events`,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  api.get('/api/deployments/:id/events', requirePermission('project:read'), (req, res) => {
    try {
      res.json({ deploymentId: req.params.id, events: artifactDeployService.listEvents(req.params.id) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---------------------------------------------------------------- download

  const download = express.Router();
  const downloadGuards = rateLimits.download ? [rateLimits.download] : [];

  // No session: the agent authenticates with its per-deploy download token
  // (Authorization header only — never a query string, which ends up in
  // proxy/access logs). Any failure is a bare 401 so nothing is learned about
  // which part was wrong. The token itself is never logged or audited.
  download.get('/api/artifacts/:artifactId/download', ...downloadGuards, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { artifactId } = req.params;
    const knownShape = ARTIFACT_ID_PATTERN.test(artifactId);
    const agentHeader = String(req.get('x-idp-agent-id') || '').trim() || undefined;

    let authorized = null;
    try {
      authorized = knownShape ? downloadService.authorize({ artifactId, token: bearerToken(req), agentId: agentHeader }) : null;
    } catch (err) {
      console.error('[artifacts] Download authorization error:', err.message);
      authorized = null;
    }
    if (!authorized) {
      auditLogger.log(null, 'ARTIFACT_DOWNLOAD_REJECTED', 'Artifact download rejected (missing, invalid or expired token)',
        { artifactId: knownShape ? artifactId : null }, { outcome: 'failure' });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { artifact, binding } = authorized;
    const meta = {
      artifactId,
      releaseId: artifact.releaseId,
      component: artifact.component,
      agentId: binding.agentId,
      deploymentId: binding.deploymentId,
      use: binding.uses,
    };
    const upstream = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) upstream.abort();
    });

    let opened;
    try {
      opened = await downloadService.open(authorized, { signal: upstream.signal });
    } catch (err) {
      auditLogger.log(null, 'ARTIFACT_DOWNLOAD_FAILED', `Artifact download failed: ${artifact.fileName}`,
        { ...meta, error: err.message }, { outcome: 'failure' });
      if (!res.headersSent) res.status(502).json({ error: 'The artifact source is unavailable.' });
      return;
    }
    if (opened.contentLength !== null && opened.contentLength !== artifact.size) {
      opened.stream.destroy();
      auditLogger.log(null, 'ARTIFACT_DOWNLOAD_FAILED', `Artifact size mismatch at the source: ${artifact.fileName}`,
        { ...meta, error: `source Content-Length ${opened.contentLength} != manifest size ${artifact.size}` }, { outcome: 'failure' });
      return res.status(502).json({ error: 'The artifact at the source does not match the release manifest.' });
    }

    res.status(200).set({
      'Content-Type': 'application/gzip',
      'Content-Length': String(artifact.size),
      'X-Artifact-Sha256': artifact.sha256,
      'Content-Disposition': `attachment; filename="${artifact.fileName}"`,
    });
    try {
      await pipeline(opened.stream, res);
      auditLogger.log(null, 'ARTIFACT_DOWNLOADED', `Artifact downloaded: ${artifact.fileName}`, meta);
    } catch (err) {
      auditLogger.log(null, 'ARTIFACT_DOWNLOAD_FAILED', `Artifact download interrupted: ${artifact.fileName}`,
        { ...meta, error: upstream.signal.aborted ? 'client disconnected' : err.message }, { outcome: 'failure' });
      res.destroy();
    }
  });

  // --------------------------------------------------------------- CI upload

  const uploadRouter = express.Router();
  const uploadGuards = rateLimits.upload ? [rateLimits.upload] : [];

  function requireUploadToken(req, res, next) {
    if (!upload.token || !uploadService) {
      req.resume();
      return res.status(503).json({ error: 'CI artifact upload is not configured.' });
    }
    if (!validUploadBearer(req)) {
      req.resume();
      auditLogger.log(null, 'ARTIFACT_UPLOAD_REJECTED', 'CI artifact upload rejected', {}, { outcome: 'failure' });
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  }

  // Which project CI is building: a project token says it by itself; the CI
  // server token names it with `?artifact=<artifactName>` (the manifest's
  // `project`). CI keeps no project id and no list of branches of its own —
  // whether a push becomes a release is decided by the targets in IDP.
  uploadRouter.get('/api/artifact-uploads/context', ...uploadGuards, (req, res) => {
    if (!upload.token || !uploadService) return res.status(503).json({ error: 'CI artifact upload is not configured.' });
    const received = bearerToken(req);
    const artifact = typeof req.query.artifact === 'string' ? req.query.artifact.trim() : '';
    const artifactNameOf = (item) => item.config?.artifactDeploy?.artifactName ?? null;
    const projects = received ? listProjects() : [];
    let project = projects.find((item) => verifyArtifactUploadToken(upload.token, item.id, received)) || null;
    if (!project && received && verifyCiServerToken(upload.token, received)) {
      if (!artifact) return res.status(400).json({ error: 'The CI server token needs ?artifact=<artifactName> to name the project.' });
      const matches = projects.filter((item) => artifactNameOf(item) === artifact);
      if (matches.length === 0) return res.status(404).json({ error: `No IDP project has artifact name '${artifact}'.` });
      if (matches.length > 1) return res.status(409).json({ error: `More than one IDP project has artifact name '${artifact}'.` });
      project = matches[0];
    } else if (project && artifact && artifactNameOf(project) !== artifact) {
      return res.status(409).json({ error: `This token belongs to '${project.name}', whose artifact name is not '${artifact}'.` });
    }
    if (!project) {
      auditLogger.log(null, 'ARTIFACT_UPLOAD_REJECTED', 'CI upload context rejected', {}, { outcome: 'failure' });
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      return res.json({
        projectId: project.id,
        projectName: project.name,
        artifactName: project.config?.artifactDeploy?.artifactName ?? null,
        autoDeployBranches: autoDeployService ? autoDeployService.autoDeployBranches(project.id) : [],
      });
    } catch (err) {
      return sendError(res, err);
    }
  });

  uploadRouter.put('/api/artifact-uploads/:projectId/:version/:fileName', ...uploadGuards, requireUploadToken, async (req, res) => {
    const type = String(req.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!['application/gzip', 'application/x-gzip', 'application/octet-stream'].includes(type)) {
      req.resume();
      return res.status(415).json({ error: 'Content-Type must be application/gzip or application/octet-stream.' });
    }
    const rawLength = req.get('content-length');
    const contentLength = rawLength === undefined ? null : Number(rawLength);
    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
      req.resume();
      return res.status(400).json({ error: 'Invalid Content-Length.' });
    }
    if (contentLength !== null && upload.maxArtifactBytes && contentLength > upload.maxArtifactBytes) {
      req.resume();
      return res.status(413).json({ error: `Artifact exceeds the ${upload.maxArtifactBytes} byte upload limit.` });
    }
    try {
      const result = await uploadService.uploadArtifact({
        projectId: req.params.projectId,
        version: req.params.version,
        fileName: req.params.fileName,
        stream: req,
        sha256: String(req.get('x-artifact-sha256') || '').trim(),
        contentLength,
      });
      return res.status(result.idempotent ? 200 : 201).json(result);
    } catch (err) {
      if (err.code === 'ARTIFACT_TOO_LARGE') return res.status(413).json({ error: err.message });
      return sendError(res, err);
    }
  });

  uploadRouter.post('/api/artifact-uploads/:projectId/:version/finalize', ...uploadGuards, requireUploadToken, async (req, res) => {
    try {
      const result = await uploadService.finalizeRelease({
        projectId: req.params.projectId,
        version: req.params.version,
        manifest: req.body,
      });
      return res.status(result.idempotent ? 200 : 201).json(result);
    } catch (err) {
      return sendError(res, err);
    }
  });

  return { apiRouter: api, downloadRouter: download, uploadRouter };
}

module.exports = { createArtifactRoutes, ARTIFACT_ID_PATTERN };
