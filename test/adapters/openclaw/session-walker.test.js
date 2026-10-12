'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionWalker } = require('../../../src/adapters/openclaw/session-walker');

test('a retry fences an older in-flight session page before it can complete its snapshot', async () => {
  const pending = [];
  const gw = { call(method, params, local) {
    return new Promise(resolve => pending.push({ method, params, local, resolve }));
  } };
  const failed = [], succeeded = [];
  const walker = createSessionWalker({ gw, onFailure: x => failed.push(x), onSuccess: () => succeeded.push(true) });
  const controller = new AbortController();
  const oldWalk = walker.walk({ signal: controller.signal });
  const oldPage = pending[0];
  assert.equal(oldPage.local.shouldIngest(), true);
  controller.abort();
  assert.equal(oldPage.local.shouldIngest(), false, 'remedy deadline immediately fences its page');
  const retry = walker.walk();
  const newPage = pending[1];
  assert.equal(oldPage.local.shouldIngest(), false, 'superseded tap is already fenced');
  newPage.resolve({ sessions: [{ key: 'fresh' }], hasMore: false });
  assert.equal((await retry).sessions[0].key, 'fresh');
  oldPage.resolve({ sessions: [{ key: 'stale' }], hasMore: false });
  assert.equal(await oldWalk, null, 'old result cannot finish the snapshot');
  assert.equal(oldPage.local.shouldIngest(), false, 'late response cannot reach the registry tap');
  assert.deepEqual(succeeded, [true]);
  assert.deepEqual(failed, []);
});

test('each walk has a distinct acquisition generation shared by every page', async () => {
  const pending = [];
  const gw = { call(method, params, local) { return new Promise(resolve => pending.push({ params, local, resolve })); } };
  let next = 40;
  const walker = createSessionWalker({ gw, nextAcquisitionGeneration: () => ++next });
  const walk = walker.walk();
  assert.equal(pending[0].local.acquisitionGeneration, 41);
  pending[0].resolve({ sessions: [{ key: 'first' }], hasMore: true, nextOffset: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending[1].local.acquisitionGeneration, 41);
  pending[1].resolve({ sessions: [{ key: 'second' }], hasMore: false });
  await walk;
  const retry = walker.walk();
  assert.equal(pending[2].local.acquisitionGeneration, 42);
  pending[2].resolve({ sessions: [], hasMore: false });
  await retry;
});
