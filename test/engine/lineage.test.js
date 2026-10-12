'use strict';
// T-0062: canonical lineage (spawnedBy) — validation, redaction, multi-runtime scoping and the office parent link.
// Synthetic adapters and sessions only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Lineage, normaliseLineage } = require('../../src/engine/model/lineage');
const { validate } = require('../../src/schema');
const { createEngine } = require('../../src/engine');
const { createMultiEngine } = require('../../src/engine/multi');
const { scopedId } = require('../../src/runtime-ids');
const { buildOfficeVM, createStateTracker } = require('../../src/api/v2/vm/office');
const { project3x } = require('../../src/api/v2/project3x');
const { project2x } = require('../../src/api/v2/project2x');
const { schemasFor } = require('../../src/api/v2/vm/schemas');

const NOW = 1791600000000;
const adapter = (id) => ({ id, name: id, schemas: {}, routes: {}, normalise: { session: row => ({ session: row }), runtimeHealth: () => ({ version: null, pluginsLoaded: null, eventLoop: null }) },
  classifySession: () => ({ kind: 'unrecognized' }), capabilities: () => ({ sessions: true }) });
const session = (key, agentId, kind, extra = {}) => ({ key, sessionId: null, class: { kind, ruleId: 'synthetic', agentId, channel: null, heartbeatOf: null, background: false, rawClassification: null },
  displayName: null, model: null, provider: null, usage: { total: 0, input: null, output: null }, updatedAt: NOW,
  run: { status: 'running', endReason: null, evidence: 'status-field', evidenceLevel: 'verified', observedAt: NOW, expiresAt: null, startedAt: NOW - 1000, endedAt: null, hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null },
  costUsd: null, parentKey: null, childKeys: [], goal: null, cwd: null, messageCount: null, interactive: true, group: null, ...extra });
const agent = (id, extra = {}) => ({ id, name: id, workspace: null, model: null, fallbackModels: [], isPrimary: false, mainSessionKey: null, ...extra });

test('normaliseLineage: shape, no known spawner, redacted label, open via, scoping', () => {
  for (const none of [null, undefined, 'x', [], {}, { via: 'orchestrator' }, { agentId: '' }]) assert.equal(normaliseLineage(none), null, JSON.stringify(none));
  const l = normaliseLineage({ sessionKey: 'pm-session', via: 'orchestrator', label: 'Reviewer token=synthetic-secret-canary\nsecond line' });
  assert.deepEqual(l, { agentId: null, sessionKey: 'pm-session', via: 'orchestrator', label: 'Reviewer token=…' });
  assert.equal(validate(Lineage, l).ok, true);
  assert.equal(normaliseLineage({ agentId: 'a', via: 'Not A Word' }).via, 'runtime', 'an invalid vocabulary word falls back to runtime');
  const scoped = normaliseLineage({ agentId: 'pm', sessionKey: 'native' }, { scope: { instance: 'coder' } });
  assert.equal(scoped.agentId, scopedId('coder', 'agent', 'pm')); assert.equal(scoped.sessionKey, scopedId('coder', 'session', 'native'));
  const cross = scopedId('other', 'session', 'pm-session');
  assert.equal(normaliseLineage({ sessionKey: cross }, { scope: { instance: 'coder' } }).sessionKey, cross, 'a canonical cross-runtime ref passes through');
  assert.equal(validate(Lineage, { agentId: null, sessionKey: null, via: 'runtime', label: null }).ok, false, 'a spawner is required');
  assert.equal(validate(Lineage, { agentId: 'a', sessionKey: null, via: 'runtime', label: null, extra: 1 }).ok, false, 'no extra fields');
});

test('canonical Agent and Session accept spawnedBy (optional, nullable) and refuse an invalid one', () => {
  const e = createEngine({ adapter: adapter('synthetic'), now: () => NOW });
  assert.equal(e.ingestCanonical('agents', [agent('pm'), agent('worker', { spawnedBy: { agentId: 'pm', sessionKey: null, via: 'orchestrator', label: null } }), agent('root', { spawnedBy: null })]).ok, true);
  assert.equal(e.agents().find(a => a.id === 'worker').spawnedBy.agentId, 'pm');
  const lax = e.ingestCanonical('agents', [agent('pm'), agent('worker', { spawnedBy: { agentId: null, sessionKey: null, via: 'orchestrator', label: null } }),
    agent('long', { spawnedBy: { agentId: 'pm', sessionKey: null, via: 'subagent-tool', label: 'x'.repeat(400) + ' password=synthetic-secret-canary' } })]);
  assert.equal(lax.ok, true, 'one unusable lineage never refuses the snapshot');
  assert.equal(e.agents().find(a => a.id === 'worker').spawnedBy, null, 'a lineage without a spawner = no known spawner');
  const long = e.agents().find(a => a.id === 'long').spawnedBy;
  assert.ok([...long.label].length <= 120 && !long.label.includes('synthetic-secret'), 'the engine bounds and redacts any adapter label');
  assert.equal(e.ingestCanonical('sessions.snapshot', [session('pm:main', 'pm', 'primary'), session('child', 'pm', 'conversation', { spawnedBy: { agentId: null, sessionKey: 'pm:main', via: 'subagent-tool', label: 'Review' } })]).ok, true);
  assert.equal(e.session('child').spawnedBy.sessionKey, 'pm:main');
});

test('multi-runtime: native lineage refs are scoped to their instance, cross-runtime canonical refs pass through', () => {
  const pmEngine = createEngine({ adapter: adapter('chat'), now: () => NOW, runtimeId: 'legacy' });
  pmEngine.ingestCanonical('agents', [agent('pm', { isPrimary: true, mainSessionKey: 'pm:main' })]);
  pmEngine.ingestCanonical('sessions.snapshot', [session('pm:main', 'pm', 'primary')]);
  const pmSession = scopedId('legacy', 'session', 'pm:main');
  const coder = createEngine({ adapter: adapter('coder'), now: () => NOW, runtimeId: 'coder' });
  coder.ingestCanonical('agents', [agent('proj', { spawnedBy: { agentId: null, sessionKey: pmSession, via: 'orchestrator', label: 'Builder' } })]);
  coder.ingestCanonical('sessions.snapshot', [session('s1', 'proj', 'conversation', { spawnedBy: { agentId: 'proj', sessionKey: null, via: 'subagent-tool', label: null } })]);
  const m = createMultiEngine({ instances: [{ id: 'legacy', adapter: 'chat', enabled: true, engine: pmEngine }, { id: 'coder', adapter: 'coder', enabled: true, engine: coder }], primary: scopedId('legacy', 'agent', 'pm') });
  const proj = m.agents().find(a => a.id === scopedId('coder', 'agent', 'proj'));
  assert.equal(proj.spawnedBy.sessionKey, pmSession, 'cross-runtime ref kept as is');
  const s1 = m.session(scopedId('coder', 'session', 's1'));
  assert.equal(s1.spawnedBy.agentId, scopedId('coder', 'agent', 'proj'), 'native ref scoped to its instance');
  assert.equal(m.agents().find(a => a.id === scopedId('legacy', 'agent', 'pm')).spawnedBy, null, 'no known spawner');
});

test('office: a spawned occupant names its parent occupant for sessions readers only; schema-valid in 2.x and 3.0', () => {
  const e = createEngine({ adapter: adapter('synthetic'), now: () => NOW, primary: 'pm' });
  e.ingestCanonical('agents', [agent('pm', { isPrimary: true, mainSessionKey: 'pm:main' }), agent('helper', { spawnedBy: { agentId: 'pm', sessionKey: null, via: 'orchestrator', label: null } })]);
  e.ingestCanonical('sessions.snapshot', [
    session('pm:main', 'pm', 'primary'),
    session('task-1', 'pm', 'conversation', { spawnedBy: { agentId: null, sessionKey: 'pm:main', via: 'subagent-tool', label: 'Review' } }),
    session('helper:main', 'helper', 'conversation'),
  ]);
  e.setGatewayConnected(true);
  const build = (canReadSessions, P = project3x) => buildOfficeVM({ engine: e, now: NOW, tracker: createStateTracker(), canReadSessions, configuredAgents: { helper: 'Helper' }, actorOf: () => ({ kind: 'system', name: 'System' }), P });
  const vm = build(true);
  const task = vm.occupants.find(o => o.sessionKey === 'task-1');
  assert.equal(task.parentId, 'primary', 'session lineage → the spawning session\'s occupant');
  assert.equal(vm.occupants.find(o => o.id === 'agent:helper').parentId, 'primary', 'agent lineage → the spawner agent\'s occupant');
  assert.equal(vm.occupants.find(o => o.id === 'primary').parentId, null, 'T-0092 projects an explicit root parent');
  assert.equal(validate(schemasFor(3).office, vm).ok, true);
  const v2 = build(true, project2x);
  assert.equal(v2.occupants.find(o => o.id === 'agent:helper').parentId, 'main', '2.x occupant ids');
  assert.equal(validate(schemasFor(2).office, v2).ok, true);
  assert.ok(build(false).occupants.every(o => o.parentId === null), 'no lineage without the sessions read grant');
});
