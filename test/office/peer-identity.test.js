'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createEngine } = require('../../src/engine');
const { buildOfficeVM, createStateTracker, officeDefaults } = require('../../src/api/v2/vm/office');
const { setupLayout } = require('../../src/ops/setup-layout');
const { project3x } = require('../../src/api/v2/project3x');
const { openStore } = require('../../src/store');
const NOW = 1791288000000;
test('critic P1: foreign primary, peer and same-subject delegate retain separate identities and KPI', () => {
  const adapter = { id: 'foreign', name: 'Foreign Runtime', schemas: {}, routes: {}, normalise: { session: row => ({ session: row }), runtimeHealth: () => ({ version: null, pluginsLoaded: null, eventLoop: null }) }, classifySession: () => ({ kind: 'unrecognized' }), capabilities: () => ({ sessions: true }) };
  const engine = createEngine({ adapter, now: () => NOW, primary: 'atlas' });
  const row = (key, cls, displayName) => ({ key, sessionId: null, class: { kind: 'primary', ruleId: 'foreign', agentId: 'atlas', channel: null, heartbeatOf: null, background: false, rawClassification: null, ...cls },
    displayName, label: cls.kind === 'subagent' ? displayName : null, model: null, provider: null, usage: { total: 0, input: null, output: null }, updatedAt: NOW,
    run: { status: 'running', endReason: null, evidence: 'none', startedAt: NOW, endedAt: null, hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null },
    costUsd: null, parentKey: null, childKeys: [], goal: null, cwd: null, messageCount: null, interactive: true, group: null });
  assert.equal(engine.ingestCanonical('agents', ['atlas', 'quill'].map(id => ({ id, name: id, isPrimary: id === 'atlas', mainSessionKey: id === 'atlas' ? 'foreign:primary' : null, workspace: null, model: null, fallbackModels: [] }))).ok, true);
  assert.equal(engine.ingestCanonical('sessions.snapshot', [row('foreign:primary', {}, 'Atlas'), row('foreign:child', { kind: 'subagent', subagentId: 'quill' }, 'Research task')]).ok, true);
  engine.setGatewayConnected(true);
  const names = { atlas: 'Atlas', quill: 'Quill' }, looks = { quill: { character: 'fen', variant: null, accessories: [] } };
  const layout = { ...officeDefaults(), layout: setupLayout({ primary: 'atlas', names, looks }) };
  const vm = buildOfficeVM({ engine, now: NOW, tracker: createStateTracker(), layout, configuredAgents: names, actorOf: () => ({ kind: 'agent', id: 'atlas', name: 'Atlas' }), P: project3x });
  assert.deepEqual(vm.occupants.map(o => o.id).sort(), ['agent:quill', 'primary', 'subagent:quill']);
  assert.equal(vm.occupants.find(o => o.id === 'agent:quill').role, 'agent');
  assert.equal(vm.occupants.find(o => o.id === 'subagent:quill').name, 'Research task');
  assert.equal(vm.kpis.find(k => k.id === 'subagents').value, 1);
});
test('critic P1: saved onboarding peer rules migrate once, ordinary delegate rules stay intact', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-peer-rules-')); const store = openStore({ dir: tmp, instance: 'test' });
  try {
    const layout = setupLayout({ primary: 'atlas', names: { quill: 'Quill' }, looks: { quill: { character: 'fen', variant: null, accessories: [] } } });
    const rule = layout.agents.find(a => a.agentId === 'agent:quill'); rule.agentId = 'subagent:quill'; rule.match.kind = 'subagent';
    layout.agents.unshift({ ...structuredClone(rule), agentId: 'subagent:actual-child', name: 'Real task' });
    store.office.active(() => layout);
    assert.equal(store.office.migrateConfiguredPeers({ quill: 'Quill' }), true);
    assert.ok(store.office.active().data.agents.some(a => a.agentId === 'agent:quill' && a.match.kind === 'agent'));
    assert.ok(store.office.active().data.agents.some(a => a.agentId === 'subagent:actual-child'));
    assert.equal(store.office.migrateConfiguredPeers({ quill: 'Quill' }), false);
  } finally { store.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
