'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
const { deriveArtifactUploadToken, deriveCiServerToken } = require('../src/auth/artifactUploadToken');

// <project-id>: that project's upload token.
// --ci-server: one token for a CI server that builds many projects (any project,
// named by its artifactName) — one Jenkins credential instead of one per job.
const arg = process.argv[2];
if (!arg || process.argv.length !== 3) {
  console.error('Usage: node scripts/derive-artifact-upload-token.js <project-id> | --ci-server');
  process.exit(2);
}

try {
  const master = process.env.IDP_ARTIFACT_UPLOAD_TOKEN || '';
  console.log(arg === '--ci-server' ? deriveCiServerToken(master) : deriveArtifactUploadToken(master, arg));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
