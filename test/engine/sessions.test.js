'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { createQuarantine } = require('../../src/engine/quarantine');
const { runStateOf } = require('../../src/adapters/openclaw/normalise/session');
const { executionState } = require('../../src/engine/execution-state');
const { activityOf } = require('../../src/engine/derive/activity');
const { deriveInterlocutors } = require('../../src/engine/derive/interlocutors');
const { deriveOccupants } = require('../../src/engine/derive/occupants');
const { loadScenario, skipUnlessLocal } = require('../helpers/scenario');
const { feed } = require('../helpers/feed');

const NOW = Date.UTC(2026, 9, 5, 18);
const SF = '100000000000000001';
const list = (sessions) => ({ source: 'gateway', channel: 'gw.rpc.sessions.list', receivedAt: NOW, body: { kind: 'json', value: { sessions } } });
const row = (key, o) => Object.assign({ key, updatedAt: NOW - 60000, totalTokens: 100 }, o);

describe('RunState', () => {
  const st = (r) => { const x = runStateOf(r, { observedAt: NOW }); return [x.run.status, x.run.endReason, x.run.evidence, x.unmappedStatus]; };
  it('maps every status seen live, with the right precedence', () => {
    assert.deepEqual(st({ hasActiveRun: true, status: 'done' }), ['running', null, 'gateway-flag', undefined]);
    assert.deepEqual(st({ status: 'active' }), ['running', null, 'status-field', undefined]);
    assert.deepEqual(st({ status: 'complete', startedAt: NOW }), ['succeeded', null, 'status-field', undefined]);
    assert.deepEqual(st({ status: 'timeout', startedAt: NOW }), ['failed', 'timeout', 'status-field', undefined]);
    assert.deepEqual(st({ status: 'killed' }), ['failed', 'killed', 'status-field', undefined]);
    assert.deepEqual(st({ status: 'budget_limited' }), ['failed', 'budget-limited', 'status-field', undefined]);
    assert.deepEqual(st({ startedAt: NOW, updatedAt: NOW }), ['running', null, 'start-without-end', undefined]);
    assert.deepEqual(st({ status: 'paused', startedAt: NOW, updatedAt: NOW }), ['running', null, 'start-without-end', 'paused']);
    assert.deepEqual(st({}), ['unknown', null, 'none', undefined]);
  });
  it('treats an explicit inactive gateway flag as verified idle, while a gateway activity summary stays observed', () => {
    const inactive = runStateOf({ hasActiveRun: false, hasActiveSubagentRun: false }, { observedAt: NOW }).run;
    assert.deepEqual([inactive.status, inactive.evidence, inactive.evidenceLevel], ['idle', 'gateway-flag', 'verified']);
    const active = runStateOf({ activitySummary: { state: 'working', updatedAt: NOW, canEnsure: true } }, { observedAt: NOW }).run;
    assert.deepEqual([active.status, active.evidence, active.evidenceLevel], ['running', 'live-activity', 'observed']);
    assert.equal(active.expiresAt, NOW + 30000, 'summary activity receives a local receipt-time lease');
    assert.equal(executionState(active, NOW + 30000).status, 'unknown', 'summary activity cannot remain running after its lease');
  });
  it('keeps indirect run evidence bounded and never infers idle from an expired start', () => {
    const observed = runStateOf({ startedAt: NOW - 1000, updatedAt: NOW }, { observedAt: NOW }).run;
    assert.equal(observed.evidenceLevel, 'observed');
    assert.equal(observed.expiresAt, NOW + 30000);
    assert.deepEqual(executionState(observed, NOW + 29999), { status: 'running', level: 'observed', observedAt: NOW, expiresAt: NOW + 30000 });
    assert.deepEqual(executionState(observed, NOW + 30000), { status: 'unknown', level: 'unknown', observedAt: NOW, expiresAt: NOW + 30000 });
    assert.equal(executionState(runStateOf({ status: 'idle', updatedAt: NOW }).run, NOW).level, 'verified');
    assert.equal(activityOf({ key: 'observed', run: observed }), null, 'an observed start cannot become verified Activity');
    assert.equal(activityOf({ key: 'verified', updatedAt: NOW, run: runStateOf({ status: 'active', updatedAt: NOW }).run })?.kind, 'working');
  });
  it('anchors observed leases to local receipt time despite provider clock skew', () => {
    for (const updatedAt of [NOW - 365 * 86400000, NOW + 365 * 86400000]) {
      const run = runStateOf({ startedAt: NOW - 1000, updatedAt }, { observedAt: NOW }).run;
      assert.equal(run.observedAt, NOW);
      assert.equal(run.expiresAt, NOW + 30000);
      assert.equal(executionState(run, NOW + 29999).status, 'running');
      assert.equal(executionState(run, NOW + 30000).status, 'unknown');
    }
    const withoutReceipt = runStateOf({ startedAt: NOW - 1000, updatedAt: NOW + 365 * 86400000 }).run;
    assert.equal(withoutReceipt.status, 'unknown', 'provider time alone cannot mint observed evidence');
  });
});

describe('engine sessions registry', () => {
  it('normalises, quarantines unclassified keys and unmapped statuses, keeps list order', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(list([row('agent:main:main', { isMain: true }), row('weird-key'), row(`agent:main:discord:direct:${SF}`, { status: 'paused' })]));
    assert.deepEqual(e.sessions().map((s) => s.class.kind), ['primary', 'unrecognized', 'conversation-direct']);
    assert.deepEqual(e.quarantine.list().map((i) => `${i.code} ${i.path}`).sort(), ['enum.unmapped $.sessions[].status', 'session.unclassified $.sessions[].key']);
    assert.equal(e.quarantine.list().find((i) => i.code === 'enum.unmapped').sample, undefined);   // S4.1: no sample, ever
    assert.equal(e.classify(`agent:main:discord:direct:${SF}`).interlocutorId, 'discord-user:' + SF);
    assert.equal(e.classify('agent:main:cron:j').kind, 'scheduled');   // unknown to the registry: key grammar
  });

  it('keeps unknown sessions canonical while counting one classifier warning per registry lifetime', () => {
    const e = createEngine({ now: () => NOW });
    const rows = Array.from({ length: 1000 }, (_, i) => row('unmapped-' + i));
    const ingestPages = () => {
      for (let offset = 0; offset < rows.length; offset += 300) {
        const sessions = rows.slice(offset, offset + 300);
        const hasMore = offset + sessions.length < rows.length;
        const page = list(sessions);
        page.context = { offset };
        page.body.value = { sessions, totalCount: rows.length, hasMore, nextOffset: hasMore ? offset + sessions.length : null };
        e.ingest(page);
      }
    };
    ingestPages(); ingestPages();
    assert.equal(e.sessions().length, 1000);
    assert.ok(e.sessions().every(s => s.class.kind === 'unrecognized'));
    const issue = e.quarantine.list().find(i => i.code === 'session.unclassified');
    assert.equal(issue.count, 1);
  });

  it('counts the first unknown event once even after the initial complete inventory', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(list([row('agent:main:main', { isMain: true })]));
    const changed = sessionKey => ({ source: 'gateway', channel: 'gw.event.sessions.changed', receivedAt: NOW,
      body: { kind: 'json', value: { sessionKey, updatedAt: NOW - 60000, totalTokens: 100 } } });
    e.ingest(changed('future-session-family'));
    e.ingest(changed('another-future-family'));
    assert.equal(e.sessions().filter(s => s.class.kind === 'unrecognized').length, 2);
    assert.equal(e.quarantine.list().filter(i => i.code === 'session.unclassified').length, 1);
    assert.equal(e.quarantine.list().find(i => i.code === 'session.unclassified').count, 1);
  });

  it('normalizes a persisted per-session warning burst to the single canonical classification warning', () => {
    const q = createQuarantine({ now: () => NOW });
    q.restore([{ fingerprint: '0123456789abcdef', code: 'session.unclassified', severity: 'warn', channel: 'gateway', path: '$.sessions[].key',
      count: 31713, firstSeenAt: NOW - 1000, lastSeenAt: NOW, state: 'open' }]);
    assert.equal(q.list()[0].count, 1);
    assert.equal(q.takeDirty().upserts[0].count, 1);
  });

  it('a complete snapshot (hasMore false) without a session removes it', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(list([row('agent:main:main'), row('agent:main:cron:a')]));
    e.ingest(list([row('agent:main:main')]));
    assert.deepEqual(e.sessions().map((s) => s.key), ['agent:main:main']);
  });

  it('real capture: 175 sessions, 54 Discord interlocutors (the legacy Habilitations page also lists 54) + 1 WeChat room (G3b)', skipUnlessLocal('capture-20261005'), () => {
    const capture = loadScenario('capture-20261005');
    const e = feed(createEngine({ now: () => capture.now }), capture);
    assert.equal(e.sessions().length, 175);
    assert.equal(e.sessionsMeta().totalCount, 175);
    const all = deriveInterlocutors(e.sessions());
    assert.equal(all.filter((i) => i.family === 'discord').length, 54);
    assert.deepEqual(all.filter((i) => i.family !== 'discord').map((i) => i.kind), ['wechat-room']);
    assert.ok(!e.quarantine.list().some((i) => i.code === 'session.unclassified' || (i.code === 'enum.unmapped' && /^\$\.sessions/.test(i.path))));
  });
});

describe('derived interlocutors', () => {
  it('groups by interlocutor, ignores heartbeats, picks the most recent session', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(list([
      row(`agent:main:discord:direct:${SF}`, { updatedAt: NOW - 1000, totalTokens: 10 }),
      row(`agent:main:discord:direct:${SF}:heartbeat`, { updatedAt: NOW, totalTokens: 999 }),
      row(`agent:main:discord:channel:${SF}`, { updatedAt: NOW - 5000, totalTokens: 7 }),
    ]));
    const it = deriveInterlocutors(e.sessions());
    assert.deepEqual(it.map((i) => [i.id, i.stats.sessionCount, i.stats.totalTokens, i.primarySessionKey]), [
      ['discord-user:' + SF, 1, 10, `agent:main:discord:direct:${SF}`],
      ['discord-channel:' + SF, 1, 7, `agent:main:discord:channel:${SF}`],
    ]);
  });
});

describe('derived occupants', () => {
  it('projects explicit OpenClaw inactive/active gateway flags as primary-agent idle/working', () => {
    for (const [hasActiveRun, expected] of [[false, 'idle'], [true, 'working']]) {
      const e = createEngine({ now: () => NOW });
      e.ingest(list([row('agent:main:main', { isMain: true, hasActiveRun })]));
      const [primary] = deriveOccupants({ sessions: e.sessions(), gwConnected: true, now: NOW });
      assert.equal(primary.state, expected);
      assert.equal(e.sessions()[0].run.evidenceLevel, 'verified');
    }
  });
  it('projects a verified OpenClaw done status without an active-run flag as idle', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(list([row('agent:main:main', { isMain: true, status: 'done' })]));
    const [primary] = deriveOccupants({ sessions: e.sessions(), gwConnected: true, now: NOW });
    assert.deepEqual([e.sessions()[0].run.status, e.sessions()[0].run.evidenceLevel, primary.state], ['succeeded', 'verified', 'idle']);
  });
  const mk = (rows) => { const e = createEngine({ now: () => NOW }); e.ingest(list(rows)); return e.sessions(); };
  const ids = (o) => o.map((x) => `${x.id.split(':')[0]}/${x.state}/${x.stationUid}`);

  it('main is always there; offline when the gateway is down', () => {
    assert.deepEqual(ids(deriveOccupants({ sessions: [], gwConnected: false, now: NOW })), ['primary/offline/desk-1']);
    assert.deepEqual(ids(deriveOccupants({ sessions: mk([row('agent:main:main', { isMain: true, status: 'idle' })]), gwConnected: true, now: NOW })), ['primary/idle/desk-1']);
  });

  it('running interactive sessions join, newest first, deduplicated, heartbeats and dashboards excluded', () => {
    const s = mk([
      row('agent:main:main', { isMain: true }),
      row('agent:main:subagent:a', { status: 'active', updatedAt: NOW - 1000 }),
      row('agent:main:cron:j', { status: 'active', updatedAt: NOW - 500 }),
      row(`agent:main:discord:direct:${SF}:heartbeat`, { status: 'active' }),
      row('agent:main:dashboard:d', { status: 'active' }),
      row('agent:main:subagent:b', { status: 'done' }),
    ]);
    assert.deepEqual(ids(deriveOccupants({ sessions: s, gwConnected: true, now: NOW })),
      ['primary/working/desk-1', 'scheduled/working/desk-2', 'subagent/working/desk-3', 'subagent/idle/desk-4'],
      'a recently completed interactive child stays on stage as idle during the presence window');
    const expired = mk([
      row('agent:main:main', { isMain: true }),
      row('agent:main:subagent:a', { status: 'active', updatedAt: NOW - 1000 }),
      row('agent:main:cron:j', { status: 'active', updatedAt: NOW - 500 }),
      row(`agent:main:discord:direct:${SF}:heartbeat`, { status: 'active' }),
      row('agent:main:dashboard:d', { status: 'active' }),
      row('agent:main:subagent:b', { status: 'done', updatedAt: NOW - 15 * 60 * 1000 - 1 }),
    ]);
    assert.deepEqual(ids(deriveOccupants({ sessions: expired, gwConnected: true, now: NOW })),
      ['primary/working/desk-1', 'scheduled/working/desk-2', 'subagent/working/desk-3'],
      'the completed child leaves the stage after the bounded presence window');
    assert.deepEqual(ids(deriveOccupants({ sessions: mk([row('agent:main:main', { isMain: true }), row('agent:main:cron:j', { status: 'active' }), row(`agent:main:discord:direct:${SF}`, { status: 'active' })]), gwConnected: true, now: NOW })),
      ['primary/working/desk-1', 'scheduled/working/desk-2', 'direct/working/desk-3'], 'office-dev-22: the main agent works its own scheduled run and DM (each keeps its occupant)');
  });

  it('office-dev-22: a running DM or child keeps the owner working; visitors and delegates remain visible', () => {
    const dm = `agent:main:discord:direct:${SF}`;
    const o = deriveOccupants({ sessions: mk([row('agent:main:main', { isMain: true }), row(dm, { status: 'active', updatedAt: NOW - 100 })]), gwConnected: true, now: NOW });
    assert.deepEqual(ids(o), ['primary/working/desk-1', 'direct/working/desk-2']);
    assert.equal(o[1].sessionKey, dm, 'the person keeps their occupant (name plate, roster, journal)');
    // its live activity kind is the main agent's too
    const live = deriveOccupants({ sessions: mk([row('agent:main:main', { isMain: true }), row(dm, { status: 'active' })]), activityFor: (k) => (k === dm ? 'writing' : null), gwConnected: true, now: NOW });
    assert.equal(live[0].state, 'writing');
    // the DM ended: main back to idle
    assert.equal(deriveOccupants({ sessions: mk([row('agent:main:main', { isMain: true, status: 'idle' }), row(dm, { status: 'done' })]), gwConnected: true, now: NOW })[0].state, 'idle');
    // A running child is part of the owning agent's active execution; both remain visible.
    assert.deepEqual(ids(deriveOccupants({ sessions: mk([row('agent:main:main', { isMain: true, status: 'idle' }), row('agent:main:subagent:a', { status: 'active' })]), gwConnected: true, now: NOW })),
      ['primary/working/desk-1', 'subagent/working/desk-2']);
  });

  it('live activity sets state; all active delegates stay on stage beyond the seven default stations', () => {
    const rows = [row('agent:main:main', { isMain: true })].concat(Array.from({ length: 10 }, (_, i) => row('agent:main:subagent:s' + i, { status: 'active', updatedAt: NOW - i })));
    const o = deriveOccupants({ sessions: mk(rows), activityFor: (k) => (k === 'agent:main:subagent:s0' ? 'calling' : null), gwConnected: true, now: NOW });
    assert.equal(o.length, 11); assert.equal(o[1].state, 'calling'); assert.deepEqual(o.map((x) => x.order), Array.from({ length: 11 }, (_, i) => i));
    assert.equal(o[7].stationUid, null, 'rows beyond the default station inventory keep their roster identity without a fake station');
  });
});
