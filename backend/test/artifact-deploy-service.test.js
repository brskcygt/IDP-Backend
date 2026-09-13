/**
 * Artifact deploy service (core/artifacts/artifactDeployService.js) against a
 * fake agent gateway: payload build (OS selection, runtimeConfig only where
 * flagged, hooks, no secrets besides the download token), strict deployId
 * correlation (other deploys, other agents and the legacy
 * command_execution_result are ignored), results, timeout, cancel through
 * DeploymentManager.abort(), rollback, the per-target lock and preconditions.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/store/db');
const { createArtifactDeployRepository } = require('../src/store/artifactDeployRepository');
const { createDownloadTokenService } = require('../src/core/artifacts/downloadTokens');
const { createArtifactDeployService } = require('../src/core/artifacts/artifactDeployService');
const deploymentManager = require('../src/services/DeploymentManager');
const deploymentRepository = require('../src/store/deploymentRepository');
const { ValidationError, ConflictError, UpstreamError, NotFoundError } = require('../src/core/errors');

const PUBLIC_URL = 'https://idp.example';
const SHA = 'd'.repeat(64);

class FakeGateway {
  constructor() {
    this.agents = [{ id: 'WIN-01', online: true }, { id: 'LNX-01', online: true }, { id: 'OFF-01', online: false }];
    this.sent = [];
    this.subscriptions = new Set();
    this.failSend = null;
    this.failList = false;
  }
  async listAgents() {
    if (this.failList) throw new Error('connect ECONNREFUSED 127.0.0.1:7004');
    return this.agents;
  }
  async sendArtifactCommand(agentId, process, payload) {
    if (this.failSend) throw this.failSend;
    this.sent.push({ agentId, process, payload: JSON.parse(JSON.stringify(payload)) });
    return { type: true, sent: true };
  }
  subscribe(agentId, handlers) {
    const sub = { agentId, handlers, closed: false };
    this.subscriptions.add(sub);
    setImmediate(() => handlers.onMessage({ type: 'server', process: 'handshake_ack', payload: { connected: true } }));
    return () => {
      sub.closed = true;
      this.subscriptions.delete(sub);
    };
  }
  emit(agentId, process, payload) {
    for (const sub of [...this.subscriptions]) {
      sub.handlers.onMessage({ date: new Date().toISOString(), type: 'agent', agentId, process, payload });
    }
  }
  drop() {
    for (const sub of [...this.subscriptions]) {
      this.subscriptions.delete(sub);
      sub.handlers.onClose();
    }
  }
  last(process) {
    return [...this.sent].reverse().find((entry) => entry.process === process);
  }
}

function makeProject() {
  return {
    id: 'p1',
    name: 'JetSRM',
    environment: 'Dev',
    config: {
      apiToken: 'CI-SECRET',
      artifactDeploy: {
        source: { platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm', token: 'SRC-SECRET' },
        build: { provider: 'pipeline' },
        components: [
          {
            name: 'backend',
            subdir: 'backend',
            runtime: { type: 'nssm', serviceName: 'jetsrm-backend' },
            preserve: ['.env', 'certificates/**', 'uploads/**'],
            health: { url: 'http://127.0.0.1:3000/health', timeoutSec: 90 },
            hooks: { preStart: [{ name: 'migrate', command: 'node', args: ['node_modules/sequelize-cli/lib/sequelize', 'db:migrate'], env: { NODE_ENV: 'prod' } }] },
          },
          { name: 'frontend', subdir: 'frontend', runtime: { type: 'iis-static' }, preserve: ['web.config'], writeRuntimeConfig: true },
        ],
      },
    },
  };
}

async function waitFor(condition, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not met in time');
}

function setup({ timing = {}, refreshTargetStatus = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-artifact-deploy-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  const repository = createArtifactDeployRepository(db);
  const tokens = createDownloadTokenService({ repository });
  const gateway = new FakeGateway();
  const project = makeProject();
  const audit = [];

  const release = repository.createRelease({
    projectId: 'p1', version: '2.5.0', status: 'ready', sourcePlatform: 'bitbucket',
    manifest: { schema: 1, project: 'jetsrm', version: '2.5.0', artifacts: [] },
  });
  const artifacts = repository.replaceArtifacts(release.id, [
    { component: 'backend', os: 'win-x64', file: 'jetsrm-backend-2.5.0-win-x64.tar.gz', sha256: SHA, size: 11, sourceRef: 'b-win' },
    { component: 'backend', os: 'linux-x64', file: 'jetsrm-backend-2.5.0-linux-x64.tar.gz', sha256: SHA, size: 12, sourceRef: 'b-lnx' },
    { component: 'frontend', os: 'any', file: 'jetsrm-frontend-2.5.0.tar.gz', sha256: SHA, size: 13, sourceRef: 'f' },
  ]);
  const byKey = Object.fromEntries(artifacts.map((a) => [`${a.component}/${a.os}`, a]));
  const target = repository.createTarget({
    projectId: 'p1', name: 'temsa-test', agentId: 'WIN-01', os: 'windows', environment: 'Dev',
    runtimeConfig: { VITE_APP_MAIN_URL: 'https://api.temsa', VITE_COMPANY_NAME: 'temsa' },
  });

  const service = createArtifactDeployService({
    repository,
    deploymentManager,
    auditLogger: { log: (user, action, description, metadata, options) => audit.push({ user, action, metadata, options }) },
    getProject: (id) => {
      if (id !== 'p1') throw new NotFoundError('Project not found');
      return project;
    },
    tokens,
    getGateway: () => gateway,
    refreshTargetStatus,
    timing: { resubscribeDelayMs: 5, channelTimeoutMs: 500, ...timing },
  });

  return {
    db, service, repository, tokens, gateway, project, audit, release, target, byKey,
    cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

async function startDeploy(env, extra = {}) {
  const result = await env.service.deploy({
    targetId: env.target.id, releaseId: env.release.id, triggeredBy: 'bob', publicUrl: PUBLIC_URL, ...extra,
  });
  return { ...result, payload: env.gateway.last('artifact_deploy').payload };
}

const success = (deployId, components = []) => ({
  deployId, success: true, version: '2.5.0', rolledBack: false, durationMs: 1000, components, error: null,
});

test('deploy: payload per contract 1.2 — OS selection, runtimeConfig only where flagged, hooks, only the download token', async () => {
  const env = setup();
  try {
    const { deploymentId, deployId, payload } = await startDeploy(env);
    assert.match(deployId, /^dep_[0-9a-f]{24}$/);
    const sent = env.gateway.last('artifact_deploy');
    assert.equal(sent.agentId, 'WIN-01');
    assert.equal(payload.deployId, deployId);
    assert.equal(payload.project, 'jetsrm');
    assert.equal(payload.version, '2.5.0');

    const [backend, frontend] = payload.components;
    const winBackend = env.byKey['backend/win-x64'];
    assert.equal(backend.download.url, `${PUBLIC_URL}/api/artifacts/${winBackend.id}/download`);
    assert.equal(backend.download.sha256, SHA);
    assert.equal(backend.download.size, 11);
    assert.match(backend.download.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(backend.runtimeConfig, null);
    assert.deepEqual(backend.runtime, { type: 'nssm', serviceName: 'jetsrm-backend', appPool: null });
    assert.equal(backend.hooks.preStart[0].name, 'migrate');
    assert.equal(backend.hooks.preStart[0].timeoutSec, 600);
    assert.equal(frontend.download.url, `${PUBLIC_URL}/api/artifacts/${env.byKey['frontend/any'].id}/download`);
    assert.deepEqual(frontend.runtimeConfig, { format: 'frontend-config-js', values: env.target.runtimeConfig });
    assert.equal(frontend.hooks, null);
    assert.notEqual(backend.download.token, frontend.download.token);

    const serialized = JSON.stringify(payload);
    for (const secret of ['SRC-SECRET', 'CI-SECRET']) assert.ok(!serialized.includes(secret), secret);

    const session = deploymentManager.getSession(deploymentId);
    assert.equal(session.kind, 'artifact_deploy');
    assert.equal(session.targetId, env.target.id);
    assert.equal(session.releaseId, env.release.id);
    assert.equal(session.status, 'running');
    assert.equal(deploymentRepository.findById(deploymentId).kind, 'artifact_deploy');
    assert.equal(env.service.isTargetBusy(env.target.id), true);

    // Nothing sensitive in logs or audit: no token, no hook env value, no runtime config value.
    const logs = session.logs.join('\n');
    for (const value of [backend.download.token, frontend.download.token, 'https://api.temsa']) {
      assert.ok(!logs.includes(value), `log leaked ${value}`);
      assert.ok(!JSON.stringify(env.audit).includes(value), `audit leaked ${value}`);
    }
    assert.ok(logs.includes('preStart: migrate'));
    assert.ok(logs.includes('frontend-config-js keys: VITE_APP_MAIN_URL, VITE_COMPANY_NAME'));

    // The token works for its artifact, bound to this deployment + agent.
    const binding = env.tokens.consume(backend.download.token, winBackend.id, { agentId: 'WIN-01' });
    assert.equal(binding.deploymentId, deploymentId);
    assert.equal(env.tokens.consume(backend.download.token, env.byKey['frontend/any'].id), null);

    env.gateway.emit('WIN-01', 'deploy_result', success(deployId));
  } finally {
    env.cleanup();
  }
});

test('config apply: component specs, dedicated event/result correlation, SSE, audit and target lock', async () => {
  const env = setup();
  try {
    env.repository.updateTarget(env.target.id, { runtimeConfig: {
      backend: { format: 'env-file', values: { PORT: '3000', DB_PASSWORD: 'TOP-SECRET' } },
      frontend: { format: 'frontend-config-js', values: { VITE_API_URL: 'https://api.customer' } },
    } });
    const { deploymentId, deployId } = await env.service.applyConfig({ targetId: env.target.id, triggeredBy: 'bob' });
    const sent = env.gateway.last('artifact_config_apply');
    assert.equal(sent.agentId, 'WIN-01');
    assert.equal(sent.payload.deployId, deployId);
    assert.deepEqual(sent.payload.components, [
      { name: 'backend', runtimeConfig: { format: 'env-file', values: { PORT: '3000', DB_PASSWORD: 'TOP-SECRET' } } },
      { name: 'frontend', runtimeConfig: { format: 'frontend-config-js', values: { VITE_API_URL: 'https://api.customer' } } },
    ]);
    const session = deploymentManager.getSession(deploymentId);
    assert.equal(session.kind, 'artifact_config_apply');
    assert.equal(session.releaseId, null);
    assert.equal(env.service.isTargetBusy(env.target.id), true);
    await assert.rejects(env.service.applyConfig({ targetId: env.target.id }), ConflictError);
    for (const secret of ['TOP-SECRET', 'https://api.customer']) {
      assert.ok(!session.logs.join('\n').includes(secret));
      assert.ok(!JSON.stringify(env.audit).includes(secret));
    }

    env.gateway.emit('WIN-01', 'deploy_result', { deployId, success: false, error: 'wrong channel' });
    env.gateway.emit('WIN-01', 'artifact_config_event', {
      deployId, component: 'backend', stage: 'configuring', status: 'done', message: '.env written TOP-SECRET',
    });
    assert.equal(session.status, 'running');
    assert.ok(session.logs.join('\n').includes('__EVENT__:{"type":"artifact_config_event"'));
    assert.ok(!session.logs.join('\n').includes('TOP-SECRET'));
    assert.ok(session.logs.join('\n').includes('[REDACTED]'));
    env.gateway.emit('WIN-01', 'artifact_config_result', {
      deployId, success: true, components: [
        { name: 'backend', success: true, version: '2.5.0', rolledBack: false },
        { name: 'frontend', success: true, version: '2.5.0', rolledBack: false },
      ],
    });
    assert.equal(session.status, 'succeeded');
    assert.equal(env.service.isTargetBusy(env.target.id), false);
    assert.deepEqual(env.audit.map((entry) => entry.action), [
      'ARTIFACT_CONFIG_APPLY_TRIGGERED', 'ARTIFACT_CONFIG_APPLY_SUCCEEDED',
    ]);
  } finally {
    env.cleanup();
  }
});

test('config apply: timeout and DeploymentManager abort send artifact_cancel and release the lock on result', async () => {
  const env = setup({ timing: { resultTimeoutMs: 30 } });
  try {
    env.repository.updateTarget(env.target.id, { runtimeConfig: {
      backend: { format: 'env-file', values: { PORT: '3000' } },
    } });
    let run = await env.service.applyConfig({ targetId: env.target.id, triggeredBy: 'bob' });
    await waitFor(() => deploymentManager.getSession(run.deploymentId).status === 'failed');
    assert.match(deploymentManager.getSession(run.deploymentId).lastError, /artifact_config_result/);
    assert.deepEqual(env.gateway.last('artifact_cancel').payload, { deployId: run.deployId });
    assert.equal(env.service.isTargetBusy(env.target.id), false);

    run = await env.service.applyConfig({ targetId: env.target.id, triggeredBy: 'bob' });
    await deploymentManager.abort(run.deploymentId);
    assert.equal(deploymentManager.getSession(run.deploymentId).status, 'aborted');
    assert.equal(env.service.isTargetBusy(env.target.id), true);
    assert.deepEqual(env.gateway.last('artifact_cancel').payload, { deployId: run.deployId });
    env.gateway.emit('WIN-01', 'artifact_config_result', {
      deployId: run.deployId, success: false, rolledBack: true, error: 'cancelled', components: [],
    });
    assert.equal(env.service.isTargetBusy(env.target.id), false);
    assert.equal(env.audit.at(-1).action, 'ARTIFACT_CONFIG_APPLY_CANCELLED');
  } finally {
    env.cleanup();
  }
});

test('deploy: events map to logs/rows/__EVENT__; only matching deployId from the target agent counts', async () => {
  const env = setup();
  try {
    const { deploymentId, deployId, payload } = await startDeploy(env);
    const emit = (process, body, agentId = 'WIN-01') => env.gateway.emit(agentId, process, body);

    emit('deploy_event', { deployId, component: 'backend', stage: 'downloading', status: 'started', progress: null, message: 'jetsrm-backend' });
    emit('deploy_event', { deployId, component: 'backend', stage: 'downloading', status: 'progress', progress: 12, message: '' });
    emit('deploy_event', { deployId, component: 'backend', stage: 'downloading', status: 'progress', progress: 15.5, message: '' });
    emit('deploy_event', { deployId, component: 'backend', stage: 'downloading', status: 'progress', progress: 27, message: '' });
    emit('deploy_event', { deployId, component: 'backend', stage: 'pre_start', status: 'started', progress: null, message: 'migrate' });
    // Must all be ignored:
    emit('deploy_event', { deployId: 'dep_other', component: 'backend', stage: 'switching', status: 'done', message: 'OTHER-DEPLOY' });
    emit('command_execution_result', { success: true, output: 'LEGACY-OUTPUT' });
    emit('deploy_result', { deployId, success: false, error: 'WRONG-AGENT' }, 'LNX-01');
    emit('deploy_result', { deployId: 'dep_other', success: false, error: 'OTHER-RESULT' });
    emit('deploy_result', { success: false, error: 'NO-DEPLOY-ID' });

    const session = deploymentManager.getSession(deploymentId);
    assert.equal(session.status, 'running');
    const logs = session.logs.join('\n');
    for (const ignored of ['OTHER-DEPLOY', 'LEGACY-OUTPUT', 'WRONG-AGENT', 'OTHER-RESULT', 'NO-DEPLOY-ID']) {
      assert.ok(!logs.includes(ignored), ignored);
    }
    assert.ok(logs.includes('[Deploy] backend · downloading started — jetsrm-backend'));
    assert.ok(logs.includes('[Deploy] backend · pre_start started — migrate'));
    assert.ok(logs.includes('__EVENT__:{"type":"artifact_deploy_event"'));

    const events = env.service.listEvents(deploymentId);
    assert.deepEqual(events.map((e) => `${e.stage}:${e.status}:${e.progress}`), [
      'downloading:started:null', 'downloading:progress:12', 'downloading:progress:27', 'pre_start:started:null',
    ]);

    emit('deploy_result', success(deployId, [
      { name: 'backend', success: true, rolledBack: false, previousVersion: '2.4.0', error: null },
      { name: 'frontend', success: true, rolledBack: false, previousVersion: null, error: null },
    ]));
    assert.equal(session.status, 'succeeded');
    assert.equal(env.service.isTargetBusy(env.target.id), false);
    const target = env.repository.findTarget(env.target.id);
    assert.equal(target.currentReleaseId, env.release.id);
    assert.equal(target.currentVersions.backend.version, '2.5.0');
    assert.deepEqual(target.currentVersions.backend.previousVersions, ['2.4.0']);
    assert.equal(target.currentVersions.frontend.version, '2.5.0');
    assert.match(deploymentRepository.findById(deploymentId).logText, /2\.5\.0 deployed to 'temsa-test'/);
    assert.equal(env.tokens.consume(payload.components[1].download.token, env.byKey['frontend/any'].id), null, 'tokens revoked at the end');
    assert.deepEqual(env.audit.map((e) => e.action), ['ARTIFACT_DEPLOY_TRIGGERED', 'ARTIFACT_DEPLOY_SUCCEEDED']);

    // A duplicate terminal result changes nothing.
    emit('deploy_result', { deployId, success: false, error: 'late duplicate' });
    assert.equal(session.status, 'succeeded');
    assert.equal(env.gateway.subscriptions.size, 0, 'subscription closed');
  } finally {
    env.cleanup();
  }
});

test('deploy: failure, busy and rollback results', async () => {
  const env = setup();
  try {
    let run = await startDeploy(env);
    env.gateway.emit('WIN-01', 'deploy_result', {
      deployId: run.deployId, success: false, rolledBack: true, durationMs: 5, error: 'health check failed',
      components: [{ name: 'backend', success: false, rolledBack: true, previousVersion: '2.4.0', error: 'health 500' }],
    });
    let session = deploymentManager.getSession(run.deploymentId);
    assert.equal(session.status, 'failed');
    assert.match(session.lastError, /health check failed\. Switched components were rolled back\./);
    assert.ok(session.logs.join('\n').includes('✗ backend rolled back to 2.4.0 — health 500'));
    assert.match(deploymentRepository.findById(run.deploymentId).logText, /Failed: health check failed/);
    assert.equal(env.repository.findTarget(env.target.id).currentVersions, null);
    assert.equal(env.audit.at(-1).action, 'ARTIFACT_DEPLOY_FAILED');
    assert.equal(env.audit.at(-1).options.outcome, 'failure');

    run = await startDeploy(env);
    env.gateway.emit('WIN-01', 'deploy_result', { deployId: run.deployId, success: false, error: 'busy', components: [] });
    session = deploymentManager.getSession(run.deploymentId);
    assert.equal(session.status, 'failed');
    assert.match(session.lastError, /busy/);
    assert.equal(env.service.isTargetBusy(env.target.id), false);
  } finally {
    env.cleanup();
  }
});

test('deploy: no result before the timeout → failed, cancel sent, lock released', async () => {
  const env = setup({ timing: { resultTimeoutMs: 30 } });
  try {
    const { deploymentId, deployId } = await startDeploy(env);
    await waitFor(() => deploymentManager.getSession(deploymentId).status === 'failed');
    assert.match(deploymentManager.getSession(deploymentId).lastError, /No deploy_result/);
    assert.deepEqual(env.gateway.last('artifact_cancel'), { agentId: 'WIN-01', process: 'artifact_cancel', payload: { deployId } });
    assert.equal(env.service.isTargetBusy(env.target.id), false);
  } finally {
    env.cleanup();
  }
});

test('cancel goes through DeploymentManager.abort(): artifact_cancel, lock held until the agent result', async () => {
  const env = setup();
  try {
    const { deploymentId, deployId, payload } = await startDeploy(env);
    await env.service.cancel(deploymentId);
    const session = deploymentManager.getSession(deploymentId);
    assert.equal(session.status, 'aborted');
    assert.deepEqual(env.gateway.last('artifact_cancel').payload, { deployId });
    assert.equal(env.service.isTargetBusy(env.target.id), true, 'the agent is still rolling back');
    assert.ok(env.audit.some((e) => e.action === 'ARTIFACT_DEPLOY_CANCEL_REQUESTED'));

    env.gateway.emit('WIN-01', 'deploy_result', { deployId, success: false, rolledBack: true, error: 'cancelled', components: [] });
    assert.equal(session.status, 'aborted');
    assert.equal(env.service.isTargetBusy(env.target.id), false);
    assert.equal(env.audit.at(-1).action, 'ARTIFACT_DEPLOY_CANCELLED');
    assert.equal(env.tokens.consume(payload.components[0].download.token, env.byKey['backend/win-x64'].id), null);
    await assert.rejects(env.service.cancel(deploymentId), NotFoundError);
  } finally {
    env.cleanup();
  }
});

test('cancel that arrives too late: the agent result wins and is recorded as succeeded', async () => {
  const env = setup();
  try {
    const { deploymentId, deployId } = await startDeploy(env);
    await deploymentManager.abort(deploymentId);
    env.gateway.emit('WIN-01', 'deploy_result', success(deployId));
    const session = deploymentManager.getSession(deploymentId);
    assert.equal(session.status, 'succeeded');
    assert.ok(session.logs.join('\n').includes('completed before the cancel request took effect'));
  } finally {
    env.cleanup();
  }
});

test('rollback: artifact_rollback payload, result, status refresh', async () => {
  const refreshed = [];
  const env = setup({ refreshTargetStatus: async (targetId) => { refreshed.push(targetId); } });
  try {
    const { deploymentId, deployId } = await env.service.rollback({ targetId: env.target.id, components: ['backend'], triggeredBy: 'bob' });
    assert.deepEqual(env.gateway.last('artifact_rollback'), {
      agentId: 'WIN-01', process: 'artifact_rollback', payload: { deployId, components: ['backend'] },
    });
    const session = deploymentManager.getSession(deploymentId);
    assert.equal(session.kind, 'artifact_rollback');
    assert.equal(session.releaseId, null);
    env.gateway.emit('WIN-01', 'deploy_result', success(deployId, [{ name: 'backend', success: true, rolledBack: true, previousVersion: '2.5.0' }]));
    assert.equal(session.status, 'succeeded');
    await waitFor(() => refreshed.length === 1);
    assert.deepEqual(refreshed, [env.target.id]);
    assert.deepEqual(env.audit.map((e) => e.action), ['ARTIFACT_ROLLBACK_TRIGGERED', 'ARTIFACT_ROLLBACK_SUCCEEDED']);

    const all = await env.service.rollback({ targetId: env.target.id, triggeredBy: 'bob' });
    assert.equal(env.gateway.last('artifact_rollback').payload.components, null);
    env.gateway.emit('WIN-01', 'deploy_result', { deployId: all.deployId, success: false, error: 'no previous release', components: [] });

    await assert.rejects(env.service.rollback({ targetId: env.target.id, components: ['worker'] }), ValidationError);
    await assert.rejects(env.service.rollback({ targetId: env.target.id, components: ['Bad Name'] }), ValidationError);
  } finally {
    env.cleanup();
  }
});

test('per-target lock and preconditions', async () => {
  const env = setup();
  try {
    const first = await startDeploy(env);
    const sentBefore = env.gateway.sent.length;
    await assert.rejects(startDeploy(env), ConflictError);
    await assert.rejects(env.service.rollback({ targetId: env.target.id }), ConflictError);
    assert.equal(env.gateway.sent.length, sentBefore);
    env.gateway.emit('WIN-01', 'deploy_result', success(first.deployId));

    await assert.rejects(env.service.deploy({ targetId: env.target.id, releaseId: env.release.id, publicUrl: '' }), /IDP_PUBLIC_URL/);
    await assert.rejects(env.service.deploy({ targetId: 'tgt_missing', releaseId: env.release.id, publicUrl: PUBLIC_URL }), NotFoundError);
    await assert.rejects(env.service.deploy({ targetId: env.target.id, releaseId: 'rel_missing', publicUrl: PUBLIC_URL }), NotFoundError);
    await assert.rejects(startDeploy(env, { components: ['worker'] }), ValidationError);

    env.repository.updateRelease(env.release.id, { status: 'building' });
    await assert.rejects(startDeploy(env), ConflictError);
    env.repository.updateRelease(env.release.id, { status: 'ready' });

    env.repository.updateTarget(env.target.id, { agentId: 'OFF-01' });
    await assert.rejects(startDeploy(env), /offline/);
    env.repository.updateTarget(env.target.id, { agentId: 'GONE-01' });
    await assert.rejects(startDeploy(env), /not registered/);
    env.gateway.failList = true;
    await assert.rejects(startDeploy(env), UpstreamError);
  } finally {
    env.cleanup();
  }
});

test('linux target: linux-x64 artifact chosen; missing OS artifact rejected; target overrides applied', async () => {
  const env = setup();
  try {
    const linux = env.repository.createTarget({
      projectId: 'p1', name: 'lnx', agentId: 'LNX-01', os: 'linux',
      components: [{ name: 'backend', runtime: { type: 'systemd', serviceName: 'jetsrm' } }],
    });
    const { deployId } = await env.service.deploy({ targetId: linux.id, releaseId: env.release.id, publicUrl: PUBLIC_URL });
    const payload = env.gateway.last('artifact_deploy').payload;
    assert.deepEqual(payload.components.map((c) => c.name), ['backend'], 'target restricts components');
    assert.equal(payload.components[0].download.url, `${PUBLIC_URL}/api/artifacts/${env.byKey['backend/linux-x64'].id}/download`);
    assert.deepEqual(payload.components[0].runtime, { type: 'systemd', serviceName: 'jetsrm', appPool: null });
    env.gateway.emit('LNX-01', 'deploy_result', success(deployId));

    const windowsOnly = env.repository.createRelease({
      projectId: 'p1', version: '2.6.0', status: 'ready', manifest: { schema: 1, project: 'jetsrm', version: '2.6.0', artifacts: [] },
    });
    env.repository.replaceArtifacts(windowsOnly.id, [
      { component: 'backend', os: 'win-x64', file: 'b.tar.gz', sha256: SHA, size: 1, sourceRef: 'b' },
    ]);
    await assert.rejects(
      env.service.deploy({ targetId: linux.id, releaseId: windowsOnly.id, publicUrl: PUBLIC_URL }),
      /no linux-x64 or 'any' artifact for: backend/
    );
  } finally {
    env.cleanup();
  }
});

test('agent offline at send time (gateway 404) → failed, lock released, tokens revoked', async () => {
  const env = setup();
  try {
    env.gateway.failSend = Object.assign(new Error('Agent WIN-01 is not connected.'), { status: 404 });
    const { deploymentId } = await env.service.deploy({ targetId: env.target.id, releaseId: env.release.id, publicUrl: PUBLIC_URL });
    const session = deploymentManager.getSession(deploymentId);
    assert.equal(session.status, 'failed');
    assert.match(session.lastError, /not connected/);
    assert.equal(env.service.isTargetBusy(env.target.id), false);
    const tokenRows = env.db.prepare('SELECT COUNT(*) AS n FROM artifact_download_tokens WHERE deployment_id = ?').get(deploymentId).n;
    assert.equal(tokenRows, 0, 'tokens issued for the failed send are revoked');
  } finally {
    env.cleanup();
  }
});

test('a dropped gateway subscription is re-established and the result still lands', async () => {
  const env = setup();
  try {
    const { deploymentId, deployId } = await startDeploy(env);
    env.gateway.drop();
    await waitFor(() => env.gateway.subscriptions.size === 1);
    await waitFor(() => deploymentManager.getSession(deploymentId).logs.some((l) => l.includes('Reconnected')));
    env.gateway.emit('WIN-01', 'deploy_result', success(deployId));
    assert.equal(deploymentManager.getSession(deploymentId).status, 'succeeded');
  } finally {
    env.cleanup();
  }
});
