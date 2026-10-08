'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { runStateOf } = require('../../src/adapters/openclaw/normalise/session');
const { deriveInterlocutors } = require('../../src/engine/derive/interlocutors');
const { deriveOccupants } = require('../../src/engine/derive/occupants');
const { loadScenario, skipUnlessLocal } = require('../helpers/scenario');
const { feed } = require('../helpers/feed');

const NOW = Date.UTC(2026, 9, 5, 18);
const SF = '100000000000000001';
const list = (sessions) => ({ source: 'gateway', channel: 'gw.rpc.sessions.list', receivedAt: NOW, body: { kind: 'json', value: { sessions } } });
const row = (key, o) => Object.assign({ key, updatedAt: NOW - 60000, totalTokens: 100 }, o);

describe('RunState', () => {
  const st = (r) => { const x = runStateOf(r); return [x.run.status, x.run.endReason, x.run.evidence, x.unmappedStatus]; };
  it('maps every status seen live, with the right precedence', () => {
    assert.deepEqual(st({ hasActiveRun: true, status: 'done' }), ['running', null, 'gateway-flag', undefined]);
    assert.deepEqual(st({ status: 'active' }), ['running', null, 'status-field', undefined]);
    assert.deepEqual(st({ status: 'complete', startedAt: NOW }), ['succeeded', null, 'status-field', undefined]);
    assert.deepEqual(st({ status: 'timeout', startedAt: NOW }), ['failed', 'timeout', 'status-field', undefined]);
    assert.deepEqual(st({ status: 'killed' }), ['failed', 'killed', 'status-field', undefined]);
    assert.deepEqual(st({ status: 'budget_limited' }), ['failed', 'budget-limited', 'status-field', undefined]);
    assert.deepEqual(st({ startedAt: NOW }), ['running', null, 'start-without-end', undefined]);
    assert.deepEqual(st({ status: 'paused', startedAt: NOW }), ['running', null, 'start-without-end', 'paused']);
    assert.deepEqual(st({}), ['idle', null, 'none', undefined]);
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

  it('a complete snapshot (hasMore false) without a session removes it', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(list([row('agent:main:main'), row('agent:main:cron:a')]));
    e.ingest(list([row('agent:main:main')]));
    assert.deepEqual(e.sessions().map((s) => s.key), ['agent:main:main']);
  });

  it('real capture: 175 sessions, 54 Discord interlocutors (the legacy Habilitations page also lists 54) + 1 WeChat room (G3b)', skipUnlessLocal('capture-20261005'), () => {
    const e = feed(createEngine({ now: () => 0 }), loadScenario('capture-20261005'));
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
  const mk = (rows) => { const e = createEngine({ now: () => NOW }); e.ingest(list(rows)); return e.sessions(); };
  const ids = (o) => o.map((x) => `${x.id.split(':')[0]}/${x.state}/${x.stationUid}`);

  it('main is always there; offline when the gateway is down', () => {
    assert.deepEqual(ids(deriveOccupants({ sessions: [], gwConnected: false, now: NOW })), ['primary/offline/desk-1']);
    assert.deepEqual(ids(deriveOccupants({ sessions: mk([row('agent:main:main', { isMain: true })]), gwConnected: true, now: NOW })), ['primary/idle/desk-1']);
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
    assert.deepEqual(ids(deriveOccupants({ sessions: s, gwConnected: true, now: NOW })), ['primary/working/desk-1', 'scheduled/working/desk-2', 'subagent/working/desk-3']);   // R6-05: run-state rule (main: its dashboard session runs)
    assert.deepEqual(ids(deriveOccupants({ sessions: mk([row('agent:main:main', { isMain: true }), row('agent:main:cron:j', { status: 'active' }), row(`agent:main:discord:direct:${SF}`, { status: 'active' })]), gwConnected: true, now: NOW })),
      ['primary/working/desk-1', 'scheduled/working/desk-2', 'direct/working/desk-3'], 'office-dev-22: the main agent works its own scheduled run and DM (each keeps its occupant)');
  });

  it('office-dev-22: a Discord DM running → the main agent works AND the person stays in the office; sub-agents alone do not make main busy', () => {
    const dm = `agent:main:discord:direct:${SF}`;
    const o = deriveOccupants({ sessions: mk([row('agent:main:main', { isMain: true }), row(dm, { status: 'active', updatedAt: NOW - 100 })]), gwConnected: true, now: NOW });
    assert.deepEqual(ids(o), ['primary/working/desk-1', 'direct/working/desk-2']);
    assert.equal(o[1].sessionKey, dm, 'the person keeps their occupant (name plate, roster, journal)');
    // its live activity kind is the main agent's too
    const live = deriveOccupants({ sessions: mk([row('agent:main:main', { isMain: true }), row(dm, { status: 'active' })]), activityFor: (k) => (k === dm ? 'writing' : null), gwConnected: true, now: NOW });
    assert.equal(live[0].state, 'writing');
    // the DM ended: main back to idle
    assert.equal(deriveOccupants({ sessions: mk([row('agent:main:main', { isMain: true }), row(dm, { status: 'done' })]), gwConnected: true, now: NOW })[0].state, 'idle');
    // R6-05 kept for helpers: a running sub-agent doesn't make main busy
    assert.deepEqual(ids(deriveOccupants({ sessions: mk([row('agent:main:main', { isMain: true }), row('agent:main:subagent:a', { status: 'active' })]), gwConnected: true, now: NOW })),
      ['primary/idle/desk-1', 'subagent/working/desk-2']);
  });

  it('live activity sets the state; caps at 7 stations', () => {
    const rows = [row('agent:main:main', { isMain: true })].concat(Array.from({ length: 10 }, (_, i) => row('agent:main:subagent:s' + i, { status: 'active', updatedAt: NOW - i })));
    const o = deriveOccupants({ sessions: mk(rows), activityFor: (k) => (k === 'agent:main:subagent:s0' ? 'calling' : null), gwConnected: true, now: NOW });
    assert.equal(o.length, 7); assert.equal(o[1].state, 'calling'); assert.deepEqual(o.map((x) => x.order), [0, 1, 2, 3, 4, 5, 6]);
  });
});
