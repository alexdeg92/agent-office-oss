'use strict';

// Independent compatibility implementation retained only for rollback and
// engine-vs-legacy parity. The canonical implementation is engine/office/builder.
const { projectionFor } = require('./project3x');
const Pof = request => projectionFor(request.apiVersion);

function buildLegacyTeamOfficeProjection({ office, snapshot, principal, projection: P, planningOffice, tracker, sourceEnabled,
  engine, now, activeLayout, officeDefaults, placementPopulationFor, sessionsReadable, currentOfficeTimings, store, persist = true }) {
  if (!snapshot || !sourceEnabled) return office;
  const { projectOfficeOccupant, projectOfficeTeamOccupants } = require('../orchestrator-team-projection');
  const agents = engine.agents(), links = snapshot.identityLinks || [];
  const rows = new Map((snapshot.agents || []).map(row => [row.id, row]));
  const occupantAgent = occupant => occupant.role === 'primary' ? engine.primaryAgent() : agents.find(agent => occupant.id === 'agent:' + agent.id);
  const occupantForAgent = agentId => {
    const agent = agents.find(row => row.id === agentId); if (!agent) return null;
    const native = agent.isPrimary ? 'primary' : 'agent:' + agent.id;
    const projected = Pof({ apiVersion: 3 }).occupantId(native);
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
    if (P.version !== 3) return occupant;
    const agent = occupantAgent(occupant); if (!agent) return occupant;
    const matches = links.filter(link => link.agentId === agent.id && link.confidence === 'exact');
    if (matches.length !== 1) return occupant;
    const link = matches[0], host = rows.get(link.hostAgentId), lineage = host?.spawnedBy || null;
    const parentOccupantId = lineage ? occupantForSession(lineage.sessionKey) || occupantForAgent(lineage.agentId) : null;
    return projectOfficeOccupant(occupant, host, link, principal, { sourceEnabled: true, agentId: agent.id, parentOccupantId,
      observedAt: snapshot.observedAt, tracker });
  }) };
  const projected = projectOfficeTeamOccupants(annotated, snapshot, principal, { sourceEnabled: true, runtimeAgents: agents,
    primaryAgentId: engine.primaryAgent()?.id || null, runtimeIdentitySessions: engine.identitySessions?.(snapshot.agents?.[0]?.hostId) || [],
    runtimeSessions: engine.sessions(), canReadSessions: sessionsReadable({ session: null, principal }), version: P.version,
    tracker, agentPresenceWindowMs: currentOfficeTimings().agentPresenceWindowMs, index: officeDefaults().index,
    assignLook: store?.office?.automaticLook ? (id, avatarIndex, options) => store.office.automaticLook(id, avatarIndex, options) : null,
    assignMemberAppearances: store?.office?.memberAppearances
      ? (ids, index, options) => store.office.memberAppearances(ids, index, options) : null });
  const { projectOfficeRoster, projectOfficePlacement } = require('./vm/office-roster');
  const roster = projectOfficeRoster(projected, { projectOccupantId: P.occupantId });
  const placementLayout = activeLayout();
  return projectOfficePlacement(roster, { layout: placementLayout.layout, index: officeDefaults().index,
    projectOccupantId: P.occupantId, now: now(), tracker,
    planningOccupants: placementPopulationFor(planningOffice, snapshot, P, sourceEnabled), engine,
    canReadSessions: sessionsReadable({ session: null, principal }), idleTransitionDebounceMs: currentOfficeTimings().idleTransitionDebounceMs,
    homeAssignments: store?.office?.teamHomeAssignments?.(placementLayout.revision) || null,
    ...(persist && store?.office?.rememberTeamHomeAssignments ? {
      rememberHomeAssignments: assignments => store.office.rememberTeamHomeAssignments(placementLayout.revision, assignments),
    } : {}) });
}

module.exports = { buildLegacyTeamOfficeProjection };
