'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { mountCommands } = require('../../src/api/v2/commands');
const { errorMiddleware } = require('../../src/api/v2/errors');
const { createCli } = require('../../src/adapters/openclaw/cli');
const { bind } = require('../../src/adapters/openclaw/commands');
const { waitFor } = require('../helpers/harness');

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function ownerRouter(t, commands, extra = {}) {
  const app = express(), r = express.Router(); app.use(express.json());
  const engine = { runtime: () => ({ capabilities: { flows: { write: true }, skills: { toggle: true } } }), primaryAgent: () => ({ id: 'main' }),
    cronJobs: () => ['a', 'b', 'c'].map(id => ({ id })), cronRuns: () => ({ runs: [] }), skills: () => [{ name: 'test' }] };
  mountCommands({ r, engine, runtime: { commands, ...extra }, topics: { define() {}, invalidate() {} }, authed: (_req, _res, next) => next(),
    guard: () => (_req, _res, next) => next(), ok: (res, data) => res.json({ data }) });
  r.use(errorMiddleware()); app.use(['/api/v2', '/api/v3'], r);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return async (route, { version = 2, method = 'POST', body = {} } = {}) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/v' + version + route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };
}

test('one flow run is reserved across API versions until dispatch and refresh finish, without blocking another job', async t => {
  const dispatched = deferred(), run = deferred(), refreshed = deferred(), refresh = deferred(); let calls = 0, refreshCalls = 0;
  const request = await ownerRouter(t, { flowRun: id => { calls++; if (id === 'a' && calls === 1) { dispatched.resolve(); return run.promise; } return { ok: true }; } },
    { refreshFlows: () => { if (++refreshCalls === 2) { refreshed.resolve(); return refresh.promise; } } });
  const first = request('/flows/a/runs'); await dispatched.promise;
  const duplicate = await request('/flows/a/runs', { version: 3 });
  assert.equal(duplicate.status, 409); assert.deepEqual(duplicate.json.error.details, [{ issue: 'run-pending' }]); assert.equal(calls, 1);
  assert.equal((await request('/flows/b/runs')).status, 200);
  run.resolve({ ok: true }); await refreshed.promise;
  assert.equal((await request('/flows/a/runs')).status, 409); assert.equal(calls, 2);
  refresh.resolve(); assert.equal((await first).status, 200);
  assert.equal((await request('/flows/a/runs')).status, 200); assert.equal(calls, 3);
});

test('flow reservation is released after fixed failure, thrown rejection or busy refusal', async t => {
  for (const failure of [{ failed: 'timeout' }, Error('secret synthetic failure'), { failed: 'busy' }]) {
    let calls = 0;
    const request = await ownerRouter(t, { flowRun: () => { if (++calls === 1) { if (failure instanceof Error) return Promise.reject(failure); return failure; } return { ok: true }; } });
    const first = await request('/flows/a/runs');
    assert.equal(first.status, failure instanceof Error ? 500 : failure.failed === 'busy' ? 429 : 502);
    assert.ok(!JSON.stringify(first.json).includes('secret synthetic failure'));
    assert.equal((await request('/flows/a/runs')).status, 200); assert.equal(calls, 2);
  }
});

test('distinct flow and skill requests share the CLI ceiling; refused requests never spawn and completion frees a slot', async t => {
  const children = [];
  t.mock.method(childProcess, 'execFile', (_bin, args, _options, callback) => {
    const child = new EventEmitter(); children.push({ args, finish() { callback(null, '{"ok":true}', ''); child.emit('close', 0); } }); return child;
  });
  const cli = createCli({ bin: '/synthetic/openclaw', home: '/synthetic/home', readonly: false, maxActive: 3 });
  const request = await ownerRouter(t, bind(cli));
  const first = request('/flows/a/runs'); await waitFor(() => children.length === 1);
  const second = request('/flows/b/runs'); await waitFor(() => children.length === 2);
  const busy = await request('/skills/test/enabled', { method: 'PUT', body: { enabled: true } });
  assert.equal(busy.status, 429); assert.equal(busy.json.error.code, 'rate_limited'); assert.deepEqual(busy.json.error.details, [{ issue: 'command-busy' }]);
  assert.equal(children.length, 2);
  const freshness = cli.run(['skills', 'list', '--agent', 'main'], 1000, { freshness: true }); assert.equal(children.length, 3);
  children[0].finish(); assert.equal((await first).status, 200);
  const skill = request('/skills/test/enabled', { method: 'PUT', body: { enabled: true } }); await waitFor(() => children.length === 4);
  children[1].finish(); children[2].finish(); children[3].finish();
  assert.equal((await second).status, 200); assert.equal((await freshness).ok, true); assert.equal((await skill).status, 200);
});
