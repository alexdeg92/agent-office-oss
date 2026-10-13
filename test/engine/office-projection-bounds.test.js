'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { createSessionsRegistry } = require('../../src/engine/sessions-registry');
const { buildOfficeVM, createStateTracker } = require('../../src/api/v2/vm/office');
const { project2x } = require('../../src/api/v2/project2x');
const { project3x } = require('../../src/api/v2/project3x');
const { schemasFor } = require('../../src/api/v2/vm/schemas');
const { 'gw.rpc.sessions.list': sessionListSchema } = require('../../src/adapters/openclaw/schemas/gateway.v1');
const { MAX_SESSION_PAGE_SIZE, MAX_OFFICE_OCCUPANTS, MAX_RUNTIME_SESSIONS } = require('../../src/engine/session-limits');
const { validate } = require('../../src/schema');

const NOW = Date.UTC(2026, 9, 12, 12);
const adapter = { id: 'synthetic', name: 'Synthetic', schemas: {}, routes: {}, normalise: { session: row => ({ session: row }), runtimeHealth: () => ({ version: null, pluginsLoaded: null, eventLoop: null }) },
  classifySession: () => ({ kind: 'unrecognized' }) };
function session(key, kind = 'subagent') {
  return { key, sessionId: null, class: { kind, ruleId: 'fixture', agentId: 'agent', subagentId: kind === 'subagent' ? key : null, channel: null, heartbeatOf: null, background: false, rawClassification: null },
    displayName: null, summary: null, model: null, provider: null, usage: { total: 1, input: null, output: null }, updatedAt: NOW,
    run: { status: 'running', endReason: null, evidence: 'status-field', evidenceLevel: 'verified', observedAt: NOW, expiresAt: null,
      startedAt: NOW - 1000, endedAt: null, hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null },
    costUsd: null, parentKey: null, childKeys: [], goal: null, cwd: null, messageCount: null, interactive: true, group: null };
}
const agent = { id: 'agent', name: 'Synthetic agent', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: 'main' };

test('office projections bound large live inventories and report every omitted occupant in v2 and v3', () => {
  const engine = createEngine({ adapter, now: () => NOW, primary: 'agent' });
  assert.equal(engine.ingestCanonical('agents', [agent]).ok, true);
  const sessions = [session('main', 'primary'), ...Array.from({ length: MAX_RUNTIME_SESSIONS - 1 }, (_, i) => session(`worker-${i}`))];
  const ingest = engine.ingestCanonical('sessions.snapshot', sessions);
  assert.equal(ingest.ok, true, `supported inventory remains ingestible: ${JSON.stringify(ingest.issues.slice(0, 2))}`);
  engine.setGatewayConnected(true);

  for (const P of [project2x, project3x]) {
    const vm = buildOfficeVM({ engine, now: NOW, tracker: createStateTracker(), canReadSessions: true,
      configuredAgents: {}, actorOf: () => ({ kind: 'system', name: 'System' }), P });
    assert.equal(vm.occupants.length, MAX_OFFICE_OCCUPANTS, `${P.version}: the office projection has a hard row cap`);
    assert.equal(vm.occupantOverflowCount, MAX_RUNTIME_SESSIONS - MAX_OFFICE_OCCUPANTS,
      `${P.version}: truncation is explicit and accurately counted`);
    assert.equal(validate(schemasFor(P.version).office, vm).ok, true, `${P.version}: bounded office remains schema-valid`);
    assert.ok(Buffer.byteLength(JSON.stringify(vm)) < 1024 * 1024, `${P.version}: payload stays below one MiB`);
    assert.equal(vm.occupants[0].id, P.occupantId('primary'), `${P.version}: the primary is retained`);
  }
});

test('canonical session snapshots above the supported inventory are rejected before row normalization', () => {
  const engine = createEngine({ adapter, now: () => NOW });
  const tooMany = Array.from({ length: MAX_RUNTIME_SESSIONS + 1 }, (_, i) => session(`worker-${i}`));
  const result = engine.ingestCanonical('sessions.snapshot', tooMany);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.path === '$.sessions' && /supported limit/.test(issue.detail)));
  assert.equal(engine.sessions().length, 0);
});

test('an unfinished native page cannot grow the retained canonical inventory beyond its bound', () => {
  const registry = createSessionsRegistry({ now: () => NOW, normalise: row => ({ session: row }), classify: () => ({ kind: 'unrecognized' }) });
  const issues = [];
  const record = issue => issues.push(issue);
  const sessions = Array.from({ length: MAX_RUNTIME_SESSIONS }, (_, i) => session(`canonical-${i}`));
  registry.acceptPage({ sessions, hasMore: false, totalCount: sessions.length }, 0, record, { canonical: true, acquisitionGeneration: 1 });
  assert.equal(registry.list().length, MAX_RUNTIME_SESSIONS);
  for (let cycle = 0; cycle < 8; cycle++) {
    const incoming = Array.from({ length: MAX_SESSION_PAGE_SIZE }, (_, i) => session(`interrupted-${cycle}-${i}`));
    incoming[0] = session('canonical-0');
    incoming[0].usage.total = cycle + 10;
    registry.acceptPage({ sessions: incoming, hasMore: true, nextOffset: incoming.length }, 0, record,
      { canonical: true, acquisitionGeneration: cycle + 2 });
    assert.equal(registry.list().length, MAX_RUNTIME_SESSIONS, `cycle ${cycle} keeps the retained inventory bounded`);
    assert.equal(registry.meta().complete, false, `cycle ${cycle} marks the current observation partial`);
    assert.equal(registry.get('canonical-0')?.usage.total, cycle + 10, `cycle ${cycle} applies existing-key updates`);
  }
  const replacement = Array.from({ length: 40 }, (_, i) => session(`replacement-${i}`));
  registry.acceptPage({ sessions: replacement, hasMore: false, totalCount: replacement.length }, 0, record,
    { canonical: true, acquisitionGeneration: 20 });
  assert.equal(registry.list().length, replacement.length, 'a later complete snapshot reconciles the old inventory');
  assert.equal(registry.get('replacement-0')?.key, 'replacement-0');
  assert.equal(registry.get('canonical-0'), null);
});

test('an invalid canonical row in a complete page cannot erase the last valid snapshot', () => {
  const registry = createSessionsRegistry({ now: () => NOW, normalise: row => ({ session: row }), classify: () => ({ kind: 'unrecognized' }) });
  const issues = [];
  const record = issue => issues.push(issue);
  const seed = [session('kept-1'), session('kept-2')];
  registry.acceptPage({ sessions: seed, hasMore: false, totalCount: 2 }, 0, record, { canonical: true, acquisitionGeneration: 1 });
  assert.deepEqual(registry.list().map(row => row.key), ['kept-1', 'kept-2']);
  assert.equal(registry.meta().complete, true);

  const malformed = session('replacement');
  malformed.usage = { total: -1, input: null, output: null };
  registry.acceptPage({ sessions: [malformed], hasMore: false, totalCount: 1 }, 0, record, { canonical: true, acquisitionGeneration: 2 });

  assert.deepEqual(registry.list().map(row => row.key), ['kept-1', 'kept-2'], 'invalid replacement has no deletion authority');
  assert.equal(registry.meta().complete, false, 'the rejected observation is not marked complete');
  assert.ok(issues.some(issue => issue.code === 'shape.invalid' && issue.path.startsWith('$.canonical')));

  const mixedUpdate = session('kept-1'); mixedUpdate.usage.total = 99;
  const invalidUpdate = session('invalid-update'); invalidUpdate.usage.total = -1;
  registry.acceptPage({ sessions: [mixedUpdate, invalidUpdate], hasMore: false, totalCount: 2 }, 0, record, { canonical: true, acquisitionGeneration: 3 });
  assert.deepEqual(registry.list().map(row => row.key), ['kept-1', 'kept-2'], 'a mixed valid/invalid replacement is rejected atomically');
  assert.equal(registry.get('kept-1').usage.total, 1, 'a valid update in a rejected replacement does not partially commit');
  assert.equal(registry.meta().complete, false);

  registry.acceptPage({ sessions: [session('partial-valid')], hasMore: true, nextOffset: 1 }, 0, record, { canonical: true, acquisitionGeneration: 4 });
  const invalidLaterPage = session('invalid-later-page'); invalidLaterPage.usage.total = -1;
  registry.acceptPage({ sessions: [invalidLaterPage], hasMore: false, totalCount: 2 }, 1, record, { canonical: true, acquisitionGeneration: 4 });
  assert.deepEqual(new Set(registry.list().map(row => row.key)), new Set(['kept-1', 'kept-2', 'partial-valid']),
    'invalid final page cannot authorize deletion of rows absent from the walk');
  assert.equal(registry.meta().complete, false);

  registry.acceptPage({ sessions: [session('replacement-valid')], hasMore: false, totalCount: 1 }, 0, record, { canonical: true, acquisitionGeneration: 5 });
  assert.deepEqual(registry.list().map(row => row.key), ['replacement-valid'], 'a later valid snapshot can reconcile the retained rows');
  assert.equal(registry.meta().complete, true);
});

test('rejected changed rows and descriptions roll back before later healthy updates and snapshots', () => {
  const makeRegistry = () => createSessionsRegistry({ now: () => NOW, normalise: row => ({ session: row }), classify: () => ({ kind: 'unrecognized' }) });
  const record = () => {};
  for (const mode of ['changed', 'description']) {
    const registry = makeRegistry(), canonical = mode === 'changed';
    registry.acceptPage({ sessions: [session('main', 'primary'), session('bad-key')], hasMore: false, totalCount: 2 }, 0, record,
      { canonical, acquisitionGeneration: 1 });
    const invalid = session('bad-key'); invalid.usage.total = -1;
    if (mode === 'changed') registry.acceptChanged(invalid, record, { canonical: true, sourceOrder: 2 });
    else registry.acceptDescription(invalid, record, { sourceOrder: 2 });

    const healthy = session('main', 'primary'); healthy.usage.total = 99;
    registry.acceptChanged(healthy, record, { canonical: true, sourceOrder: 3 });
    assert.equal(registry.get('main')?.usage.total, 99, `${mode}: invalid row cannot poison an unrelated update`);
    assert.equal(registry.get('bad-key')?.usage.total, 1, `${mode}: last accepted row remains available`);
    assert.deepEqual(registry.list().map(row => row.key), ['main', 'bad-key']);

    const recovered = [session('main', 'primary'), session('bad-key')]; recovered[0].usage.total = 101;
    registry.acceptPage({ sessions: recovered, hasMore: false, totalCount: 2 }, 0, record, { canonical: true, acquisitionGeneration: 4 });
    assert.equal(registry.meta().complete, true, `${mode}: a later valid complete snapshot recovers normally`);
    assert.equal(registry.get('main')?.usage.total, 101);
  }
});

test('changed rows and descriptions share the retained session capacity', () => {
  const makeRegistry = () => createSessionsRegistry({ now: () => NOW, normalise: row => ({ session: row }), classify: () => ({ kind: 'unrecognized' }) });
  const record = () => {};
  const seed = Array.from({ length: MAX_RUNTIME_SESSIONS }, (_, i) => session(`retained-${i}`));
  const changed = makeRegistry();
  changed.acceptPage({ sessions: seed, hasMore: false, totalCount: seed.length }, 0, record, { canonical: true, acquisitionGeneration: 1 });
  changed.acceptChanged(session('changed-overflow'), record, { canonical: true, sourceOrder: 2 });
  assert.equal(changed.list().length, MAX_RUNTIME_SESSIONS);
  assert.equal(changed.get('changed-overflow'), null);

  const described = makeRegistry();
  described.acceptPage({ sessions: seed, hasMore: false, totalCount: seed.length }, 0, record, { canonical: true, acquisitionGeneration: 1 });
  described.acceptDescription(session('description-overflow'), record, { sourceOrder: 2 });
  assert.equal(described.list().length, MAX_RUNTIME_SESSIONS);
  assert.equal(described.get('description-overflow'), null);
});

test('restricted office projections withhold the exact hidden occupant overflow', () => {
  const engine = createEngine({ adapter, now: () => NOW, primary: 'agent' });
  assert.equal(engine.ingestCanonical('agents', [agent]).ok, true);
  const rows = [session('main', 'primary'), ...Array.from({ length: 80 }, (_, i) => {
    const row = session(`private-${i}`, 'conversation-direct');
    row.class.agentId = 'agent';
    return row;
  })];
  assert.equal(engine.ingestCanonical('sessions.snapshot', rows).ok, true);
  engine.setGatewayConnected(true);
  for (const P of [project2x, project3x]) {
    const restricted = buildOfficeVM({ engine, now: NOW, tracker: createStateTracker(), canReadSessions: false,
      configuredAgents: {}, actorOf: () => ({ kind: 'system', name: 'System' }), P });
    assert.equal(restricted.occupants.length, 1, 'only the primary remains visible without session access');
    assert.equal(restricted.conversationCount, 0);
    assert.equal(Object.hasOwn(restricted, 'occupantOverflowCount'), false, `${P.version}: hidden session cardinality is not projected`);
  }
});

test('oversized gateway pages are rejected before per-row validation', () => {
  const result = validate(sessionListSchema.schema, { sessions: Array.from({ length: 301 }, () => ({})) });
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(issue => issue.path), ['$.sessions']);
});
