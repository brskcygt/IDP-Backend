/**
 * Artifact download tokens (core/artifacts/downloadTokens.js, contract 1.3):
 * issue / verify / expiry / max uses / artifact + agent binding / revocation,
 * and that only the hash is ever stored.
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
const { createDownloadTokenService, hashToken, TOKEN_MAX_USES, TOKEN_TTL_MS } = require('../src/core/artifacts/downloadTokens');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-tokens-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  const repository = createArtifactDeployRepository(db);
  let now = 1_000_000;
  const tokens = createDownloadTokenService({ repository, now: () => now });
  return {
    db,
    repository,
    tokens,
    advance: (ms) => { now += ms; },
    cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('an issued token verifies for its artifact and carries its binding', () => {
  const env = setup();
  try {
    const token = env.tokens.issue({ artifactId: 'art_1', agentId: 'WIN-01', deploymentId: 'deploy_1' });
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const record = env.tokens.consume(token, 'art_1');
    assert.equal(record.artifactId, 'art_1');
    assert.equal(record.agentId, 'WIN-01');
    assert.equal(record.deploymentId, 'deploy_1');
    assert.equal(record.uses, 1);
  } finally {
    env.cleanup();
  }
});

test('only the sha256 of a token is stored', () => {
  const env = setup();
  try {
    const token = env.tokens.issue({ artifactId: 'art_1', agentId: 'WIN-01', deploymentId: 'deploy_1' });
    const rows = env.db.prepare('SELECT * FROM artifact_download_tokens').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token_hash, hashToken(token));
    assert.ok(!JSON.stringify(rows).includes(token));
  } finally {
    env.cleanup();
  }
});

test('a token is bound to one artifact; a wrong artifact neither verifies nor uses it up', () => {
  const env = setup();
  try {
    const token = env.tokens.issue({ artifactId: 'art_1', agentId: 'WIN-01', deploymentId: 'deploy_1' });
    assert.equal(env.tokens.consume(token, 'art_2'), null);
    assert.equal(env.tokens.consume(token, 'art_1').uses, 1);
  } finally {
    env.cleanup();
  }
});

test('tokens expire after the TTL', () => {
  const env = setup();
  try {
    const token = env.tokens.issue({ artifactId: 'art_1', agentId: 'WIN-01', deploymentId: 'deploy_1' });
    env.advance(TOKEN_TTL_MS - 1);
    assert.ok(env.tokens.consume(token, 'art_1'));
    env.advance(1);
    assert.equal(env.tokens.consume(token, 'art_1'), null);
  } finally {
    env.cleanup();
  }
});

test(`a token allows ${TOKEN_MAX_USES} downloads (agent retries), then stops`, () => {
  const env = setup();
  try {
    const token = env.tokens.issue({ artifactId: 'art_1', agentId: 'WIN-01', deploymentId: 'deploy_1' });
    for (let use = 1; use <= TOKEN_MAX_USES; use += 1) assert.equal(env.tokens.consume(token, 'art_1').uses, use);
    assert.equal(env.tokens.consume(token, 'art_1'), null);
  } finally {
    env.cleanup();
  }
});

test('an X-IDP-Agent-Id that does not match the binding is rejected', () => {
  const env = setup();
  try {
    const token = env.tokens.issue({ artifactId: 'art_1', agentId: 'WIN-01', deploymentId: 'deploy_1' });
    assert.equal(env.tokens.consume(token, 'art_1', { agentId: 'WIN-02' }), null);
    assert.ok(env.tokens.consume(token, 'art_1', { agentId: 'WIN-01' }));
    assert.ok(env.tokens.consume(token, 'art_1'));
  } finally {
    env.cleanup();
  }
});

test('malformed or unknown tokens are rejected without touching storage', () => {
  const env = setup();
  try {
    env.tokens.issue({ artifactId: 'art_1', agentId: 'WIN-01', deploymentId: 'deploy_1' });
    for (const token of [undefined, null, '', 'short', 'x'.repeat(43), `${'a'.repeat(42)}=`, 42]) {
      assert.equal(env.tokens.consume(token, 'art_1'), null, String(token));
    }
    assert.equal(env.tokens.consume('A'.repeat(43), ''), null);
  } finally {
    env.cleanup();
  }
});

test('revokeForDeployment invalidates every token of a finished deployment; expired rows are pruned', () => {
  const env = setup();
  try {
    const a = env.tokens.issue({ artifactId: 'art_1', agentId: 'WIN-01', deploymentId: 'deploy_1' });
    const b = env.tokens.issue({ artifactId: 'art_2', agentId: 'WIN-01', deploymentId: 'deploy_1' });
    const other = env.tokens.issue({ artifactId: 'art_1', agentId: 'WIN-02', deploymentId: 'deploy_2' });
    assert.equal(env.tokens.revokeForDeployment('deploy_1'), 2);
    assert.equal(env.tokens.consume(a, 'art_1'), null);
    assert.equal(env.tokens.consume(b, 'art_2'), null);
    assert.ok(env.tokens.consume(other, 'art_1'));

    env.advance(TOKEN_TTL_MS + 1);
    env.tokens.issue({ artifactId: 'art_3', agentId: 'WIN-01', deploymentId: 'deploy_3' });
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM artifact_download_tokens').get().n, 1);
  } finally {
    env.cleanup();
  }
});
