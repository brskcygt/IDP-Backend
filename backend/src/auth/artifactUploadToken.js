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

module.exports = { deriveArtifactUploadToken, verifyArtifactUploadToken };
