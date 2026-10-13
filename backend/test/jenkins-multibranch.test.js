'use strict';

/**
 * JenkinsAdapter with jobType 'multibranch': the build runs in the branch's
 * child job, a branch Jenkins has not discovered yet triggers a scan, and a
 * child that has never run is waited for until it knows its parameters.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const JenkinsAdapter = require('../src/adapters/JenkinsAdapter');

const MULTIBRANCH_CLASS = 'org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject';

/**
 * A fake Jenkins: `children` maps child job name → { displayName, params, inQueue, lastBuild }.
 * `onScan` runs when the multibranch scan is requested.
 */
function fakeJenkins({ parentClass = MULTIBRANCH_CLASS, children = {}, onScan = () => {} } = {}) {
  const calls = [];
  const client = {
    get: async (path) => {
      calls.push(['GET', path]);
      if (path === '/job/release/api/json') {
        return {
          data: {
            _class: parentClass,
            jobs: Object.entries(children).map(([name, child]) => ({ name, displayName: child.displayName || name })),
          },
        };
      }
      const childMatch = path.match(/^\/job\/release\/job\/([^/]+)\/api\/json$/);
      if (childMatch) {
        const child = children[decodeURIComponent(childMatch[1])];
        const advance = child.advance;
        if (advance) advance(child);
        return {
          data: {
            inQueue: !!child.inQueue,
            lastBuild: child.lastBuild || null,
            property: child.params ? [{ parameterDefinitions: child.params.map((name) => ({ name })) }] : [],
          },
        };
      }
      if (path.startsWith('/queue/item/')) return { data: { executable: { number: 7 } } };
      throw Object.assign(new Error(`unexpected GET ${path}`), { response: { status: 404 } });
    },
    post: async (path, _body, options = {}) => {
      calls.push(['POST', path, options.params]);
      if (path === '/job/release/build') {
        onScan(children);
        return { status: 200, headers: {} };
      }
      if (path.endsWith('/buildWithParameters')) return { status: 201, headers: { location: 'http://j/queue/item/42/' } };
      throw new Error(`unexpected POST ${path}`);
    },
  };
  return { client, calls };
}

function adapterWith(fake, config = {}) {
  const adapter = new JenkinsAdapter({
    url: 'http://jenkins.local',
    jobName: 'release',
    jobType: 'multibranch',
    timing: { scanTimeoutMs: 50, scanPollMs: 1 },
    ...config,
  });
  adapter.client = fake.client;
  adapter._sleep = () => Promise.resolve();
  return adapter;
}

test('multibranch: builds in the child job of the branch, encoded the way Jenkins names it', async () => {
  const fake = fakeJenkins({
    children: { 'feature%2Flogin': { displayName: 'feature/login', params: ['VERSION', 'BRANCH'] } },
  });
  const adapter = adapterWith(fake, { branch: 'feature/login' });

  const result = await adapter.trigger({ VERSION: '1.2.0', BRANCH: 'feature/login' });

  assert.equal(result.buildNumber, 7);
  assert.equal(adapter.jobName, 'release/feature%2Flogin');
  assert.ok(fake.calls.some(([method, path]) => method === 'POST' && path === '/job/release/job/feature%252Flogin/buildWithParameters'));
  assert.ok(!fake.calls.some(([, path]) => path === '/job/release/build'), 'no scan for a known branch');
});

test('multibranch: without a branch the default branch is built, then main', async () => {
  const fake = fakeJenkins({ children: { main: { params: ['VERSION'] }, develop: { params: ['VERSION'] } } });

  const withDefault = adapterWith(fake, { defaultBranch: 'develop' });
  await withDefault.trigger({ VERSION: '1.0.0' });
  assert.equal(withDefault.jobName, 'release/develop');

  const withoutDefault = adapterWith(fake);
  await withoutDefault.trigger({ VERSION: '1.0.0' });
  assert.equal(withoutDefault.jobName, 'release/main');
});

test('multibranch: an undiscovered branch triggers a scan and waits for its first run', async () => {
  const fake = fakeJenkins({
    children: {},
    onScan: (children) => {
      // Discovered, queued for its automatic first run, parameters still unknown.
      let polls = 0;
      children['preview%2F1.3.0'] = {
        displayName: 'preview/1.3.0',
        inQueue: true,
        advance: (child) => {
          polls += 1;
          if (polls === 2) {
            child.inQueue = false;
            child.lastBuild = { number: 1, building: true };
            child.params = ['VERSION', 'BRANCH'];
          }
        },
      };
    },
  });
  const adapter = adapterWith(fake, { branch: 'preview/1.3.0', timing: { scanTimeoutMs: 1000, scanPollMs: 1 } });
  const lines = [];
  adapter.onLog((line) => lines.push(line));

  await adapter.trigger({ VERSION: '1.3.0' });

  assert.deepEqual(fake.calls.find(([, path]) => path === '/job/release/build'), ['POST', '/job/release/build', { delay: '0' }]);
  assert.equal(adapter.jobName, 'release/preview%2F1.3.0');
  assert.ok(lines.some((line) => line.includes('scan the repository')));
  assert.ok(lines.some((line) => line.includes('learns its parameters')));
});

test('multibranch: a branch the scan never finds fails with an explanation, not a default build', async () => {
  const fake = fakeJenkins({ children: { main: { params: ['VERSION'] } } });
  const adapter = adapterWith(fake, { branch: 'feature/ghost' });

  await assert.rejects(() => adapter.trigger({ VERSION: '1.0.0' }), /no job for 'feature\/ghost' even after a repository scan/);
  assert.ok(!fake.calls.some(([, path]) => path.endsWith('/buildWithParameters')));
});

test('multibranch: a child that ran but declares no parameters is refused', async () => {
  const fake = fakeJenkins({ children: { main: { lastBuild: { number: 3, building: false } } } });
  const adapter = adapterWith(fake);

  await assert.rejects(() => adapter.trigger({ VERSION: '1.0.0' }), /declares no parameters/);
});

test('multibranch: a child that never ran times out with instructions instead of starting a parameterless build', async () => {
  const fake = fakeJenkins({ children: { main: {} } });
  const adapter = adapterWith(fake);

  await assert.rejects(() => adapter.trigger({ VERSION: '1.0.0' }), /has never run/);
  assert.ok(!fake.calls.some(([method, path]) => method === 'POST' && path.endsWith('/build') && path !== '/job/release/build'));
});

test('multibranch: a job that is not a multibranch project is reported as such', async () => {
  const fake = fakeJenkins({ parentClass: 'org.jenkinsci.plugins.workflow.job.WorkflowJob' });
  const adapter = adapterWith(fake);

  await assert.rejects(() => adapter.trigger({ VERSION: '1.0.0' }), /is not a Multibranch Pipeline job/);
});

test('standard job type keeps triggering the configured job directly', async () => {
  const fake = fakeJenkins();
  fake.client.post = async (path, _body, options = {}) => {
    fake.calls.push(['POST', path, options.params]);
    return { status: 201, headers: { location: 'http://j/queue/item/42/' } };
  };
  const adapter = adapterWith(fake, { jobType: undefined, branch: 'feature/login' });

  await adapter.trigger({ VERSION: '1.0.0', BRANCH: 'feature/login' });

  assert.deepEqual(fake.calls.filter(([method]) => method === 'POST').map(([, path]) => path), ['/job/release/buildWithParameters']);
});
