'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionsRegistry } = require('../../src/engine/sessions-registry');
const { createEngine } = require('../../src/engine');
const { EventEmitter } = require('node:events');
const { tapGateway } = require('../../src/adapters/openclaw/taps');
const { bind } = require('../../src/adapters/openclaw/reads');
const NOW = Date.UTC(2026, 9, 11);

const session = (status, lastRunId, updatedAt) => ({
  key: 'rt:primary:conversation:test', sessionId: 'conversation-test',
  class: { kind: 'conversation', ruleId: 'test', agentId: 'primary', channel: null, heartbeatOf: null,
    background: false, rawClassification: null },
  displayName: null, model: null, provider: null, usage: { total: 0, input: null, output: null }, updatedAt,
  run: { status, endReason: status === 'failed' ? 'error' : null, evidence: 'status-field', startedAt: updatedAt - 10,
    endedAt: status === 'running' ? null : updatedAt, hasActiveSubagentRun: false, runtimeMs: null, lastRunId, lastError: null },
  costUsd: null, parentKey: null, childKeys: [], goal: null, cwd: null, messageCount: null, interactive: true, group: null,
});

function registry() {
  return createSessionsRegistry({ now: () => NOW, normalise: () => { throw new Error('canonical input expected'); }, classify: () => ({ kind: 'unrecognized' }) });
}

describe('session lifecycle source ordering', () => {
  it('does not let an older snapshot revive a terminal observation for the same run', () => {
    const r = registry(), rec = () => {};
    const other = session('idle', null, NOW - 200); other.key = 'rt:primary:conversation:other';
    r.acceptPage({ sessions: [session('running', 'run-a', NOW - 200), other], hasMore: false, totalCount: 2 }, 0, rec,
      { canonical: true, acquisitionGeneration: 10 });
    r.acceptChanged(session('succeeded', 'run-a', NOW - 100), rec, { canonical: true, sourceOrder: 11 });

    // The response belongs to a request acquired before the terminal change. Its wall-clock
    // timestamp is deliberately later to prove timestamps cannot act as an ordering token.
    r.acceptPage({ sessions: [session('running', 'run-a', NOW + 900)], hasMore: false, totalCount: 1 }, 0, rec,
      { canonical: true, acquisitionGeneration: 10 });
    // Even a later poll cannot revive a run whose identity is already terminal.
    assert.equal(r.get('rt:primary:conversation:test').run.status, 'succeeded');
    assert.equal(r.get('rt:primary:conversation:test').run.lastRunId, 'run-a');
    assert.ok(r.get('rt:primary:conversation:other'), 'an older complete snapshot cannot delete a session absent from it');
    const later = session('running', 'run-a', NOW + 1000); later.usage.total = 5;
    r.acceptPage({ sessions: [later], hasMore: false, totalCount: 1 }, 0, rec,
      { canonical: true, acquisitionGeneration: 12 });
    assert.equal(r.get('rt:primary:conversation:test').run.status, 'succeeded');
    assert.equal(r.get('rt:primary:conversation:test').usage.total, 5, 'fresh non-lifecycle fields still update');
  });

  it('threads acquisition order through gateway page and changed-event ingestion', () => {
    const e = createEngine({ now: () => NOW });
    const key = 'agent:main:main';
    const page = (status, updatedAt, generation) => ({ source: 'gateway', channel: 'gw.rpc.sessions.list', receivedAt: NOW,
      context: { offset: 0, acquisitionGeneration: generation, sourceOrder: generation + 1 },
      body: { kind: 'json', value: { hasMore: false, sessions: [{ key, isMain: true, status, hasActiveRun: status === 'active',
        lastRunId: 'run-a', startedAt: NOW, endedAt: status === 'active' ? null : updatedAt, updatedAt }] } } });
    e.ingest(page('active', NOW, 10));
    e.ingest({ source: 'gateway', channel: 'gw.event.sessions.changed', receivedAt: NOW,
      context: { sourceOrder: 12 }, body: { kind: 'json', value: { sessionKey: key, runId: 'run-a', status: 'done',
        startedAt: NOW, endedAt: NOW + 1, updatedAt: NOW + 1, totalTokens: 0 } } });
    e.ingest(page('active', NOW + 900, 10));

    assert.equal(e.session(key).run.status, 'succeeded');
    assert.equal(e.session(key).run.lastRunId, 'run-a');
  });

  it('keeps independent descriptions ordered per session and does not let them fence snapshot discovery', async () => {
    const e = createEngine({ now: () => NOW });
    const gw = new EventEmitter(), pending = [];
    gw.call = (method, params) => new Promise(resolve => pending.push({ method, params, resolve }));
    tapGateway(gw, e);
    e.setReads(bind({ gw, cli: {} }));
    const keyA = 'agent:main:main', keyB = 'agent:main:cron:synthetic', keyC = 'agent:main:subagent:synthetic';
    const raw = (key, displayName) => ({ key, isMain: key === keyA, status: 'idle', updatedAt: NOW, totalTokens: 1, displayName });
    const seed = gw.call('sessions.list', {}), seedCall = pending.shift();
    seedCall.resolve({ sessions: [raw(keyA, 'old A'), raw(keyB, 'old B')], hasMore: false });
    await seed;

    const describeA = e.request('describeSession', keyA), callA = pending.shift();
    const describeB = e.request('describeSession', keyB), callB = pending.shift();
    callB.resolve({ session: raw(keyB, 'fresh B') });
    await describeB;
    callA.resolve({ session: raw(keyA, 'fresh A') });
    assert.equal((await describeA).ok, true);
    assert.equal(e.session(keyA).displayName, 'fresh A');

    const scan = gw.call('sessions.list', {}), scanCall = pending.shift();
    const laterB = e.request('describeSession', keyB), laterBCall = pending.shift();
    laterBCall.resolve({ session: raw(keyB, 'newer B') });
    await laterB;
    scanCall.resolve({ sessions: [raw(keyA, 'scanned A'), raw(keyB, 'scanned B'), raw(keyC, 'new C')], hasMore: false });
    await scan;
    assert.ok(e.session(keyC), 'an unrelated description must not prevent complete snapshot discovery');
    assert.equal(e.session(keyA).displayName, 'scanned A');
    assert.equal(e.session(keyB).displayName, 'newer B', 'older list acquisition cannot overwrite a newer description for the same key');
  });

  it('does not delete a session described after a snapshot began when that snapshot omits it', async () => {
    const e = createEngine({ now: () => NOW });
    const gw = new EventEmitter(), pending = [];
    gw.call = (method, params) => new Promise(resolve => pending.push({ method, params, resolve }));
    tapGateway(gw, e);
    e.setReads(bind({ gw, cli: {} }));
    const keyA = 'agent:main:main', keyB = 'agent:main:cron:synthetic';
    const raw = (key, displayName) => ({ key, isMain: key === keyA, status: 'idle', updatedAt: NOW, totalTokens: 1, displayName });
    const seed = gw.call('sessions.list', {}), seedCall = pending.shift();
    seedCall.resolve({ sessions: [raw(keyA, 'A'), raw(keyB, 'B')], hasMore: false });
    await seed;

    const scan = gw.call('sessions.list', {}), scanCall = pending.shift();
    const description = e.request('describeSession', keyA), descriptionCall = pending.shift();
    descriptionCall.resolve({ session: raw(keyA, 'Fresh A') });
    assert.equal((await description).ok, true);
    scanCall.resolve({ sessions: [raw(keyB, 'B')], hasMore: false });
    await scan;
    assert.equal(e.session(keyA).displayName, 'Fresh A');
    assert.equal(e.sessions().length, 2, 'an older absence cannot delete a newer per-key observation');
  });

  it('ignores a stale continuation without invalidating the newer in-flight snapshot', () => {
    const r = registry(), rec = () => {};
    const removed = session('idle', null, NOW - 1), a = session('idle', null, NOW), b = session('idle', null, NOW + 1), c = session('idle', null, NOW + 2);
    removed.key = 'rt:primary:conversation:removed'; a.key = 'rt:primary:conversation:a'; b.key = 'rt:primary:conversation:b'; c.key = 'rt:primary:conversation:c';
    r.acceptPage({ sessions: [removed], hasMore: false, totalCount: 1 }, 0, rec, { canonical: true, acquisitionGeneration: 5 });
    r.acceptPage({ sessions: [a], hasMore: true, nextOffset: 1 }, 0, rec, { canonical: true, acquisitionGeneration: 10 });
    r.acceptPage({ sessions: [b], hasMore: true, nextOffset: 1 }, 0, rec, { canonical: true, acquisitionGeneration: 20 });
    r.acceptPage({ sessions: [a], hasMore: false }, 0, rec, { canonical: true, acquisitionGeneration: 10 });
    r.acceptPage({ sessions: [c], hasMore: false }, 1, rec, { canonical: true, acquisitionGeneration: 10 });
    r.acceptPage({ sessions: [c], hasMore: false }, 1, rec, { canonical: true, acquisitionGeneration: 20 });
    assert.equal(r.meta().complete, true);
    assert.equal(r.meta().totalCount, 2);
    assert.equal(r.get(removed.key), null, 'the completed newer snapshot reconciles absent sessions');
    assert.deepEqual(new Set(r.list().map(row => row.key)), new Set([b.key, c.key]));
  });

  it('does not infer a new run when a terminal run id is omitted but start time matches', () => {
    const r = registry(), rec = () => {};
    const terminal = session('succeeded', 'run-a', NOW - 100);
    r.acceptChanged(terminal, rec, { canonical: true, sourceOrder: 11 });
    const active = session('running', null, NOW + 100);
    active.run.startedAt = terminal.run.startedAt;
    active.run.endedAt = null;
    r.acceptPage({ sessions: [active], hasMore: false, totalCount: 1 }, 0, rec, { canonical: true, acquisitionGeneration: 12 });
    assert.equal(r.get(terminal.key).run.status, 'succeeded');
    assert.equal(r.get(terminal.key).run.lastRunId, 'run-a');
  });

  it('admits a genuinely new run after the prior run becomes terminal', () => {
    const r = registry(), rec = () => {};
    r.acceptChanged(session('failed', 'run-a', NOW - 100), rec, { canonical: true, sourceOrder: 11 });
    r.acceptPage({ sessions: [session('running', 'run-b', NOW - 200)], hasMore: false, totalCount: 1 }, 0, rec,
      { canonical: true, acquisitionGeneration: 12 });

    assert.equal(r.get('rt:primary:conversation:test').run.status, 'running');
    assert.equal(r.get('rt:primary:conversation:test').run.lastRunId, 'run-b');
  });

  it('emits a start for a new run id even when the session remains running', () => {
    const e = createEngine({ now: () => NOW });
    const page = lastRunId => ({ source: 'gateway', channel: 'gw.rpc.sessions.list', receivedAt: NOW,
      context: { offset: 0, acquisitionGeneration: lastRunId === 'run-a' ? 10 : 12, sourceOrder: lastRunId === 'run-a' ? 10 : 12 },
      body: { kind: 'json', value: { hasMore: false, sessions: [{ key: 'agent:main:main', isMain: true, status: 'active', lastRunId, startedAt: NOW }] } } });
    e.ingest(page('run-a'));
    e.ingest(page('run-b'));

    assert.equal(e.liveEvents().filter(event => event.kind === 'run.started').length, 1);
    assert.equal(e.session('agent:main:main').run.lastRunId, 'run-b');
  });

  it('does not emit duplicate run starts when the id is omitted and restored at the same start time', () => {
    const e = createEngine({ now: () => NOW }), key = 'agent:main:main';
    const page = (lastRunId, generation) => ({ source: 'gateway', channel: 'gw.rpc.sessions.list', receivedAt: NOW,
      context: { offset: 0, acquisitionGeneration: generation, sourceOrder: generation },
      body: { kind: 'json', value: { hasMore: false, sessions: [{ key, isMain: true, status: 'active', lastRunId, startedAt: NOW }] } } });
    e.ingest(page('run-a', 10));
    e.ingest(page(null, 12));
    e.ingest(page('run-a', 14));
    assert.equal(e.liveEvents().filter(event => event.kind === 'run.started').length, 0);

    const noIdFirst = createEngine({ now: () => NOW });
    noIdFirst.ingest(page(null, 20));
    noIdFirst.ingest(page('run-a', 22));
    assert.equal(noIdFirst.liveEvents().filter(event => event.kind === 'run.started').length, 0);

    const distinctAfterGap = createEngine({ now: () => NOW });
    distinctAfterGap.ingest(page('run-a', 30));
    distinctAfterGap.ingest(page(null, 32));
    distinctAfterGap.ingest(page('run-b', 34));
    const starts = distinctAfterGap.liveEvents().filter(event => event.kind === 'run.started');
    assert.equal(starts.reduce((sum, event) => sum + event.count, 0), 1, 'a different run id remains distinguishable across a missing-id observation');
  });

  it('keeps canonical run identity across an ID-less terminal row so a later run is admitted', () => {
    const e = createEngine({ now: () => NOW }), key = 'agent:main:main';
    const page = (status, lastRunId, generation, startedAt = NOW) => ({ source: 'gateway', channel: 'gw.rpc.sessions.list', receivedAt: NOW,
      context: { offset: 0, acquisitionGeneration: generation, sourceOrder: generation },
      body: { kind: 'json', value: { hasMore: false, sessions: [{ key, isMain: true, status, lastRunId, startedAt, endedAt: status === 'done' ? NOW + 1 : null }] } } });
    e.ingest(page('active', 'run-a', 10));
    e.ingest(page('active', null, 12));
    e.ingest(page('done', null, 14));
    assert.equal(e.session(key).run.lastRunId, 'run-a');
    e.ingest(page('active', 'run-b', 16));
    assert.equal(e.session(key).run.status, 'running');
    assert.equal(e.session(key).run.lastRunId, 'run-b');
    assert.equal(e.liveEvents().filter(event => event.kind === 'run.started').reduce((sum, event) => sum + event.count, 0), 1);
  });
});
