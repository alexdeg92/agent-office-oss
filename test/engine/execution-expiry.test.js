'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { createTopics } = require('../../src/api/v2/topics');
const { buildOfficeVM, createStateTracker } = require('../../src/api/v2/vm/office');
const { normaliseSession } = require('../../src/adapters/openclaw/normalise/session');
const { project2x } = require('../../src/api/v2/project2x');
const { project3x } = require('../../src/api/v2/project3x');

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

test('waiting activity accepts a bounded reply window longer than ordinary transcript detail', t => {
  let clock = Date.UTC(2026, 9, 11, 12);
  const engine = createEngine({ now: () => clock });
  t.after(() => engine.close());
  const key = 'agent:main:main';
  const { session } = normaliseSession({ key, isMain: true }, { observedAt: clock });
  engine.ingestCanonical('sessions.snapshot', [session]);
  assert.equal(engine.setObservedActivity(key, { kind: 'waiting', source: 'transcript', since: clock, expiresAt: clock + 15 * 60_000 }), true);
  assert.equal(engine.activity(key)?.kind, 'waiting');
  assert.equal(engine.setObservedActivity(key, { kind: 'waiting', source: 'transcript', since: clock, expiresAt: clock + 15 * 60_000 + 1 }), false,
    'waiting evidence still has a hard upper bound');
  clock += 15 * 60_000;
  engine.expireObservedActivity();
  assert.equal(engine.activity(key), null, 'expired waiting cannot outlive its explicit lease');
});

test('a live rich transcript lease overlays but does not discard a generic working fallback', t => {
  let clock = Date.UTC(2026, 9, 11, 12);
  const started = clock;
  const engine = createEngine({ now: () => clock });
  t.after(() => engine.close());
  const key = 'agent:main:main';
  const { session } = normaliseSession({ key, isMain: true, startedAt: clock - 25_000 }, { observedAt: clock - 25_000 });
  Object.assign(session.run, { status: 'running', evidence: 'start-without-end', evidenceLevel: 'observed', observedAt: clock - 25_000, expiresAt: clock + 5_000 });
  engine.ingestCanonical('agents', [{ id: 'main', name: 'Main', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: key }]);
  engine.ingestCanonical('sessions.snapshot', [session]);
  assert.equal(engine.setObservedActivity(key, { kind: 'blocked', source: 'transcript', since: clock - 1_000, expiresAt: clock + 9_000 }), true);
  clock += 5_001;
  assert.equal(engine.setObservedActivity(key, { kind: 'working', source: 'transcript', since: clock, expiresAt: clock + 30_000 }), true);
  assert.equal(engine.activity(key).kind, 'blocked', 'generic work remains a fallback until the richer lease expires');
  engine.setGatewayConnected(true);

  const vm = buildOfficeVM({ engine, now: clock, tracker: createStateTracker(),
    actorOf: () => ({ kind: 'system', name: 'System' }), canReadSessions: true });
  assert.equal(vm.occupants[0].state, 'blocked');
  assert.deepEqual(vm.occupants[0].execution, { status: 'running', evidence: { level: 'observed', observedAt: started - 1_000, expiresAt: started + 9_000 } });

  // At the detail lease's original expiry, the independently accepted generic
  // lease becomes the presentation/evidence source with its own clock.
  clock = started + 9_001;
  engine.expireObservedActivity();
  assert.equal(engine.activity(key).kind, 'working');
  for (const P of [project2x, project3x]) {
    const fallback = buildOfficeVM({ engine, now: clock, tracker: createStateTracker(), P,
      actorOf: () => ({ kind: 'system', name: 'System' }), canReadSessions: true });
    assert.equal(fallback.occupants[0].state, 'working', `${P.version}: generic fallback remains visible`);
    assert.deepEqual(fallback.occupants[0].execution, { status: 'running', evidence: { level: 'observed', observedAt: started + 5_001, expiresAt: started + 35_001 } });
  }

  clock = started + 35_002;
  engine.expireObservedActivity();
  assert.equal(engine.activity(key), null, 'the generic lease expires at its own deadline');
  for (const P of [project2x, project3x]) {
    const expired = buildOfficeVM({ engine, now: clock, tracker: createStateTracker(), P,
      actorOf: () => ({ kind: 'system', name: 'System' }), canReadSessions: true });
    assert.equal(expired.occupants[0].state, 'unknown', `${P.version}: no expired evidence is promoted`);
  }
});

test('expiry timer promotes generic activity after a rich overlay and invalidates cached office state', async t => {
  let clock = Date.UTC(2026, 9, 11, 12);
  const started = clock;
  const engine = createEngine({ now: () => clock });
  t.after(() => engine.close());
  const key = 'agent:main:timer-overlay';
  const { session } = normaliseSession({ key, isMain: true, startedAt: clock - 25 }, { observedAt: clock - 25 });
  Object.assign(session.run, { status: 'running', evidence: 'start-without-end', evidenceLevel: 'observed', observedAt: clock - 25, expiresAt: clock + 50 });
  engine.ingestCanonical('agents', [{ id: 'main', name: 'Main', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: key }]);
  engine.ingestCanonical('sessions.snapshot', [session]);
  engine.setObservedActivity(key, { kind: 'blocked', source: 'transcript', since: clock, expiresAt: clock + 90 });
  engine.setGatewayConnected(true);
  const topics = createTopics({ office: { build: () => buildOfficeVM({ engine, now: clock, tracker: createStateTracker(),
    actorOf: () => ({ kind: 'system', name: 'System' }), canReadSessions: true }) } }, { coalesceMs: 0 });
  t.after(() => topics.close());
  engine.on('change', () => topics.invalidate('office'));
  const before = topics.current('office');
  assert.equal(before.vm.occupants[0].state, 'blocked');

  clock = started + 60;
  engine.setObservedActivity(key, { kind: 'working', source: 'transcript', since: clock, expiresAt: started + 360 });
  assert.equal(engine.activity(key).kind, 'blocked');
  clock = started + 91;
  const promotedChange = new Promise(resolve => topics.on('change', resolve));
  const promoted = await Promise.race([promotedChange, new Promise((_, reject) => setTimeout(() => reject(new Error('rich lease expiry did not invalidate Office')), 1000))]);
  assert.equal(promoted.rev, before.rev + 1);
  assert.equal(topics.current('office').vm.occupants[0].state, 'working');

  clock = started + 361;
  const expiredChange = new Promise(resolve => topics.on('change', resolve));
  const expired = await Promise.race([expiredChange, new Promise((_, reject) => setTimeout(() => reject(new Error('generic fallback expiry did not invalidate Office')), 1000))]);
  assert.equal(expired.rev, before.rev + 2);
  assert.equal(topics.current('office').vm.occupants[0].state, 'unknown');
});

test('verified terminal completion clears both rich and generic transcript leases', t => {
  const clock = Date.UTC(2026, 9, 11, 12);
  const engine = createEngine({ now: () => clock });
  t.after(() => engine.close());
  const key = 'agent:main:terminal-overlay';
  const { session } = normaliseSession({ key, isMain: true, startedAt: clock - 1000 }, { observedAt: clock });
  Object.assign(session.run, { status: 'running', evidence: 'start-without-end', evidenceLevel: 'observed', observedAt: clock, expiresAt: clock + 5000 });
  engine.ingestCanonical('agents', [{ id: 'main', name: 'Main', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: key }]);
  engine.ingestCanonical('sessions.snapshot', [session]);
  assert.equal(engine.setObservedActivity(key, { kind: 'blocked', source: 'transcript', since: clock, expiresAt: clock + 9000 }), true);
  assert.equal(engine.setObservedActivity(key, { kind: 'working', source: 'transcript', since: clock, expiresAt: clock + 30000 }), true);

  const completed = structuredClone(session);
  completed.run = { ...completed.run, status: 'succeeded', evidence: 'status-field', evidenceLevel: 'verified', observedAt: clock,
    expiresAt: null, startedAt: clock - 1000, endedAt: clock };
  assert.equal(engine.ingestCanonical('sessions.snapshot', [completed]).ok, true);
  assert.equal(engine.activity(key), null);
  assert.equal(engine.clearObservedActivity(key), false, 'the terminal ingestion already removed both stored leases');
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
