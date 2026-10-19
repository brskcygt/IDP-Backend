'use strict';

const crypto = require('node:crypto');

function deriveArtifactUploadToken(masterToken, projectId) {
  if (typeof masterToken !== 'string' || masterToken.length < 32) throw new Error('Artifact upload master token is unavailable.');
  if (typeof projectId !== 'string' || projectId.trim() === '') throw new Error('Project id is required.');
  return `idpu_${crypto.createHmac('sha256', masterToken).update(`project:${projectId}`).digest('base64url')}`;
}

function verifyArtifactUploadToken(masterToken, projectId, receivedToken) {
  if (!masterToken || !receivedToken) return false;
  const expected = Buffer.from(deriveArtifactUploadToken(masterToken, projectId));
  const received = Buffer.from(String(receivedToken));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

/**
 * One token for a CI server that builds many projects (one Jenkins), so it does
 * not need a credential per job. It may upload to any project; the project is
 * named by its artifactName (see GET /api/artifact-uploads/context). Derived
 * from the same master with its own prefix, so it is never a project's token.
 */
function deriveCiServerToken(masterToken) {
  if (typeof masterToken !== 'string' || masterToken.length < 32) throw new Error('Artifact upload master token is unavailable.');
  return `idpc_${crypto.createHmac('sha256', masterToken).update('ci-server:all-projects').digest('base64url')}`;
}

function verifyCiServerToken(masterToken, receivedToken) {
  if (!masterToken || !receivedToken) return false;
  const expected = Buffer.from(deriveCiServerToken(masterToken));
  const received = Buffer.from(String(receivedToken));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

module.exports = { deriveArtifactUploadToken, verifyArtifactUploadToken, deriveCiServerToken, verifyCiServerToken };
