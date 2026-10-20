'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collect, healthRows, logSnapshot, startReporter } = require('../../src/engine/parity-observability');
const { settingsFixture } = require('../helpers/settings-fixture');

test('parity export has bounded counters, fixed surface labels, and no projection data', () => {
  const engine = { orchestrationParityCounters: () => ({
    office: { comparisons: 7, mismatches: 1, changedRows: 2, overflowKeys: 3, overflowSurfaces: 0 },
    'office.limited': { comparisons: 4, mismatches: 0, changedRows: 0, overflowKeys: 0, overflowSurfaces: 0 },
    'private-session-identity': { comparisons: 9, mismatches: 2, changedRows: 8, overflowKeys: 5, overflowSurfaces: 1 },
  }) };
  const vmRows = healthRows(engine), line = logSnapshot(engine);
  assert.deepEqual(vmRows.map(row => row.surface.key), [
    'health.parity.surface.office', 'health.parity.surface.officeLimited', 'health.parity.surface.other',
  ]);
  assert.equal(vmRows[2].comparisons, 9, 'unknown surfaces aggregate without their internal key');
  assert.deepEqual(line, { event: 'engine.parity', surfaces: [
    { surface: 'office', comparisons: 7, mismatches: 1, changedRows: 2, overflowKeys: 3, overflowSurfaces: 0 },
    { surface: 'office.limited', comparisons: 4, mismatches: 0, changedRows: 0, overflowKeys: 0, overflowSurfaces: 0 },
    { surface: 'other', comparisons: 9, mismatches: 2, changedRows: 8, overflowKeys: 5, overflowSurfaces: 1 },
  ] });
  assert.doesNotMatch(JSON.stringify({ vmRows, line }), /private-session-identity/);
  for (const row of vmRows) {
    assert.deepEqual(Object.keys(row).sort(), ['changedRows', 'comparisons', 'labels', 'mismatches', 'overflowKeys', 'overflowSurfaces', 'surface']);
    assert.deepEqual(Object.keys(row.labels).sort(), ['changedRows', 'comparisons', 'mismatches', 'overflowKeys', 'overflowSurfaces']);
  }
  assert.equal(collect({ orchestrationParityCounters: () => ({ office: { comparisons: Number.MAX_SAFE_INTEGER } }) }).known.get('office').comparisons, 1_000_000);
});

test('parity reporter emits the fixed value-free event every ten minutes and can be closed', () => {
  let tick, delay, cleared = false, logged, sampled = 0;
  const stop = startReporter({ engine: { orchestrationParityCounters: () => ({ office: { comparisons: 1 } }) },
    log: row => { logged = row; }, onSample: () => { sampled++; },
    setIntervalFn: (fn, ms) => { tick = fn; delay = ms; return { unref() {} }; }, clearIntervalFn: () => { cleared = true; } });
  assert.equal(delay, 600_000);
  tick();
  assert.equal(logged.event, 'engine.parity');
  assert.equal(sampled, 1);
  stop(); assert.equal(cleared, true);
});

test('mounted HealthVM exposes parity only to admins and denies an admin-topic replay after role loss', async t => {
  let principal = { id: 'parity-admin', role: 'admin', permissionRevision: 1, permissions: { health: 'read' } };
  const h = await settingsFixture({ sourcePrincipalFor: () => principal });
  t.after(() => h.close());
  h.engine.compareOrchestrationProjection('office', [{ id: 'private-row-id', state: 'working' }], [{ id: 'private-row-id', state: 'idle' }], ['id', 'state']);

  let adminTopicId;
  for (const version of [2, 3]) {
    principal = { id: 'parity-admin', role: 'admin', permissionRevision: version, permissions: { health: 'read' } };
    const admin = await h.get(`/api/v${version}/views/health`);
    assert.equal(admin.status, 200, admin.text);
    assert.ok(Array.isArray(admin.json.data.engineParity), admin.text);
    assert.equal(admin.json.data.engineParity[0].comparisons, 1);
    assert.equal(admin.json.data.engineParity[0].mismatches, 1);
    assert.match(admin.json.meta.topic.id, /^health-admin:/);
    adminTopicId = admin.json.meta.topic.id;
    assert.doesNotMatch(admin.text, /private-row-id|private-row|working|idle/);

    principal = { id: 'parity-reader', role: 'custom', permissionRevision: 2, permissions: { health: 'read' } };
    const reader = await h.get(`/api/v${version}/views/health`);
    assert.equal(reader.status, 200, reader.text);
    assert.equal(Object.hasOwn(reader.json.data, 'engineParity'), false, 'non-admin gets the ordinary HealthVM');
  }

  // Replaying the previously issued scoped topic must be refused after the same
  // authenticated principal no longer has the admin role.
  const abort = new AbortController();
  const streamResponse = await fetch(`${h.base}/api/v3/stream?topics=${encodeURIComponent(adminTopicId)}`, {
    headers: { cookie: h.cookie, accept: 'text/event-stream' }, signal: abort.signal,
  });
  const reader = streamResponse.body.getReader();
  const first = await reader.read();
  abort.abort();
  const text = new TextDecoder().decode(first.value);
  assert.equal(streamResponse.status, 200);
  assert.match(text, /permission-denied/);
});
