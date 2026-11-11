'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compareOrSkipOrchestrationProjection } = require('../../src/api/orchestration-parity');
const { createOrchestratorTeamSnapshots } = require('../../src/sources/orchestrator-team-snapshots');

test('unsynced source revisions skip parity, while aligned real differences count as mismatches', () => {
  let skipped = 0, comparisons = 0, mismatches = 0;
  const engine = {
    skipOrchestrationProjection(surface, reason) { assert.equal(surface, 'office'); assert.equal(reason, 'unsynced'); skipped++; },
    compareOrchestrationProjection(surface, oldRows, newRows) {
      assert.equal(surface, 'office'); comparisons++;
      const equal = JSON.stringify(oldRows) === JSON.stringify(newRows);
      if (!equal) mismatches++;
      return { equal };
    },
  };
  const compatibility = { hasHerdr: true, hasTeamStore: true, hostRevision: 12, teamRevision: 5, identityRevision: 4 };
  const canonicalSkew = { hasHerdr: true, hasTeamStore: true, sourceRevisions: { herdr: 11, 'agent-team-pm': 5 },
    identityRevisions: { herdr: 4, 'agent-team-pm': 4 } };
  const skippedResult = compareOrSkipOrchestrationProjection(engine, 'office', compatibility, canonicalSkew,
    [{ id: 'member', parentId: 'lead-a' }], [{ id: 'member', parentId: 'lead-b' }]);
  assert.deepEqual(skippedResult, { status: 'skipped-unsynced' });
  assert.deepEqual({ skipped, comparisons, mismatches }, { skipped: 1, comparisons: 0, mismatches: 0 });

  const canonicalAligned = { hasHerdr: true, hasTeamStore: true, sourceRevisions: { herdr: 12, 'agent-team-pm': 5 },
    identityRevisions: { herdr: 4, 'agent-team-pm': 4 } };
  const comparedResult = compareOrSkipOrchestrationProjection(engine, 'office', compatibility, canonicalAligned,
    [{ id: 'member', parentId: 'lead-a' }], [{ id: 'member', parentId: 'lead-b' }]);
  assert.deepEqual(comparedResult, { status: 'compared', result: { equal: false } });
  assert.deepEqual({ skipped, comparisons, mismatches }, { skipped: 1, comparisons: 1, mismatches: 1 });
});

test('a runtime identity change between source polls skips parity until canonical ingestion catches up', () => {
  let identities = [{ id: 'session-a', agentId: 'agent-a', hostId: 'host-a', runtimeKind: 'codex',
    sessionRef: 'stable-ref-a', sessionKey: 'session-key-a' },
  { id: 'session-b', agentId: 'agent-b', hostId: 'host-a', runtimeKind: 'codex',
    sessionRef: 'stable-ref-b', sessionKey: 'session-key-b', identityRef: null }];
  const snapshots = createOrchestratorTeamSnapshots({
    runtimeIdentitySessions: () => identities,
  });
  const first = snapshots.getSnapshot();
  assert.ok(Number.isSafeInteger(first.runtimeIdentityRevision));
  assert.equal(first.runtimeIdentityRevision, 1, 'nullable adapter identity fields are valid absent values');
  identities = [...identities].reverse();
  assert.equal(snapshots.getSnapshot().runtimeIdentityRevision, first.runtimeIdentityRevision,
    'runtime identity row ordering alone does not create a different generation');
  const engine = {
    skipped: 0,
    compared: 0,
    skipOrchestrationProjection() { this.skipped++; },
    compareOrchestrationProjection() { this.compared++; return { equal: true }; },
  };
  const compatibility = { hasHerdr: true, hasTeamStore: false, hostRevision: 4, identityRevision: first.runtimeIdentityRevision };
  const canonical = { hasHerdr: true, hasTeamStore: false, sourceRevisions: { herdr: 4 },
    identityRevisions: { herdr: first.runtimeIdentityRevision } };
  assert.equal(compareOrSkipOrchestrationProjection(engine, 'office', compatibility, canonical, [], []).status, 'compared');

  identities = [{ ...identities[0], sessionRef: 'stable-ref-changed' }, identities[1]];
  const changed = snapshots.getSnapshot();
  assert.ok(changed.runtimeIdentityRevision > first.runtimeIdentityRevision,
    'the private identity generation advances even though Herdr/team source revisions have not polled');
  const skewedCompatibility = { ...compatibility, identityRevision: changed.runtimeIdentityRevision };
  assert.equal(compareOrSkipOrchestrationProjection(engine, 'office', skewedCompatibility, canonical, [], []).status, 'skipped-unsynced');
  assert.equal(engine.compared, 1, 'unlike runtime-identity generations are never compared');
  assert.equal(engine.skipped, 1);

  const caughtUp = { ...canonical, identityRevisions: { herdr: changed.runtimeIdentityRevision } };
  assert.equal(compareOrSkipOrchestrationProjection(engine, 'office', skewedCompatibility, caughtUp, [], []).status, 'compared');
  assert.equal(engine.compared, 2, 'the next admitted generation resumes parity');
  snapshots.close();
});

test('team-store-only parity follows runtime identity generations without Herdr', () => {
  let identities = [{ id: 'session-a', agentId: 'agent-a', runtimeKind: 'claude-code',
    sessionRef: 'stable-ref-a', sessionKey: 'session-key-a' }];
  const snapshots = createOrchestratorTeamSnapshots({ runtimeIdentitySessions: () => identities });
  const first = snapshots.getSnapshot();
  const engine = {
    skipped: 0,
    compared: 0,
    skipOrchestrationProjection() { this.skipped++; },
    compareOrchestrationProjection() { this.compared++; return { equal: true }; },
  };
  const compatibility = { hasHerdr: false, hasTeamStore: true, teamRevision: 7,
    identityRevision: first.runtimeIdentityRevision };
  const canonical = { hasHerdr: false, hasTeamStore: true,
    sourceRevisions: { 'agent-team-pm': 7 },
    identityRevisions: { 'agent-team-pm': first.runtimeIdentityRevision } };
  assert.equal(compareOrSkipOrchestrationProjection(engine, 'office', compatibility, canonical, [], []).status, 'compared');

  identities = [{ ...identities[0], sessionRef: 'stable-ref-b' }];
  const changed = snapshots.getSnapshot();
  assert.ok(changed.runtimeIdentityRevision > first.runtimeIdentityRevision);
  const skewedCompatibility = { ...compatibility, identityRevision: changed.runtimeIdentityRevision };
  assert.equal(compareOrSkipOrchestrationProjection(engine, 'office', skewedCompatibility, canonical, [], []).status,
    'skipped-unsynced', 'team-only projections must not compare against the previous identity generation');
  assert.equal(engine.compared, 1);
  assert.equal(engine.skipped, 1);

  const readmitted = { ...canonical,
    identityRevisions: { 'agent-team-pm': changed.runtimeIdentityRevision } };
  assert.equal(compareOrSkipOrchestrationProjection(engine, 'office', skewedCompatibility, readmitted, [], []).status,
    'compared', 'team admission carries the new shared identity generation even without Herdr');
  assert.equal(engine.compared, 2);
  snapshots.close();
});
