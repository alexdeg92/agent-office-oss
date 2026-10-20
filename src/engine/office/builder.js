'use strict';

// Canonical orchestration-aware OfficeVM builder. The API supplies an already
// authorized runtime OfficeVM and opaque projection callbacks; identity joins,
// host/team annotations, roster construction, and placement live here. The
// legacy API projector remains independent for rollback/parity comparison.
const { projectOfficeOccupant, projectOfficeTeamOccupants, projectOfficeTeamPlacementPopulation } = require('./team-projection');
const { projectOfficeRoster, projectOfficePlacement } = require('./roster');
const { buildOfficeVM: buildRuntimeOfficeView } = require('./base-view');

function buildOfficeView(engine, {
  office, snapshot, principal, projection, planningOffice, tracker, planningTracker = tracker, sourceEnabled, baseOptions = null,
  planningBaseOptions = null, scope = null,
  layout, index, now, canReadSessions, agentPresenceWindowMs, idleTransitionDebounceMs,
  homeAssignments = null, rememberHomeAssignments = null, persist = true,
}) {
  if (!office) {
    if (!baseOptions || typeof baseOptions !== 'object') throw new TypeError('base Office view options are required');
    office = buildRuntimeOfficeView({ ...baseOptions, engine });
  }
  const limited = scope?.canReadSessions === false;
  if (limited) {
    // Limited callers receive a VM built without transcript-derived fields.
    // Placement still uses a private full planning population so desk pressure
    // and team grouping do not depend on the caller's grants or cache order.
    if (!planningOffice && planningBaseOptions) {
      planningOffice = buildRuntimeOfficeView({ ...planningBaseOptions, engine, canReadSessions: true,
        tracker: planningTracker });
    }
    if (!snapshot || !sourceEnabled || snapshot.sourcesReady === false || !planningOffice) return office;
    if (scope.includeTeams !== true) {
      const planningOccupants = projectOfficeTeamPlacementPopulation(planningOffice, snapshot, {
        runtimeAgents: engine.agents(), primaryAgentId: engine.primaryAgent()?.id || null,
        runtimeIdentitySessions: engine.identitySessions?.(snapshot.agents?.[0]?.hostId) || [],
        runtimeSessions: engine.sessions(), version: projection.version, tracker: planningTracker, agentPresenceWindowMs,
      });
      return projectOfficePlacement(office, { layout, index, projectOccupantId: projection.occupantId, now, tracker,
        planningOccupants, engine, canReadSessions: false, idleTransitionDebounceMs,
        homeAssignments, ...(persist && typeof rememberHomeAssignments === 'function' ? { rememberHomeAssignments } : {}) });
    }
  }
  if (!snapshot || !sourceEnabled) return office;
  const agents = engine.agents(), links = snapshot.identityLinks || [];
  const rows = new Map((snapshot.agents || []).map(row => [row.id, row]));
  const occupantAgent = occupant => occupant.role === 'primary' ? engine.primaryAgent() : agents.find(agent => occupant.id === 'agent:' + agent.id);
  const occupantForAgent = agentId => {
    const agent = agents.find(row => row.id === agentId); if (!agent) return null;
    const native = agent.isPrimary ? 'primary' : 'agent:' + agent.id;
    const projected = projection.occupantId(native);
    return office.occupants.some(row => row.id === projected) ? projected : null;
  };
  const occupantForSession = sessionKey => {
    if (!sessionKey) return null;
    const direct = office.occupants.find(row => row.sessionKey === sessionKey);
    if (direct) return direct.id;
    const session = engine.session(sessionKey);
    return session?.class?.agentId ? occupantForAgent(session.class.agentId) : null;
  };
  const annotated = { ...office, occupants: office.occupants.map(occupant => {
    if (projection.version !== 3) return occupant;
    const agent = occupantAgent(occupant); if (!agent) return occupant;
    const matches = links.filter(link => link.agentId === agent.id && link.confidence === 'exact');
    if (matches.length !== 1) return occupant;
    const link = matches[0], host = rows.get(link.hostAgentId), lineage = host?.spawnedBy || null;
    const parentOccupantId = lineage ? occupantForSession(lineage.sessionKey) || occupantForAgent(lineage.agentId) : null;
    return projectOfficeOccupant(occupant, host, link, principal, { sourceEnabled: true, agentId: agent.id, parentOccupantId,
      observedAt: snapshot.observedAt, tracker });
  }) };
  const projected = projectOfficeTeamOccupants(annotated, snapshot, principal, { sourceEnabled: true, runtimeAgents: agents,
    primaryAgentId: engine.primaryAgent()?.id || null,
    runtimeIdentitySessions: engine.identitySessions?.(snapshot.agents?.[0]?.hostId) || [],
    runtimeSessions: engine.sessions(), canReadSessions, version: projection.version,
    tracker, agentPresenceWindowMs, index, assignLook: baseOptions?.assignLook,
    assignMemberAppearances: baseOptions?.assignMemberAppearances });
  const roster = projectOfficeRoster(projected, { projectOccupantId: projection.occupantId });
  const placementPopulation = projectOfficeTeamPlacementPopulation(planningOffice || office, snapshot, {
    runtimeAgents: agents, primaryAgentId: engine.primaryAgent()?.id || null,
    runtimeIdentitySessions: engine.identitySessions?.(snapshot.agents?.[0]?.hostId) || [],
    runtimeSessions: engine.sessions(), version: projection.version, tracker, agentPresenceWindowMs,
  });
  return projectOfficePlacement(roster, { layout, index, projectOccupantId: projection.occupantId, now, tracker,
    planningOccupants: placementPopulation, engine, canReadSessions: limited ? false : canReadSessions,
    idleTransitionDebounceMs,
    homeAssignments,
    ...(persist && typeof rememberHomeAssignments === 'function' ? { rememberHomeAssignments } : {}) });
}

module.exports = { buildOfficeView };
