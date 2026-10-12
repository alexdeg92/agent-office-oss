'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { buildOfficeVM, createStateTracker } = require('../../src/api/v2/vm/office');
const { project3x } = require('../../src/api/v2/project3x');
const { project2x } = require('../../src/api/v2/project2x');
const { schemasFor } = require('../../src/api/v2/vm/schemas');
const { validate } = require('../../src/schema');

const NOW = 1791600000000;
function makeEngine(count = 13) {
  const adapter = { id: 'synthetic', name: 'Synthetic', schemas: {}, routes: {}, normalise: { session: row => ({ session: row }), runtimeHealth: () => ({ version: null, pluginsLoaded: null, eventLoop: null }) },
    classifySession: () => ({ kind: 'unrecognized' }), capabilities: () => ({ sessions: true }) };
  const e = createEngine({ adapter, now: () => NOW, primary: 'agent-0' });
  const agents = Array.from({ length: count }, (_, i) => ({ id: `agent-${i}`, name: i === 0 ? 'Primary' : i === 1 || i === 2 ? 'Atlas' : `Agent ${i}`, displayName: i === 0 ? 'Synthetic private title' : null, workspace: null,
    model: i === 0 ? { primary: 'model-synthetic', provider: 'test' } : null, fallbackModels: [], isPrimary: i === 0,
    mainSessionKey: i === 0 ? 'synthetic:session:0' : null }));
  const sessions = agents.map((a, i) => ({ key: `synthetic:session:${i}`, sessionId: null,
    class: { kind: i === 0 ? 'primary' : 'explicit', ruleId: 'synthetic', agentId: a.id, channel: null, heartbeatOf: null, background: false, rawClassification: null, ...(i ? { explicitKey: `session-${i}` } : {}) },
    displayName: null, summary: `Synthetic task ${i}`, summarySource: 'runtime', projectLabel: `project-${i}`, tokensKnown: false,
    model: a.model ? { id: a.model.primary, provider: a.model.provider } : null, provider: null,
    usage: { total: 0, input: null, output: null }, updatedAt: NOW, run: { status: 'idle', endReason: null, evidence: 'none', startedAt: null, endedAt: null,
      hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null }, costUsd: null, parentKey: null, childKeys: [], goal: null,
    cwd: null, messageCount: null, interactive: true, group: null }));
  assert.equal(e.ingestCanonical('agents', agents).ok, true);
  assert.equal(e.ingestCanonical('sessions.snapshot', sessions).ok, true);
  e.setGatewayConnected(true);
  return { e, agents };
}

test('office identity names stay unique for 12+ agents and preserve owner-configured names', () => {
  const { e, agents } = makeEngine();
  const names = Object.fromEntries(agents.slice(1).map(a => [a.id, ['agent-1', 'agent-2'].includes(a.id) ? 'Atlas' : a.name]));
  const vm = buildOfficeVM({ engine: e, now: NOW, tracker: createStateTracker(), configuredAgents: names, canReadSessions: true,
    actorOf: () => ({ kind: 'system', name: 'System' }), P: project3x });
  assert.equal(vm.occupants.length, 13);
  assert.equal(new Set(vm.occupants.map(o => o.name.toLocaleLowerCase('en'))).size, 13);
  assert.equal(vm.occupants.find(o => o.id === 'agent:agent-1').name, 'Atlas');
  assert.equal(vm.occupants.find(o => o.id === 'agent:agent-2').name, 'Atlas · 2');
  assert.equal(vm.occupants.find(o => o.id === 'agent:agent-1').summary, undefined);
  assert.equal(validate(schemasFor(3).office, vm).ok, true);
  const legacy = buildOfficeVM({ engine: e, now: NOW, tracker: createStateTracker(), configuredAgents: names, canReadSessions: true,
    actorOf: () => ({ kind: 'system', name: 'System' }), P: project2x });
  assert.equal(validate(schemasFor(2).office, legacy).ok, true);
});

test('office without logs:read projects only name and state, with no transcript-derived fields', () => {
  const { e, agents } = makeEngine(2);
  const names = { [agents[1].id]: 'Atlas' };
  const vm = buildOfficeVM({ engine: e, now: NOW, tracker: createStateTracker(), configuredAgents: names, canReadSessions: false,
    actorOf: () => ({ kind: 'system', name: 'System' }), P: project3x });
  const row = vm.occupants.find(o => o.id === 'primary');
  assert.equal(row.name, 'Primary');
  assert.equal(row.summary, undefined);
  assert.equal(row.sessionKey, null);
  assert.equal(row.tokensKnown, undefined);
  assert.equal(row.model, undefined);
  assert.equal(row.project, undefined);
  assert.equal(row.lastActivityAt, undefined);
  assert.equal(vm.kpis.find(k => k.id === 'tokens').value, null);
  assert.equal(vm.occupants.length, 2);
  assert.ok(vm.occupants.every(o => !/Synthetic private title/.test(o.name) && !o.summary && !o.model && !o.project && !o.sessionKey));
  assert.equal(vm.journal.length, 0);
});

test('Office exposes a known canonical session token total in the occupant detail', () => {
  const { e } = makeEngine(1);
  const session = e.sessions()[0];
  assert.equal(e.ingestCanonical('sessions.snapshot', [{ ...session, tokensKnown: true, usage: { ...session.usage, total: 73 } }]).ok, true);
  const vm = buildOfficeVM({ engine: e, now: NOW, tracker: createStateTracker(), canReadSessions: true,
    actorOf: () => ({ kind: 'system', name: 'System' }), P: project3x });
  const row = vm.occupants.find(o => o.id === 'primary');
  assert.equal(row.tokens, 73);
  assert.equal(row.tokensKnown, true);
});

test('an owner rename wins over the adapter display name (canonical engine rule)', () => {
  const adapter = { id: 'synthetic', name: 'Synthetic', schemas: {}, routes: {}, normalise: { session: row => ({ session: row }), runtimeHealth: () => ({ version: null, pluginsLoaded: null, eventLoop: null }) },
    classifySession: () => ({ kind: 'unrecognized' }), capabilities: () => ({ sessions: true }) };
  const e = createEngine({ adapter, now: () => NOW, primary: 'agent-0', agentNames: { 'agent-0': 'Owner name' } });
  assert.equal(e.ingestCanonical('agents', [{ id: 'agent-0', name: 'Gateway name', displayName: 'Adapter title', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: null }]).ok, true);
  e.setGatewayConnected(true);
  assert.equal(e.agents()[0].displayName, 'Owner name');
  const vm = buildOfficeVM({ engine: e, now: NOW, tracker: createStateTracker(), canReadSessions: true, actorOf: () => ({ kind: 'system', name: 'System' }), P: project3x });
  assert.equal(vm.occupants.find(o => o.id === 'primary').name, 'Owner name');
});

test('durable automatic looks coexist with configured names without exposing summaries', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { listMigrations } = require('../../src/store/db');
  const { createOfficeRepo } = require('../../src/store/repos/office');
  const db = new DatabaseSync(':memory:');
  try {
    for (const migration of listMigrations()) db.exec(migration.sql);
    const repo = createOfficeRepo(db, { now: () => NOW });
    const { e } = makeEngine(2);
    const build = (P, canReadSessions) => buildOfficeVM({ engine: e, now: NOW, tracker: createStateTracker(),
      configuredAgents: { 'agent-1': 'Owner name' }, canReadSessions, P,
      actorOf: () => ({ kind: 'system', name: 'System' }),
      assignLook: (id, index, opts) => repo.automaticLook(id, index, opts) });
    const full = build(project3x, true);
    const named = full.occupants.find(o => o.id === 'agent:agent-1');
    assert.equal(named.name, 'Owner name');
    assert.equal(named.summary, undefined);
    assert.ok(named.automaticLook);
    const canonicalLooks = full.occupants.map(o => o.automaticLook);
    for (const P of [project2x, project3x]) for (const readable of [true, false]) {
      const vm = build(P, readable);
      assert.equal(validate(schemasFor(P.version).office, vm).ok, true);
      assert.deepEqual(vm.occupants.map(o => o.automaticLook), canonicalLooks);
      assert.equal(vm.occupants[1].name, 'Owner name');
      assert.equal(vm.occupants[1].summary, undefined);
      if (!readable) assert.ok(vm.occupants.every(o => !o.sessionKey && !o.model && !o.project && !o.exchanges));
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM office_automatic_looks').get().n, 2);
    assert.ok(db.prepare('SELECT 1 FROM office_automatic_looks WHERE identity_id = ?').get('agent:agent-0'));
  } finally { db.close(); }
});
