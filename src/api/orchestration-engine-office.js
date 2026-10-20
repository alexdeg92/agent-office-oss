'use strict';

// Translate the engine's admitted canonical source view into the projection
// input shape. The Office builder consumes these rows; private native refs are
// read only through the engine-only, non-enumerable index.
function orchestrationOfficeSnapshot(engine) {
  const admitted = engine?.orchestrationProjectionSnapshot?.();
  if (!admitted) return null;
  const sources = Array.isArray(admitted.sourceStatus) ? admitted.sourceStatus : [];
  const capabilities = sources.map(row => row.capabilities?.orchestration || {});
  const privateMemberSessionRefs = Object.create(null), privateMemberSessionKeys = Object.create(null);
  const privateHostRefs = Object.create(null);
  for (const sourceRefs of Object.values(admitted.privateSources || {})) {
    for (const [id, ref] of Object.entries(sourceRefs || {})) {
      if (ref?.memberId && ref.sessionRef && ref.sessionKey && ref.runtimeKind) {
        privateMemberSessionRefs[id] = ref;
        privateMemberSessionKeys[id] = ref.sessionKey;
      }
      if (ref?.paneRef || ref?.hostId) privateHostRefs[id] = ref;
    }
  }
  const invalid = table => sources.reduce((sum, row) => Math.min(5000, sum + (row.invalidRowsByTable?.[table] || 0)), 0);
  const result = {
    hosts: admitted.hosts, orchestrators: admitted.orchestrators, agents: admitted.hostAgents,
    identityLinks: admitted.identityLinks, team: admitted.teams.length === 1 ? admitted.teams[0] : null, teams: admitted.teams,
    members: admitted.members, tasks: admitted.tasks, reviews: admitted.reviews,
    diagnostics: { skippedMemberCount: invalid('members'), skippedTaskCount: invalid('tasks') },
    observedAt: sources.reduce((at, row) => Math.max(at, row.observedAt || 0), 0) || null,
    sourcesReady: admitted.sourcesReady,
    hasHerdr: sources.some(row => row.enabled && row.status !== 'unavailable' && row.capabilities?.orchestration?.hosts === true),
    hasTeamStore: sources.some(row => row.enabled && row.status !== 'unavailable' && row.capabilities?.orchestration?.teams === true),
    herdrDetected: sources.some(row => row.capabilities?.discovery?.detected === true),
  };
  Object.defineProperties(result, {
    privateMemberSessionRefs: { enumerable: false, value: Object.freeze(privateMemberSessionRefs) },
    privateMemberSessionKeys: { enumerable: false, value: Object.freeze(privateMemberSessionKeys) },
    privateHostRefs: { enumerable: false, value: Object.freeze(privateHostRefs) },
  });
  return Object.freeze(result);
}

module.exports = { orchestrationOfficeSnapshot };
