'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/store/db');
const { createArtifactDeployRepository } = require('../src/store/artifactDeployRepository');
const { createTargetService } = require('../src/core/artifacts/targetService');
const { ConflictError, ValidationError, UpstreamError } = require('../src/core/errors');

class FakeGateway {
  constructor() {
    this.agents = [{ id: 'WIN-01', online: true }, { id: 'WIN-02', online: false }];
    this.sent = [];
    this.handler = null;
    this.statusPayload = null;
    this.closed = 0;
  }

  async listAgents() {
    return this.agents;
  }

  subscribe(_agentId, handlers) {
    this.handler = handlers;
    setImmediate(() => handlers.onMessage({ process: 'handshake_ack' }));
    return () => { this.closed += 1; };
  }

  async sendArtifactCommand(agentId, process, payload) {
    this.sent.push({ agentId, process, payload });
    if (this.statusPayload) {
      const result = { ...this.statusPayload, requestId: payload.requestId };
      setImmediate(() => this.handler.onMessage({
        type: 'agent',
        agentId,
        process: 'artifact_status_result',
        payload: result,
      }));
    }
  }
}

function setup({ busy = () => false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-target-service-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  const repository = createArtifactDeployRepository(db);
  const gateway = new FakeGateway();
  const audit = [];
  const project = {
    id: 'p1',
    name: 'JetSRM',
    config: {
      artifactDeploy: {
        source: { platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm' },
        build: { provider: 'none' },
        components: [
          { name: 'backend', subdir: 'backend', runtime: { type: 'nssm', serviceName: 'jetsrm' } },
          { name: 'frontend', subdir: 'frontend', runtime: { type: 'iis-static' } },
        ],
      },
    },
  };
  const service = createTargetService({
    repository,
    auditLogger: { log: (user, action, description, metadata) => audit.push({ user, action, description, metadata }) },
    getProject: (id) => {
      if (id !== project.id) throw new Error('Project not found');
      return project;
    },
    getGateway: () => gateway,
    isTargetBusy: busy,
    timing: { statusTimeoutMs: 25, channelTimeoutMs: 25 },
  });
  return {
    db, repository, gateway, audit, service,
    cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('target CRUD enforces registered agents, one target per agent and configured components', async () => {
  const env = setup();
  try {
    await assert.rejects(
      env.service.createTarget('p1', { name: 'bad', agentId: 'UNKNOWN', os: 'windows' }, 'alice'),
      ValidationError
    );
    await assert.rejects(
      env.service.createTarget('p1', {
        name: 'bad-component', agentId: 'WIN-01', os: 'windows', components: [{ name: 'unknown' }],
      }, 'alice'),
      ValidationError
    );

    const target = await env.service.createTarget('p1', {
      name: 'temsa', agentId: 'WIN-01', os: 'windows', components: [{ name: 'backend' }],
    }, 'alice');
    assert.equal(env.service.getTarget(target.id).agentId, 'WIN-01');
    assert.deepEqual(env.service.listTargets('p1').map((entry) => entry.id), [target.id]);
    await assert.rejects(
      env.service.createTarget('p1', { name: 'duplicate', agentId: 'WIN-01', os: 'windows' }, 'alice'),
      ConflictError
    );

    const updated = await env.service.updateTarget(target.id, { name: 'temsa-prod', agentId: 'WIN-02' }, 'alice');
    assert.equal(updated.name, 'temsa-prod');
    assert.equal(updated.agentId, 'WIN-02');
    env.service.deleteTarget(target.id, 'alice');
    assert.deepEqual(env.service.listTargets('p1'), []);
    assert.deepEqual(env.audit.map((entry) => entry.action), [
      'DEPLOY_TARGET_CREATED', 'DEPLOY_TARGET_UPDATED', 'DEPLOY_TARGET_DELETED',
    ]);
  } finally {
    env.cleanup();
  }
});

test('busy targets cannot be updated or deleted', async () => {
  let busyId = null;
  const env = setup({ busy: (id) => id === busyId });
  try {
    const target = await env.service.createTarget('p1', { name: 'temsa', agentId: 'WIN-01', os: 'windows' }, 'alice');
    busyId = target.id;
    await assert.rejects(env.service.updateTarget(target.id, { name: 'new-name' }, 'alice'), ConflictError);
    assert.throws(() => env.service.deleteTarget(target.id, 'alice'), ConflictError);
  } finally {
    env.cleanup();
  }
});

test('refreshStatus sanitizes the agent response and links a matching release', async () => {
  const env = setup();
  try {
    const release = env.repository.createRelease({ projectId: 'p1', version: '2.5.0', status: 'ready' });
    const target = await env.service.createTarget('p1', { name: 'temsa', agentId: 'WIN-01', os: 'windows' }, 'alice');
    env.gateway.statusPayload = {
      basePath: 'C:\\Apps\\JetSRM',
      components: {
        backend: { version: '2.5.0', deployedAt: '2026-09-13T12:00:00Z', previousVersions: ['2.4.0', '../bad'] },
        'bad/name': { version: '9.9.9' },
      },
    };

    const refreshed = await env.service.refreshStatus(target.id);
    assert.equal(refreshed.basePath, 'C:\\Apps\\JetSRM');
    assert.equal(refreshed.currentReleaseId, release.id);
    assert.deepEqual(refreshed.currentVersions.backend.previousVersions, ['2.4.0']);
    assert.equal(refreshed.currentVersions['bad/name'], undefined);
    assert.equal(env.gateway.sent[0].process, 'artifact_status');
    assert.equal(env.gateway.closed, 1);
  } finally {
    env.cleanup();
  }
});

test('refreshStatus times out cleanly and closes the gateway subscription', async () => {
  const env = setup();
  try {
    const target = await env.service.createTarget('p1', { name: 'temsa', agentId: 'WIN-01', os: 'windows' }, 'alice');
    await assert.rejects(env.service.refreshStatus(target.id), UpstreamError);
    assert.equal(env.gateway.closed, 1);
  } finally {
    env.cleanup();
  }
});
