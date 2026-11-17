/**
 * Brand layers: one frontend build ships every brand as a variant artifact
 * (component `brand`), a target receives only the one its runtime config
 * names — merged into the package (core/artifacts/layeredArtifacts.js) so the
 * agent installs a single tarball. Manifest variants, `brandLayer` on a
 * component, the merge itself, the deploy payload/token and applyConfig
 * reinstalling on a brand change.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { openDatabase } = require('../src/store/db');
const { createArtifactDeployRepository } = require('../src/store/artifactDeployRepository');
const { createDownloadTokenService } = require('../src/core/artifacts/downloadTokens');
const { createArtifactDeployService } = require('../src/core/artifacts/artifactDeployService');
const { createLayeredArtifacts } = require('../src/core/artifacts/layeredArtifacts');
const { createArtifactDownloadService } = require('../src/core/artifacts/artifactDownloadService');
const {
  validateManifest,
  validateArtifactDeployConfig,
  normalizeArtifactDeployConfig,
  selectArtifact,
  selectBrandLayer,
} = require('../src/core/artifacts/contracts');
const deploymentManager = require('../src/services/DeploymentManager');
const { ValidationError, NotFoundError } = require('../src/core/errors');

const SHA = 'd'.repeat(64);
const PUBLIC_URL = 'https://idp.example';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function writeTree(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

/** `tar -czf out -C dir .` — the same shape Jenkins produces. */
function tarGz(dir, out) {
  execFileSync('tar', ['-czf', out, '-C', dir, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return out;
}

function listTar(file) {
  return execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean)
    .map((name) => name.replace(/^\.\//, '')).filter((name) => name !== '' && name !== '.').sort();
}

// --------------------------------------------------------------- contracts

test('manifest: variant artifacts are kept, one per component/os/variant; manifests without stay unchanged', () => {
  const base = { schema: 1, project: 'mdp-srm', version: '1.0.0' };
  const entry = (extra) => ({ component: 'brand', os: 'any', sha256: SHA, size: 5, ...extra });
  const ok = validateManifest({
    ...base,
    artifacts: [
      { component: 'frontend', os: 'any', file: 'f.tar.gz', sha256: SHA, size: 5 },
      entry({ file: 'b-koksan.tar.gz', variant: 'koksan' }),
      entry({ file: 'b-temsa.tar.gz', variant: 'temsa' }),
    ],
  });
  assert.equal(ok.valid, true, ok.errors.join(' '));
  assert.deepEqual(ok.manifest.artifacts.map((a) => a.variant), [undefined, 'koksan', 'temsa']);
  assert.equal('variant' in ok.manifest.artifacts[0], false);

  const duplicate = validateManifest({ ...base, artifacts: [entry({ file: 'a.tar.gz', variant: 'temsa' }), entry({ file: 'b.tar.gz', variant: 'temsa' })] });
  assert.equal(duplicate.valid, false);
  assert.match(duplicate.errors.join(' '), /variant 'temsa'/);

  const bad = validateManifest({ ...base, artifacts: [entry({ file: 'a.tar.gz', variant: 'Temsa/..' })] });
  assert.equal(bad.valid, false);
  assert.match(bad.errors.join(' '), /invalid variant/);
});

test('brandLayer on a component: true = defaults, object fields validated', () => {
  const config = (brandLayer) => ({
    components: [{ name: 'frontend', subdir: 'frontend', runtime: { type: 'iis-static' }, brandLayer }],
  });
  assert.deepEqual(validateArtifactDeployConfig(config(true)), []);
  assert.deepEqual(normalizeArtifactDeployConfig(config(true)).components[0].brandLayer,
    { artifact: 'brand', configKey: 'VITE_COMPANY_NAME', dir: 'brand' });
  assert.deepEqual(normalizeArtifactDeployConfig(config({ dir: 'marka' })).components[0].brandLayer,
    { artifact: 'brand', configKey: 'VITE_COMPANY_NAME', dir: 'marka' });
  assert.equal(normalizeArtifactDeployConfig(config(undefined)).components[0].brandLayer, null);

  const errors = validateArtifactDeployConfig(config({ dir: '../x', configKey: 'lower', extra: 1 }));
  assert.deepEqual(errors.map((e) => e.path).sort(), [
    'artifactDeploy.components.0.brandLayer.configKey',
    'artifactDeploy.components.0.brandLayer.dir',
    'artifactDeploy.components.0.brandLayer.extra',
  ].sort());
});

test('selectBrandLayer: variant from runtime config; bundled release; missing variant; variants never chosen as a package', () => {
  const component = { name: 'frontend', os: null, writeRuntimeConfig: true, brandLayer: { artifact: 'brand', configKey: 'VITE_COMPANY_NAME', dir: 'brand' } };
  const artifacts = [
    { id: 'f', component: 'frontend', os: 'any', variant: null },
    { id: 'k', component: 'brand', os: 'any', variant: 'koksan' },
    { id: 't', component: 'brand', os: 'any', variant: 'temsa' },
  ];
  const pick = (value, list = artifacts) => selectBrandLayer(list, component, { VITE_COMPANY_NAME: value });

  assert.equal(pick(' Koksan ').artifact.id, 'k');
  assert.equal(pick(' Koksan ').variant, 'koksan');
  assert.deepEqual(pick(''), { variant: null, artifact: null, bundled: false, error: null });
  assert.match(pick('evyap').error, /no 'brand' layer 'evyap'.*ships: koksan, temsa/);
  assert.equal(pick('koksan', artifacts.slice(0, 1)).bundled, true);
  assert.equal(selectBrandLayer(artifacts, { ...component, brandLayer: null }, {}), null);
  // A component named like the layer artifact still never gets a variant as its package.
  assert.equal(selectArtifact(artifacts, { name: 'brand', os: null }, 'windows'), null);
});

// ------------------------------------------------------------------ merge

function mergeFixture() {
  const dir = tmp('idp-layer-');
  const baseDir = path.join(dir, 'base');
  const layerDir = path.join(dir, 'layer');
  const longName = `assets/${'x'.repeat(120)}.js`;
  writeTree(baseDir, {
    'index.html': '<html>',
    'config.js': 'window.__ENV__ = {};',
    [longName]: 'long',
    'brand/stale.js': 'old brand left in the package',
  });
  writeTree(layerDir, {
    'brand/brand.js': 'export default { key: "koksan" };',
    [`brand/assets/${'y'.repeat(120)}.svg`]: '<svg/>',
  });
  const base = tarGz(baseDir, path.join(dir, 'base.tar.gz'));
  const layer = tarGz(layerDir, path.join(dir, 'layer.tar.gz'));
  return { dir, base, layer, longName };
}

function layeredFor(files, root) {
  const opened = [];
  const layered = createLayeredArtifacts({
    root,
    openArtifact: async (artifact) => {
      opened.push(artifact.id);
      return { stream: fs.createReadStream(files[artifact.id]) };
    },
  });
  return { layered, opened };
}

const baseArtifact = { id: 'art_base', releaseId: 'rel_1', sha256: 'a'.repeat(64), fileName: 'mdp-srm-frontend-1.0.0.tar.gz' };
const layerArtifact = { id: 'art_koksan', releaseId: 'rel_1', sha256: 'b'.repeat(64), variant: 'koksan', fileName: 'mdp-srm-brand-koksan-1.0.0.tar.gz' };

test('merge: package entries + layer under brand/, package\'s own brand/ dropped, long names kept; cached by content', async () => {
  const fx = mergeFixture();
  try {
    const { layered, opened } = layeredFor({ art_base: fx.base, art_koksan: fx.layer }, path.join(fx.dir, 'store'));
    const merged = await layered.ensure({ release: {}, base: baseArtifact, layer: layerArtifact, dir: 'brand' });

    const bytes = fs.readFileSync(merged.file);
    assert.equal(merged.size, bytes.length);
    assert.equal(merged.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(listTar(merged.file), [
      'assets/', fx.longName, 'brand/', `brand/assets/`, `brand/assets/${'y'.repeat(120)}.svg`, 'brand/brand.js', 'config.js', 'index.html',
    ].sort());

    const out = path.join(fx.dir, 'out');
    fs.mkdirSync(out);
    execFileSync('tar', ['-xzf', merged.file, '-C', out]);
    assert.equal(fs.readFileSync(path.join(out, 'brand/brand.js'), 'utf8'), 'export default { key: "koksan" };');
    assert.equal(fs.existsSync(path.join(out, 'brand/stale.js')), false);

    const again = await layered.ensure({ release: {}, base: baseArtifact, layer: layerArtifact, dir: 'brand' });
    assert.equal(again.sha256, merged.sha256);
    assert.deepEqual(opened, ['art_base', 'art_koksan'], 'the second ensure is served from the cache');

    const download = await layered.open({ release: {}, base: baseArtifact, layer: layerArtifact, dir: 'brand' });
    await new Promise((resolve) => {
      download.stream.on('close', resolve);
      download.stream.destroy();
    });
    assert.equal(download.fileName, 'mdp-srm-frontend-1.0.0+brand-koksan.tar.gz');
    assert.equal(download.size, merged.size);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('merge: a layer with anything outside its folder is refused, nothing is cached', async () => {
  const dir = tmp('idp-layer-bad-');
  try {
    writeTree(path.join(dir, 'base'), { 'index.html': '<html>' });
    writeTree(path.join(dir, 'layer'), { 'brand/brand.js': 'ok', 'index.html': '<script>evil</script>' });
    const files = {
      art_base: tarGz(path.join(dir, 'base'), path.join(dir, 'base.tar.gz')),
      art_koksan: tarGz(path.join(dir, 'layer'), path.join(dir, 'layer.tar.gz')),
    };
    const store = path.join(dir, 'store');
    const { layered } = layeredFor(files, store);
    await assert.rejects(layered.ensure({ release: {}, base: baseArtifact, layer: layerArtifact, dir: 'brand' }), (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /may only contain brand\/; it has .*index\.html/);
      return true;
    });
    assert.deepEqual(fs.readdirSync(path.join(store, 'layered')), []);
    await assert.rejects(layered.ensure({ release: {}, base: baseArtifact, layer: { ...layerArtifact, releaseId: 'other' }, dir: 'brand' }), ValidationError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------- deploy

class FakeGateway {
  constructor() {
    this.sent = [];
    this.subscriptions = new Set();
  }
  async listAgents() {
    return [{ id: 'WIN-01', online: true }];
  }
  async sendArtifactCommand(agentId, process, payload) {
    this.sent.push({ agentId, process, payload: JSON.parse(JSON.stringify(payload)) });
    return { type: true, sent: true };
  }
  subscribe(agentId, handlers) {
    const sub = { agentId, handlers };
    this.subscriptions.add(sub);
    setImmediate(() => handlers.onMessage({ type: 'server', process: 'handshake_ack', payload: { connected: true } }));
    return () => this.subscriptions.delete(sub);
  }
  emit(agentId, process, payload) {
    for (const sub of [...this.subscriptions]) sub.handlers.onMessage({ type: 'agent', agentId, process, payload });
  }
  last(process) {
    return [...this.sent].reverse().find((entry) => entry.process === process);
  }
}

async function waitFor(condition, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not met in time');
}

function setupDeploy({ brands = ['koksan', 'temsa'], company = 'Koksan' } = {}) {
  const dir = tmp('idp-brand-deploy-');
  const db = openDatabase(path.join(dir, 'test.db'));
  const repository = createArtifactDeployRepository(db);
  const tokens = createDownloadTokenService({ repository });
  const gateway = new FakeGateway();
  const project = {
    id: 'p1',
    name: 'SRM',
    config: {
      artifactDeploy: {
        components: [{ name: 'frontend', subdir: 'frontend', runtime: { type: 'iis-static' }, writeRuntimeConfig: true, brandLayer: true }],
      },
    },
  };
  const release = repository.createRelease({
    projectId: 'p1', version: '1.0.0', status: 'ready', sourcePlatform: 'local',
    manifest: { schema: 1, project: 'mdp-srm', version: '1.0.0', artifacts: [] },
  });
  repository.replaceArtifacts(release.id, [
    { component: 'frontend', os: 'any', file: 'mdp-srm-frontend-1.0.0.tar.gz', sha256: SHA, size: 10, sourceRef: 'f' },
    ...brands.map((variant) => ({ component: 'brand', os: 'any', variant, file: `mdp-srm-brand-${variant}-1.0.0.tar.gz`, sha256: SHA, size: 3, sourceRef: variant })),
  ]);
  const target = repository.createTarget({
    projectId: 'p1', name: 'koksan-test', agentId: 'WIN-01', os: 'windows', environment: 'Dev',
    runtimeConfig: { VITE_API_URL: 'https://api', VITE_COMPANY_NAME: company },
  });
  const ensured = [];
  const layered = {
    async ensure({ base, layer, dir: layerDir }) {
      ensured.push({ base: base.id, layer: layer.variant, dir: layerDir });
      return { sha256: 'e'.repeat(64), size: 99 };
    },
  };
  const service = createArtifactDeployService({
    repository,
    deploymentManager,
    auditLogger: { log: () => {} },
    getProject: (id) => {
      if (id !== 'p1') throw new NotFoundError('Project not found');
      return project;
    },
    tokens,
    getGateway: () => gateway,
    layered,
    timing: { resubscribeDelayMs: 5, channelTimeoutMs: 500 },
  });
  return {
    service, repository, gateway, release, target, ensured,
    cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const success = (deployId) => ({ deployId, success: true, version: '1.0.0', rolledBack: false, durationMs: 10, components: [], error: null });

test('deploy: the package goes out merged with the target\'s brand only; token bound to that layer; layer recorded', async () => {
  const env = setupDeploy();
  try {
    const { deploymentId, deployId } = await env.service.deploy({ targetId: env.target.id, releaseId: env.release.id, triggeredBy: 'bob', publicUrl: PUBLIC_URL });
    const { payload } = env.gateway.last('artifact_deploy');
    const [frontend] = payload.components;
    assert.equal(frontend.download.sha256, 'e'.repeat(64));
    assert.equal(frontend.download.size, 99);
    assert.deepEqual(env.ensured, [{ base: frontend.download.url.split('/').at(-2), layer: 'koksan', dir: 'brand' }]);

    const artifactId = frontend.download.url.split('/').at(-2);
    const koksan = env.repository.listArtifacts(env.release.id).find((a) => a.variant === 'koksan');
    const binding = createDownloadTokenService({ repository: env.repository }).consume(frontend.download.token, artifactId);
    assert.equal(binding.layerArtifactId, koksan.id);
    assert.equal(binding.layerDir, 'brand');
    assert.ok(deploymentManager.getSession(deploymentId).logs.some((line) => /brand layer 'koksan'.*no other brand/.test(line)));

    env.gateway.emit('WIN-01', 'deploy_result', success(deployId));
    await waitFor(() => deploymentManager.getSession(deploymentId).status === 'succeeded');
    assert.equal(env.repository.findTarget(env.target.id).currentVersions.frontend.layer, 'koksan');
  } finally {
    env.cleanup();
  }
});

test('deploy: a brand the release does not ship is refused before anything is sent', async () => {
  const env = setupDeploy({ company: 'evyap' });
  try {
    await assert.rejects(
      env.service.deploy({ targetId: env.target.id, releaseId: env.release.id, publicUrl: PUBLIC_URL }),
      (err) => err instanceof ValidationError && /no 'brand' layer 'evyap'/.test(err.message),
    );
    assert.equal(env.gateway.sent.length, 0);
  } finally {
    env.cleanup();
  }
});

test('deploy: a release without brand layers installs as it is and is recorded as bundled', async () => {
  const env = setupDeploy({ brands: [] });
  try {
    const { deploymentId, deployId } = await env.service.deploy({ targetId: env.target.id, releaseId: env.release.id, publicUrl: PUBLIC_URL });
    assert.equal(env.gateway.last('artifact_deploy').payload.components[0].download.size, 10);
    assert.deepEqual(env.ensured, []);
    env.gateway.emit('WIN-01', 'deploy_result', success(deployId));
    await waitFor(() => deploymentManager.getSession(deploymentId).status === 'succeeded');
    assert.equal(env.repository.findTarget(env.target.id).currentVersions.frontend.layer, '*');

    // A bundled install never needs a reinstall for a brand change.
    env.repository.updateTarget(env.target.id, { runtimeConfig: { VITE_COMPANY_NAME: 'temsa' } });
    await env.service.applyConfig({ targetId: env.target.id, publicUrl: PUBLIC_URL });
    assert.ok(env.gateway.last('artifact_config_apply'));
  } finally {
    env.cleanup();
  }
});

test('applyConfig: same brand → config write; changed brand → reinstall of the installed release with the new layer', async () => {
  const env = setupDeploy();
  try {
    const first = await env.service.deploy({ targetId: env.target.id, releaseId: env.release.id, publicUrl: PUBLIC_URL });
    env.gateway.emit('WIN-01', 'deploy_result', success(first.deployId));
    await waitFor(() => deploymentManager.getSession(first.deploymentId).status === 'succeeded');

    const same = await env.service.applyConfig({ targetId: env.target.id, triggeredBy: 'bob', publicUrl: PUBLIC_URL });
    assert.equal(same.redeployed, undefined);
    assert.ok(env.gateway.last('artifact_config_apply'));
    env.gateway.emit('WIN-01', 'artifact_config_result', { deployId: same.deployId, success: true, components: [] });
    await waitFor(() => deploymentManager.getSession(same.deploymentId).status === 'succeeded');

    env.repository.updateTarget(env.target.id, { runtimeConfig: { VITE_API_URL: 'https://api', VITE_COMPANY_NAME: 'temsa' } });
    const deploysBefore = env.gateway.sent.filter((entry) => entry.process === 'artifact_deploy').length;
    const changed = await env.service.applyConfig({ targetId: env.target.id, triggeredBy: 'bob', publicUrl: PUBLIC_URL });
    assert.deepEqual(changed.redeployed, ['frontend']);
    assert.equal(env.gateway.sent.filter((entry) => entry.process === 'artifact_deploy').length, deploysBefore + 1);
    assert.equal(env.ensured.at(-1).layer, 'temsa');
    const payload = env.gateway.last('artifact_deploy').payload;
    assert.equal(payload.components[0].runtimeConfig.values.VITE_COMPANY_NAME, 'temsa');
    assert.ok(deploymentManager.getSession(changed.deploymentId).logs.some((line) => /brand changed for frontend/.test(line)));

    env.gateway.emit('WIN-01', 'deploy_result', success(changed.deployId));
    await waitFor(() => deploymentManager.getSession(changed.deploymentId).status === 'succeeded');
    assert.equal(env.repository.findTarget(env.target.id).currentVersions.frontend.layer, 'temsa');
  } finally {
    env.cleanup();
  }
});

test('download: a token bound to a layer serves the merged file; a plain token the package itself', async () => {
  const env = setupDeploy();
  try {
    const tokens = createDownloadTokenService({ repository: env.repository });
    const artifacts = env.repository.listArtifacts(env.release.id);
    const frontend = artifacts.find((a) => a.component === 'frontend');
    const temsa = artifacts.find((a) => a.variant === 'temsa');
    const served = [];
    const downloads = createArtifactDownloadService({
      repository: env.repository,
      tokens,
      getProject: () => ({}),
      resolveSecrets: async (project) => project,
      localStore: { open: async ({ artifact }) => ({ stream: `own:${artifact.id}`, contentLength: artifact.size }) },
      layered: { open: async ({ base, layer, dir }) => { served.push([base.id, layer.variant, dir]); return { stream: 'merged', sha256: 'f'.repeat(64), size: 42 }; } },
    });

    const layeredToken = tokens.issue({ artifactId: frontend.id, agentId: 'WIN-01', deploymentId: 'd1', layerArtifactId: temsa.id, layerDir: 'brand' });
    const authorized = downloads.authorize({ artifactId: frontend.id, token: layeredToken });
    assert.equal(authorized.layer.id, temsa.id);
    const opened = await downloads.open(authorized);
    assert.equal(opened.size, 42);
    assert.deepEqual(served, [[frontend.id, 'temsa', 'brand']]);

    const plainToken = tokens.issue({ artifactId: frontend.id, agentId: 'WIN-01', deploymentId: 'd1' });
    const plain = downloads.authorize({ artifactId: frontend.id, token: plainToken });
    assert.equal(plain.layer, null);
    assert.equal((await downloads.open(plain)).stream, `own:${frontend.id}`);

    // A layer token is useless for any other artifact.
    const other = tokens.issue({ artifactId: frontend.id, agentId: 'WIN-01', deploymentId: 'd1', layerArtifactId: temsa.id, layerDir: 'brand' });
    assert.equal(downloads.authorize({ artifactId: temsa.id, token: other }), null);
  } finally {
    env.cleanup();
  }
});
