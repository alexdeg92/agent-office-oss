'use strict';
// S3.1 behaviour tests for R2-02 … R2-08 (see design/reports/review-02.md).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { runStateOf } = require('../../src/adapters/openclaw/normalise/session');
const { classifySession } = require('../../src/adapters/openclaw/classify/session-kind');
const { deriveOccupants } = require('../../src/engine/derive/occupants');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');

const NOW = Date.UTC(2026, 9, 5, 18);
const row = (key, o) => Object.assign({ key, updatedAt: NOW - 60000, totalTokens: 100 }, o);
const page = (sessions, o, offset) => ({ source: 'gateway', channel: 'gw.rpc.sessions.list', receivedAt: NOW, context: { offset: offset || 0 }, body: { kind: 'json', value: Object.assign({ sessions }, o) } });
const fail = (offset) => ({ source: 'gateway', channel: 'gw.rpc.sessions.list', receivedAt: NOW, context: { offset }, body: { kind: 'error', message: 'timeout' } });
const describeEnv = (r) => ({ source: 'gateway', channel: 'gw.rpc.sessions.describe', receivedAt: NOW, context: { key: r.key }, body: { kind: 'json', value: { session: r } } });
const keys = (e) => e.sessions().map((s) => s.key);

describe('R2-02 paginated snapshots', () => {
  const many = (n, from = 0) => Array.from({ length: n }, (_, i) => row(`agent:main:subagent:s${from + i}`, { status: 'done' }));

  it('a snapshot spanning pages admits every page; >300 sessions', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(page(many(300), { hasMore: true, nextOffset: 300, totalCount: 301 }, 0));
    e.ingest(page([row('agent:main:subagent:late', { status: 'active' })], { hasMore: false, totalCount: 301 }, 300));
    assert.equal(e.sessions().length, 301);
    assert.equal(e.session('agent:main:subagent:late').run.status, 'running');
    assert.deepEqual(e.sessionsMeta().complete, true);
  });

  it('a failing second page deletes nothing', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(page([row('agent:main:main'), row('agent:main:cron:a')], { hasMore: false }));
    e.ingest(page([row('agent:main:main')], { hasMore: true, nextOffset: 1 }, 0));
    e.ingest(fail(1));
    e.ingest(page([], { hasMore: false }, 1));       // a late page of a broken run must not complete it
    assert.deepEqual(keys(e).sort(), ['agent:main:cron:a', 'agent:main:main']);
  });

  it('two consecutive partial refreshes delete nothing', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(page([row('agent:main:main'), row('agent:main:cron:a')], { hasMore: false }));
    for (let i = 0; i < 2; i++) e.ingest(page([row('agent:main:main')], { hasMore: true, nextOffset: 1 }, 0));
    assert.deepEqual(keys(e).sort(), ['agent:main:cron:a', 'agent:main:main']);
  });

  it('changed ordering across a complete snapshot keeps everything listed, in the new order', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(page([row('agent:main:cron:a'), row('agent:main:cron:b')], { hasMore: true, nextOffset: 2 }, 0));
    e.ingest(page([row('agent:main:cron:c')], { hasMore: false }, 2));
    e.ingest(page([row('agent:main:cron:c'), row('agent:main:cron:a')], { hasMore: true, nextOffset: 2 }, 0));
    e.ingest(page([row('agent:main:cron:b')], { hasMore: false }, 2));
    assert.deepEqual(keys(e), ['agent:main:cron:c', 'agent:main:cron:a', 'agent:main:cron:b']);
  });

  it('an out-of-order page or a stalled walk invalidates the run', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(page([row('agent:main:main'), row('agent:main:cron:a')], { hasMore: false }));
    e.ingest(page([row('agent:main:main')], { hasMore: true, nextOffset: 1 }, 0));
    e.ingest(page([], { hasMore: false }, 5));          // wrong offset
    assert.ok(keys(e).includes('agent:main:cron:a'));
    e.ingest(page([row('agent:main:main')], { hasMore: true, nextOffset: 1 }, 0));
    e.ingest(page([row('agent:main:main')], { hasMore: true, nextOffset: 2 }, 1));   // no new keys: stalled
    e.ingest(page([], { hasMore: false }, 2));
    assert.ok(keys(e).includes('agent:main:cron:a'));
  });

  it('the portal walks every page (FakeGateway end to end)', async () => {
    const all = many(301);
    const h = await startServer(loadScenario('synthetic-basic'), { handlers: {
      'sessions.list': (p) => { const off = p.offset || 0; const sl = all.slice(off, off + 300); return { sessions: sl, totalCount: all.length, hasMore: off + 300 < all.length, nextOffset: off + 300 < all.length ? off + 300 : null }; },
    } });
    try {
      const ids = []; let cursor = null;   // every page of the v3 logs view (v1's /api/logs before S16)
      do {
        const page = (await h.get('/api/v3/views/logs?limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))).json.data;
        ids.push(...page.items.map((x) => x.id)); cursor = page.nextCursor;
      } while (cursor);
      assert.equal(new Set(ids).size, 301);
      assert.deepEqual(h.gw.callsTo('sessions.list').slice(0, 2).map((c) => c.params.offset || 0), [0, 300]);
    } finally { await h.stop(); }
  });
});

describe('R2-03 enum lookups', () => {
  const PROTO = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];
  it('prototype-named statuses are unmapped (reported), never inherited', () => {
    for (const p of PROTO) {
      const r = runStateOf({ status: p });
      assert.equal(r.unmappedStatus, p); assert.ok(['idle', 'running'].includes(r.run.status), p);
    }
  });
  it('an unknown status is reported even when an active flag decides the state', () => {
    for (const flag of ['hasActiveRun', 'hasActiveSubagentRun']) {
      const r = runStateOf({ status: 'paused', [flag]: true });
      assert.equal(r.run.status, 'running'); assert.equal(r.unmappedStatus, 'paused');
    }
  });
});

describe('R2-04 structured fallbacks and heartbeats', () => {
  it('two role-only sub-agents keep distinct identities, also in the office (v1 summary before S16)', async () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(page([row('agent:main:spawned:a', { subagentRole: 'worker', status: 'active' }), row('agent:main:spawned:b', { subagentRole: 'worker', status: 'active' })], { hasMore: false }));
    const ids = e.sessions().map((s) => s.class.subagentId);
    assert.deepEqual(ids, ['spawned:a', 'spawned:b']);
    const h = await startServer(loadScenario('synthetic-basic'), { handlers: {
      'sessions.list': { sessions: [row('agent:main:main', { isMain: true }), row('agent:main:spawned:a', { subagentRole: 'worker', status: 'active' }), row('agent:main:spawned:b', { subagentRole: 'worker', status: 'active' })], hasMore: false },
    } });
    try {
      const occupants = (await h.get('/api/v3/views/office')).json.data.occupants;
      assert.equal(occupants.filter((o) => o.id.startsWith('subagent:')).length, 2, JSON.stringify(occupants.map((o) => o.id)));
    } finally { await h.stop(); }
  });

  it("a heartbeat uses its base's structured evidence, in either list order", () => {
    for (const order of [0, 1]) {
      const rows = [row('agent:main:spawned:a', { subagentRole: 'worker' }), row('agent:main:spawned:a:heartbeat', { isMain: true })];
      if (order) rows.reverse();
      const e = createEngine({ now: () => NOW });
      e.ingest(page(rows, { hasMore: false }));
      const hb = e.session('agent:main:spawned:a:heartbeat');
      assert.equal(hb.class.kind, 'subagent'); assert.equal(hb.class.heartbeatOf, 'agent:main:spawned:a');
      assert.ok(!e.quarantine.list().some((i) => i.code === 'session.unclassified'));
    }
    assert.equal(classifySession('agent:main:spawned:a:heartbeat', { isMain: true }).kind, 'unrecognized', 'own isMain is never used');
  });
});

describe('R2-05 descriptions merge into the canonical session', () => {
  it('list then describe; later list refresh keeps the described name', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(page([row('agent:main:main', { isMain: true })], { hasMore: false }));
    e.ingest(describeEnv(row('agent:main:main', { displayName: 'Nom décrit', status: 'active' })));
    assert.equal(e.session('agent:main:main').displayName, 'Nom décrit');
    assert.equal(e.session('agent:main:main').run.status, 'running');
    e.ingest(page([row('agent:main:main', { isMain: true, status: 'done' })], { hasMore: false }));
    assert.equal(e.session('agent:main:main').displayName, 'Nom décrit');
    assert.equal(e.session('agent:main:main').run.status, 'succeeded', 'the newer list wins where it has a value');
  });

  it('describe before list is applied when the session appears; partial descriptions only fill gaps', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(describeEnv({ key: 'agent:main:cron:j', displayName: 'Veille' }));
    assert.equal(e.session('agent:main:cron:j'), null);
    e.ingest(page([row('agent:main:cron:j', { totalTokens: 7 })], { hasMore: false }));
    const s = e.session('agent:main:cron:j');
    assert.equal(s.displayName, 'Veille'); assert.equal(s.usage.total, 7);
  });
});

describe('R2-07 canonical contract', () => {
  it('negative counts are rejected at the door; provider-only model; typed goal; wechat', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(page([
      row('agent:main:cron:neg', { totalTokens: -5 }),
      row('agent:main:cron:prov', { modelProvider: 'openai' }),
      row('agent:main:cron:goal', { goal: { objective: 'Finir', status: 'active', tokensUsed: 10, tokenBudget: null, id: 'g1' } }),
      row('agent:main:wechat:group:x'),
    ], { hasMore: false }));
    assert.equal(e.session('agent:main:cron:neg'), null);
    assert.ok(e.quarantine.list().some((i) => i.code === 'shape.invalid' && i.path === '$.sessions[].totalTokens'));
    const p = e.session('agent:main:cron:prov'); assert.equal(p.model, null); assert.equal(p.provider, 'openai');
    assert.deepEqual(e.session('agent:main:cron:goal').goal, { objective: 'Finir', status: 'active', tokensUsed: 10, tokenBudget: null });
    assert.equal(e.session('agent:main:wechat:group:x').class.channel, 'wechat');
  });
});

describe('R2-08 occupants', () => {
  const mk = (rows) => { const e = createEngine({ now: () => NOW }); e.ingest(page(rows, { hasMore: false })); return e.sessions(); };
  const states = (o) => o.map((x) => `${x.id.split(':')[0]}/${x.state}`);

  it('a recently failed sub-agent stays on stage in error, with or without prior activity', () => {
    const rows = [row('agent:main:main', { isMain: true }), row('agent:main:subagent:x', { status: 'failed', endedAt: NOW - 1000 })];
    assert.deepEqual(states(deriveOccupants({ sessions: mk(rows), gwConnected: true, now: NOW })), ['primary/idle', 'subagent/error']);
    assert.deepEqual(states(deriveOccupants({ sessions: mk(rows), activityFor: (k) => (k.includes('subagent') ? 'calling' : null), gwConnected: true, now: NOW })), ['primary/idle', 'subagent/error']);
    assert.deepEqual(states(deriveOccupants({ sessions: mk(rows), gwConnected: true, now: NOW + 120000 })), ['primary/idle'], 'gone after the window');
  });

  it('a recently failed main session is in error', () => {
    const o = deriveOccupants({ sessions: mk([row('agent:main:main', { isMain: true, status: 'timeout', endedAt: NOW - 500 })]), gwConnected: true, now: NOW });
    assert.deepEqual(states(o), ['primary/error']);
  });

  it('a dashboard as the only active session drives the main agent', () => {
    const s = mk([row('agent:main:main', { isMain: true }), row('agent:main:dashboard:d', { status: 'active' })]);
    assert.deepEqual(states(deriveOccupants({ sessions: s, gwConnected: true, now: NOW })), ['primary/working']);
    assert.deepEqual(states(deriveOccupants({ sessions: s, activityFor: (k) => (k.endsWith(':d') ? 'writing' : null), gwConnected: true, now: NOW })), ['primary/writing']);
  });
});

describe('R5 residuals', () => {
  it('Residual C: a page set with dropped rows is not deletion evidence', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(page([row('agent:main:cron:a'), row('agent:main:cron:b')], { hasMore: false, totalCount: 2 }));
    e.ingest(page([row('agent:main:cron:a')], { hasMore: true, nextOffset: 1, totalCount: 2 }, 0));
    e.ingest(page([row('agent:main:cron:b', { totalTokens: -5 })], { hasMore: false, totalCount: 2 }, 1));
    assert.deepEqual(keys(e).sort(), ['agent:main:cron:a', 'agent:main:cron:b']);
    assert.equal(e.session('agent:main:cron:b').usage.total, 100, 'last good value kept');
    assert.equal(e.sessionsMeta().complete, false);
  });

  it('Residual C: a totalCount that contradicts the rows received is not deletion evidence', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(page([row('agent:main:cron:a'), row('agent:main:cron:b'), row('agent:main:cron:c')], { hasMore: false, totalCount: 3 }));
    e.ingest(page([row('agent:main:cron:a'), row('agent:main:cron:c')], { hasMore: false, totalCount: 3 }));
    assert.ok(keys(e).includes('agent:main:cron:b'));
    e.ingest(page([row('agent:main:cron:a'), row('agent:main:cron:c')], { hasMore: false, totalCount: 2 }));
    assert.ok(!keys(e).includes('agent:main:cron:b'), 'a consistent snapshot does delete');
  });

  it('Residual D: a newer terminal observation clears older active-run flags, in both source orders', () => {
    const a = createEngine({ now: () => NOW });
    a.ingest(page([row('agent:main:cron:a', { hasActiveRun: true, status: 'active' })], { hasMore: false }));
    a.ingest(describeEnv(row('agent:main:cron:a', { status: 'done', endedAt: NOW })));
    assert.equal(a.session('agent:main:cron:a').run.status, 'succeeded');
    const b = createEngine({ now: () => NOW });
    b.ingest(describeEnv(row('agent:main:cron:a', { hasActiveRun: true, status: 'active' })));
    b.ingest(page([row('agent:main:cron:a', { hasActiveRun: true, status: 'active' })], { hasMore: false }));
    b.ingest(page([row('agent:main:cron:a', { status: 'done', endedAt: NOW })], { hasMore: false }));
    assert.equal(b.session('agent:main:cron:a').run.status, 'succeeded');
  });

  it('Residual D: within ONE observation the gateway flag still has priority', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(page([row('agent:main:cron:a', { hasActiveRun: true, status: 'done' })], { hasMore: false }));
    assert.equal(e.session('agent:main:cron:a').run.status, 'running');
    assert.equal(e.session('agent:main:cron:a').run.evidence, 'gateway-flag');
  });
});
