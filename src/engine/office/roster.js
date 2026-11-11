'use strict';

const OFFICE_STATES = new Set(['unknown', 'observed', 'idle', 'thinking', 'working', 'researching', 'writing', 'executing', 'calling', 'waiting', 'blocked', 'error', 'offline']);
const CONVERSATION_ROLES = new Set(['direct', 'group', 'conversation', 'session', 'dm', 'channel']);
const HUMAN_CONTACT_ROLES = new Set(['direct', 'dm']);
const ROSTER_ROOT_ROLES = new Set(['primary', 'main', 'agent']);
const MOBILE_LABEL_LIMIT = 3;
const WORKING_STATES = new Set(['thinking', 'working', 'researching', 'writing', 'executing', 'calling', 'waiting']);
const { MAX_OFFICE_OCCUPANTS } = require('../session-limits');
const { tagTeamMember, teamMemberId, teamMemberAliases } = require('./placement-identity');
const { seatTile } = require('./layout-rules');

const TEAM_ACCENTS = Object.freeze(['violet', 'teal', 'amber', 'rose', 'sky', 'lime']);
const comparableLabel = value => String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
function assignTeamAccents(groups) {
  // Palette collision ownership is based only on stable team identity, never
  // snapshot order or source timestamps. Adding/removing a non-colliding team
  // therefore leaves every existing assignment intact. A team in a collision
  // chain can move when an earlier-sorting colliding ID joins or leaves.
  const ordered = [...groups].sort((a, b) => a.id.localeCompare(b.id));
  const assigned = new Set(), counts = new Map(TEAM_ACCENTS.map(token => [token, 0]));
  for (const group of ordered) {
    const preferred = accentHash(group.id) % TEAM_ACCENTS.length;
    let token = null;
    for (let offset = 0; offset < TEAM_ACCENTS.length; offset++) {
      const candidate = TEAM_ACCENTS[(preferred + offset) % TEAM_ACCENTS.length];
      if (!assigned.has(candidate)) { token = candidate; break; }
    }
    if (!token) {
      const least = Math.min(...counts.values());
      for (let offset = 0; offset < TEAM_ACCENTS.length; offset++) {
        const candidate = TEAM_ACCENTS[(preferred + offset) % TEAM_ACCENTS.length];
        if (counts.get(candidate) === least) { token = candidate; break; }
      }
    }
    group.accentToken = token;
    assigned.add(token); counts.set(token, counts.get(token) + 1);
  }
}
function accentHash(id) {
  let hash = 2166136261;
  for (const char of String(id)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}
const labelText = text => ({ key: 'custom', params: { text: String(text || '') } });
function projectTeamGroups(occupants, snapshot, runtimePresentationFor = null, { floorLayouts = [], index = null } = {}) {
  if (!snapshot || !Array.isArray(snapshot.members) || !snapshot.members.length) return [];
  const teams = new Map();
  const teamRows = [...(snapshot.teams || []), ...(snapshot.team ? [snapshot.team] : [])]
    .filter(team => team && typeof team.id === 'string');
  for (const team of teamRows) {
    if (team && typeof team.id === 'string' && !teams.has(team.id)) {
      teams.set(team.id, team);
    }
  }
  const linksByHost = new Map();
  for (const link of snapshot.identityLinks || []) if (link?.confidence === 'exact') {
    const prior = linksByHost.get(link.hostAgentId) || [];
    prior.push(link.agentId); linksByHost.set(link.hostAgentId, prior);
  }
  const byId = new Map(occupants.map(row => [row.id, row]));
  const memberOccupant = member => {
    const direct = occupants.find(row => row.memberId === member.id);
    if (direct) return direct;
    const agentIds = linksByHost.get(member.hostAgentId) || [];
    for (const agentId of agentIds) {
      const match = occupants.find(row => row.id === `agent:${agentId}` || row.id === `subagent:${agentId}`
        || row.id === 'main' && (row.hostAgentId === member.hostAgentId || row.memberId === member.id)
        || row.id === 'primary' && (row.hostAgentId === member.hostAgentId || row.memberId === member.id));
      if (match) return match;
    }
    return null;
  };
  const membersByTeam = new Map();
  for (const member of snapshot.members) {
    const teamId = member?.teamId || snapshot.team?.id;
    if (!member || typeof teamId !== 'string') continue;
    const list = membersByTeam.get(teamId) || [];
    list.push(member.teamId ? member : { ...member, teamId }); membersByTeam.set(teamId, list);
  }
  const groups = [];
  for (const [teamId, records] of membersByTeam) {
    const team = teams.get(teamId) || { id: teamId, label: teamId };
    const resolved = records.map(member => ({ member, occupant: memberOccupant(member) }))
      .filter(pair => pair.occupant && pair.occupant.teamId === teamId || pair.occupant?.teamIds?.includes(teamId));
    if (!resolved.length) continue;
    const explicitLeads = resolved.filter(pair => pair.member.roleKind === 'lead');
    const structuralLeads = resolved.filter(pair => !pair.member.parentMemberId);
    const lead = explicitLeads.length === 1 ? explicitLeads[0] : explicitLeads.length === 0 && structuralLeads.length === 1 ? structuralLeads[0] : null;
    if (!lead) continue;
    const leadOccupantId = lead.occupant.id;
    const floorId = lead.occupant.floorId || '1';
    resolved.sort((a, b) => (a.member.roleKind === 'lead' ? -1 : 0) - (b.member.roleKind === 'lead' ? -1 : 0)
      || (a.occupant.rosterOrder ?? Number.MAX_SAFE_INTEGER) - (b.occupant.rosterOrder ?? Number.MAX_SAFE_INTEGER)
      || a.member.id.localeCompare(b.member.id));
    const memberRows = resolved.map(({ member, occupant }) => {
      const parent = records.find(row => row.id === member.parentMemberId);
      const parentOccupant = parent && memberOccupant(parent);
      const runtime = runtimePresentationFor?.(member.runtimeKind) || null;
      const state = occupant.state || 'unknown';
      const tone = ['thinking', 'working', 'researching', 'writing', 'executing', 'calling', 'waiting'].includes(state) ? 'working'
        : ['blocked', 'error'].includes(state) ? 'attention' : ['idle', 'offline'].includes(state) ? 'idle' : 'unknown';
      const roleLabel = member.roleLabel && comparableLabel(member.roleLabel) === comparableLabel(member.name)
        ? null : member.roleLabel ? labelText(member.roleLabel) : { key: `occupantRole.${member.roleKind === 'lead' ? 'agent' : 'subagent'}` };
      return { occupantId: occupant.id,
        roleLabel,
        parentLabel: parent ? { key: 'team.member.reportsTo', params: { name: parentOccupant?.name || parent.name } } : null,
        runtimeLabel: runtime?.label || { key: 'team.runtime.other' },
        runtimeMark: runtime?.brand || null,
        stateLabel: occupant.stateLabel || { key: `agentState.${state}` }, stateTone: tone,
      };
    });
    const label = labelText(team.label);
    groups.push({ id: teamId, label,
      floorId, leadOccupantId,
      members: memberRows, memberCount: memberRows.length,
      memberCountLabel: { key: 'office.team.memberCount', params: { n: memberRows.length } },
      _resolvedOccupants: resolved.map(pair => pair.occupant) });
  }
  const floorOrder = id => id === 'rdc' ? 0 : id === 'gym' ? 10002 : Number(id) || 1;
  const ordered = groups.sort((a, b) => floorOrder(a.floorId) - floorOrder(b.floorId) || a.id.localeCompare(b.id));
  assignTeamAccents(ordered);
  const teamsByLead = new Map();
  for (const group of ordered) {
    const teamIds = teamsByLead.get(group.leadOccupantId) || [];
    teamIds.push(group.id);
    teamsByLead.set(group.leadOccupantId, teamIds);
  }
  const homePodByLead = new Map();
  for (const group of ordered) {
    if (homePodByLead.has(group.leadOccupantId)) continue;
    const leadOccupant = group._resolvedOccupants.find(occupant => occupant.id === group.leadOccupantId);
    const homeTeamId = leadOccupant?.teamId;
    homePodByLead.set(group.leadOccupantId, teamsByLead.get(group.leadOccupantId)?.includes(homeTeamId) ? homeTeamId : group.id);
  }
  for (const group of ordered) {
    // A shared lead is represented in every team's member list, but its
    // canonical team owns the physical seat and pod geometry.
    const podOccupants = group._resolvedOccupants.filter(occupant => occupant.id !== group.leadOccupantId
      || homePodByLead.get(group.leadOccupantId) === group.id);
    const geometry = teamPodGeometry(podOccupants, group.floorId, floorLayouts, index);
    group.pod = { floorId: group.floorId, coordinateSpace: 'floor-grid', ...geometry,
      seats: podOccupants.map(occupant => ({ occupantId: occupant.id,
        stationUid: occupant.stationUid || null, standingPoint: occupant.standingPoint || null })) };
  }
  const byTeamId = new Map(ordered.map(group => [group.id, group]));
  return ordered.map(group => {
    const isHomePod = homePodByLead.get(group.leadOccupantId) === group.id;
    const sharedLeadLinks = isHomePod ? (teamsByLead.get(group.leadOccupantId) || []).filter(otherTeamId => otherTeamId !== group.id).map(otherTeamId => {
      const other = byTeamId.get(otherTeamId);
      return { occupantId: group.leadOccupantId, teamId: otherTeamId, label: labelText(teams.get(otherTeamId)?.label || otherTeamId),
        fromPoint: zoneCenter(group.pod.zone), toPoint: zoneCenter(other?.pod.zone) };
    }) : [];
    const { _resolvedOccupants: _podMembers, ...result } = group;
    return { ...result, sharedLeadLinks };
  });
}

function teamPodGeometry(occupants, floorId, floorLayouts, index) {
  const floor = (Array.isArray(floorLayouts) ? floorLayouts : []).find(row => row.id === floorId);
  const room = floor?.layout?.room && index?.rooms?.get(floor.layout.room);
  if (!room || !Number.isFinite(room.cols) || !Number.isFinite(room.rows)) return { zone: null };
  const points = occupants.map(occupant => teamOccupantPoint(occupant, floorId, floorLayouts, index))
    .filter(Boolean).map(point => ({ x: Math.max(0, Math.min(room.cols, point.x)), y: Math.max(0, Math.min(room.rows, point.y)) }));
  if (!points.length) return { zone: null };
  const bounds = {
    minX: Math.max(0, Math.min(...points.map(point => point.x)) - 1),
    minY: Math.max(0, Math.min(...points.map(point => point.y)) - 1),
    maxX: Math.min(room.cols, Math.max(...points.map(point => point.x)) + 1),
    maxY: Math.min(room.rows, Math.max(...points.map(point => point.y)) + 1),
  };
  const zone = { bounds, polygon: [
    { x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY },
  ] };
  return { zone };
}

function zoneCenter(zone) {
  const bounds = zone?.bounds;
  return bounds && Number.isFinite(bounds.minX) && Number.isFinite(bounds.maxX)
    && Number.isFinite(bounds.minY) && Number.isFinite(bounds.maxY)
    ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 } : null;
}

function teamOccupantPoint(occupant, floorId, floorLayouts, index) {
  const floor = (Array.isArray(floorLayouts) ? floorLayouts : []).find(row => row.id === floorId);
  const roomItems = floor?.layout?.items || [];
  const itemByUid = new Map(roomItems.filter(row => typeof row.uid === 'string').map(row => [row.uid, row]));
  const station = occupant?.stationUid && itemByUid.get(occupant.stationUid);
  const furniture = station && index?.furniture?.get(station.asset);
  if (station && furniture?.station) {
    try { return seatTile(station, furniture); } catch { /* use a supplied target below */ }
  }
  if (occupant?.standingPoint && Number.isFinite(occupant.standingPoint.x) && Number.isFinite(occupant.standingPoint.y)) return occupant.standingPoint;
  if (occupant?.sceneTarget?.point && Number.isFinite(occupant.sceneTarget.point.x) && Number.isFinite(occupant.sceneTarget.point.y)) return occupant.sceneTarget.point;
  return null;
}

function withoutTeamMembership(office) {
  if (!office || typeof office !== 'object') return office;
  const withoutTeamLabel = ({ teamLabel: _teamLabel, ...item }) => item;
  const occupants = (office.occupants || []).map(({ teamId: _teamId, teamIds: _teamIds, memberId: _memberId, ...row }) => ({ ...row, teamId: null }));
  return { ...office,
    occupants,
    rosterGroups: (office.rosterGroups || []).map(({ teamId: _teamId, ...group }) => ({ ...group, teamId: null })),
    rosterItems: (office.rosterItems || []).map(withoutTeamLabel),
    rosterPreviewItems: (office.rosterPreviewItems || []).map(withoutTeamLabel),
    rosterFloors: projectFloorAgentGroups((office.rosterFloors || []).map(floor => ({ ...floor,
      items: (floor.items || []).filter(item => item.kind !== 'team-group') })), occupants),
    unseatedTeams: [], teamGroups: [], teamLegend: [],
  };
}

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

function officeAgentCountLabel(count) {
  return { key: count === 1 ? 'office.floor.count.one' : 'office.floor.count.other', params: { n: count } };
}

// "Teams and agents" lists the whole office on every floor (owner decision, reverses T-0255 for the roster
// only): each team once with all its members wherever they sit, then every agent without a team. The selected
// floor's teams come first; members away from the group's main floor carry that floor's label. The map side
// (teamGroups, pods, showTeamPanel) stays per floor.
function projectFloorAgentGroups(rosterFloors, occupants, teamGroups = []) {
  const byId = new Map((occupants || []).map(row => [row.id, row]));
  const previewFor = occupantIds => {
    const occupantId = occupantIds[0] || null, row = occupantId ? byId.get(occupantId) : null;
    return row ? { previewOccupantId: occupantId, previewState: row.state, previewStateKind: row.stateKind || row.state,
      previewStateLabel: row.stateLabel || { key: `agentState.${row.state || 'unknown'}` },
      previewStateActive: row.stateActive === true } : {};
  };
  const floors = rosterFloors || [], floorRank = new Map(floors.map((floor, index) => [floor.id, index])), floorOf = new Map();
  for (const floor of floors) for (const id of floor.occupantIds || []) if (byId.has(id) && !floorOf.has(id)) floorOf.set(id, floor.id);
  const isAgent = id => floorOf.has(id) && !CONVERSATION_ROLES.has(byId.get(id).role);
  const seatedAgent = id => isAgent(id) && !byId.get(id).visitPhase;
  // Office-wide membership, decided once: a shared lead belongs to its canonical team only.
  const teams = [...new Map((teamGroups || []).map(team => [team.id, team])).values()].sort((a, b) => {
    const aCanonical = byId.get(a.leadOccupantId)?.teamId === a.id ? 0 : 1;
    const bCanonical = byId.get(b.leadOccupantId)?.teamId === b.id ? 0 : 1;
    return aCanonical - bCanonical || a.id.localeCompare(b.id);
  });
  const assigned = new Set(), teamRows = [];
  for (const team of teams) {
    const occupantIds = (team.members || []).map(member => member.occupantId).filter(id => isAgent(id) && !assigned.has(id));
    if (!occupantIds.length) continue;
    for (const id of occupantIds) assigned.add(id);
    teamRows.push({ team, occupantIds });
  }
  const unassignedIds = floors.flatMap(floor => (floor.occupantIds || []).filter(id => floorOf.get(id) === floor.id && seatedAgent(id) && !assigned.has(id)));
  const placement = (occupantIds, mainFloorId) => ({
    floorLabels: [...new Set(occupantIds.map(id => floorOf.get(id)))]
      .sort((a, b) => (a === mainFloorId ? -1 : b === mainFloorId ? 1 : floorRank.get(a) - floorRank.get(b))).map(floorLabel),
    memberFloors: occupantIds.filter(id => floorOf.get(id) !== mainFloorId).map(id => ({ occupantId: id, label: floorLabel(floorOf.get(id)) })),
  });
  return floors.map(floor => {
    const ordered = [...teamRows.filter(row => row.team.floorId === floor.id), ...teamRows.filter(row => row.team.floorId !== floor.id)];
    const groups = ordered.map(({ team, occupantIds }) => ({ id: team.id, kind: 'team', teamId: team.id, label: team.label, accentToken: team.accentToken,
      leadOccupantId: team.leadOccupantId, occupantIds, count: occupantIds.length, countLabel: officeAgentCountLabel(occupantIds.length),
      ...previewFor([[team.leadOccupantId, ...occupantIds].find(id => occupantIds.includes(id))].filter(Boolean)),
      sharedLabel: team.sharedLeadLinks?.length ? { key: 'office.floor.sharedAcrossTeams', params: { n: team.sharedLeadLinks.length + 1 } } : null,
      ...placement(occupantIds, team.floorId) }));
    const loose = [...unassignedIds.filter(id => floorOf.get(id) === floor.id), ...unassignedIds.filter(id => floorOf.get(id) !== floor.id)];
    if (loose.length) groups.push({ id: `unassigned:${floor.id}`, kind: 'unassigned', teamId: null,
      label: { key: 'office.floor.unassignedAgents' }, occupantIds: loose,
      count: loose.length, countLabel: officeAgentCountLabel(loose.length), ...previewFor(loose), ...placement(loose, floor.id) });
    // The map's team panel and pods remain those seated on this floor.
    const floorTeamGroups = teamRows.filter(row => row.team.floorId === floor.id && row.occupantIds.some(id => floorOf.get(id) === floor.id)).map(row => row.team);
    const listed = new Set(groups.flatMap(group => group.occupantIds));
    const otherItems = [];
    let pendingHeaders = [];
    for (const item of floor.items || []) {
      if (item.kind === 'team-header') { pendingHeaders.push(item); continue; }
      if (floorOf.get(item.occupantId) === floor.id && !listed.has(item.occupantId)) {
        const row = byId.get(item.occupantId), parent = row && byId.get(row.parentId);
        if (parent && !pendingHeaders.length) pendingHeaders.push({
          kind: 'team-header', id: `team-header:${parent.id}:${floor.id}`,
          label: { key: 'office.floor.team', params: { name: parent.name, floor: floorLabel(parent.floorId) } },
        });
        otherItems.push(...pendingHeaders, item);
      }
      pendingHeaders = [];
    }
    return { ...floor, agentGroups: groups, agentGroupsLabel: { key: 'office.floor.agentGroups' }, teamGroups: floorTeamGroups,
      showTeamPanel: floorTeamGroups.length > 0, otherItems };
  });
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
  const agentRows = rows => rows.filter(row => !row.visitPhase);
  const activeCount = rows => agentRows(rows).some(row => stateOf(row) === 'unknown') ? null : agentRows(rows).filter(row => !['idle', 'offline'].includes(stateOf(row))).length;
  // Scene, floor totals, KPI population, and the mobile summary describe the
  // same on-stage set, including a conversation while it is visibly visiting.
  const rosterSummary = { count: agentRows(office.occupants).length, activeCount: activeCount(office.occupants) };
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
      stateActive: !row.visitPhase && !['unknown', 'idle', 'offline'].includes(state),
      ...(row.visitPhase ? { stateKind: 'visitor' } : {}),
      floorId: typeof row.floorId === 'string' ? row.floorId : '1',
      standingPoint: row.standingPoint && Number.isFinite(row.standingPoint.x) && Number.isFinite(row.standingPoint.y)
        ? { x: row.standingPoint.x, y: row.standingPoint.y } : null,
      rosterDepth: row.visitPhase && parents.get(id) && byId.get(parents.get(id))?.floorId !== row.floorId ? 1
        : conversations.has(id) && !row.visitPhase ? 0 : depth,
      parentName: !row.visitPhase && !conversations.has(id) && parents.get(id) ? byId.get(parents.get(id))?.name || null : null,
      drawerRoleLabel: row.visitPhase && HUMAN_CONTACT_ROLES.has(row.role)
        ? { key: `occupantRole.${row.role}` }
        : row.roleLabel || { key: `occupantRole.${row.role}` },
      ...(row.visitPhase && HUMAN_CONTACT_ROLES.has(row.role) ? { roleLabel: { key: 'occupantRole.visitor' } } : {}),
      stateLabel: row.visitPhase ? { key: 'occupantRole.visitor' } : { key: `agentState.${state}` },
      stateDetailLabel: row.visitPhase ? { key: 'occupantRole.visitor' } : stateDetailLabel(state),
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
    const visitIds = ordered.filter(entry => entry.rootId === rootId && conversations.has(entry.id) && rows.get(entry.id)?.visitPhase)
      .map(entry => entry.id);
    const root = rows.get(rootId);
    const childIds = [...memberIds, ...visitIds];
    const previewOccupantIds = [rootId, ...childIds.slice(0, 2)];
    const overflowCount = Math.max(0, childIds.length - 2);
    return { id: rootId, kind: childIds.length ? 'group' : 'occupant', isGroup: childIds.length > 0, rootId, occupantIds: [rootId, ...childIds], childIds,
      previewOccupantIds, overflowCount,
      teamLabel: { key: 'office.mobile.team', params: { name: root.name } },
      openLabel: { key: 'office.mobile.openTeam', params: { name: root.name, n: memberIds.length } },
      delegatesLabel: { key: 'office.mobile.delegates', params: { n: memberIds.length } },
      overflowLabel: overflowCount ? { key: 'office.mobile.overflowCount', params: { n: overflowCount } } : null,
      order: orderById.get(rootId), count: childIds.length, label: root.title };
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
  const rosterFloors = projectFloorAgentGroups([...floorsMap].map(([id, people]) => { const agents = agentRows(people); const active = activeCount(people); return { id, order: floorOrder(id), label: floorLabel(id), countLabel: officeAgentCountLabel(agents.length), occupantIds: people.map(row => row.id), mobileLabelIds: mobileLabelIds(people, rosterGroups), items: floorRosterItems(people, rows, projectReference),
    count: agents.length, activeCount: active, statusLabel: active == null ? { key: 'office.floor.activityUnknown' } : { key: 'office.floor.status', params: { active, idle: agents.filter(row => ['idle', 'offline'].includes(stateOf(row))).length } },
    idleCount: agents.filter(row => ['idle', 'offline'].includes(stateOf(row))).length,
    kind: id === 'rdc' ? 'lobby' : id === 'gym' ? 'gym' : 'office', layout: null, capacity: null } })
    .sort((a, b) => a.order - b.order), occupants);
  const stateLabels = Object.fromEntries([...OFFICE_STATES].map(state => [state, { key: `agentState.${state}` }]));
  stateLabels.observed = { key: 'agentState.observed' };
  return { ...office, occupants, rosterGroups, rosterItems, rosterPreviewItems, rosterOverflowCount, rosterSummary, conversationIds,
    conversationCount: conversationIds.length, stateLabels, rosterAllLabel: { key: 'office.mobile.all', params: { n: rosterItems.length } },
    rosterOverflowLabel: { key: 'office.mobile.overflowCount', params: { n: rosterOverflowCount } },
    conversationLabel: { key: 'office.mobile.conversations', params: { n: conversationIds.length } }, rosterFloors, teamGroups: [], teamLegend: [],
    unseatedTeams: Array.isArray(office.unseatedTeams) ? office.unseatedTeams : [] };
}

function projectOfficePlacement(office, { layout, index, projectOccupantId = id => id, now = Date.now(), tracker = null, planningOccupants = null,
  homeAssignments = null, rememberHomeAssignments = null, engine = null, canReadSessions = false, idleTransitionDebounceMs = 3_000,
  teamSnapshot = null, canReadTeams = false } = {}) {
  if (!office || !Array.isArray(office.occupants) || !layout || !index) return office;
  const { planOfficePlacement } = require('./placement');
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
  let population = boundedOccupants([...populationById.values()]).rows;
  population = tracker?.debounceIdleTransitions?.(population, now, idleTransitionDebounceMs) || population;
  const effectiveById = new Map(population.map(row => [row.id, row]));
  office = { ...office, occupants: office.occupants.map(row => {
    const id = placementIdBySourceId.get(row.id) || placementId(row), effective = effectiveById.get(id);
    return effective ? { ...row, state: effective.state, stateSince: effective.stateSince } : row;
  }) };
  // Exact-session folding can replace a runtime row ID with the stable private
  // member ID while a previously persisted plan still stores its station under
  // the old ID's placement token. Move those private saved tokens forward so
  // the seat remains with the same logical member instead of being reserved as
  // if its former identity were a departed occupant.
  const placementHomeAssignments = remapSavedMemberStations(homeAssignments, suppliedPopulation, placementId);
  const plan = planOfficePlacement({ index, layout, occupants: population, now, tracker, homeAssignments: placementHomeAssignments });
  const finalPlacementById = new Map(plan.placements.map(row => [row.id, row]));
  tracker?.rememberIdlePlacements?.(population.map(row => ({ ...row, ...(finalPlacementById.get(row.id) || {}) })));
  if (typeof rememberHomeAssignments === 'function' && plan.homeAssignments) rememberHomeAssignments(plan.homeAssignments);
  const plannedById = new Map(plan.placements.map(row => [displayIdByPlacementId.get(row.id) || row.id, row]));
  // The placement engine enforces atomic team home-floor assignment before it
  // may move an idle member to a declared activity spot.
  const occupants = office.occupants.map(sourceRow => {
    const row = typeof sourceRow.parentId === 'string' && displayIdBySourceId.has(sourceRow.parentId)
      ? { ...sourceRow, parentId: displayIdBySourceId.get(sourceRow.parentId) } : sourceRow;
    const place = plannedById.get(row.id);
    if (row.visitPhase) {
      const host = office.occupants.find(candidate => candidate.id === row.parentId);
      return { ...row, floorId: place?.floorId || host?.floorId || row.floorId, stationUid: null,
        standingPoint: place?.standingPoint || null, ...(place?.sceneTarget ? { sceneTarget: place.sceneTarget } : {}),
        ...(place?.sceneTravel ? { sceneTravel: place.sceneTravel } : {}) };
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
    const agentPeople = finalPeople.filter(row => !row.visitPhase);
    const active = agentPeople.some(row => !OFFICE_STATES.has(row.state) || row.state === 'unknown')
      ? null : agentPeople.filter(row => !['idle', 'offline'].includes(row.state)).length;
    return { id: floor.id, order: floorOrder(floor.id), label: floorLabel(floor.id), countLabel: officeAgentCountLabel(agentPeople.length), kind: floor.kind, occupantIds: finalPeople.map(row => row.id), mobileLabelIds: mobileLabelIds(finalPeople, rosterOffice.rosterGroups), items: floorRosterItems(finalPeople, byId, projectReference),
      count: agentPeople.length, activeCount: active, statusLabel: active == null ? { key: 'office.floor.activityUnknown' } : { key: 'office.floor.status', params: { active, idle: agentPeople.filter(row => ['idle', 'offline'].includes(row.state)).length } },
      idleCount: agentPeople.filter(row => ['idle', 'offline'].includes(row.state)).length, layout: floor.layout, capacity: floor.capacity };
  }).sort((a, b) => a.order - b.order);
  const communicated = require('./communication').projectCommunication(
    { ...rosterOffice, rosterFloors, unseatedTeams: visibleUnseatedTeams }, { engine, index, layout, now, canReadSessions });
  const teamGroups = canReadTeams ? projectTeamGroups(communicated.occupants, teamSnapshot,
    kind => engine?.runtimePresentationFor?.(kind) || null, { floorLayouts: plan.floors, index }) : [];
  const sanitized = canReadTeams ? communicated : withoutTeamMembership(communicated);
  const floorAgentGroups = projectFloorAgentGroups(sanitized.rosterFloors, sanitized.occupants, canReadTeams ? teamGroups : []);
  const teamLegend = teamGroups.map(group => ({ teamId: group.id, label: group.label, accentToken: group.accentToken }));
  return { ...sanitized, rosterFloors: floorAgentGroups, teamGroups, teamLegend };
}

function exactMemberLayoutRule(layout, row) {
  const rules = require('./layout-rules');
  return [row.id, ...teamMemberAliases(row)].find(alias => {
    const rule = rules.ruleFor(layout, alias, row.role);
    return rule && rules.ruleKind(rule.agentId) === 'exact';
  }) || null;
}

function remapSavedMemberStations(homeAssignments, rows, placementId) {
  if (!homeAssignments || typeof homeAssignments !== 'object') return homeAssignments;
  const { placementToken } = require('./floors');
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

module.exports = { projectOfficeRoster, projectOfficePlacement, projectTeamGroups, projectFloorAgentGroups, withoutTeamMembership,
  teamOccupantPoint };
