'use strict';

// Independent compatibility implementation retained only for rollback and
// engine-vs-legacy parity. The canonical implementation is engine/office/builder.
const { projectionFor } = require('./project3x');
const { allowsPrincipal } = require('../../security/orchestrator-team-resources');
const Pof = request => projectionFor(request.apiVersion);

function buildLegacyTeamOfficeProjection({ office, snapshot, principal, projection: P, planningOffice, tracker, sourceEnabled,
  engine, now, activeLayout, officeDefaults, placementPopulationFor, sessionsReadable, currentOfficeTimings, store, persist = true,
  homeAssignmentsOverride = undefined }) {
  const canReadTeams = allowsPrincipal(principal, 'teams', 'read');
  const withoutTeamMembership = require('../../engine/office/roster').withoutTeamMembership;
  const { projectFloorAgentGroups } = require('../../engine/office/roster');
  if (!snapshot || !sourceEnabled) {
    const authorized = canReadTeams ? office : withoutTeamMembership(office);
    return canReadTeams ? { ...authorized, rosterFloors: projectFloorAgentGroups(authorized.rosterFloors, authorized.occupants) } : authorized;
  }
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
  const placed = projectOfficePlacement(roster, { layout: placementLayout.layout, index: officeDefaults().index,
    projectOccupantId: P.occupantId, now: now(), tracker,
    planningOccupants: placementPopulationFor(planningOffice, snapshot, P, sourceEnabled, tracker), engine,
    canReadSessions: sessionsReadable({ session: null, principal }), idleTransitionDebounceMs: currentOfficeTimings().idleTransitionDebounceMs,
    teamSnapshot: snapshot, canReadTeams,
    homeAssignments: homeAssignmentsOverride === undefined
      ? store?.office?.teamHomeAssignments?.(placementLayout.revision) || null : homeAssignmentsOverride,
    ...(persist && store?.office?.rememberTeamHomeAssignments ? {
      rememberHomeAssignments: assignments => store.office.rememberTeamHomeAssignments(placementLayout.revision, assignments),
    } : {}) });
  const { projectTeamGroups } = require('../../engine/office/roster');
  const teamGroups = canReadTeams ? projectTeamGroups(placed.occupants, snapshot,
    kind => engine?.runtimePresentationFor?.(kind) || null, { floorLayouts: placed.rosterFloors, index: officeDefaults().index }) : [];
  const authorized = canReadTeams ? placed : withoutTeamMembership(placed);
  const rosterFloors = projectFloorAgentGroups(authorized.rosterFloors, authorized.occupants, canReadTeams ? teamGroups : []);
  const teamLegend = teamGroups.map(group => ({ teamId: group.id, label: group.label, accentToken: group.accentToken }));
  return { ...authorized, rosterFloors, teamGroups, teamLegend };
}

module.exports = { buildLegacyTeamOfficeProjection };
