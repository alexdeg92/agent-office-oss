'use strict';

// Revisions are private server-side tokens. These helpers prevent comparisons
// between independently polled Herdr/team snapshots from being counted as
// either equal or different when the inputs do not describe the same source
// generation.
function orchestrationSourcesAligned(engineSnapshot, compatibilitySnapshot) {
  if (!engineSnapshot || !compatibilitySnapshot) return false;
  const pairs = [['herdr', 'hasHerdr', 'hostRevision'], ['agent-team-pm', 'hasTeamStore', 'teamRevision']];
  let compared = false;
  for (const [sourceId, activeField, revisionField] of pairs) {
    const engineActive = engineSnapshot[activeField] === true;
    const compatibilityActive = compatibilitySnapshot[activeField] === true;
    if (engineActive !== compatibilityActive) return false;
    if (!engineActive) continue;
    const currentRevision = engineSnapshot.sourceRevisions?.[sourceId];
    const compatibilityRevision = compatibilitySnapshot[revisionField];
    if (!Number.isSafeInteger(currentRevision) || !Number.isSafeInteger(compatibilityRevision)
        || currentRevision !== compatibilityRevision) return false;
    // The joined compatibility snapshot derives team refs, status and lineage
    // from runtime identity sessions even when Herdr itself is off. Fence every
    // active source against that shared projection input generation.
    if (compatibilitySnapshot.hasHerdr === true || compatibilitySnapshot.hasTeamStore === true) {
      const currentIdentityRevision = engineSnapshot.identityRevisions?.[sourceId];
      const compatibilityIdentityRevision = compatibilitySnapshot.identityRevision;
      if (!Number.isSafeInteger(currentIdentityRevision) || !Number.isSafeInteger(compatibilityIdentityRevision)
          || currentIdentityRevision !== compatibilityIdentityRevision) return false;
    }
    compared = true;
  }
  return compared;
}

function compareOrSkipOrchestrationProjection(engine, surface, compatibilitySnapshot, engineSnapshot,
  oldProjection, newProjection, fields) {
  if (!orchestrationSourcesAligned(engineSnapshot, compatibilitySnapshot)) {
    engine.skipOrchestrationProjection?.(surface, 'unsynced');
    return Object.freeze({ status: 'skipped-unsynced' });
  }
  const result = engine.compareOrchestrationProjection?.(surface, oldProjection, newProjection, fields) ?? null;
  return Object.freeze({ status: 'compared', result });
}

module.exports = { orchestrationSourcesAligned, compareOrSkipOrchestrationProjection };
