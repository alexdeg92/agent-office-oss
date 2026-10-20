'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const M = require('../../src/model');
const { TABLES, MAX_BYTES_PER_SOURCE, MAX_PARITY_KEYS, MAX_PARITY_SURFACES, boundedJsonBytes } = require('../../src/engine/orchestration-sources');

const NOW = 1800000000000;
const sourceRows = () => ({
  hosts: [{ id: 'host-a', label: null, platform: 'linux', sourceStatus: 'available', observedAt: NOW }],
  orchestrators: [{ id: 'orch-a', hostId: 'host-a', kind: 'source', label: null, sourceStatus: 'available', observedAt: NOW }],
  hostAgents: [{ id: 'host-agent-a', hostId: 'host-a', orchestratorId: 'orch-a', name: 'Builder', runtimeKind: 'codex',
    role: 'delegate', status: 'working', observedAt: NOW, staleAfter: NOW + 1000 }],
  identityLinks: [{ hostAgentId: 'host-agent-a', agentId: 'runtime:codex:agent:builder', evidence: 'shared-runtime-session-ref', confidence: 'exact' }],
  teams: [{ id: 'team-a', storeId: 'store-a', label: 'Delivery', status: 'active', observedAt: NOW }],
  members: [{ id: 'member-a', teamId: 'team-a', name: 'Builder', roleKind: 'lead', roleLabel: 'lead', roleEvidence: 'explicit',
    sourceAgentName: 'Builder', runtimeKind: 'codex', hostAgentId: 'host-agent-a', parentMemberId: null, sessionStatus: 'known', status: 'active', spawnedBy: null }],
  tasks: [{ id: 'task-a', teamId: 'team-a', title: 'Review change', state: 'working', priority: 1, ownerMemberId: 'member-a',
    reviewerMemberIds: [], createdAt: NOW, updatedAt: NOW, commit: null, reportPresent: false, briefPresent: true, messageCount: 0 }],
  reviews: [], teamMessages: [],
});

function setup() {
  const engine = createEngine({ now: () => NOW });
  const issues = [];
  assert.equal(engine.registerOrchestrationSource('synthetic-source', {
    capabilities: Object.freeze({ teams: { read: true } }),
    async readSnapshot() { return sourceRows(); },
  }), true);
  engine.on('change', event => { if (event.type === 'OrchestrationSource') issues.push(event.type); });
  return { engine, issues };
}

test('synthetic source fixture rows satisfy each canonical entity contract', t => {
  for (const [table, [entityName]] of Object.entries(TABLES)) {
    for (const row of sourceRows()[table]) {
      const checked = M[entityName].check(row);
      assert.equal(checked.ok, true, `${table}: ${checked.issues.map(issue => issue.path + ' ' + issue.detail).join(', ')}`);
    }
  }
  assert.equal(M.Host.check({ ...sourceRows().hosts[0], label: 'x'.repeat(161) }).ok, false);
  assert.equal(M.HostAgent.check({ ...sourceRows().hostAgents[0], name: 'x'.repeat(121) }).ok, false);
  assert.equal(M.TeamMember.check({ ...sourceRows().members[0], sourceAgentName: 'x'.repeat(121) }).ok, false);
});

test('engine admits source snapshots as canonical rows without changing runtime output', async t => {
  const { engine, issues } = setup(); t.after(() => engine.close());
  assert.deepEqual(engine.agents(), []);
  const result = await engine.refreshOrchestrationSource('synthetic-source');
  assert.deepEqual(result, { ok: true, invalidRows: 0 });
  const snapshot = engine.orchestrationSnapshot();
  assert.equal(snapshot.hostAgents[0].status, 'working');
  assert.equal(snapshot.members[0].roleKind, 'lead');
  assert.equal(snapshot.tasks[0].state, 'working');
  assert.deepEqual(engine.agents(), [], 'source ingestion does not alter runtime agents or existing public projections');
  assert.equal(issues.length, 1);
  assert.deepEqual(engine.orchestrationSourceStatus()[0].counts, {
    hosts: 1, orchestrators: 1, hostAgents: 1, identityLinks: 1, teams: 1, members: 1, tasks: 1, reviews: 0, teamMessages: 0,
  });
});

test('canonical entity instances are measured without serialization before admission', t => {
  const { engine } = setup(); t.after(() => engine.close());
  const rows = sourceRows();
  rows.hosts = [M.Host.from(rows.hosts[0])];
  assert.equal(engine.ingestOrchestrationSource('synthetic-source', rows, { observedAt: NOW }).ok, true);
});

test('shared acyclic values are measured more than once like JSON', t => {
  const { engine } = setup(); t.after(() => engine.close());
  const rows = sourceRows();
  const sharedLineage = { agentId: 'agent-parent', sessionKey: null, via: 'orchestrator', label: null };
  rows.hostAgents[0].spawnedBy = sharedLineage;
  rows.hostAgents.push({ ...rows.hostAgents[0], id: 'host-agent-b', spawnedBy: sharedLineage });
  assert.equal(engine.ingestOrchestrationSource('synthetic-source', rows, { observedAt: NOW }).ok, true);
  assert.equal(engine.orchestrationSnapshot().hostAgents.length, 2);
});

test('byte estimates count JSON-escaped lone surrogates at their actual six-byte size', () => {
  assert.equal(JSON.stringify('\uD800').length, 8);
  assert.equal(boundedJsonBytes('\uD800', 7), null);
  assert.equal(boundedJsonBytes('\uD800', 8), 8);
  const key = { ['\uD800']: 1 };
  assert.equal(JSON.stringify(key).length, 12);
  assert.equal(boundedJsonBytes(key, 11), null);
  assert.equal(boundedJsonBytes(key, 12), 12);
});

test('undefined object metadata is omitted for sizing; undefined row fields remain partial row errors', t => {
  const { engine } = setup(); t.after(() => engine.close());
  const rows = sourceRows();
  rows.status = undefined;
  rows.members.push({ ...rows.members[0], id: 'member-invalid', runtimeKind: undefined });
  const result = engine.ingestOrchestrationSource('synthetic-source', rows, { observedAt: NOW });
  assert.deepEqual(result, { ok: true, invalidRows: 1 });
  assert.equal(engine.orchestrationSourceStatus()[0].status, 'available');
  assert.deepEqual(engine.orchestrationSnapshot().members.map(member => member.id), ['member-a']);
});

test('partial canonical row failures are counted and do not erase valid source rows', t => {
  const { engine } = setup(); t.after(() => engine.close());
  const rows = sourceRows(); rows.members.push({ id: 'hostile', role: 'provider-specific' });
  assert.deepEqual(engine.ingestOrchestrationSource('synthetic-source', rows, { observedAt: NOW }), { ok: true, invalidRows: 1 });
  assert.equal(engine.orchestrationSnapshot().members.length, 1);
  assert.equal(engine.orchestrationSourceStatus()[0].invalidRows, 1);
  assert.equal(engine.ingestOrchestrationSource('synthetic-source', null).ok, false);
  assert.equal(engine.orchestrationSourceStatus()[0].status, 'stale');
  assert.equal(engine.orchestrationSnapshot().members.length, 1, 'last admitted generation remains available as stale data');
});

test('private cross-source refs stay outside canonical rows, diagnostics, and parity counters', t => {
  const { engine } = setup(); t.after(() => engine.close());
  const rows = sourceRows();
  Object.defineProperty(rows, 'privateRefs', { value: { 'member-a': { runtimeKind: 'codex', sessionRef: 'private-session-uuid', paneRef: 'private-pane-id' } } });
  assert.equal(engine.ingestOrchestrationSource('synthetic-source', rows, { observedAt: NOW }).ok, true);
  const snapshotText = JSON.stringify(engine.orchestrationSnapshot());
  assert.ok(!snapshotText.includes('private-session-uuid'));
  assert.ok(!snapshotText.includes('private-pane-id'));
  assert.equal(engine.orchestrationSourcePrivateRefs('synthetic-source')['member-a'].sessionRef, 'private-session-uuid');
  const parity = engine.compareOrchestrationProjection('office', [{ id: 'opaque-1', state: 'working', name: 'private name' }],
    [{ id: 'opaque-1', state: 'idle', name: 'other private name' }], ['id', 'state']);
  assert.deepEqual(parity, { compared: 1, oldCount: 1, newCount: 1, changedRows: 1, overflowKeys: 0, equal: false });
  assert.deepEqual(engine.orchestrationParityCounters(), { office: { comparisons: 1, mismatches: 1, changedRows: 1, overflowKeys: 0, overflowSurfaces: 0 } });
  assert.equal(engine.compareOrchestrationProjection('office', [], [], ['name']), null, 'non-approved comparison fields are rejected');
  assert.ok(!JSON.stringify(engine.orchestrationParityCounters()).includes('private'));
});

test('disabled sources expose no records or private references and close their adapters', t => {
  const engine = createEngine(); t.after(() => engine.close());
  let closed = 0;
  assert.equal(engine.registerOrchestrationSource('synthetic-source', { capabilities: {}, readSnapshot: async () => sourceRows(), close: () => { closed++; } }, { enabled: false }), true);
  assert.deepEqual(engine.ingestOrchestrationSource('synthetic-source', sourceRows()), { ok: false, issue: 'source-unavailable' });
  assert.equal(engine.orchestrationSnapshot().members.length, 0);
  assert.equal(engine.setOrchestrationSourceEnabled('synthetic-source', true), true);
  engine.close();
  assert.equal(closed, 1);
});

test('source capability declarations are copied, bounded and kept separate from canonical rows', t => {
  const engine = createEngine(); t.after(() => engine.close());
  const capabilities = { teams: { read: true }, tasks: { read: true, write: false } };
  assert.equal(engine.registerOrchestrationSource('synthetic-source', {
    capabilities, readSnapshot: async () => sourceRows(),
  }), true);
  capabilities.teams.read = false;
  assert.deepEqual(JSON.parse(JSON.stringify(engine.orchestrationSourceCapabilities('synthetic-source'))), {
    teams: { read: true }, tasks: { read: true, write: false },
  });
  assert.equal(engine.registerOrchestrationSource('bad-capabilities', {
    capabilities: { declaration: 'x'.repeat(161) }, readSnapshot: async () => sourceRows(),
  }), false);
  assert.equal(JSON.stringify(engine.orchestrationSnapshot()).includes('capabilities'), false);
});

test('snapshot admission has an aggregate row bound and retains the prior generation on overflow', t => {
  const { engine } = setup(); t.after(() => engine.close());
  assert.equal(engine.ingestOrchestrationSource('synthetic-source', sourceRows()).ok, true);
  const oversized = sourceRows();
  oversized.teamMessages = Array.from({ length: 5000 }, (_, i) => ({ id: `message-${i}`, teamId: 'team-a', taskId: null,
    fromMemberId: null, toMemberId: null, createdAt: NOW, bodyPresent: false }));
  // The canonical table size is valid, but the combined snapshot exceeds the total admission budget.
  oversized.reviews = Array.from({ length: 5000 }, (_, i) => ({ id: `review-${i}`, taskId: 'task-a', reviewerMemberId: null,
    verdict: 'pending', createdAt: NOW, reportPresent: false }));
  assert.deepEqual(engine.ingestOrchestrationSource('synthetic-source', oversized), { ok: false, issue: 'row-limit' });
  assert.equal(engine.orchestrationSnapshot().members.length, 1);
  assert.equal(engine.orchestrationSourceStatus()[0].status, 'stale');
});

test('source and private-index byte caps reject atomically and retain the last good generation', t => {
  const { engine } = setup(); t.after(() => engine.close());
  assert.equal(engine.ingestOrchestrationSource('synthetic-source', sourceRows(), { observedAt: NOW }).ok, true);
  const oversized = sourceRows();
  oversized.hosts[0].label = 'x'.repeat(MAX_BYTES_PER_SOURCE);
  assert.deepEqual(engine.ingestOrchestrationSource('synthetic-source', oversized, { observedAt: NOW }),
    { ok: false, issue: 'source-byte-limit' });
  assert.equal(engine.orchestrationSnapshot().hosts[0].label, null);
  const tooManyRefs = sourceRows();
  Object.defineProperty(tooManyRefs, 'privateRefs', { value: Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`member-${i}`, { sessionRef: 's' }])) });
  assert.deepEqual(engine.ingestOrchestrationSource('synthetic-source', tooManyRefs, { observedAt: NOW }),
    { ok: false, issue: 'invalid-private-index' });
  const longRef = sourceRows();
  Object.defineProperty(longRef, 'privateRefs', { value: { 'member-a': { sessionRef: 's'.repeat(513) } } });
  assert.deepEqual(engine.ingestOrchestrationSource('synthetic-source', longRef, { observedAt: NOW }),
    { ok: false, issue: 'invalid-private-index' });
  assert.equal(engine.orchestrationSnapshot().members[0].id, 'member-a');
  assert.equal(engine.orchestrationSourceStatus()[0].status, 'stale');
});

test('oversized snapshots abort incremental measurement before later fields or JSON serialization', t => {
  const { engine } = setup(); t.after(() => engine.close());
  const snapshot = Object.fromEntries(Object.keys(TABLES).map(table => [table, []]));
  const huge = 'x'.repeat(MAX_BYTES_PER_SOURCE + 100);
  const oversized = { id: 'host-a' };
  let laterFieldRead = false;
  Object.defineProperty(oversized, 'label', { enumerable: true, get() { return huge; } });
  Object.defineProperty(oversized, 'later', { enumerable: true, get() { laterFieldRead = true; return 'must not be visited'; } });
  snapshot.hosts.push(oversized);
  const stringify = JSON.stringify;
  const byteLength = Buffer.byteLength;
  const codePointAt = String.prototype.codePointAt;
  let oversizedStringByteLengthCalls = 0, scannedOversizedChars = 0;
  JSON.stringify = () => { throw new Error('snapshot serialization must not be used'); };
  Buffer.byteLength = function (value, ...args) {
    if (value === huge) oversizedStringByteLengthCalls++;
    return byteLength.call(this, value, ...args);
  };
  String.prototype.codePointAt = function (index) {
    if (this.length > MAX_BYTES_PER_SOURCE) scannedOversizedChars++;
    return codePointAt.call(this, index);
  };
  let result;
  try { result = engine.ingestOrchestrationSource('synthetic-source', snapshot, { observedAt: NOW }); }
  finally { JSON.stringify = stringify; Buffer.byteLength = byteLength; String.prototype.codePointAt = codePointAt; }
  assert.deepEqual(result, { ok: false, issue: 'source-byte-limit' });
  assert.equal(laterFieldRead, false, 'measurement stops at the first field that exceeds the admission budget');
  assert.equal(oversizedStringByteLengthCalls, 0, 'the full oversized string is never measured in one operation');
  assert.ok(scannedOversizedChars < huge.length, 'string scanning stops at the remaining byte budget');
});

test('registry total bytes are bounded across sources', t => {
  const engine = createEngine({ now: () => NOW }); t.after(() => engine.close());
  const rows = { ...sourceRows(), hosts: Array.from({ length: 5000 }, (_, i) => ({ id: `host-${i}`, label: 'x'.repeat(120),
    platform: 'linux', sourceStatus: 'available', observedAt: NOW })) };
  for (let i = 0; i < 9; i++) {
    const id = `source-${i}`;
    assert.equal(engine.registerOrchestrationSource(id, { capabilities: {}, readSnapshot: async () => rows }), true);
  }
  let accepted = 0;
  for (let i = 0; i < 9; i++) {
    const result = engine.ingestOrchestrationSource(`source-${i}`, rows, { observedAt: NOW });
    if (result.ok) accepted++;
    else assert.equal(result.issue, 'registry-byte-limit');
  }
  assert.ok(accepted > 0 && accepted < 9, `expected a bounded subset, accepted ${accepted}`);
});

test('live host freshness rejects excessive future skew and leases while counting invalid rows', t => {
  const { engine } = setup(); t.after(() => engine.close());
  const future = sourceRows();
  future.hostAgents[0].observedAt = NOW + 60_001;
  future.hostAgents[0].staleAfter = NOW + 61_001;
  assert.equal(engine.ingestOrchestrationSource('synthetic-source', future, { observedAt: NOW }).invalidRows, 1);
  assert.equal(engine.orchestrationSnapshot().hostAgents.length, 0);
  const longLease = sourceRows();
  longLease.hostAgents[0].staleAfter = NOW + 120_001;
  assert.equal(engine.ingestOrchestrationSource('synthetic-source', longLease, { observedAt: NOW }).invalidRows, 1);
  assert.equal(engine.orchestrationSnapshot().hostAgents.length, 0);
});

test('source refresh generations are monotonic and older pending reads cannot overwrite newer data', async t => {
  const engine = createEngine({ now: () => NOW }); t.after(() => engine.close());
  const pending = [];
  assert.equal(engine.registerOrchestrationSource('race-source', { capabilities: {}, readSnapshot: () => new Promise(resolve => pending.push(resolve)) }), true);
  const older = engine.refreshOrchestrationSource('race-source');
  const newer = engine.refreshOrchestrationSource('race-source');
  const newRows = sourceRows(); newRows.teams[0].label = 'newer'; newRows.observedAt = NOW + 20;
  pending[1](newRows);
  assert.equal((await newer).ok, true);
  const oldRows = sourceRows(); oldRows.teams[0].label = 'older'; oldRows.observedAt = NOW + 10;
  pending[0](oldRows);
  assert.deepEqual(await older, { ok: false, issue: 'stale-generation' });
  assert.equal(engine.orchestrationSnapshot().teams[0].label, 'newer');
});

test('a replaced source adapter cannot admit its pending generation into the replacement', async t => {
  const engine = createEngine({ now: () => NOW }); t.after(() => engine.close());
  let resolveOld;
  const oldAdapter = { capabilities: {}, readSnapshot: () => new Promise(resolve => { resolveOld = resolve; }) };
  assert.equal(engine.registerOrchestrationSource('replace-source', oldAdapter), true);
  const pending = engine.refreshOrchestrationSource('replace-source');
  const replacement = { capabilities: {}, readSnapshot: async () => { const rows = sourceRows(); rows.teams[0].label = 'replacement'; return rows; } };
  assert.equal(engine.registerOrchestrationSource('replace-source', replacement), true);
  assert.equal((await engine.refreshOrchestrationSource('replace-source')).ok, true);
  const stale = sourceRows(); stale.teams[0].label = 'old'; resolveOld(stale);
  assert.deepEqual(await pending, { ok: false, issue: 'stale-generation' });
  assert.equal(engine.orchestrationSnapshot().teams[0].label, 'replacement');
});

test('parity detects visible reorder and rolls excess keys and surfaces into bounded counters', t => {
  const { engine } = setup(); t.after(() => engine.close());
  const left = [{ id: 'a', state: 'working' }, { id: 'b', state: 'idle' }];
  const right = [...left].reverse();
  const reorder = engine.compareOrchestrationProjection('office', left, right, ['id', 'state']);
  assert.equal(reorder.equal, false);
  assert.equal(reorder.changedRows, 2);
  const many = Array.from({ length: MAX_PARITY_KEYS + 10 }, (_, i) => ({ id: `agent-${i}`, state: 'working' }));
  const changed = many.map(row => ({ ...row, state: 'idle' }));
  const bounded = engine.compareOrchestrationProjection('office', many, changed, ['id', 'state']);
  assert.equal(bounded.changedRows, MAX_PARITY_KEYS);
  assert.equal(bounded.overflowKeys, 10);
  for (let i = 0; i < MAX_PARITY_SURFACES + 5; i++) {
    engine.compareOrchestrationProjection(`surface-${i}`, [], [], ['id']);
  }
  const counters = engine.orchestrationParityCounters();
  assert.equal(Object.keys(counters).length, MAX_PARITY_SURFACES + 1);
  assert.equal(counters.$overflow.overflowSurfaces, 6);
  assert.equal(counters.office.overflowKeys, 10);
});
