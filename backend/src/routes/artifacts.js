'use strict';

/**
 * Artifact deploy HTTP routes (docs/ARTIFACT-DEPLOY.md).
 *
 *   GET    /api/projects/:id/releases              project:read
 *   POST   /api/projects/:id/releases              release:create  {version, ref?}  → build (SSE)
 *   POST   /api/projects/:id/releases/import       release:create  {version}
 *   GET    /api/releases/:id                       project:read
 *   DELETE /api/releases/:id                       release:delete (admin; DB rows only)
 *   GET    /api/projects/:id/targets               project:read
 *   POST   /api/projects/:id/targets               project:write
 *   PUT    /api/targets/:id                        project:write
 *   DELETE /api/targets/:id                        project:write
 *   POST   /api/targets/:id/refresh-status         deploy:trigger
 *   POST   /api/targets/:id/deploy                 deploy:trigger  {releaseId, components?, confirmation?}
 *   POST   /api/targets/:id/rollback               deploy:trigger  {components?, confirmation?}
 *   GET    /api/deployments/:id/events             project:read
 *
 *   GET    /api/artifacts/:artifactId/download     NO session — `Authorization: Bearer <download token>` only
 *
 * Cancel = the existing POST /api/deploy/:id/abort (deploy:abort).
 * Business logic lives in core/artifacts/*; this file maps HTTP in/out.
 */

const express = require('express');
const { pipeline } = require('node:stream/promises');
const { requirePermission } = require('../auth/permissions');
const { validate, string, array, object, optional } = require('../validation/schema');
const { sendError } = require('../http/errorMapper');
const { VERSION_PATTERN, COMPONENT_NAME_PATTERN, checkTargetConfirmation } = require('../core/artifacts/contracts');

const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{24}$/;

const versionRule = () => string({ min: 1, max: 64, pattern: VERSION_PATTERN });
const componentsRule = () => optional(array({ max: 10, of: string({ min: 1, max: 32, pattern: COMPONENT_NAME_PATTERN }) }));

const createReleaseSchema = object({
  fields: { version: versionRule(), ref: optional(string({ max: 255 })) },
  allowUnknown: false,
});
const importReleaseSchema = object({ fields: { version: versionRule() }, allowUnknown: false });
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

function bearerToken(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(req.get('authorization') || '').trim());
  return match ? match[1] : '';
}

/**
 * @param {object} deps
 * @param {{ releaseService: object, targetService: object, artifactDeployService: object, downloadService: object }} deps.services
 * @param {(id: string) => object} deps.getProject
 * @param {{ log: Function }} deps.auditLogger
 * @param {string|null} deps.publicUrl - IDP_PUBLIC_URL (validated), null = artifact deploy disabled.
 * @param {string|null} [deps.publicUrlError]
 * @param {{ trigger?: Function, download?: Function }} [deps.rateLimits]
 * @returns {{ apiRouter: import('express').Router, downloadRouter: import('express').Router }}
 */
function createArtifactRoutes({ services, getProject, auditLogger, publicUrl = null, publicUrlError = null, rateLimits = {} }) {
  if (!services) throw new Error('createArtifactRoutes: services are required.');
  if (!auditLogger) throw new Error('createArtifactRoutes: auditLogger is required.');
  const { releaseService, targetService, artifactDeployService, downloadService } = services;
  const trigger = rateLimits.trigger ? [rateLimits.trigger] : [];
  const actor = (req) => req.session?.user?.username;
  const invalid = (res, message, result) => res.status(400).json({ error: message, details: result.errors });

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
        triggeredBy: actor(req),
      });
      res.status(202).json({ release, deploymentId, sseUrl: `/api/deploy/logs/${deploymentId}` });
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

  api.get('/api/projects/:id/targets', requirePermission('project:read'), (req, res) => {
    try {
      res.json(targetService.listTargets(req.params.id));
    } catch (err) {
      sendError(res, err);
    }
  });

  api.post('/api/projects/:id/targets', requirePermission('project:write'), async (req, res) => {
    try {
      res.status(201).json(await targetService.createTarget(req.params.id, req.body ?? {}, actor(req)));
    } catch (err) {
      sendError(res, err);
    }
  });

  api.put('/api/targets/:id', requirePermission('project:write'), async (req, res) => {
    try {
      res.json(await targetService.updateTarget(req.params.id, req.body ?? {}, actor(req)));
    } catch (err) {
      sendError(res, err);
    }
  });

  api.delete('/api/targets/:id', requirePermission('project:write'), (req, res) => {
    try {
      targetService.deleteTarget(req.params.id, actor(req));
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
      const target = targetService.getTarget(req.params.id);
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
      const target = targetService.getTarget(req.params.id);
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

  return { apiRouter: api, downloadRouter: download };
}

module.exports = { createArtifactRoutes, ARTIFACT_ID_PATTERN };
