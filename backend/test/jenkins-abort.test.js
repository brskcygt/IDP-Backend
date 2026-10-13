'use strict';

/**
 * Aborting a Jenkins deployment: the adapter must actually return (a pending
 * sleep used to hang forever, leaving the project "running" with its lock
 * held) and Jenkins must be told — whether the build is running, still
 * queued, or turning from one into the other while the abort arrives.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const JenkinsAdapter = require('../src/adapters/JenkinsAdapter');

function adapterWith(client) {
  const adapter = new JenkinsAdapter({ url: 'http://jenkins.local', jobName: 'release' });
  adapter.client = client;
  return adapter;
}

const withinMs = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms)),
]);

test('abort while logs are streaming: streamLogs returns at once and the build is stopped', async () => {
  const posts = [];
  const adapter = adapterWith({
    get: async (path) => {
      if (path.endsWith('/logText/progressiveText')) return { data: 'line\n', headers: { 'x-text-size': '5', 'x-more-data': 'true' } };
      return { data: { building: true, estimatedDuration: 60_000, timestamp: Date.now() } };
    },
    post: async (path) => { posts.push(path); return { status: 200, headers: {} }; },
  });
  adapter.buildNumber = 12;

  const streaming = adapter.streamLogs(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50)); // now inside the 1.5 s poll sleep
  await adapter.abort();

  await assert.rejects(withinMs(streaming, 300), /Build #12 was aborted/);
  assert.deepEqual(posts, ['/job/release/12/stop']);
});

test('abort while the build is queued: the queue item is cancelled and trigger gives up', async () => {
  const posts = [];
  const adapter = adapterWith({
    get: async () => ({ data: { why: 'Waiting for next available executor' } }),
    post: async (path, _body, options = {}) => {
      posts.push([path, options.params]);
      if (path.endsWith('/buildWithParameters')) return { status: 201, headers: { location: 'http://jenkins.local/queue/item/77/' } };
      return { status: 204, headers: {} };
    },
  });

  const triggering = adapter.trigger({ VERSION: '1.0.0' });
  await new Promise((resolve) => setTimeout(resolve, 50)); // polling the queue
  await adapter.abort();

  await assert.rejects(withinMs(triggering, 300), /aborted/);
  assert.deepEqual(posts.at(-1), ['/queue/cancelItem', { id: '77' }]);
  assert.equal(adapter.buildNumber, null);
});

test('abort as the queue item becomes a build: that build is stopped too', async () => {
  const posts = [];
  let adapter;
  adapter = adapterWith({
    get: async () => {
      // The abort lands while this poll is in flight; Jenkins has just started build #5.
      await adapter.abort();
      return { data: { executable: { number: 5 } } };
    },
    post: async (path) => {
      posts.push(path);
      if (path.endsWith('/buildWithParameters')) return { status: 201, headers: { location: 'http://jenkins.local/queue/item/9/' } };
      return { status: 204, headers: {} };
    },
  });

  await assert.rejects(withinMs(adapter.trigger({ VERSION: '1.0.0' }), 300), /Build #5 was aborted/);
  assert.ok(posts.includes('/queue/cancelItem'), 'the queue item was cancelled first');
  assert.ok(posts.includes('/job/release/5/stop'), 'and the build that slipped through is stopped');
});

test('a second abort is a no-op', async () => {
  const posts = [];
  const adapter = adapterWith({ post: async (path) => { posts.push(path); return { status: 200, headers: {} }; } });
  adapter.buildNumber = 3;
  await adapter.abort();
  await adapter.abort();
  assert.deepEqual(posts, ['/job/release/3/stop']);
});
