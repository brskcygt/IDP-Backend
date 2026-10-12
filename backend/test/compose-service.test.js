/**
 * Release composer (core/artifacts/composeService.js) on top of the REAL
 * release service + repository, with a fake Bitbucket repo client and a fake
 * build adapter: happy path (branch created, PRs merged, build on the preview
 * branch, composition persisted, branch deleted afterwards), merge conflict
 * (PR declined, branch deleted, release failed, no build), validation,
 * production refusal, ref listing and tag creation.
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
const deploymentManager = require('../src/services/DeploymentManager');
const { createReleaseService } = require('../src/core/artifacts/releaseService');
const { createComposeService, composeBranchName } = require('../src/core/artifacts/composeService');
const { VERSION_PATTERN, GIT_REF_PATTERN } = require('../src/core/artifacts/contracts');
const { NotFoundError, ValidationError, ConflictError, UpstreamError } = require('../src/core/errors');
const { CiHttpError } = require('../src/adapters/ci/http');

const SHA = 'c'.repeat(64);
const NOW = new Date('2026-10-12T09:08:07.000Z');
const sha = (ch) => ch.repeat(40);

function makeProject({ platform = 'bitbucket' } = {}) {
  return {
    id: 'p1',
    name: 'JetSRM',
    environment: 'Dev',
    config: {
      apiToken: 'CI-TOKEN',
      ciConfig: { platform: 'bitbucket', owner: 'mdp', repo: 'jetsrm', ref: 'master', pipeline: 'release' },
      artifactDeploy: {
        source: { platform, owner: 'mdp', repo: 'jetsrm', token: 'SRC-TOKEN' },
        build: { provider: 'pipeline' },
        components: [{ name: 'frontend', subdir: 'frontend', runtime: { type: 'iis-static' } }],
      },
    },
  };
}

/** In-memory Bitbucket: branches/tags maps, PR log, injectable merge failures. */
class FakeRepoClient {
  constructor({ conflictOn = null, noChangesOn = null } = {}) {
    this.branches = new Map([
      ['main', sha('a')], ['feature/login', sha('b')], ['feature/Pay_Flow', sha('d')], ['preview/old-1', sha('e')],
    ]);
    this.tags = new Map([['2.5.0', sha('f')]]);
    this.prs = [];
    this.calls = [];
    this.conflictOn = conflictOn;
    this.noChangesOn = noChangesOn;
    this.released = 0;
  }
  ref(name, hash) { return { name, sha: hash, date: '2026-10-01T00:00:00+00:00', message: `on ${name}` }; }
  async getRepository() { return { defaultBranch: 'main' }; }
  async listBranches({ q } = {}) {
    this.calls.push(['listBranches', q]);
    return [...this.branches].filter(([n]) => !q || n.includes(q)).map(([n, h]) => this.ref(n, h));
  }
  async listTags({ q } = {}) { return [...this.tags].filter(([n]) => !q || n.includes(q)).map(([n, h]) => this.ref(n, h)); }
  async getBranch(name) { this.calls.push(['getBranch', name]); return this.branches.has(name) ? this.ref(name, this.branches.get(name)) : null; }
  async getTag(name) { this.calls.push(['getTag', name]); return this.tags.has(name) ? this.ref(name, this.tags.get(name)) : null; }
  async getCommit(hash) { return hash.startsWith('abc') ? sha('9') : null; }
  async createBranch(name, hash) { this.calls.push(['createBranch', name, hash]); this.branches.set(name, hash); return this.ref(name, hash); }
  async deleteBranch(name) { this.calls.push(['deleteBranch', name]); this.branches.delete(name); }
  async createTag({ name, hash, message }) { this.calls.push(['createTag', name, hash, message]); this.tags.set(name, hash); return { ...this.ref(name, hash), message: message || null }; }
  async createPullRequest({ title, source, destination }) {
    if (source === this.noChangesOn) {
      const err = new CiHttpError('Pull request creation failed (HTTP 400): There are no changes to be pulled', { status: 400, providerMessage: 'There are no changes to be pulled' });
      throw err;
    }
    const pr = { id: this.prs.length + 1, title, source, destination, state: 'OPEN' };
    this.prs.push(pr);
    this.calls.push(['createPullRequest', source, destination]);
    return { id: pr.id };
  }
  async mergePullRequest(id) {
    const pr = this.prs.find((p) => p.id === id);
    this.calls.push(['mergePullRequest', id]);
    if (pr.source === this.conflictOn) {
      const err = new CiHttpError('Pull request merge failed (HTTP 409): Merge conflict', { status: 409, providerMessage: 'Merge conflict' });
      err.mergeFailed = true;
      throw err;
    }
    pr.state = 'MERGED';
    // A merge commit moves the preview branch head.
    this.branches.set(pr.destination, sha(String(id)));
    return { mergeCommit: sha(String(id)) };
  }
  async declinePullRequest(id) { this.calls.push(['declinePullRequest', id]); this.prs.find((p) => p.id === id).state = 'DECLINED'; }
  releaseCredentials() { this.released += 1; }
}

class FakeBuildAdapter {
  constructor() { this.calls = []; this.config = {}; }
  onLog(cb) { this.cb = cb; }
  async connect() { this.calls.push('connect'); }
  async trigger(params) { this.calls.push(['trigger', params]); }
  async streamLogs(cb) { cb('[CI] building...'); }
  async abort() {}
  releaseCredentials() {}
}

function setup({ client = new FakeRepoClient(), platform = 'bitbucket', deployRelease = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-compose-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  const repository = createArtifactDeployRepository(db);
  const project = makeProject({ platform });
  const audit = [];
  const buildArgs = [];
  const adapter = new FakeBuildAdapter();
  const repoClientArgs = [];
  const auditLogger = { log: (user, action, description, metadata) => audit.push({ user, action, metadata }) };
  const getProject = (id) => {
    if (id !== project.id) throw new NotFoundError('Project not found');
    return project;
  };
  const releaseService = createReleaseService({
    repository,
    deploymentManager,
    auditLogger,
    getProject,
    resolveSecrets: async (p) => p,
    createBuildAdapter: (args) => {
      buildArgs.push(args);
      return { adapter, triggerParams: { VERSION: args.version } };
    },
    createSourceClient: () => ({
      async fetchManifest({ version }) {
        return {
          manifest: {
            schema: 1, project: 'jetsrm', version, commit: 'abc',
            artifacts: [{ component: 'frontend', os: 'any', file: `jetsrm-frontend-${version}.tar.gz`, sha256: SHA, size: 1 }],
          },
          context: {},
        };
      },
      async resolveArtifacts(artifacts) { return artifacts.map((a) => ({ ...a, sourceRef: a.file })); },
      releaseCredentials() {},
    }),
    deployRelease,
    timing: { manifestRetryMs: 1 },
  });
  const service = createComposeService({
    repository,
    releaseService,
    auditLogger,
    getProject,
    resolveSecrets: async (p) => p,
    createRepoClient: (source, credentials) => {
      repoClientArgs.push({ source, credentials });
      return client;
    },
    now: () => NOW,
  });
  return {
    service, releaseService, repository, project, audit, buildArgs, adapter, client, repoClientArgs,
    cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('composeBranchName / preview version: slugified, joined by +, valid build ref and version', () => {
  const name = composeBranchName(['feature/login', 'feature/Pay Flow', 'third'], NOW);
  assert.equal(name, 'preview/feature-login+feature-pay-flow-20261012090807');
  assert.ok(GIT_REF_PATTERN.test(name));
  const long = composeBranchName(['a'.repeat(80)], NOW);
  assert.equal(long, `preview/${'a'.repeat(40)}-20261012090807`);
  assert.equal(composeBranchName(['///'], NOW), 'preview/compose-20261012090807');
});

test('compose: happy path — preview branch, PRs merged in order, build on the branch, composition persisted, branch deleted', async () => {
  const installed = [];
  const env = setup({ deployRelease: async (args) => { installed.push(args); } });
  try {
    const target = env.repository.createTarget({ projectId: 'p1', name: 'temsa-test', agentId: 'T-01', os: 'windows', environment: 'Dev' });
    const { release, deploymentId } = await env.service.compose({
      projectId: 'p1',
      base: { type: 'branch', name: 'main' },
      branches: ['feature/login', 'feature/Pay_Flow'],
      deployTo: { targetId: target.id },
      triggeredBy: 'baris',
    });
    const composeBranch = 'preview/feature-login+feature-pay_flow-20261012090807';
    assert.equal(release.version, '0.0.0-preview.20261012090807');
    assert.ok(VERSION_PATTERN.test(release.version));
    assert.equal(release.status, 'building');
    assert.equal(release.ref, composeBranch);
    assert.equal(release.refType, 'branch');
    assert.deepEqual(release.composition, {
      baseType: 'branch', baseRef: 'main', baseSha: '',
      branches: [{ name: 'feature/login', sha: '' }, { name: 'feature/Pay_Flow', sha: '' }],
      composeBranch, headSha: null,
    });

    await env.releaseService.waitForBuild(release.id);
    const done = env.repository.findRelease(release.id);
    assert.equal(done.status, 'ready');
    assert.deepEqual(done.composition, {
      baseType: 'branch', baseRef: 'main', baseSha: sha('a'),
      branches: [{ name: 'feature/login', sha: sha('b') }, { name: 'feature/Pay_Flow', sha: sha('d') }],
      composeBranch, headSha: sha('2'),
    });

    const ops = env.client.calls.filter(([op]) => !['getBranch', 'getTag'].includes(op));
    assert.deepEqual(ops, [
      ['createBranch', composeBranch, sha('a')],
      ['createPullRequest', 'feature/login', composeBranch],
      ['mergePullRequest', 1],
      ['createPullRequest', 'feature/Pay_Flow', composeBranch],
      ['mergePullRequest', 2],
      ['deleteBranch', composeBranch],
    ]);
    assert.ok(!env.client.branches.has(composeBranch), 'the preview branch is gone after the build');
    assert.deepEqual(env.client.prs.map((p) => p.state), ['MERGED', 'MERGED'], 'merged PRs stay as history');
    assert.equal(env.client.released, 1);
    assert.equal(env.repoClientArgs[0].credentials.token, 'SRC-TOKEN');

    // The existing build path, on the preview branch.
    assert.equal(env.buildArgs[0].ref, composeBranch);
    assert.equal(env.buildArgs[0].refType, 'branch');
    assert.deepEqual(env.adapter.calls, ['connect', ['trigger', { VERSION: release.version }]]);
    assert.deepEqual(installed, [{ targetId: target.id, releaseId: release.id, components: undefined, triggeredBy: 'baris' }]);

    const logs = deploymentManager.getSession(deploymentId).logs.join('\n');
    assert.match(logs, /\[Compose\] ✓ Created preview\/feature-login/);
    assert.match(logs, /Merged feature\/Pay_Flow/);
    assert.match(logs, /Deleted preview branch/);
    assert.ok(logs.indexOf('[Compose] ✓ preview/') < logs.indexOf('[CI] building...'), 'merging happens before the build');

    const composed = env.audit.find((e) => e.action === 'RELEASE_COMPOSED');
    assert.deepEqual(composed.metadata.base, { type: 'branch', name: 'main' });
    assert.deepEqual(composed.metadata.branches, ['feature/login', 'feature/Pay_Flow']);
    assert.equal(composed.metadata.composeBranch, composeBranch);
    assert.ok(!JSON.stringify(env.audit).includes('SRC-TOKEN'));
  } finally {
    env.cleanup();
  }
});

test('compose: a merge conflict declines the PR, deletes the branch, fails the release and never builds', async () => {
  const env = setup({ client: new FakeRepoClient({ conflictOn: 'feature/Pay_Flow' }) });
  try {
    const { release, deploymentId } = await env.service.compose({
      projectId: 'p1', base: { type: 'tag', name: '2.5.0' }, branches: ['feature/login', 'feature/Pay_Flow'], version: 'qa-1',
    });
    await env.releaseService.waitForBuild(release.id);
    const failed = env.repository.findRelease(release.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'Merge conflict: feature/Pay_Flow → 2.5.0');
    assert.equal(failed.composition.baseSha, sha('f'), 'a tag base resolves through the tag');
    assert.equal(failed.composition.headSha, null);

    assert.deepEqual(env.client.prs.map((p) => p.state), ['MERGED', 'DECLINED']);
    assert.ok(env.client.calls.some(([op, id]) => op === 'declinePullRequest' && id === 2));
    assert.equal(env.client.calls.filter(([op]) => op === 'deleteBranch').length, 1, 'deleted once, not again after the build');
    assert.ok(![...env.client.branches.keys()].some((n) => n.startsWith('preview/feature-login')));
    assert.deepEqual(env.adapter.calls, [], 'the CI is never contacted');
    assert.equal(env.client.released, 1);

    const session = deploymentManager.getSession(deploymentId);
    assert.equal(session.status, 'failed');
    assert.match(session.logs.join('\n'), /feature\/Pay_Flow could not be merged: Merge conflict/);
    assert.ok(env.audit.some((e) => e.action === 'RELEASE_BUILD_FAILED'));
  } finally {
    env.cleanup();
  }
});

test('compose: a missing branch fails fast before the preview branch exists; no-change features are skipped', async () => {
  const env = setup();
  try {
    const { release } = await env.service.compose({ projectId: 'p1', base: { type: 'branch', name: 'main' }, branches: ['feature/nope'] });
    await env.releaseService.waitForBuild(release.id);
    const failed = env.repository.findRelease(release.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /Branch 'feature\/nope' was not found in mdp\/jetsrm/);
    assert.ok(!env.client.calls.some(([op]) => op === 'createBranch'));
    assert.deepEqual(env.adapter.calls, []);
  } finally {
    env.cleanup();
  }

  const skip = setup({ client: new FakeRepoClient({ noChangesOn: 'feature/login' }) });
  try {
    const { release, deploymentId } = await skip.service.compose({
      projectId: 'p1', base: { type: 'branch', name: 'main' }, branches: ['feature/login', 'feature/Pay_Flow'], version: 'qa-2',
    });
    await skip.releaseService.waitForBuild(release.id);
    assert.equal(skip.repository.findRelease(release.id).status, 'ready');
    assert.match(deploymentManager.getSession(deploymentId).logs.join('\n'), /feature\/login has no changes .* skipped/);
  } finally {
    skip.cleanup();
  }
});

test('compose: request validation, production refusal and non-Bitbucket sources (nothing is created)', async () => {
  const env = setup();
  try {
    const prod = env.repository.createTarget({ projectId: 'p1', name: 'temsa', agentId: 'P-01', os: 'windows', environment: 'Prod' });
    const base = { type: 'branch', name: 'main' };
    const cases = [
      [{ base, branches: ['main'] }, /is the base/],
      [{ base, branches: Array.from({ length: 11 }, (_, i) => `f${i}`) }, /between 1 and 10/],
      [{ base, branches: [] }, /between 1 and 10/],
      [{ base, branches: ['a', 'a'] }, /more than once/],
      [{ base, branches: ['bad name'] }, /Invalid branch/],
      [{ base, branches: ['preview/old-1'] }, /composer output/],
      [{ base: { type: 'commit', name: 'x' }, branches: ['a'] }, /Invalid base/],
      [{ base, branches: ['a'], version: '../x' }, /Invalid version/],
      [{ base, branches: ['a'], deployTo: { targetId: 'tgt_nope' } }, /not a deploy target/],
    ];
    for (const [input, pattern] of cases) {
      await assert.rejects(
        () => env.service.compose({ projectId: 'p1', ...input }),
        (err) => err instanceof ValidationError && pattern.test(err.message),
        JSON.stringify(input),
      );
    }
    await assert.rejects(
      () => env.service.compose({ projectId: 'p1', base, branches: ['feature/login'], deployTo: { targetId: prod.id } }),
      (err) => err instanceof ValidationError && err.code === 'PREVIEW_NOT_ALLOWED_ON_PROD',
    );
    assert.deepEqual(env.repository.listReleases('p1'), []);
    assert.deepEqual(env.client.calls, []);
  } finally {
    env.cleanup();
  }

  const github = setup({ platform: 'github' });
  try {
    await assert.rejects(
      () => github.service.compose({ projectId: 'p1', base: { type: 'branch', name: 'main' }, branches: ['x'] }),
      (err) => err instanceof ValidationError && /only supported for Bitbucket/.test(err.message),
    );
    await assert.rejects(() => github.service.listRefs({ projectId: 'p1' }), ValidationError);
  } finally {
    github.cleanup();
  }
});

test('listRefs: default branch, branches and tags; hidePreview drops preview/ branches only', async () => {
  const env = setup();
  try {
    const all = await env.service.listRefs({ projectId: 'p1' });
    assert.equal(all.platform, 'bitbucket');
    assert.equal(all.defaultBranch, 'main');
    assert.ok(all.branches.some((r) => r.name === 'preview/old-1'));
    assert.deepEqual(all.tags.map((r) => r.name), ['2.5.0']);
    assert.deepEqual(Object.keys(all.branches[0]), ['name', 'sha', 'date', 'message']);

    const hidden = await env.service.listRefs({ projectId: 'p1', q: ' feature ', hidePreview: true });
    assert.deepEqual(hidden.branches.map((r) => r.name), ['feature/login', 'feature/Pay_Flow']);
    assert.deepEqual(env.client.calls.filter(([op]) => op === 'listBranches').map(([, q]) => q), [undefined, 'feature']);
    assert.equal(env.client.released, 2);

    env.client.listTags = async () => { throw new CiHttpError('Tag listing failed (HTTP 503).', { status: 503, transient: true }); };
    await assert.rejects(() => env.service.listRefs({ projectId: 'p1' }), UpstreamError);
  } finally {
    env.cleanup();
  }
});

test('createTag: from a branch head or a commit; existing tag → 409; invalid names refused', async () => {
  const env = setup();
  try {
    const { tag } = await env.service.createTag({
      projectId: 'p1', name: '2.6.0', from: { type: 'branch', name: 'main' }, message: 'Release 2.6.0', triggeredBy: 'admin',
    });
    assert.deepEqual(tag, { name: '2.6.0', sha: sha('a'), date: '2026-10-01T00:00:00+00:00', message: 'Release 2.6.0' });
    const fromCommit = await env.service.createTag({ projectId: 'p1', name: '2.6.1', from: { type: 'commit', name: 'abc1234' } });
    assert.equal(fromCommit.tag.sha, sha('9'));

    await assert.rejects(
      () => env.service.createTag({ projectId: 'p1', name: '2.5.0', from: { type: 'branch', name: 'main' } }),
      ConflictError,
    );
    for (const [name, from] of [
      ['../x', { type: 'branch', name: 'main' }],
      ['2.6.', { type: 'branch', name: 'main' }],
      ['2..6', { type: 'branch', name: 'main' }],
      ['2.7.0', { type: 'commit', name: 'zzz' }],
      ['2.7.0', { type: 'tag', name: 'x' }],
    ]) {
      await assert.rejects(() => env.service.createTag({ projectId: 'p1', name, from }), ValidationError, name);
    }
    await assert.rejects(
      () => env.service.createTag({ projectId: 'p1', name: '2.7.0', from: { type: 'branch', name: 'gone' } }),
      (err) => err instanceof ValidationError && /not found/.test(err.message),
    );
    await assert.rejects(
      () => env.service.createTag({ projectId: 'p1', name: '2.7.0', from: { type: 'commit', name: 'def4567' } }),
      (err) => err instanceof ValidationError && /not found/.test(err.message),
    );
    const created = env.audit.filter((e) => e.action === 'RELEASE_TAG_CREATED');
    assert.deepEqual(created.map((e) => e.metadata.tag), ['2.6.0', '2.6.1']);
    assert.equal(created[0].user, 'admin');
  } finally {
    env.cleanup();
  }
});
