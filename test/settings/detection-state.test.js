'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { settingsFixture } = require('../helpers/settings-fixture');
const { detectRuntimes } = require('../../src/adapters/detection');
const { createSettings } = require('../../src/settings/service');
const IC = require('../../src/instance-config');
const BASE = '/api/v3/settings';
const getVM = async h => { const r = await h.get(BASE); assert.equal(r.status, 200, r.text); return r.json.data; };

test('fresh-boot VM never claims detected or absent before any actual check', async t => {
  const h = await settingsFixture({ effectiveV3: true }); t.after(() => h.close());
  const vm = await getVM(h);
  for (const row of vm.runtimes) {
    assert.deepEqual(row.detection, { status: 'not-checked', checkedAt: null });
    assert.equal(row.found, false); assert.equal(row.reason.key, 'settings.detection.notChecked');
  }
  assert.equal(h.detectCalls, 0);
});

test('boot and bounded schedule detect synthetic HOME, manual button refreshes the same stored state', async t => {
  const h = await settingsFixture({ effectiveV3: true, detect: ctx => detectRuntimes({ env: { ...ctx.env, PATH: '' } }) }); t.after(() => h.close());
  fs.rmSync(path.join(h.tmp, '.codex'), { recursive: true });
  let scheduled, cancelled = 0;
  await h.settings.startDetection({ intervalMs: 300000, setTimer: (fn, ms) => { assert.equal(ms, 300000); scheduled = fn; return { unref() {} }; }, clearTimer: () => cancelled++ });
  let vm = await getVM(h), row = vm.runtimes.find(r => r.id === 'legacy');
  assert.deepEqual(row.detection, { status: 'detected', checkedAt: h.clock.now }); assert.equal(row.reason.key, 'settings.detection.config');
  assert.equal(vm.runtimes.filter(r => r.adapter === 'openclaw').length, 1);
  assert.equal(vm.runtimes.find(r => r.id === 'codex').detection.status, 'not-detected');
  fs.mkdirSync(path.join(h.tmp, '.codex')); h.clock.now += 300000;
  await scheduled(); vm = await getVM(h);
  assert.equal(vm.runtimes.find(r => r.id === 'codex').detection.status, 'detected');
  fs.rmSync(path.join(h.tmp, '.codex'), { recursive: true }); h.clock.now += 1000;
  const manual = await h.post(BASE + '/detect'); assert.equal(manual.status, 200, manual.text);
  assert.equal(manual.json.data.vm.runtimes.find(r => r.id === 'codex').detection.status, 'not-detected');
  assert.equal(manual.json.data.vm.runtimes.find(r => r.id === 'codex').detection.checkedAt, h.clock.now);
  assert.equal(h.settings.revision(), 1, 'detection does not amend owner configuration');
  h.settings.close(); assert.equal(cancelled, 1);
});

test('store reopen renders the last real detection immediately without rereading HOME or leaking credentials', async t => {
  const h = await settingsFixture({ effectiveV3: true }); t.after(() => h.close());
  await h.post(BASE + '/detect'); const before = await getVM(h), raw = h.store.db.prepare("SELECT value FROM runtime_detection WHERE id=1").get()?.value;
  assert.ok(raw, 'last result is persisted'); assert.ok(!raw.includes(h.fake.token)); assert.ok(!raw.includes('secret'));
  h.settings.close();
  const dir = path.join(h.tmp, 'reopened-store'); fs.mkdirSync(dir); fs.copyFileSync(h.store.backup(), path.join(dir, 'agent-office.sqlite'));
  const store = require('../../src/store').openStore({ dir, instance: 'test', ownerName: 'Camille', log: () => {} }); t.after(() => store.close());
  const cold = createSettings({ env: h.env, files: IC.readInstanceConfig(h.env), cfg: h.controller.cfg, store, auth: h.auth, engine: h.engine, paths: require('../../src/config').openclawPaths(h.env), detect: () => { throw Error('must not run on GET'); } }); t.after(() => cold.close());
  const vm = cold.vm({ headers: {}, session: {} });
  assert.deepEqual(vm.runtimes.map(r => [r.id, r.detection, r.checkedPaths]), before.runtimes.map(r => [r.id, r.detection, r.checkedPaths]));
  assert.ok(!JSON.stringify(vm).includes(h.fake.token));
});

test('manual and scheduled refresh share one flight; close rejects late publication', async t => {
  let release, calls = 0;
  const h = await settingsFixture({ effectiveV3: true, detect: () => { calls++; return new Promise(r => { release = r; }); } }); t.after(() => h.close());
  const boot = h.settings.startDetection();
  await new Promise(r => setImmediate(r));
  const manual = h.post(BASE + '/detect'); await new Promise(r => setTimeout(r, 20));
  assert.equal(calls, 1); h.settings.close();
  release([{ runtime: 'codex', name: 'Codex', found: true, confidence: 'presence', checkedPaths: [path.join(h.tmp, '.codex')], agents: [] }]);
  await boot; await manual;
  assert.equal(h.store.db.prepare("SELECT value FROM runtime_detection WHERE id=1").get(), undefined);
});

test('failed automatic refresh retains the prior snapshot and bounded scheduling continues', async t => {
  let fail = false, scheduled;
  const h = await settingsFixture({ effectiveV3: true, detect: () => { if (fail) throw Error('synthetic private failure'); return [{ runtime: 'codex', name: 'Codex', found: true, confidence: 'presence', agents: [] }]; } }); t.after(() => h.close());
  await h.settings.startDetection({ setTimer: fn => { scheduled = fn; return { unref() {} }; }, clearTimer() {} });
  const before = (await getVM(h)).runtimes.find(r => r.id === 'codex').detection;
  fail = true; h.clock.now += 300000; await scheduled();
  assert.deepEqual((await getVM(h)).runtimes.find(r => r.id === 'codex').detection, before);
  assert.equal((await h.post(BASE + '/detect')).status, 503);
});

test('expired owner session cannot publish a manual detection after its async work', async t => {
  let release;
  const h = await settingsFixture({ detect: () => new Promise(r => { release = r; }) }); t.after(() => h.close());
  const pending = h.post(BASE + '/detect');
  while (!release) await new Promise(r => setImmediate(r));
  await h.post('/api/logout'); release([{ runtime: 'codex', name: 'Codex', found: true, agents: [] }]);
  assert.equal((await pending).status, 401);
  assert.equal(h.store.db.prepare('SELECT value FROM runtime_detection WHERE id=1').get(), undefined);
});

test('corrupt and different-HOME persisted snapshots are unchecked rather than reused', async t => {
  const h = await settingsFixture({ effectiveV3: true }); t.after(() => h.close()); await h.post(BASE + '/detect');
  const { createDetectionState } = require('../../src/settings/detection-state');
  const foreign = createDetectionState({ store: h.store, env: { ...h.env, HOME: path.join(h.tmp, 'different-home') }, detect: () => [] }); t.after(() => foreign.close());
  assert.deepEqual(foreign.rows(), []);
  h.store.db.prepare('UPDATE runtime_detection SET value=? WHERE id=1').run('{"version":1,"scope":"bad","checkedAt":-1,"runtimes":[]}');
  const corrupt = createDetectionState({ store: h.store, env: h.env, detect: () => [] }); t.after(() => corrupt.close());
  assert.deepEqual(corrupt.rows(), []);
});

test('timeout bounds a refresh, keeps one hung source in flight, and ignores late completion', async t => {
  const h = await settingsFixture(); t.after(() => h.close());
  const { createDetectionState } = require('../../src/settings/detection-state');
  let release, calls = 0;
  const state = createDetectionState({ store: h.store, env: h.env, timeoutMs: 20, detect: () => { calls++; return new Promise(r => { release = r; }); } }); t.after(() => state.close());
  await assert.rejects(state.refresh(), /timeout/);
  await assert.rejects(state.refresh(), /timeout/); assert.equal(calls, 1);
  release([{ runtime: 'codex', found: true, agents: [] }]); await new Promise(r => setImmediate(r));
  assert.deepEqual(state.rows(), []); assert.equal(h.store.db.prepare('SELECT value FROM runtime_detection WHERE id=1').get(), undefined);
});

test('automatic read-only-store discovery is visible but never writes the cache', async t => {
  const h = await settingsFixture({ effectiveV3: true, env: { PORTAL_READONLY_STORE: '1' } }); t.after(() => h.close());
  await h.settings.startDetection();
  assert.equal((await getVM(h)).runtimes.find(r => r.id === 'legacy').detection.status, 'detected');
  assert.equal(h.store.db.prepare('SELECT value FROM runtime_detection WHERE id=1').get(), undefined);
  assert.equal((await h.post(BASE + '/detect')).status, 403);
});
