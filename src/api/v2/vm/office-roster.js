'use strict';

const OFFICE_STATES = new Set(['unknown', 'observed', 'idle', 'thinking', 'working', 'researching', 'writing', 'executing', 'calling', 'waiting', 'blocked', 'error', 'offline']);
const CONVERSATION_ROLES = new Set(['direct', 'group', 'conversation', 'session', 'dm', 'channel']);
const ROSTER_ROOT_ROLES = new Set(['primary', 'main', 'agent']);
const MOBILE_LABEL_LIMIT = 3;
const WORKING_STATES = new Set(['thinking', 'working', 'researching', 'writing', 'executing', 'calling', 'waiting']);
const { MAX_OFFICE_OCCUPANTS } = require('../../../engine/session-limits');
const { tagTeamMember, teamMemberId, teamMemberAliases } = require('./office-placement-identity');

function boundedOccupants(rows) {
  if (rows.length <= MAX_OFFICE_OCCUPANTS) return { rows, overflow: 0 };
  const byId = new Map(rows.map(row => [row.id, row]));
  const priority = row => row.role === 'primary' || row.role === 'main' ? 0
    : row.role === 'agent' || row.role === 'subagent' || row.teamId ? 1
      : CONVERSATION_ROLES.has(row.role) ? 3 : 2;
  const candidates = rows.map((row, index) => ({ row, index })).sort((a, b) => priority(a.row) - priority(b.row) || a.index - b.index);
  const selected = new Set();
  const visiting = new Set();
  const add = row => {
    if (!row || selected.has(row.id) || selected.size >= MAX_OFFICE_OCCUPANTS || visiting.has(row.id)) return false;
    visiting.add(row.id);
    if (typeof row.parentId === 'string' && row.parentId !== row.id) {
      const parent = byId.get(row.parentId);
      if (parent && !selected.has(parent.id) && !add(parent)) { visiting.delete(row.id); return false; }
    }
    visiting.delete(row.id);
    if (selected.size >= MAX_OFFICE_OCCUPANTS) return false;
    selected.add(row.id);
    return true;
  };
  for (const { row } of candidates) add(row);
  const bounded = rows.filter(row => selected.has(row.id));
  return { rows: bounded, overflow: rows.length - bounded.length };
}
function mobileLabelIds(people, rosterGroups) {
  const teamLeads = new Set((rosterGroups || []).map(group => group.rootId));
  return people.filter(row => !CONVERSATION_ROLES.has(row.role)).map((row, index) => ({ row, index })).sort((a, b) => {
    const priority = row => WORKING_STATES.has(row.state) ? 0 : teamLeads.has(row.id) ? 1 : ['blocked', 'error'].includes(row.state) ? 2 : 3;
    return priority(a.row) - priority(b.row)
      || (Number.isSafeInteger(a.row.rosterOrder) ? a.row.rosterOrder : a.index)
        - (Number.isSafeInteger(b.row.rosterOrder) ? b.row.rosterOrder : b.index);
  }).slice(0, MOBILE_LABEL_LIMIT).map(item => item.row.id);
}

function stateDetailLabel(state) {
  return { key: `agentState.${state}` };
}

function floorLabel(id) {
  return id === 'rdc' ? { key: 'office.floor.rdc' } : id === 'gym' ? { key: 'office.floor.gym' }
    : { key: id === '1' ? 'office.floor.first' : 'office.floor.number', params: { n: Number(id) || 1 } };
}

function floorRosterItems(people, byId, projectOccupantId = id => id) {
  const items = [], headers = new Set();
  for (const row of people) {
    const parent = byId.get(row.parentId);
    const crossFloorTeam = parent && parent.floorId !== row.floorId && !CONVERSATION_ROLES.has(row.role);
    if (crossFloorTeam) {
      const id = `team-header:${projectOccupantId(parent.id)}:${row.floorId}`;
      if (!headers.has(id)) {
        headers.add(id);
        items.push({ kind: 'team-header', id, label: { key: 'office.floor.team', params: {
          name: parent.name, floor: floorLabel(parent.floorId),
        } } });
      }
    }
    const occupantId = projectOccupantId(row.id);
    items.push({ kind: 'occupant', id: `occupant:${occupantId}`, occupantId });
  }
  return items;
}

function rosterReferenceProjector(rows, projectOccupantId) {
  const ids = new Set(rows.map(row => row.id));
  return id => {
    const projected = projectOccupantId(id);
    return ids.has(projected) ? projected : id;
  };
}

/** Finalize the backend-owned roster tree after runtime and source projections have been joined. */
function projectOfficeRoster(office, { now = Date.now(), projectOccupantId = id => id } = {}) {
  if (!office || !Array.isArray(office.occupants)) return office;
  const bounded = boundedOccupants(office.occupants);
  const hasVisibleOverflow = Number.isSafeInteger(office.occupantOverflowCount);
  office = { ...office, occupants: bounded.rows,
    ...(hasVisibleOverflow ? { occupantOverflowCount: office.occupantOverflowCount + bounded.overflow } : {}) };
  const byId = new Map(office.occupants.map(row => [row.id, row]));
  const children = new Map();
  const parents = new Map();
  for (const row of office.occupants) {
    const parentId = typeof row.parentId === 'string' && row.parentId !== row.id && byId.has(row.parentId) ? row.parentId : null;
    parents.set(row.id, parentId);
    if (parentId) {
      const list = children.get(parentId) || [];
      list.push(row.id);
      children.set(parentId, list);
    }
  }
  // A malformed cycle is surfaced as independent rows rather than an invented tree.
  for (const row of office.occupants) {
    const seen = new Set([row.id]);
    let cursor = parents.get(row.id);
    while (cursor) {
      if (seen.has(cursor)) { parents.set(row.id, null); break; }
      seen.add(cursor);
      cursor = parents.get(cursor);
    }
  }
  children.clear();
  for (const [id, parentId] of parents) if (parentId) {
    const list = children.get(parentId) || [];
    list.push(id);
    children.set(parentId, list);
  }

  const ordered = [];
  const visited = new Set();
  const visit = (id, rootId, depth) => {
    if (visited.has(id)) return;
    visited.add(id);
    ordered.push({ id, rootId, depth });
    for (const childId of children.get(id) || []) visit(childId, rootId, depth + 1);
  };
  for (const row of office.occupants) if (!parents.get(row.id)) visit(row.id, row.id, 0);
  // Broken cycles remain visible in source order, with no invented parent.
  for (const row of office.occupants) if (!visited.has(row.id)) { parents.set(row.id, null); visit(row.id, row.id, 0); }

  const orderById = new Map(ordered.map((entry, index) => [entry.id, index]));
  const conversationIds = office.occupants.filter(row => CONVERSATION_ROLES.has(row.role)).map(row => row.id);
  const conversations = new Set(conversationIds);
  const stateOf = row => OFFICE_STATES.has(row?.state) ? row.state : 'unknown';
  const activeCount = rows => rows.some(row => stateOf(row) === 'unknown') ? null : rows.filter(row => !['idle', 'offline'].includes(stateOf(row))).length;
  // Scene, floor totals, KPI population, and the mobile summary describe the
  // same on-stage set, including a conversation while it is visibly visiting.
  const rosterSummary = { count: office.occupants.length, activeCount: activeCount(office.occupants) };
  const groupRoots = ordered.filter(entry => ROSTER_ROOT_ROLES.has(byId.get(entry.id)?.role)
    && ordered.some(candidate => candidate.rootId === entry.id && candidate.id !== entry.id && !conversations.has(candidate.id)));
  const rootFor = new Map(ordered.map(entry => [entry.id, entry.rootId]));
  const occupants = ordered.map(({ id, rootId, depth }, rosterOrder) => {
    const row = byId.get(id);
    const state = OFFICE_STATES.has(row.state) ? row.state : 'unknown';
    const teamId = typeof row.teamId === 'string' && row.teamId ? row.teamId : null;
    // Conversation rows retain canonical lineage (`parentId`) but are rendered as their own roster entries;
    // only spawned/runtime agents are indented as team members.
    return { ...row, state, parentId: parents.get(id), parentAmbiguous: row.parentAmbiguous === true, teamId, groupId: rootFor.get(id), rosterOrder,
      stateActive: !['unknown', 'idle', 'offline'].includes(state),
      floorId: typeof row.floorId === 'string' ? row.floorId : '1',
      standingPoint: row.standingPoint && Number.isFinite(row.standingPoint.x) && Number.isFinite(row.standingPoint.y)
        ? { x: row.standingPoint.x, y: row.standingPoint.y } : null,
      rosterDepth: conversations.has(id) ? 0 : byId.get(parents.get(id))?.floorId !== row.floorId && parents.get(id) ? 1 : depth,
      parentName: !conversations.has(id) && parents.get(id) ? byId.get(parents.get(id))?.name || null : null,
      stateLabel: { key: `agentState.${state}` },
      stateDetailLabel: stateDetailLabel(state),
      stateLastLabel: { key: 'office.lastState', params: { state: { key: `agentState.${state}` } } } };
  });
  const rows = new Map(occupants.map(row => [row.id, row]));
  const projectReference = rosterReferenceProjector(occupants, projectOccupantId);
  const rosterGroups = groupRoots.map(({ id: rootId }) => {
    const memberIds = ordered.filter(entry => entry.rootId === rootId && entry.id !== rootId && !conversations.has(entry.id)).map(entry => entry.id);
    const childIds = (children.get(rootId) || []).filter(id => !conversations.has(id));
    const members = memberIds.map(id => rows.get(id));
    const root = rows.get(rootId);
    return { id: rootId, rootId, teamId: root?.teamId || members.find(row => row.teamId)?.teamId || null,
      occupantIds: [rootId, ...memberIds], childIds, order: orderById.get(rootId), count: memberIds.length,
      activeCount: activeCount(members),
      label: root?.title || { key: 'sessionTitle.named', params: { name: root?.name || '' } } };
  });
  const rosterItems = ordered.filter(entry => !parents.get(entry.id) && !conversations.has(entry.id)).map(({ id: rootId }) => {
    const memberIds = ordered.filter(entry => entry.rootId === rootId && entry.id !== rootId && !conversations.has(entry.id)).map(entry => entry.id);
    const root = rows.get(rootId);
    const childIds = memberIds;
    const previewOccupantIds = [rootId, ...childIds.slice(0, 2)];
    const overflowCount = Math.max(0, childIds.length - 2);
    return { id: rootId, kind: childIds.length ? 'group' : 'occupant', isGroup: childIds.length > 0, rootId, occupantIds: [rootId, ...memberIds], childIds,
      previewOccupantIds, overflowCount,
      openLabel: { key: 'office.mobile.openTeam', params: { name: root.name, n: memberIds.length } },
      delegatesLabel: { key: 'office.mobile.delegates', params: { n: memberIds.length } },
      overflowLabel: overflowCount ? { key: 'office.mobile.overflowCount', params: { n: overflowCount } } : null,
      order: orderById.get(rootId), count: memberIds.length, label: root.title };
  });
  const rosterPreviewItems = rosterItems.slice(0, 5);
  const rosterOverflowCount = Math.max(0, rosterItems.length - rosterPreviewItems.length);
  const floorsMap = new Map();
  for (const row of occupants) {
    const id = row.floorId;
    if (!floorsMap.has(id)) floorsMap.set(id, []);
    floorsMap.get(id).push(row);
  }
  const floorOrder = id => id === 'rdc' ? 0 : id === 'gym' ? 10002 : Number(id) || 1;
  const rosterFloors = [...floorsMap].map(([id, people]) => { const active = activeCount(people); return { id, order: floorOrder(id), label: floorLabel(id), countLabel: { key: 'office.floor.count', params: { n: people.length } }, occupantIds: people.map(row => row.id), mobileLabelIds: mobileLabelIds(people, rosterGroups), items: floorRosterItems(people, rows, projectReference),
    count: people.length, activeCount: active, statusLabel: active == null ? { key: 'office.floor.activityUnknown' } : { key: 'office.floor.status', params: { active, idle: people.filter(row => ['idle', 'offline'].includes(stateOf(row))).length } },
    idleCount: people.filter(row => ['idle', 'offline'].includes(stateOf(row))).length,
    kind: id === 'rdc' ? 'lobby' : id === 'gym' ? 'gym' : 'office', layout: null, capacity: null } })
    .sort((a, b) => a.order - b.order);
  const stateLabels = Object.fromEntries([...OFFICE_STATES].map(state => [state, { key: `agentState.${state}` }]));
  stateLabels.observed = { key: 'agentState.observed' };
  return { ...office, occupants, rosterGroups, rosterItems, rosterPreviewItems, rosterOverflowCount, rosterSummary, conversationIds,
    conversationCount: conversationIds.length, stateLabels, rosterAllLabel: { key: 'office.mobile.all', params: { n: rosterItems.length } },
    rosterOverflowLabel: { key: 'office.mobile.overflowCount', params: { n: rosterOverflowCount } },
    conversationLabel: { key: 'office.mobile.conversations', params: { n: conversationIds.length } }, rosterFloors,
    unseatedTeams: Array.isArray(office.unseatedTeams) ? office.unseatedTeams : [] };
}

function projectOfficePlacement(office, { layout, index, projectOccupantId = id => id, now = Date.now(), tracker = null, planningOccupants = null,
  homeAssignments = null, rememberHomeAssignments = null, engine = null, canReadSessions = false } = {}) {
  if (!office || !Array.isArray(office.occupants) || !layout || !index) return office;
  const { planOfficePlacement } = require('../../../engine/office/placement');
  // Limited views can hide session rows. Plan their visible subset against the
  // shared full-office population so a viewer's grants never move a visible
  // occupant to a different floor or seat.
  const suppliedPopulation = Array.isArray(planningOccupants) ? planningOccupants : office.occupants;
  // The private placement population is projected independently of the
  // caller-visible OfficeVM so permissions cannot change anyone else's seat.
  // Full and limited views can expose different occupant IDs for the same
  // session-only member. Plan against a stable private member identity, then
  // map the result back to this view's public ID. The symbol is server-only and
  // survives the roster's object spreads without entering JSON.
  const privatePlacementId = row => teamMemberId(row) && !['primary', 'main'].includes(row.role) && !['primary', 'main'].includes(row.id)
    ? `placement-member:${teamMemberId(row)}` : row.id;
  // The grant-independent producer owns canonical identity. View rows are
  // resolved through its opaque aliases, even when their public projection
  // intentionally has no session key or member symbol.
  const privatePlacementIdBySourceId = new Map();
  for (const row of suppliedPopulation) if (row && typeof row.id === 'string') {
    const id = privatePlacementId(row);
    for (const sourceId of [row.id, ...teamMemberAliases(row)]) privatePlacementIdBySourceId.set(sourceId, id);
  }
  const placementId = row => privatePlacementIdBySourceId.get(row.id) || privatePlacementId(row);
  const displayIdByPlacementId = new Map(office.occupants.map(row => [placementId(row), row.id]));
  const displayIdBySourceId = new Map();
  const placementIdBySourceId = new Map();
  for (const row of [...suppliedPopulation, ...office.occupants]) if (row && typeof row.id === 'string') {
    const canonicalId = placementId(row);
    for (const sourceId of [row.id, ...teamMemberAliases(row)]) {
      const prior = placementIdBySourceId.get(sourceId);
      if (!prior || teamMemberId(row)) placementIdBySourceId.set(sourceId, canonicalId);
    }
  }
  for (const row of office.occupants) for (const sourceId of [row.id, ...teamMemberAliases(row)]) {
    const canonicalId = placementIdBySourceId.get(sourceId) || placementId(row);
    if (displayIdByPlacementId.has(canonicalId)) displayIdBySourceId.set(sourceId, displayIdByPlacementId.get(canonicalId));
  }
  const populationById = new Map();
  const addToPopulation = (row, minimal = false) => {
    if (!row || typeof row.id !== 'string') return;
    const id = placementId(row);
    if (populationById.has(id)) return;
    const parentId = typeof row.parentId === 'string' ? placementIdBySourceId.get(row.parentId) || row.parentId : null;
    const layoutRuleId = teamMemberId(row) && !['primary', 'main'].includes(row.role) && !['primary', 'main'].includes(row.id)
      ? exactMemberLayoutRule(layout, row) || row.id : row.id;
    const normalized = minimal ? { id, role: row.role, parentId, teamId: row.teamId || null, state: row.state,
      stateSince: row.stateSince, gone: row.gone === true, visitPhase: row.visitPhase || null,
      stationUid: row.stationUid ?? null, homeFloor: row.homeFloor ?? null, layoutRuleId }
      : { ...row, id, parentId, layoutRuleId };
    populationById.set(id, tagTeamMember(normalized, teamMemberId(row), teamMemberAliases(row)));
  };
  for (const row of suppliedPopulation) addToPopulation(row);
  for (const row of office.occupants) addToPopulation(row, true);
  const population = boundedOccupants([...populationById.values()]).rows;
  // Exact-session folding can replace a runtime row ID with the stable private
  // member ID while a previously persisted plan still stores its station under
  // the old ID's placement token. Move those private saved tokens forward so
  // the seat remains with the same logical member instead of being reserved as
  // if its former identity were a departed occupant.
  const placementHomeAssignments = remapSavedMemberStations(homeAssignments, suppliedPopulation, placementId);
  const plan = planOfficePlacement({ index, layout, occupants: population, now, tracker, homeAssignments: placementHomeAssignments });
  if (typeof rememberHomeAssignments === 'function' && plan.homeAssignments) rememberHomeAssignments(plan.homeAssignments);
  const plannedById = new Map(plan.placements.map(row => [displayIdByPlacementId.get(row.id) || row.id, row]));
  // The placement engine enforces atomic team home-floor assignment before it
  // may move an idle member to a declared activity spot.
  const occupants = office.occupants.map(sourceRow => {
    const row = typeof sourceRow.parentId === 'string' && displayIdBySourceId.has(sourceRow.parentId)
      ? { ...sourceRow, parentId: displayIdBySourceId.get(sourceRow.parentId) } : sourceRow;
    const place = plannedById.get(row.id);
    if (row.visitPhase) {
      const host = office.occupants.find(candidate => candidate.id === office.visitIntent?.hostId);
      return { ...row, floorId: host?.floorId || place?.floorId || row.floorId, stationUid: null, standingPoint: null };
    }
    const sharedTarget = !canReadSessions && population.find(candidate => candidate.id === row.id)?.sceneTarget;
    const target = sharedTarget?.kind === 'visit' ? sharedTarget : place?.sceneTarget;
    return place ? { ...row, floorId: place.floorId, stationUid: place.stationUid,
      standingPoint: place.standingPoint || null, homeTarget: place.homeTarget ?? null, sceneTarget: target ?? null,
      activity: place.activity ?? null, sceneTravel: place.sceneTravel ?? null } : row;
  });
  const byFloor = new Map();
  for (const row of occupants) {
    const list = byFloor.get(row.floorId) || [];
    list.push(row); byFloor.set(row.floorId, list);
  }
  const floorOrder = id => id === 'rdc' ? 0 : id === 'gym' ? 10002 : Number(id) || 1;
  const visibleIds = new Set(occupants.map(row => row.id));
  const visibleUnseatedTeams = plan.unseatedTeams.flatMap(team => {
    const parentId = displayIdByPlacementId.get(team.parentId) || team.parentId;
    if (!visibleIds.has(parentId)) return [];
    const root = occupants.find(row => row.id === parentId);
    const count = occupants.filter(row => row.parentId === parentId && row.teamId === root?.teamId && !row.stationUid).length;
    return count ? [{ ...team, parentId, count }] : [];
  });
  const rosterOffice = projectOfficeRoster({ ...office, occupants, unseatedTeams: visibleUnseatedTeams }, { projectOccupantId, now });
  const finalOccupants = rosterOffice.occupants;
  const byId = new Map(finalOccupants.map(row => [row.id, row]));
  const projectReference = rosterReferenceProjector(finalOccupants, projectOccupantId);
  const rosterFloors = plan.floors.map(floor => {
    const people = byFloor.get(floor.id) || [];
    const finalPeople = people.map(row => byId.get(row.id)).filter(Boolean);
    const active = finalPeople.some(row => !OFFICE_STATES.has(row.state) || row.state === 'unknown')
      ? null : finalPeople.filter(row => !['idle', 'offline'].includes(row.state)).length;
    return { id: floor.id, order: floorOrder(floor.id), label: floorLabel(floor.id), countLabel: { key: 'office.floor.count', params: { n: finalPeople.length } }, kind: floor.kind, occupantIds: finalPeople.map(row => row.id), mobileLabelIds: mobileLabelIds(finalPeople, rosterOffice.rosterGroups), items: floorRosterItems(finalPeople, byId, projectReference),
      count: finalPeople.length, activeCount: active, statusLabel: active == null ? { key: 'office.floor.activityUnknown' } : { key: 'office.floor.status', params: { active, idle: finalPeople.filter(row => ['idle', 'offline'].includes(row.state)).length } },
      idleCount: finalPeople.filter(row => ['idle', 'offline'].includes(row.state)).length, layout: floor.layout, capacity: floor.capacity };
  }).sort((a, b) => a.order - b.order);
  return require('../../../engine/office/communication').projectCommunication(
    { ...rosterOffice, rosterFloors, unseatedTeams: visibleUnseatedTeams }, { engine, index, layout, now, canReadSessions });
}

function exactMemberLayoutRule(layout, row) {
  const rules = require('../../../engine/office/layout-rules');
  return [row.id, ...teamMemberAliases(row)].find(alias => {
    const rule = rules.ruleFor(layout, alias, row.role);
    return rule && rules.ruleKind(rule.agentId) === 'exact';
  }) || null;
}

function remapSavedMemberStations(homeAssignments, rows, placementId) {
  if (!homeAssignments || typeof homeAssignments !== 'object') return homeAssignments;
  const { placementToken } = require('../../../engine/office/floors');
  const next = { ...homeAssignments };
  const leadAliases = new Set(rows.filter(row => row && (row.role === 'primary' || row.role === 'main' || row.id === 'primary' || row.id === 'main'))
    .flatMap(row => [row.id, ...teamMemberAliases(row)]));
  for (const row of rows) {
    if (!row || !teamMemberId(row) || ['primary', 'main'].includes(row.role) || ['primary', 'main'].includes(row.id)) continue;
    const aliases = [...new Set([row.id, ...teamMemberAliases(row)])].filter(alias => alias && !leadAliases.has(alias));
    if (!aliases.length) continue;
    const currentToken = placementToken(placementId(row));
    for (const [key, assignment] of Object.entries(next)) {
      if (!assignment?.stations || typeof assignment.stations !== 'object') continue;
      const stations = { ...assignment.stations };
      if (typeof stations[currentToken] !== 'string') {
        const prior = aliases.map(alias => stations[placementToken(alias)]).find(value => typeof value === 'string');
        if (prior) stations[currentToken] = prior;
      }
      for (const alias of aliases) delete stations[placementToken(alias)];
      next[key] = { ...assignment, stations };
    }
  }
  return next;
}

module.exports = { projectOfficeRoster, projectOfficePlacement };
