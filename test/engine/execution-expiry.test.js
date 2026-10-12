'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { createTopics } = require('../../src/api/v2/topics');
const { buildOfficeVM, createStateTracker } = require('../../src/api/v2/vm/office');
const { normaliseSession } = require('../../src/adapters/openclaw/normalise/session');

test('an observed run lease invalidates a cached Office topic at expiry without source traffic', async t => {
  let clock = Date.UTC(2026, 9, 11, 12);
  const engine = createEngine({ now: () => clock });
  t.after(() => engine.close());
  const { session } = normaliseSession({ key: 'agent:main:main', isMain: true, startedAt: clock - 1000 }, { observedAt: clock });
  session.run.expiresAt = clock + 80;
  engine.ingestCanonical('sessions.snapshot', [session]);
  engine.setGatewayConnected(true);

  const topics = createTopics({ office: { build: () => buildOfficeVM({ engine, now: clock, tracker: createStateTracker(),
    actorOf: () => ({ kind: 'system', name: 'System' }), canReadSessions: true }) } }, { coalesceMs: 0 });
  t.after(() => topics.close());
  engine.on('change', () => topics.invalidate('office'));
  const before = topics.current('office');
  assert.equal(before.vm.occupants[0].execution.evidence.level, 'observed');
  const changed = new Promise(resolve => topics.on('change', resolve));
  clock += 100;
  const delta = await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error('expiry did not invalidate Office')), 1000))]);
  assert.equal(delta.rev, before.rev + 1);
  const after = topics.current('office');
  assert.equal(after.vm.occupants[0].state, 'unknown');
  assert.deepEqual(after.vm.occupants[0].execution, { status: 'unknown', evidence: { level: 'unknown', observedAt: clock - 100, expiresAt: clock - 20 } });
  assert.equal(after.vm.kpis.find(k => k.id === 'active').value, null);
  assert.deepEqual(after.vm.kpis.find(k => k.id === 'active').sub, { key: 'kpi.stateUnknown' });
});

test('a transcript-only activity lease invalidates cached Office state when its lease expires', async t => {
  let clock = Date.UTC(2026, 9, 11, 12);
  const engine = createEngine({ now: () => clock });
  t.after(() => engine.close());
  const key = 'agent:main:main';
  const { session } = normaliseSession({ key, isMain: true }, { observedAt: clock });
  engine.ingestCanonical('agents', [{ id: 'main', name: 'Main', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: key }]);
  engine.ingestCanonical('sessions.snapshot', [session]);
  assert.equal(engine.setObservedActivity(key, { kind: 'working', source: 'transcript', since: clock, expiresAt: clock + 80 }), true);
  engine.setGatewayConnected(true);

  const topics = createTopics({ office: { build: () => buildOfficeVM({ engine, now: clock, tracker: createStateTracker(),
    actorOf: () => ({ kind: 'system', name: 'System' }), canReadSessions: true }) } }, { coalesceMs: 0 });
  t.after(() => topics.close());
  engine.on('change', () => topics.invalidate('office'));
  const before = topics.current('office');
  assert.equal(before.vm.occupants[0].execution.evidence.level, 'observed');
  const changed = new Promise(resolve => topics.on('change', resolve));
  clock += 100;
  const delta = await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error('transcript expiry did not invalidate Office')), 1000))]);
  assert.equal(delta.rev, before.rev + 1);
  const after = topics.current('office');
  assert.equal(after.vm.occupants[0].state, 'unknown');
  assert.equal(after.vm.occupants[0].execution.evidence.level, 'unknown');
});


test('a read that lazily expires transcript activity still invalidates cached Office state', async t => {
  let clock = Date.UTC(2026, 9, 11, 12);
  const engine = createEngine({ now: () => clock });
  t.after(() => engine.close());
  const key = 'agent:main:read-before-expiry';
  const { session } = normaliseSession({ key, isMain: true }, { observedAt: clock });
  engine.ingestCanonical('agents', [{ id: 'main', name: 'Main', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: key }]);
  engine.ingestCanonical('sessions.snapshot', [session]);
  engine.setObservedActivity(key, { kind: 'working', source: 'transcript', since: clock, expiresAt: clock + 80 });
  engine.setGatewayConnected(true);
  const topics = createTopics({ office: { build: () => buildOfficeVM({ engine, now: clock, tracker: createStateTracker(),
    actorOf: () => ({ kind: 'system', name: 'System' }), canReadSessions: true }) } }, { coalesceMs: 0 });
  t.after(() => topics.close());
  engine.on('change', () => topics.invalidate('office'));
  const before = topics.current('office');
  assert.equal(before.vm.occupants[0].execution.evidence.level, 'observed');
  const changed = new Promise(resolve => topics.on('change', resolve));
  clock += 100;
  assert.equal(engine.activity(key), null, 'the lazy lookup removes the expired transcript lease');
  const delta = await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error('lazy expiry did not invalidate Office')), 1000))]);
  assert.equal(delta.rev, before.rev + 1);
  assert.equal(topics.current('office').vm.occupants[0].execution.evidence.level, 'unknown');
});
