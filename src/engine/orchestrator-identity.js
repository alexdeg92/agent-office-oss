'use strict';

// Exact join helper for trusted adapters. `sessionRef` and `identityRef` are private adapter values;
// they are compared here and never copied to the returned canonical IdentityLink.
function createOrchestratorIdentityResolver() {
  const validRef = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
  const key = (hostId, runtimeKind, evidence, ref) => JSON.stringify([hostId, runtimeKind, evidence, ref]);

  function reconcile({ hosts = [], agents = [] } = {}) {
    const byKey = new Map();
    for (const agent of agents) {
      if (!agent || typeof agent.id !== 'string' || typeof agent.hostId !== 'string' || typeof agent.runtimeKind !== 'string') continue;
      const refs = [];
      if (validRef(agent.sessionRef)) refs.push(['shared-runtime-session-ref', agent.sessionRef]);
      if (validRef(agent.identityRef)) refs.push(['explicit-runtime-identity', agent.identityRef]);
      for (const [evidence, ref] of refs) {
        const k = key(agent.hostId, agent.runtimeKind, evidence, ref);
        const bucket = byKey.get(k) || new Map();
        bucket.set(agent.id, evidence);
        byKey.set(k, bucket);
      }
    }

    const links = [];
    const seenHostIds = new Set();
    for (const host of hosts) {
      const row = host?.row;
      if (!row || typeof row.id !== 'string' || typeof row.hostId !== 'string' || typeof row.runtimeKind !== 'string' || seenHostIds.has(row.id)) continue;
      seenHostIds.add(row.id);
      const refs = [];
      if (validRef(host.sessionRef)) refs.push(['shared-runtime-session-ref', host.sessionRef]);
      if (validRef(host.identityRef)) refs.push(['explicit-runtime-identity', host.identityRef]);
      const candidates = new Map();
      for (const [expected, ref] of refs) {
        const matches = byKey.get(key(row.hostId, row.runtimeKind, expected, ref));
        if (matches) for (const agentId of matches.keys()) candidates.set(agentId, expected);
      }
      if (candidates.size !== 1) continue;
      const [agentId, evidence] = candidates.entries().next().value;
      links.push({ hostAgentId: row.id, agentId, evidence, confidence: 'exact' });
    }
    return links;
  }

  return Object.freeze({ reconcile });
}

module.exports = { createOrchestratorIdentityResolver };
