'use strict';
require('./scratch-home.cjs').requireScratchHome(__filename);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)
// Each regression owns a child process and a scratch HOME. A broken synchronous
// reader can only hang this child; the parent test kills it after three seconds.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const mode = process.argv[2], home = process.env.HOME;
const configPath = path.join(home, '.openclaw', 'openclaw.json'), workspace = path.join(home, 'workspace');
fs.mkdirSync(path.dirname(configPath), { recursive: true }); fs.mkdirSync(workspace);
fs.writeFileSync(configPath, JSON.stringify({ agents: { list: [{ id: 'atlas', workspace }] } }));
const identity = path.join(workspace, 'IDENTITY.md');
if (mode === 'fifo') execFileSync('/usr/bin/mkfifo', [identity]);
if (mode === 'replacement') {
  fs.writeFileSync(identity, 'Name: Before');
  const original = fs.openSync;
  fs.openSync = function(file, ...args) {
    if (file === identity) { fs.unlinkSync(identity); execFileSync('/usr/bin/mkfifo', [identity]); }
    return original.call(fs, file, ...args);
  };
}
if (mode === 'agents') fs.writeFileSync(configPath, JSON.stringify({ agents: { list: Array.from({ length: 1025 }, (_, i) => ({ id: 'agent' + i, workspace })) } }));
if (mode === 'bytes') {
  const list = Array.from({ length: 9 }, (_, i) => ({ id: 'agent' + i, workspace: path.join(home, 'workspace' + i) }));
  for (const a of list) { fs.mkdirSync(a.workspace); fs.writeFileSync(path.join(a.workspace, 'IDENTITY.md'), 'x'.repeat(1024 * 1024)); }
  fs.writeFileSync(configPath, JSON.stringify({ agents: { list } }));
}
if (process.env.T0027_DISCOVERY_BASE) {
  const Module = require('node:module');
  for (const relative of ['src/ops/local-files.js', 'src/adapters/detection.js']) {
    const file = path.resolve(relative), m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
    m._compile(execFileSync('/usr/bin/git', ['show', process.env.T0027_DISCOVERY_BASE + ':' + relative], { encoding: 'utf8' }), file); m.loaded = true; require.cache[file] = m;
  }
}
const workers = [];
if (['deadline', 'close'].includes(mode)) {
  const threads = require('node:worker_threads'), Original = threads.Worker;
  const blocked = path.join(home, 'blocked-worker.cjs');
  fs.writeFileSync(blocked, "const {parentPort}=require('node:worker_threads');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);parentPort.postMessage({rows:[{runtime:'codex',found:false,agents:[]}]});");
  threads.Worker = class extends Original { constructor(file, options) { super(blocked, options); workers.push(this); } };
}
const { detectRuntimes } = require('../../src/adapters/detection');
const { createDetectionState } = require('../../src/settings/detection-state');
async function main() {
  if (mode === 'replacement') {
    assert.equal(require('../../src/ops/local-files').read(identity, { HOME: home, AO_ENV: 'test', PATH: '' }), null);
    console.log(JSON.stringify({ mode, refused: true })); return;
  }
  const store = require('../../src/store').openStore({ dir: path.join(home, 'store'), instance: 'test', ownerName: 'Fixture', log: () => {} });
  const timeoutMs = ['deadline', 'close'].includes(mode) ? 150 : 1500;
  let actual = false, published = 0;
  const state = createDetectionState({ store, env: { HOME: home, PATH: '', AO_ENV: 'test', OC_CONFIG: configPath }, timeoutMs,
    detect: ctx => actual ? detectRuntimes({ ...ctx, timeoutMs }) : [{ runtime: 'codex', found: true, confidence: 'presence', agents: [] }], changed: () => published++ });
  const server = require('node:http').createServer((req, res) => res.end('responsive'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let ticks = 0; const heartbeat = setInterval(() => ticks++, 10);
  try {
    await state.refresh(); const prior = store.db.prepare('SELECT value FROM runtime_detection WHERE id=1').get().value;
    actual = true; const started = Date.now(), pending = state.refresh();
    // Attach rejection immediately; cancellation may happen before HTTP completes.
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    if (mode === 'close') setTimeout(() => state.close(), 40);
    const response = await fetch('http://127.0.0.1:' + server.address().port);
    assert.equal(await response.text(), 'responsive');
    const result = await outcome;
    assert.ok(Date.now() - started < 2000, 'discovery is bounded while HTTP remains responsive');
    if (mode === 'fifo') {
      assert.ifError(result.error); assert.equal(result.value.runtimes.find(r => r.runtime === 'openclaw').agents[0].name, null);
    } else {
      assert.ok(result.error, 'failed/cancelled pass must reject');
      if (mode === 'deadline') { assert.match(result.error.message, /timeout|cancelled/); assert.ok(ticks >= 3, 'HTTP thread heartbeat continues during blocked worker'); }
      if (['agents', 'bytes'].includes(mode)) assert.equal(result.error.code, 'EDETECTIONLIMIT');
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(store.db.prepare('SELECT value FROM runtime_detection WHERE id=1').get().value, prior, 'no late or partial cache publication');
      assert.equal(published, 1); assert.ok(workers.every(w => w.threadId === -1), 'cancelled worker is terminated');
    }
    console.log(JSON.stringify({ mode, ticks, elapsedMs: Date.now() - started, published }));
  } finally {
    clearInterval(heartbeat); state.close(); await new Promise(resolve => server.close(resolve)); store.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
