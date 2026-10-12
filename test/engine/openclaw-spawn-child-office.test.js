'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { buildOfficeVM, createStateTracker } = require('../../src/api/v2/vm/office');
const { project2x } = require('../../src/api/v2/project2x');
const { project3x } = require('../../src/api/v2/project3x');
const { schemasFor } = require('../../src/api/v2/vm/schemas');
const { validate } = require('../../src/schema');
const { deriveOccupants } = require('../../src/engine/derive/occupants');

const NOW = Date.UTC(2026, 9, 11, 22);
const row = (key, fields = {}) => ({ key, updatedAt: NOW, totalTokens: 0, ...fields });
const page = sessions => ({ source: 'gateway', channel: 'gw.rpc.sessions.list', receivedAt: NOW,
  body: { kind: 'json', value: { sessions } } });

test('real-shaped spawn-child rows make the primary work and count as subagents; cron unknown never supplies primary state', () => {
  const engine = createEngine({ now: () => NOW });
  const childRows = Array.from({ length: 6 }, (_, i) => row(`agent:main:spawn-child:run-${i + 1}`, {
    kind: 'spawn-child', status: 'running', parentSessionKey: 'agent:main:main',
  }));
  engine.ingest(page([
    row('agent:main:main', { isMain: true, kind: 'direct', status: 'done' }),
    ...childRows,
    row('agent:main:cron:synthetic', { kind: 'direct', status: null }),
  ]));
  engine.setGatewayConnected(true);

  const sessions = engine.sessions();
  assert.equal(sessions.filter(s => s.class.kind === 'subagent').length, 6, 'spawn-child rows are canonical subagents');
  const officeEngine = Object.assign(Object.create(engine), { agents: () => [{ id: 'main', name: 'Main agent' }],
    primaryAgent: () => ({ id: 'main', name: 'Main agent', mainSessionKey: 'agent:main:cron:synthetic' }) });
  const vm = buildOfficeVM({ engine: officeEngine, now: NOW, tracker: createStateTracker(), canReadSessions: true,
    actorOf: () => ({ kind: 'system', name: 'System' }) });
  const primary = vm.occupants.find(o => o.role === 'main');
  const children = vm.occupants.filter(o => o.role === 'subagent');
  assert.equal(primary.state, 'working', 'verified running children make their owning agent work');
  assert.equal(children.length, 6, 'all six active children fit beside the primary');
  assert.ok(children.every(o => o.parentId === primary.id), 'canonical parent session links stack under the primary');
  assert.equal(vm.kpis.find(k => k.id === 'subagents').value, 6);

  const noChildren = sessions.filter(s => s.class.kind !== 'subagent');
  const quietEngine = Object.assign(Object.create(officeEngine), { sessions: () => noChildren, session: key => noChildren.find(s => s.key === key) || null });
  const quiet = buildOfficeVM({ engine: quietEngine, now: NOW, tracker: createStateTracker(), canReadSessions: true,
    actorOf: () => ({ kind: 'system', name: 'System' }) });
  assert.equal(quiet.occupants.find(o => o.role === 'main').state, 'idle', 'an unknown cron row cannot turn the completed main session into Unknown or Working');
});

test('scheduled running rows never supply primary presence or execution evidence in either OfficeVM contract', () => {
  const engine = createEngine({ now: () => NOW });
  engine.ingest(page([
    row('agent:main:main', { isMain: true, kind: 'direct', status: 'done' }),
    row('agent:main:cron:nightly', { kind: 'direct', status: 'running' }),
  ]));
  engine.setGatewayConnected(true);
  const officeEngine = Object.assign(Object.create(engine), {
    agents: () => [{ id: 'main', name: 'Main agent' }],
    primaryAgent: () => ({ id: 'main', name: 'Main agent', mainSessionKey: 'agent:main:main' }),
  });
  for (const P of [project2x, project3x]) {
    const vm = buildOfficeVM({ engine: officeEngine, now: NOW, tracker: createStateTracker(), canReadSessions: true,
      actorOf: () => ({ kind: 'system', name: 'System' }), P });
    const primary = vm.occupants.find(o => o.role === 'primary' || o.role === 'main');
    assert.equal(primary.state, 'idle', `${P.version}: scheduled row cannot make the completed primary work`);
    assert.notEqual(primary.execution.status, 'running', `${P.version}: scheduled row is excluded from execution evidence`);
    assert.equal(validate(schemasFor(P.version).office, vm).ok, true, `${P.version}: production contract remains valid`);
  }
});

test('verified terminal child status fences its older activity from both primary and child state', () => {
  const engine = createEngine({ now: () => NOW });
  engine.ingest(page([
    row('agent:main:main', { isMain: true, kind: 'direct', status: 'done' }),
    row('agent:main:spawn-child:finished', { kind: 'spawn-child', status: 'done', endedAt: NOW - 1000 }),
  ]));
  const staleActivity = key => key.includes('spawn-child') ? 'calling' : null;
  const occupants = deriveOccupants({ sessions: engine.sessions(), activityFor: staleActivity, gwConnected: true, now: NOW });
  assert.equal(occupants.find(o => o.role === 'primary').state, 'idle');
  assert.equal(occupants.find(o => o.role === 'subagent').state, 'idle');
});

test('a completed child cannot mask a fresh observed sibling in primary execution evidence', () => {
  const engine = createEngine({ now: () => NOW });
  engine.ingest(page([
    row('agent:main:main', { isMain: true, kind: 'direct', status: 'done' }),
    row('agent:main:spawn-child:complete', { kind: 'spawn-child', status: 'done', endedAt: NOW - 1000 }),
    row('agent:main:spawn-child:active', { kind: 'spawn-child', status: 'running', parentSessionKey: 'agent:main:main' }),
  ]));
  engine.setGatewayConnected(true);
  const original = engine.sessions();
  const sessions = original.map(s => s.key.endsWith(':active') ? { ...s, run: { ...s.run, evidence: 'live-activity', evidenceLevel: 'observed', observedAt: NOW - 1000, expiresAt: NOW + 30_000 } } : s);
  const activity = key => key.endsWith(':complete') || key.endsWith(':active')
    ? { kind: 'working', sessionKey: key, since: key.endsWith(':active') ? NOW - 1000 : NOW - 2000, expiresAt: NOW + 30_000 } : null;
  const officeEngine = Object.assign(Object.create(engine), {
    sessions: () => sessions,
    session: key => sessions.find(s => s.key === key) || null,
    agents: () => [{ id: 'main', name: 'Main agent' }],
    primaryAgent: () => ({ id: 'main', name: 'Main agent', mainSessionKey: 'agent:main:main' }),
    activity,
  });
  for (const rows of [sessions, [...sessions].reverse()]) for (const P of [project2x, project3x]) {
    const ordered = Object.assign(Object.create(officeEngine), { sessions: () => rows, session: key => rows.find(s => s.key === key) || null });
    const vm = buildOfficeVM({ engine: ordered, now: NOW, tracker: createStateTracker(), canReadSessions: true,
      actorOf: () => ({ kind: 'system', name: 'System' }), P });
    const primary = vm.occupants.find(o => o.role === 'primary' || o.role === 'main');
    assert.equal(primary.state, 'working');
    assert.equal(primary.execution.status, 'running');
    assert.equal(primary.execution.evidence.level, 'observed');
  }
});
