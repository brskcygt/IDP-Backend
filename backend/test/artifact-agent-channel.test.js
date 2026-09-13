'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  sendAgentCommand,
  MAX_ARTIFACT_COMMAND_BYTES,
} = require('../src/core/artifacts/agentChannel');
const { ValidationError } = require('../src/core/errors');

test('artifact commands are rejected locally before exceeding the gateway body limit', async () => {
  let calls = 0;
  const gateway = {
    async sendArtifactCommand() {
      calls += 1;
    },
  };
  await assert.rejects(
    sendAgentCommand(gateway, 'WIN-01', 'artifact_config_apply', {
      value: 'x'.repeat(MAX_ARTIFACT_COMMAND_BYTES),
    }),
    ValidationError,
  );
  assert.equal(calls, 0);
});

test('artifact commands below the gateway body limit are forwarded', async () => {
  let received = null;
  const gateway = {
    async sendArtifactCommand(agentId, process, payload) {
      received = { agentId, process, payload };
    },
  };
  await sendAgentCommand(gateway, 'WIN-01', 'artifact_status', { requestId: 'req_1' });
  assert.deepEqual(received, {
    agentId: 'WIN-01',
    process: 'artifact_status',
    payload: { requestId: 'req_1' },
  });
});
