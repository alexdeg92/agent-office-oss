'use strict';
// S4.1: review R6 findings R6-05 … R6-13 (design/reports/review-06.md). R6-01…04 are in
// diagnostics-privacy.test.js, fixture-redact.test.js and fixtures-hygiene.test.js.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');

const NOW = Date.UTC(2026, 9, 5, 18);
const row = (key, o) => Object.assign({ key, updatedAt: NOW - 60000, totalTokens: 100 }, o);
const env = (channel, value, extra) => Object.assign({ source: channel.startsWith('cli.') ? 'cli' : channel.startsWith('host') ? 'host' : channel.startsWith('config') ? 'config' : 'gateway',
  channel, receivedAt: NOW, body: { kind: 'json', value } }, extra);
const page = (sessions, o, offset) => env('gw.rpc.sessions.list', Object.assign({ sessions }, o), { context: { offset: offset || 0 } });
const changed = (r) => env('gw.event.sessions.changed', Object.assign({ sessionKey: r.key }, r, { key: undefined }));
const counter = (e) => { const c = { n: 0, types: [] }; e.on('change', (x) => { c.n++; c.types.push(x.type || x.channel); }); return c; };
const job = (o) => Object.assign({ id: 'j', name: 'n', enabled: true, schedule: { kind: 'cron', expr: '0 9 * * 1', tz: 'America/Toronto' } }, o);

describe('R6-05 · activity from the run state only', () => {
  it('a running session is working (run-state); others have no activity', () => {
    let t = NOW;
    const e = createEngine({ now: () => t });
    e.ingest(page([row('agent:main:cron:j', { status: 'active', startedAt: NOW - 5000 }), row('agent:main:subagent:a', { status: 'done' })], { hasMore: false }));
    assert.deepEqual(e.activities(), [{ sessionKey: 'agent:main:cron:j', kind: 'working', source: 'run-state', since: NOW - 5000 }]);
    assert.equal(e.activity('agent:main:subagent:a'), null);
  });
});

describe('R6-06 · canonical LiveEvents', () => {
  it('rows carry required nulls, are coalesced by identity within 10 s (A/B/A), and connection events never merge', () => {
    let t = NOW;
    const e = createEngine({ now: () => t });
    e.ingest(env('gw.event.cron', { jobId: 'a' })); t += 1000;
    e.ingest(env('gw.event.cron', { jobId: 'b' })); t += 1000;
    e.ingest(env('gw.event.cron', { jobId: 'a' }));
    const l = e.liveEvents();
    assert.deepEqual(l.map((x) => [x.cronJobId, x.count]), [['a', 2], ['b', 1]], 'A merged and moved to the top');
    for (const x of l) { assert.equal(x.occupantId, null); assert.equal(x.sessionKey, null); }
    t += 11000; e.ingest(env('gw.event.cron', { jobId: 'a' }));
    assert.equal(e.liveEvents().length, 3, 'outside the window: a new row');
    e.setGatewayConnected(true); e.setGatewayConnected(false); e.setGatewayConnected(true);
    assert.equal(e.liveEvents().filter((x) => x.kind.startsWith('gateway.')).length, 3);
  });

  it('run transitions through sessions.changed become run.started / run.succeeded / run.failed (not on the initial snapshot)', () => {
    let t = NOW;
    const e = createEngine({ now: () => t });
    e.ingest(page([row('agent:main:main', { isMain: true }), row('agent:main:subagent:old', { status: 'active' })], { hasMore: false }));
    assert.deepEqual(e.liveEvents(), [], 'the initial snapshot emits nothing');
    e.ingest(changed(row('agent:main:subagent:x', { status: 'active', startedAt: NOW })));
    t += 2000; e.ingest(changed(row('agent:main:subagent:x', { status: 'done', startedAt: NOW, endedAt: t, updatedAt: t })));
    e.ingest(changed(row('agent:main:subagent:old', { status: 'failed', endedAt: t, updatedAt: t })));
    assert.deepEqual(e.liveEvents().map((x) => [x.kind, x.sessionKey, x.occupantId]), [
      ['run.failed', 'agent:main:subagent:old', 'subagent:old'],
      ['run.succeeded', 'agent:main:subagent:x', 'subagent:x'],
      ['run.started', 'agent:main:subagent:x', 'subagent:x'],
    ]);
  });
});

describe('R6-07 · on-demand reads go through the validated registry (the v2/v3 flow detail since S16)', () => {
  const { openSse } = require('../helpers/sse-client');
  const { waitFor } = require('../helpers/harness');
  const JOB = 'ffffffff-0c01-4000-8000-000000000001';
  let h, mode = 'good', stream;
  const GOOD = { entries: [{ ts: NOW - 1000, runAtMs: NOW - 1000, jobId: JOB, action: 'finished', status: 'ok', summary: 'SYNTHETIC_GOOD_RUN', durationMs: 10 }] };
  before(async () => {
    // a subscribed flow detail is re-read by the live pull (LIVE_PULL_MS, compressed): each mode is really fetched
    h = await startServer(loadScenario('synthetic-basic'), { env: { AO_TIME_SCALE: '50' }, handlers: {
      'cron.runs': () => { if (mode === 'good') return GOOD; if (mode === 'bad') return { entries: {} }; throw new Error('timeout'); },
    } });
    stream = openSse(h.base, '/api/v2/stream?topics=' + encodeURIComponent('flow:' + JOB), { cookie: h.cookie });
    await stream.opened;
  });
  after(async () => { if (stream) stream.close(); if (h) await h.stop(); });

  it('valid → rejected shape → transport failure: every answer is the last good history', async () => {
    const runs = async () => (await h.get('/api/v2/views/flows/' + JOB)).json.data.runs;
    await waitFor(async () => (await runs()).some((r) => r.summary === 'SYNTHETIC_GOOD_RUN'), { what: 'the good history' });
    for (const m of ['bad', 'fail']) {
      const n = h.gw.callsTo('cron.runs').length; mode = m;
      await waitFor(() => h.gw.callsTo('cron.runs').length >= n + 2, { what: m + ' read twice' });
      assert.equal((await runs())[0].summary, 'SYNTHETIC_GOOD_RUN', m);
    }
    const q = (await h.get('/api/v2/views/health')).json.data.dataQuality.issues.map((i) => i.code);
    assert.ok(q.includes('shape.invalid') && q.includes('rpc.failed'), JSON.stringify(q));
  });
});

describe('R6-08 · health, freshness and quarantine changes notify', () => {
  it('a timeout, a degraded event loop and CPU at 95 % each notify; recovery notifies; a quiet repeat does not', () => {
    const e = createEngine({ now: () => NOW });
    e.setGatewayConnected(true);
    const host = (cpuPct) => env('host.metrics', { cpuPct, load1: 1, ncpu: 4, memUsed: 1e9, memTotal: 16e9, disk: { total: 100, used: 10 }, uptimeSec: 10, host: 'h' });
    e.ingest(host(10)); e.ingest(env('gw.rpc.cron.list', { jobs: [job()] }));
    const c = counter(e);
    e.ingest(env('gw.rpc.cron.list', null, { body: { kind: 'error', message: 'timeout' } }));
    assert.equal(c.n, 1, 'cron timeout');
    e.ingest(env('gw.event.health', { ok: true, eventLoop: { degraded: true, delayP99Ms: 900 } }));
    assert.ok(c.n >= 2, 'event loop degraded');
    const before = c.n; e.ingest(host(95));
    assert.ok(c.n > before, 'CPU alert');
    const quiet = c.n; e.ingest(host(96));
    assert.equal(c.n, quiet, 'same level: no traffic');
    e.ingest(env('gw.rpc.cron.list', { jobs: [job()] }));
    assert.ok(c.n > quiet, 'recovery');
    assert.ok(c.types.every((x) => x === 'Health' || x === 'gw.rpc.cron.list'));
  });
});

describe('R6-09 · CronJob delivery channel is a ChannelRef', () => {
  it('wechat → wechat (canonical); last kept; any slug is its own ChannelRef (G3b); a non-slug → unrecognized with a warn issue (no value)', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(env('gw.rpc.cron.list', { jobs: [
      job({ id: 'a', delivery: { mode: 'announce', channel: 'wechat' } }),
      job({ id: 'b', delivery: { mode: 'announce', channel: 'last' } }),
      job({ id: 'c', delivery: { mode: 'announce', channel: 'carrier-pigeon' } }),
      job({ id: 'd', delivery: { mode: 'announce', channel: 'Carrier Pigeon!' } }),
    ] }));
    assert.deepEqual(e.cronJobs().map((j) => j.delivery.channel), ['wechat', 'last', 'carrier-pigeon', 'unrecognized']);
    const i = e.quarantine.list().find((x) => x.path === '$.jobs[].delivery.channel');
    assert.ok(i && i.code === 'enum.unmapped' && i.severity === 'warn');
    assert.ok(!JSON.stringify(e.dataQuality()).includes('Carrier Pigeon'));
  });
});

describe('R6-10 · transcript vocabulary drift', () => {
  it('an unknown part type raises enum.unmapped without its value; metadata parts and known roles do not', () => {
    const e = createEngine({ now: () => NOW });
    const get = (messages) => env('gw.rpc.sessions.get', { messages }, { context: { key: 'agent:main:main' } });
    e.ingest(get([{ role: 'assistant', timestamp: NOW, content: [{ type: 'agent', text: 'meta' }, { type: 'openai_responses_terminal' }, { type: 'text', text: 'ok' }] },
      { role: 'custom', timestamp: NOW, content: 'x' }]));
    assert.deepEqual(e.quarantine.list(), []);
    e.ingest(get([{ role: 'assistant', timestamp: NOW, content: [{ type: 'private-new-type', text: 'Lost message' }] }, { role: 'alien', timestamp: NOW, content: 'y' }]));
    assert.deepEqual(e.quarantine.list().map((i) => `${i.code} ${i.path}`).sort(), ['enum.unmapped $.messages[].content[].type', 'enum.unmapped $.messages[].role']);
    const t = JSON.stringify(e.dataQuality());
    for (const n of ['private-new-type', 'Lost message', 'alien']) assert.ok(!t.includes(n), n);
  });
});

describe('R6-11 · totals across pages', () => {
  it('a total supplied only on the first page is still evidence: contradicted → incomplete, nothing deleted', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(page([row('agent:main:subagent:a'), row('agent:main:subagent:b')], { hasMore: false }));
    e.ingest(page([row('agent:main:subagent:a')], { hasMore: true, nextOffset: 1, totalCount: 3 }, 0));
    e.ingest(page([row('agent:main:subagent:c')], { hasMore: false }, 1));
    assert.deepEqual(e.sessions().map((s) => s.key).sort(), ['agent:main:subagent:a', 'agent:main:subagent:b', 'agent:main:subagent:c']);
    assert.equal(e.sessionsMeta().complete, false);
  });
  it('totals that disagree between pages → incomplete; consistent totals → complete', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(page([row('agent:main:subagent:a')], { hasMore: true, nextOffset: 1, totalCount: 2 }, 0));
    e.ingest(page([row('agent:main:subagent:c')], { hasMore: false, totalCount: 3 }, 1));
    assert.equal(e.sessionsMeta().complete, false);
    e.ingest(page([row('agent:main:subagent:a')], { hasMore: true, nextOffset: 1, totalCount: 2 }, 0));
    e.ingest(page([row('agent:main:subagent:c')], { hasMore: false, totalCount: 2 }, 1));
    assert.equal(e.sessionsMeta().complete, true); assert.equal(e.sessionsMeta().totalCount, 2);
  });
});

describe('R6-12 · identical refreshes produce no change traffic', () => {
  it('sessions list, description, changed event and connection state repeated: no change after the first', () => {
    const e = createEngine({ now: () => NOW });
    e.setGatewayConnected(true);
    const rows = [row('agent:main:main', { isMain: true }), row('agent:main:cron:j', { status: 'done' })];
    e.ingest(page(rows, { hasMore: false }));
    e.ingest(env('gw.rpc.sessions.describe', { session: rows[1] }, { context: { key: rows[1].key } }));
    e.ingest(changed(rows[1]));
    const c = counter(e);
    e.ingest(page(rows, { hasMore: false })); e.ingest(page(rows, { hasMore: false }));
    e.ingest(env('gw.rpc.sessions.describe', { session: rows[1] }, { context: { key: rows[1].key } }));
    e.ingest(changed(rows[1]));
    e.setSourceDown('gateway', false); e.setGatewayConnected(true);
    assert.equal(c.n, 0, c.types.join(','));
  });
});

describe('R6-13 · channel policies do not depend on ingestion order', () => {
  const status = { channelOrder: ['discord'], channels: { discord: { configured: true, running: true, connected: true } } };
  const config = (dmPolicy) => env('config.openclaw', { channels: { discord: { dmPolicy, groupPolicy: 'allowlist', token: 'x' } } });
  it('status then config, config then status, and a policy edit with an unchanged status', () => {
    const a = createEngine({ now: () => NOW });
    a.ingest(env('gw.rpc.channels.status', status)); a.ingest(config('pairing'));
    const b = createEngine({ now: () => NOW });
    b.ingest(config('pairing')); b.ingest(env('gw.rpc.channels.status', status));
    assert.equal(a.channels()[0].policy.dm, 'pairing'); assert.deepEqual(a.channels(), b.channels());
    a.ingest(config('open'));
    assert.equal(a.channels()[0].policy.dm, 'open');
  });
});

describe('2.1 · Session.cwd and messageCount (PM)', () => {
  it('cwd: workspaceDir, else spawnedCwd; normalised; non-absolute or control characters → null', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(page([
      row('agent:main:subagent:a', { workspaceDir: '/home/x/dev/proj/./sub/../app/', spawnedCwd: '/elsewhere', messageCount: 12 }),
      row('agent:main:subagent:b', { spawnedCwd: '/srv/b' }),
      row('agent:main:subagent:c', { workspaceDir: 'relative/path' }),
      row('agent:main:subagent:f', { messageCount: -1 }),
      row('agent:main:subagent:d', { workspaceDir: '/bad\u0000dir' }),
      row('agent:main:subagent:e'),
    ], { hasMore: false }));
    const get = (k) => e.session('agent:main:subagent:' + k);
    assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map((k) => [get(k).cwd, get(k).messageCount]),
      [['/home/x/dev/proj/app', 12], ['/srv/b', null], [null, null], [null, null], [null, null]]);
    assert.equal(get('f'), null, 'a negative count fails the row schema: the row is dropped');
    assert.ok(e.quarantine.list().some((i) => i.path === '$.sessions[].messageCount' && i.code === 'shape.invalid'));
  });
});
