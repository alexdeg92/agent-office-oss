'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHerdrReader, parseSnapshot, HerdrReadError, MAX_AGENTS, MAX_OUTPUT_BYTES, PROCESS_TIMEOUT_MS,
  MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS } = require('../../src/adapters/herdr/reader');

const BASE = Date.UTC(2026, 9, 10);
const config = { hostId: 'host_test_1', orchestratorId: 'orchestrator_test_1', platform: 'linux', label: 'Test host' };
const row = (pane_id, agent_status = 'working', extra = {}) => ({ pane_id, agent: 'codex', name: 'Builder', agent_status,
  agent_session: { kind: 'runtime', agent: 'codex', source: 'fixture', value: `private:${pane_id}` }, cwd: '/private/path', terminal_title: 'private title', ...extra });
const response = agents => Buffer.from(JSON.stringify({ id: 'fixture-request', result: { type: 'agents', agents } }));

test('Herdr fixture envelope maps allowlisted host-agent data to opaque, stable canonical rows', () => {
  const parsed = parseSnapshot(response(['working', 'blocked', 'done', 'idle', 'waiting', 'new-status'].map((status, i) => row(`pane-${i}`, status, { name: '  Agent\u0000  ' }))),
    { ...config, observedAt: BASE });
  assert.equal(parsed.host.sourceStatus, 'available');
  assert.equal(parsed.orchestrator.kind, 'herdr');
  assert.deepEqual(parsed.agents.map(x => x.status), ['working', 'blocked', 'done', 'idle', 'waiting', 'unknown']);
  assert.equal(parsed.agents[0].name, 'Agent');
  assert.match(parsed.agents[0].id, /^ha_[a-f0-9]{32}$/);
  assert.equal(parsed.agents[0].id, parseSnapshot(response([row('pane-0')]), { ...config, observedAt: BASE + 1_000 }).agents[0].id);
  const json = JSON.stringify({ host: parsed.host, orchestrator: parsed.orchestrator, agents: parsed.agents });
  for (const secret of ['/private/path', 'private title', 'private:pane-0', 'pane-0', 'terminal_title']) assert.equal(json.includes(secret), false);
  assert.equal(parsed.privateIdentityRefs.size, 0, 'identity refs are disabled unless source stability is explicitly configured');
});

test('native Claude runtime labels canonicalize to the Claude Code adapter ID', () => {
  const parsed = parseSnapshot(response([row('pane-claude', 'working', { agent: 'claude' })]), { ...config, observedAt: BASE });
  assert.equal(parsed.agents[0].runtimeKind, 'claude-code');
});

test('Herdr stable identity refs remain private and are opt-in', () => {
  const parsed = parseSnapshot(response([row('pane-1')]), { ...config, observedAt: BASE, supportsStableSessionRef: true });
  assert.equal(parsed.privateIdentityRefs.get(parsed.agents[0].id), 'private:pane-1');
  assert.equal(JSON.stringify(parsed.agents).includes('private:pane-1'), false);
});

test('Herdr snapshots are atomic and enforce envelope, row, duplicate, and byte bounds', () => {
  for (const input of ['{bad', Buffer.alloc(MAX_OUTPUT_BYTES + 1)]) {
    assert.throws(() => parseSnapshot(input, { ...config, observedAt: BASE }), HerdrReadError);
  }
  assert.throws(() => parseSnapshot(response(Array.from({ length: MAX_AGENTS + 1 }, (_, i) => row(`p${i}`))), { ...config, observedAt: BASE }),
    e => e.code === 'row_limit');
  assert.throws(() => parseSnapshot(response([row('same'), row('same')]), { ...config, observedAt: BASE }), e => e.code === 'invalid_snapshot');
  assert.throws(() => parseSnapshot(Buffer.from('{"id":"x","result":{"type":"agents","agents":[{}]}}'), { ...config, observedAt: BASE }),
    e => e.code === 'invalid_snapshot');
  assert.throws(() => parseSnapshot(response([{ ...row('x'), agent_status: null }]), { ...config, observedAt: BASE }),
    e => e.code === 'invalid_snapshot');
});

test('reader executes only fixed argv with no shell, bounded process settings, and allowlisted environment', async () => {
  let call;
  const reader = createHerdrReader({ ...config, binaryPath: '/opt/herdr/bin/herdr', env: { HOME: '/fixture/home', PATH: '/fixture/bin', API_TOKEN: 'secret', NODE_OPTIONS: '--require=evil' },
    run: async (...args) => { call = args; return { stdout: response([]) }; }, now: () => BASE });
  const snapshot = await reader.refresh();
  assert.equal(snapshot.host.sourceStatus, 'available');
  assert.equal(call[0], '/opt/herdr/bin/herdr');
  assert.deepEqual(call[1], ['agent', 'list']);
  assert.equal(call[2].shell, false);
  assert.equal(call[2].timeout, PROCESS_TIMEOUT_MS);
  assert.equal(call[2].maxBuffer, MAX_OUTPUT_BYTES);
  assert.deepEqual(call[2].env, { HOME: '/fixture/home', PATH: '/fixture/bin' });
  assert.throws(() => createHerdrReader({ ...config, binaryPath: 'herdr', run: async () => ({ stdout: response([]) }) }),
    e => e.code === 'binary_not_configured');
});

test('reader coalesces concurrent polls, retains a stale bounded snapshot, backs off, then recovers', async () => {
  let time = BASE; let count = 0; let fail = false;
  const reader = createHerdrReader({ ...config, binaryPath: '/fixture/herdr', now: () => time,
    run: async () => { count++; await Promise.resolve(); if (fail) throw Object.assign(new Error('secret/path'), { code: 'EIO' }); return { stdout: response([row('p1')]) }; } });
  const [a, b] = await Promise.all([reader.refresh(), reader.refresh()]);
  assert.equal(count, 1);
  assert.equal(a, b);
  fail = true; time += 1_000;
  const stale = await reader.refresh();
  assert.equal(stale.host.sourceStatus, 'stale');
  assert.equal(stale.agents.length, 1);
  assert.equal(JSON.stringify(stale).includes('secret/path'), false);
  assert.equal((await reader.refresh()).host.sourceStatus, 'stale');
  assert.equal(count, 2, 'backoff suppresses another process call');
  time += 120_000;
  const expired = await reader.refresh();
  assert.equal(expired.host.sourceStatus, 'unavailable');
  assert.equal(expired.agents.length, 0);
  assert.equal(count, 3);
  fail = false; time += 60_000;
  assert.equal((await reader.refresh()).host.sourceStatus, 'available');
});

test('malformed, missing and timed-out sources preserve only the last bounded snapshot without leaking errors', async () => {
  let mode = 'good'; let time = BASE;
  const reader = createHerdrReader({ ...config, binaryPath: '/fixture/herdr', now: () => time,
    run: async () => {
      if (mode === 'missing') throw Object.assign(new Error('/private/bin/herdr'), { code: 'ENOENT' });
      if (mode === 'timeout') throw Object.assign(new Error('secret timeout argv'), { code: 'ETIMEDOUT' });
      if (mode === 'malformed') return { stdout: response([row('good'), {}]) };
      return { stdout: response([row('good')]) };
    } });
  assert.equal((await reader.refresh()).agents.length, 1);
  mode = 'malformed'; time += 2_000;
  const invalid = await reader.refresh();
  assert.equal(invalid.host.sourceStatus, 'stale');
  assert.equal(invalid.agents.length, 1, 'partial rows do not replace the accepted snapshot');
  assert.equal(JSON.stringify(invalid).includes('private/bin'), false);
  mode = 'missing'; time += 2_000;
  assert.equal((await reader.refresh()).host.sourceStatus, 'unavailable');
  assert.equal((await reader.refresh()).agents.length, 1, 'last good rows remain bounded during retention');
  mode = 'timeout'; time += 10_000;
  const timed = await reader.refresh();
  assert.equal(timed.host.sourceStatus, 'stale');
  assert.equal(JSON.stringify(timed).includes('secret timeout'), false);
});

test('disable aborts an in-flight read and cannot publish its late response', async () => {
  let finish; let aborted = false;
  const reader = createHerdrReader({ ...config, binaryPath: '/fixture/herdr', now: () => BASE,
    run: (_bin, _args, options) => new Promise(resolve => {
      options.signal.addEventListener('abort', () => { aborted = true; });
      finish = () => resolve({ stdout: response([row('late')]) });
    }) });
  const pending = reader.refresh();
  await Promise.resolve();
  reader.disable();
  finish();
  const result = await pending;
  assert.equal(aborted, true);
  assert.equal(result.host.sourceStatus, 'unavailable');
  assert.equal(result.agents.length, 0);
  reader.enable();
  assert.equal(reader.enabled, true);
});

test('poll scheduler clamps its interval and stops cleanly on disable', async () => {
  let timer; let interval; let cleared = false; let calls = 0; let published = 0;
  const reader = createHerdrReader({ ...config, binaryPath: '/fixture/herdr', now: () => BASE,
    run: async () => { calls++; return { stdout: response([]) }; },
    setIntervalFn: (fn, ms) => { timer = fn; interval = ms; return { unref() {} }; },
    clearIntervalFn: () => { cleared = true; } });
  assert.equal(reader.start({ intervalMs: 1, onSnapshot: () => { published++; } }), MIN_POLL_INTERVAL_MS);
  await new Promise(setImmediate);
  assert.equal(interval, MIN_POLL_INTERVAL_MS);
  assert.equal(calls, 1);
  assert.equal(published, 1);
  timer();
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  reader.disable();
  assert.equal(cleared, true);
  assert.equal(reader.start({ intervalMs: MAX_POLL_INTERVAL_MS + 1 }), false);
  reader.enable();
  assert.equal(reader.start({ intervalMs: MAX_POLL_INTERVAL_MS + 1 }), MAX_POLL_INTERVAL_MS);
  reader.stop();
});
