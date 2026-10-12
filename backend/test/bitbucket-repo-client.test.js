/**
 * BitbucketRepoClient (adapters/ci/BitbucketRepoClient.js) over a fake fetch:
 * ref listing + pagination (same-origin only), branch/tag create/delete,
 * pull request create + merge (200 and 202 task polling), merge refusal,
 * decline, both auth header shapes and token scrubbing.
 *
 * Run with: npm test
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createRepoClient } = require('../src/adapters/ci');
const BitbucketRepoClient = require('../src/adapters/ci/BitbucketRepoClient');

const BASE = 'https://api.bitbucket.org/2.0';
const REPO = `${BASE}/repositories/mdp/jetsrm`;
const SOURCE = { platform: 'bitbucket', baseUrl: BASE, owner: 'mdp', repo: 'jetsrm', authType: 'bearer' };

function json(status, body, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** routes: [method, url-or-RegExp, (request) => Response][]; unmatched → 404. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const request = {
      url,
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(request);
    for (const [method, match, handler] of routes) {
      if (method !== request.method) continue;
      if (match instanceof RegExp ? match.test(url) : match === url) return handler(request);
    }
    return json(404, { error: { message: 'Not found' } });
  };
  return { fetchImpl, calls };
}

function client(routes, options = {}) {
  const fake = fakeFetch(routes);
  const repo = createRepoClient(options.source || SOURCE, {
    token: 'SECRET-TOKEN',
    username: options.username,
    fetchImpl: fake.fetchImpl,
    sleep: async () => {},
    timing: { mergeTimeoutMs: options.mergeTimeoutMs ?? 60_000, mergePollMs: 1 },
  });
  return { repo, calls: fake.calls };
}

const branch = (name, hash, date = '2026-10-01T10:00:00+00:00') => ({
  name, target: { hash, date, message: `commit on ${name}\n` },
});

test('listBranches: sorted query, BBQL filter, follows same-origin pagination only, caps the total', async () => {
  const { repo, calls } = client([
    ['GET', /refs\/branches\?/, (req) => {
      if (req.url.includes('page=2')) {
        return json(200, { values: [branch('feature/b', 'b'.repeat(40))], next: 'https://evil.example/2.0/next' });
      }
      return json(200, { values: [branch('main', 'a'.repeat(40))], next: `${REPO}/refs/branches?page=2` });
    }],
  ]);
  const refs = await repo.listBranches({ q: 'fe"at' });
  assert.deepEqual(refs, [
    { name: 'main', sha: 'a'.repeat(40), date: '2026-10-01T10:00:00+00:00', message: 'commit on main' },
    { name: 'feature/b', sha: 'b'.repeat(40), date: '2026-10-01T10:00:00+00:00', message: 'commit on feature/b' },
  ]);
  assert.equal(calls.length, 2, 'the cross-origin next link is never followed');
  const first = new URL(calls[0].url);
  assert.equal(first.searchParams.get('pagelen'), '100');
  assert.equal(first.searchParams.get('sort'), '-target.date');
  assert.equal(first.searchParams.get('q'), 'name ~ "fe\\"at"');
  assert.equal(calls[0].headers.Authorization, 'Bearer SECRET-TOKEN');

  const many = Array.from({ length: 100 }, (_, i) => branch(`b${i}`, 'c'.repeat(40)));
  const capped = client([['GET', /refs\/branches\?/, () => json(200, { values: many, next: `${REPO}/refs/branches?page=x` })]]);
  assert.equal((await capped.repo.listBranches({ limit: 250 })).length, 250);
  assert.equal(capped.calls.length, 3);
});

test('listTags: annotated tag date/message win over the commit; repository default branch', async () => {
  const { repo, calls } = client([
    ['GET', /refs\/tags\?/, () => json(200, {
      values: [
        { name: '2.5.0', date: '2026-09-01T00:00:00+00:00', message: 'Release 2.5.0', target: { hash: 'd'.repeat(40), date: 'x', message: 'y' } },
        { name: '2.4.0', target: { hash: 'e'.repeat(40), date: '2026-08-01T00:00:00+00:00', message: '' } },
      ],
    })],
    ['GET', REPO, () => json(200, { mainbranch: { name: 'develop' } })],
  ]);
  assert.deepEqual(await repo.listTags(), [
    { name: '2.5.0', sha: 'd'.repeat(40), date: '2026-09-01T00:00:00+00:00', message: 'Release 2.5.0' },
    { name: '2.4.0', sha: 'e'.repeat(40), date: '2026-08-01T00:00:00+00:00', message: null },
  ]);
  assert.equal(new URL(calls[0].url).searchParams.get('q'), null);
  assert.deepEqual(await repo.getRepository(), { defaultBranch: 'develop' });
});

test('basic auth sends email:token; https is required; errors never carry the token', async () => {
  const { repo, calls } = client(
    [['GET', /refs\/branches\//, () => json(500, { error: { message: 'boom SECRET-TOKEN' } })]],
    { source: { ...SOURCE, authType: 'basic' }, username: 'baris@mdp.example' },
  );
  await assert.rejects(() => repo.getBranch('main'), (err) => {
    assert.ok(!err.message.includes('SECRET-TOKEN'));
    assert.match(err.message, /HTTP 500/);
    assert.equal(err.transient, true);
    return true;
  });
  assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('baris@mdp.example:SECRET-TOKEN').toString('base64')}`);
  assert.throws(() => createRepoClient({ ...SOURCE, baseUrl: 'http://api.bitbucket.org/2.0' }, { token: 't' }), /https/);
  assert.throws(() => createRepoClient({ ...SOURCE, platform: 'github' }, { token: 't' }), /Bitbucket/);
});

test('branch + tag: lookup (404 → null), create, delete (404 is fine), commit lookup', async () => {
  const { repo, calls } = client([
    ['GET', `${REPO}/refs/branches/feature%2Fa`, () => json(200, branch('feature/a', 'f'.repeat(40)))],
    ['GET', `${REPO}/refs/tags/9.9.9`, () => json(404, { error: { message: 'nope' } })],
    ['GET', `${REPO}/commit/abc1234`, () => json(200, { hash: 'a'.repeat(40) })],
    ['POST', `${REPO}/refs/branches`, (req) => json(201, { name: req.body.name, target: { hash: req.body.target.hash } })],
    ['DELETE', `${REPO}/refs/branches/preview%2Fx`, () => new Response(null, { status: 204 })],
    ['DELETE', `${REPO}/refs/branches/gone`, () => json(404, {})],
    ['POST', `${REPO}/refs/tags`, (req) => json(201, { name: req.body.name, message: req.body.message, target: { hash: req.body.target.hash } })],
  ]);
  assert.equal((await repo.getBranch('feature/a')).sha, 'f'.repeat(40));
  assert.equal(await repo.getTag('9.9.9'), null);
  assert.equal(await repo.getCommit('abc1234'), 'a'.repeat(40));
  assert.equal(await repo.getCommit('0000000'), null);
  const created = await repo.createBranch('preview/x', 'a'.repeat(40));
  assert.deepEqual(created, { name: 'preview/x', sha: 'a'.repeat(40), date: null, message: null });
  assert.deepEqual(calls.find((c) => c.method === 'POST').body, { name: 'preview/x', target: { hash: 'a'.repeat(40) } });
  await repo.deleteBranch('preview/x');
  await repo.deleteBranch('gone');
  const tag = await repo.createTag({ name: '2.6.0', hash: 'a'.repeat(40), message: 'Release' });
  assert.deepEqual(tag, { name: '2.6.0', sha: 'a'.repeat(40), date: null, message: 'Release' });
  assert.deepEqual(calls.at(-1).body, { name: '2.6.0', target: { hash: 'a'.repeat(40) }, message: 'Release' });
});

test('pull request: create + merge (200), merge commit strategy, never closes the source branch', async () => {
  const { repo, calls } = client([
    ['POST', `${REPO}/pullrequests`, () => json(201, { id: 42 })],
    ['POST', `${REPO}/pullrequests/42/merge`, () => json(200, { id: 42, state: 'MERGED', merge_commit: { hash: '1'.repeat(40) } })],
  ]);
  const pr = await repo.createPullRequest({ title: 'IDP compose: a → p', source: 'feature/a', destination: 'preview/p' });
  assert.deepEqual(pr, { id: 42 });
  assert.deepEqual(calls[0].body, {
    title: 'IDP compose: a → p',
    source: { branch: { name: 'feature/a' } },
    destination: { branch: { name: 'preview/p' } },
    close_source_branch: false,
  });
  assert.deepEqual(await repo.mergePullRequest(42, { message: 'Merge' }), { mergeCommit: '1'.repeat(40) });
  assert.deepEqual(calls[1].body, { type: 'pullrequest', merge_strategy: 'merge_commit', close_source_branch: false, message: 'Merge' });
});

test('pull request merge 202: polls the task status until SUCCESS / FAILED / timeout', async () => {
  let polls = 0;
  const ok = client([
    ['POST', `${REPO}/pullrequests/7/merge`, () => json(202, {}, { location: `${REPO}/pullrequests/7/merge/task-status/t1` })],
    ['GET', `${REPO}/pullrequests/7/merge/task-status/t1`, () => {
      polls += 1;
      return polls < 3
        ? json(200, { task_status: 'PENDING' })
        : json(200, { task_status: 'SUCCESS', merge_result: { merge_commit: { hash: '2'.repeat(40) } } });
    }],
  ]);
  assert.deepEqual(await ok.repo.mergePullRequest(7), { mergeCommit: '2'.repeat(40) });
  assert.equal(polls, 3);

  const failed = client([
    ['POST', `${REPO}/pullrequests/8/merge`, () => json(202, { links: { self: { href: `${REPO}/pullrequests/8/merge/task-status/t2` } } })],
    ['GET', /task-status\/t2/, () => json(200, { task_status: 'FAILED', merge_result: { error: { message: 'Merge conflict' } } })],
  ]);
  await assert.rejects(() => failed.repo.mergePullRequest(8), (err) => err.mergeFailed === true && /Merge conflict/.test(err.message));

  const slow = client([
    ['POST', `${REPO}/pullrequests/9/merge`, () => json(202, {}, { location: `${REPO}/pullrequests/9/merge/task-status/t3` })],
    ['GET', /task-status\/t3/, () => json(200, { task_status: 'PENDING' })],
  ], { mergeTimeoutMs: 0 });
  await assert.rejects(() => slow.repo.mergePullRequest(9), /did not finish/);

  const foreign = client([
    ['POST', `${REPO}/pullrequests/10/merge`, () => json(202, {}, { location: 'https://evil.example/task' })],
  ]);
  await assert.rejects(() => foreign.repo.mergePullRequest(10), /no task-status link/);
  assert.equal(foreign.calls.length, 1, 'the token is never sent to a foreign task link');
});

test('pull request merge refused (conflict) is flagged mergeFailed; decline tolerates closed PRs', async () => {
  const { repo, calls } = client([
    ['POST', `${REPO}/pullrequests/5/merge`, () => json(409, { error: { message: 'Merge conflict in backend/app.js' } })],
    ['POST', `${REPO}/pullrequests/5/decline`, () => json(200, { state: 'DECLINED' })],
    ['POST', `${REPO}/pullrequests/6/decline`, () => json(400, { error: { message: 'already merged' } })],
  ]);
  await assert.rejects(() => repo.mergePullRequest(5), (err) => {
    assert.equal(err.mergeFailed, true);
    assert.equal(err.status, 409);
    assert.match(err.providerMessage, /Merge conflict/);
    return true;
  });
  await repo.declinePullRequest(5);
  await repo.declinePullRequest(6);
  assert.equal(calls.length, 3);
  repo.releaseCredentials();
  await assert.rejects(() => repo.getBranch('main'), /released/);
});

test('toRepoRef trims long messages', () => {
  const ref = BitbucketRepoClient.toRepoRef({ name: 'x', target: { hash: 'h', message: 'm'.repeat(600) } });
  assert.equal(ref.message.length, 501);
});
