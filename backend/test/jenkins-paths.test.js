'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { jenkinsJobPath } = require('../src/adapters/jenkinsPaths');

test('jenkinsJobPath builds the remote API path for a top-level job', () => {
  assert.equal(jenkinsJobPath('release job'), '/job/release%20job');
});

test('jenkinsJobPath preserves Jenkins folder boundaries while encoding each name', () => {
  assert.equal(jenkinsJobPath('team/backend release'), '/job/team/job/backend%20release');
  assert.equal(jenkinsJobPath('/team/backend/'), '/job/team/job/backend');
});

test('jenkinsJobPath rejects an empty job name', () => {
  assert.throws(() => jenkinsJobPath(''), /job name is required/i);
});
