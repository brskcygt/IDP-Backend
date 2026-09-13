'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
const { deriveArtifactUploadToken } = require('../src/auth/artifactUploadToken');

const projectId = process.argv[2];
if (!projectId || process.argv.length !== 3) {
  console.error('Usage: node scripts/derive-artifact-upload-token.js <project-id>');
  process.exit(2);
}

try {
  console.log(deriveArtifactUploadToken(process.env.IDP_ARTIFACT_UPLOAD_TOKEN || '', projectId));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
