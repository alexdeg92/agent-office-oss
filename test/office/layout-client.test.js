'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOfficeLayoutClient, watchLayout } = require('../../public/v2/office/layout-client.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };

for (const id of [null, '1', '2', 'gym', 'rdc']) test(`layout transport preserves backend payloads and scopes reads, writes, history and theme: ${id}`, async () => {
  const calls = [], data = Object.freeze({ marker: 'backend value' });
  const http = {
    get: async (...args) => { calls.push(['GET', ...args]); return { data }; },
    put: async (...args) => { calls.push(['PUT', ...args]); return { data }; },
  };
  const root = createOfficeLayoutClient(http), client = id == null ? root : root.forFloor(id);
  const body = Object.freeze({ expectedRevision: 12, data: Object.freeze({ items: [] }) });
  const theme = Object.freeze({ expectedRevision: 12, theme: Object.freeze({ mode: 'fixed', fixed: 'night' }) });
  for (const response of [await client.get(), await client.getRevision(11), await client.put(body), await client.putTheme(theme)]) assert.equal(response, data);
  const suffix = id == null ? '' : '?floorId=' + id;
  assert.deepEqual(calls, [
    ['GET', '/api/v2/office/layout' + suffix, { quiet: true }],
    ['GET', '/api/v2/office/layout/revisions/11' + suffix, { quiet: true }],
    ['PUT', '/api/v2/office/layout' + suffix, body, { quiet: true }],
    ['PUT', '/api/v2/office/layout/theme' + suffix, theme, { quiet: true }],
  ]);
  assert.equal(calls[2][2], body, 'draft is sent unchanged, with no local merging');
  assert.equal(calls[3][2], theme);
});

test('scoped conflict payload and transport error retain their exact backend identity', async () => {
  const error = Object.freeze({ status: 409, current: Object.freeze({ revision: 24, vm: { floor: '2' } }) });
  const client = createOfficeLayoutClient({ put: async () => { throw error; } }, '2');
  await assert.rejects(client.put({ expectedRevision: 23, data: {} }), e => e === error);
  await assert.rejects(client.putTheme({ expectedRevision: 23, theme: {} }), e => e === error);
});

test('late HTTP results and failures from an abandoned floor never publish or subscribe', async () => {
  for (const reject of [false, true]) {
    const read = deferred(), output = [], subscribed = [];
    const dispose = watchLayout({ client: { get: () => read.promise }, floorId: '2',
      stream: { subscribe: (...args) => subscribed.push(args) }, onChange: value => output.push(value) });
    await tick(); dispose();
    if (reject) read.reject(new Error('old floor unavailable')); else read.resolve({ floor: '2' });
    await tick();
    assert.deepEqual(output, []); assert.deepEqual(subscribed, []);
  }
});

test('scoped stream forwards backend values and ignores callbacks after a switch', async () => {
  const vm = Object.freeze({ floor: 'gym', theme: { resolved: 'night' } }), output = [], calls = [];
  let receive, unsubscribed = 0;
  const dispose = watchLayout({ client: { get: async () => vm }, floorId: 'gym', onChange: value => output.push(value),
    stream: { subscribe: (topic, url, fn) => { calls.push([topic, url]); receive=fn; return () => unsubscribed++; } } });
  await tick();
  assert.deepEqual(calls, [['layout?floorId=gym', '/api/v2/office/layout?floorId=gym']]);
  assert.equal(output[0].data, vm);
  const update = Object.freeze({ data: { floor: 'gym', revision: 5 }, resyncing: true, loading: false });
  receive(update); assert.equal(output.at(-1), update);
  dispose(); receive({ data: { floor: 'gym', revision: 6 } });
  assert.equal(unsubscribed, 1); assert.equal(output.length, 2);
});

test('missing backend layout remains a retryable error without a generated fallback or unsupported topic', async () => {
  const error = Object.freeze({ status: 404, code: 'not_found' }), output = [];
  const dispose = watchLayout({ client: { get: async () => { throw error; } }, onChange: value => output.push(value),
    stream: { subscribe: () => assert.fail('subscribe to missing route') } });
  await tick();
  assert.equal(output.length, 1); assert.equal(output[0].error, error);
  assert.equal(output[0].data, undefined); assert.equal(output[0].loading, false);
  dispose();
});
