'use strict';
// Spatial allocation only. Canonical identity, membership, order and status are supplied by the caller.
const { planFloors } = require('./floors.js');
const { canonicalRole, canonicalRuleId, elevatorAccess, seatTile } = require('./layout-rules.js');
const { buildGrid, findPath, isWalkable } = require('./pathfind.js');
const crypto = require('node:crypto');

const DEFAULT_IDLE_RELOCATION_MINUTES = 15;
const SPOT_KINDS = new Set(['idle', 'gym', 'smoke', 'coffee', 'seat']);
const RELOCATABLE_ROLES = new Set(['primary', 'main', 'agent', 'subagent', 'host', 'team-host', 'member', 'team-member']);
const facingFor = value => ['ne', 'se', 'sw'].includes(value) ? value : 'sw';
const center = p => ({ x: p.x + 0.5, y: p.y + 0.5 });
const spatialIdentity = id => canonicalRuleId(id) || id;
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 20);

function target({ kind, floorId, stationUid = null, point, approachPoint = null, seatContact = null, mode = 'stand', seatIndex = null, facing = 'sw' }) {
  return { kind, floorId, stationUid, point: { x: point.x, y: point.y }, approachPoint: approachPoint && { x: approachPoint.x, y: approachPoint.y },
    seatContact: seatContact && { x: seatContact.x, y: seatContact.y }, mode, seatIndex, facing: facingFor(facing) };
}

function stationTargetFor(placement, floor, index, stationUid) {
  const station = stationUid && floor?.layout.items.find(row => row.uid === stationUid);
  const asset = station && index.furniture.get(station.asset);
  const stationDef = asset?.station;
  if (station && stationDef) {
    const seat = stationDef.seated?.seat ?? stationDef.seat;
    const contact = { x: station.x + seat.x, y: station.y + seat.y };
    const approach = seatTile(station, asset);
    return target({ kind: stationDef.kind === 'lounge' ? 'lounge' : 'station', floorId: placement.floorId, stationUid: station.uid,
      point: contact, approachPoint: center(approach), seatContact: contact, mode: stationDef.kind === 'lounge' ? 'sofa' : 'desk', facing: stationDef.seated?.facing ?? stationDef.facing });
  }
  const p = placement.standingPoint || { x: 0.5, y: 0.5 };
  return target({ kind: 'standing', floorId: placement.floorId, point: p, approachPoint: p, mode: 'stand' });
}

function homeTargetFor(placement, floor, index) {
  return stationTargetFor(placement, floor, index, placement._homeWant || placement.stationUid);
}

function allocatedTargetFor(placement, floor, index) {
  return stationTargetFor(placement, floor, index, placement.stationUid);
}

function activitySpotsFor(floor, index) {
  const room = index.rooms.get(floor.layout.room);
  if (!room) return [];
  const grid = buildGrid(room.cols, room.rows, floor.layout.items, index.furniture);
  const entrance = room.entrance || { x: 0, y: room.rows - 1 };
  const access = elevatorAccess(floor.layout, index);
  const start = access?.cell || entrance;
  const forbidden = new Set((access?.tiles || []).map(p => `${p.x},${p.y}`));
  const seats = floor.layout.items.flatMap(item => {
    const station = index.furniture.get(item.asset)?.station;
    if (!station || item.wall != null) return [];
    const point = seatTile(item, index.furniture.get(item.asset));
    return [{ key: `${point.x},${point.y}`, uid: item.uid }];
  });
  const used = new Set();
  const declared = index.rooms.get(floor.layout.room)?.activitySpots || [];
  return declared.flatMap(spot => {
    if (!SPOT_KINDS.has(spot.kind) || !Array.isArray(spot.points) || spot.capacity !== spot.points.length) return [];
    const seated = spot.kind === 'seat';
    if (seated && (!spot.asset || spot.approachPoints?.length !== spot.capacity || spot.seatContacts?.length !== spot.capacity)) return [];
    const items = spot.asset ? floor.layout.items.filter(item => item.asset === spot.asset && item.wall == null
      && (!spot.orientation || (item.orientation ?? 'sw') === spot.orientation)) : [null];
    return items.flatMap(item => spot.points.flatMap((local, slot) => {
      const offset = point => point && { x: point.x + (item?.x ?? 0), y: point.y + (item?.y ?? 0) };
      const p = offset(local), approach = seated ? offset(spot.approachPoints[slot]) : p;
      const contact = seated ? offset(spot.seatContacts[slot]) : null;
      if (![p, approach, ...(seated ? [contact] : [])].every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))) return [];
      const region = spot.region;
      if (region && (p.x < region.x || p.y < region.y || p.x >= region.x + region.w || p.y >= region.y + region.d)) return [];
      const x = Math.floor(approach.x), y = Math.floor(approach.y), key = `${x},${y}`;
      if (p.x < 0 || p.y < 0 || p.x >= room.cols || p.y >= room.rows
        || !isWalkable(grid, x, y) || forbidden.has(key) || used.has(key)
        || seats.some(seat => seat.key === key && seat.uid !== item?.uid)
        || !findPath(grid, start, { x, y })) return [];
      if (seated && grid.owner[Math.floor(p.y) * grid.cols + Math.floor(p.x)] !== item.uid) return [];
      used.add(key);
      const id = item ? `${spot.id}:${item.uid}` : spot.id;
      return [{ id, activityId: `${floor.id}:${id}:${slot}`, kind: spot.kind, capacity: spot.capacity, slot, floorId: floor.id,
        target: target({ kind: spot.kind === 'gym' ? 'destination' : 'lounge', floorId: floor.id, stationUid: item?.uid ?? null,
          point: p, approachPoint: approach, seatContact: contact, mode: seated ? 'sofa' : 'stand', seatIndex: seated ? slot : null }) }];
    }));
  });
}

function transitionTarget(floor, index, fallback) {
  if (!floor?.layout) return fallback;
  const room = index.rooms.get(floor.layout.room);
  const endpoint = elevatorAccess(floor.layout, index)?.cell || room?.entrance;
  return endpoint ? target({ kind: 'destination', floorId: floor.id, point: center(endpoint), approachPoint: center(endpoint) }) : fallback;
}

function visitorPlacements(rows, placements, floors, index) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const placementById = new Map(placements.map(row => [row.id, row]));
  const floorById = new Map(floors.map(row => [row.id, row]));
  const reserved = new Map();
  const reserve = (floorId, x, y) => {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return;
    const cells = reserved.get(floorId) || new Set(); cells.add(`${x},${y}`); reserved.set(floorId, cells);
  };
  for (const placement of placements) {
    if (placement.stationUid) {
      const floor = floorById.get(placement.floorId);
      const item = floor?.layout.items.find(row => row.uid === placement.stationUid);
      const asset = item && index.furniture.get(item.asset);
      const cell = item && asset?.station ? seatTile(item, asset) : null;
      if (cell) reserve(placement.floorId, cell.x, cell.y);
    }
    if (placement.standingPoint) reserve(placement.floorId, placement.standingPoint.x, placement.standingPoint.y);
    if (placement.sceneTarget?.point) reserve(placement.floorId, Math.floor(placement.sceneTarget.point.x), Math.floor(placement.sceneTarget.point.y));
  }
  const output = new Map();
  const visitors = rows.filter(row => row.visitPhase && row.parentId).sort((a, b) => a.id.localeCompare(b.id));
  for (const visitor of visitors) {
    const host = byId.get(visitor.parentId), home = host && placementById.get(host.id);
    const floor = home && floorById.get(home.floorId), room = floor && index.rooms.get(floor.layout.room);
    if (!host || !home || !floor || !room) continue;
    const grid = buildGrid(room.cols, room.rows, floor.layout.items, index.furniture);
    const station = home.stationUid && floor.layout.items.find(row => row.uid === home.stationUid);
    const asset = station && index.furniture.get(station.asset);
    const seat = station && asset?.station ? seatTile(station, asset) : null;
    const base = seat || (home.standingPoint && { x: home.standingPoint.x, y: home.standingPoint.y });
    if (!base) continue;
    const start = elevatorAccess(floor.layout, index)?.cell || room.entrance || { x: 0, y: room.rows - 1 };
    const taken = reserved.get(floor.id) || new Set();
    const candidates = [];
    for (let radius = 1; radius <= 2; radius++) for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
      const cell = { x: base.x + dx, y: base.y + dy }, key = `${cell.x},${cell.y}`;
      if (cell.x < 0 || cell.y < 0 || cell.x >= room.cols || cell.y >= room.rows || taken.has(key)
        || !isWalkable(grid, cell.x, cell.y) || !findPath(grid, start, cell)) continue;
      candidates.push({ ...cell, distance: Math.abs(dx) + Math.abs(dy), dx, dy });
    }
    candidates.sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
    const spot = candidates[0];
    if (!spot) continue;
    taken.add(`${spot.x},${spot.y}`); reserved.set(floor.id, taken);
    const facing = spot.x < base.x ? 'sw' : spot.x > base.x ? 'se' : 'sw';
    const point = center(spot);
    output.set(visitor.id, { id: visitor.id, floorId: floor.id, stationUid: null,
      standingPoint: { x: spot.x, y: spot.y }, sceneTarget: target({ kind: 'visit', floorId: floor.id, point,
        approachPoint: point, mode: 'stand', facing }) });
  }
  return output;
}

function relocateIdle(placements, occupants, floors, index, layoutData, now, tracker, pressureIds = new Set()) {
  const configured = layoutData?.idleRelocationMinutes;
  const thresholdMs = (Number.isInteger(configured) && configured >= 1 && configured <= 1440 ? configured : DEFAULT_IDLE_RELOCATION_MINUTES) * 60_000;
  const byId = new Map(occupants.map(row => [row.id, row]));
  const placementById = new Map(placements.map(row => [row.id, row]));
  const floorById = new Map(floors.map(row => [row.id, row]));
  const available = floors.flatMap(floor => activitySpotsFor(floor, index));
  const assignments = new Map();
  const reserved = new Set();
  const eligible = occupants.filter(row => RELOCATABLE_ROLES.has(canonicalRole(row.role) || row.role) && row.state === 'idle'
    && (pressureIds.has(row.id) || Number.isFinite(row.stateSince) && now - row.stateSince >= thresholdMs)
    && !row.visitPhase && !row.gone).sort((a, b) => {
    const pressureOrder = Number(pressureIds.has(b.id)) - Number(pressureIds.has(a.id));
    if (pressureOrder) return pressureOrder;
    if (pressureIds.has(a.id) && pressureIds.has(b.id))
      return (Number.isFinite(a.stateSince) ? a.stateSince : now) - (Number.isFinite(b.stateSince) ? b.stateSince : now)
        || spatialIdentity(a.id).localeCompare(spatialIdentity(b.id));
    const standingA = !placementById.get(a.id)?.stationUid ? 0 : 1;
    const standingB = !placementById.get(b.id)?.stationUid ? 0 : 1;
    return standingA - standingB || spatialIdentity(a.id).localeCompare(spatialIdentity(b.id));
  });
  // Retain valid assignments first so repeated snapshots cannot reshuffle occupants.
  for (const row of eligible) {
    const old = tracker?.relocations?.get(spatialIdentity(row.id));
    if (!old?.activityId || old.stateSince !== row.stateSince) continue;
    const spot = available.find(item => item.activityId === old.slotId);
    const isPressure = pressureIds.has(row.id);
    if (spot && spot.floorId !== placementById.get(row.id)?.floorId && (!isPressure || ['rdc', 'gym'].includes(spot.floorId))
      && !reserved.has(`${spot.floorId}:${spot.id}:${spot.slot}`)) {
      assignments.set(row.id, spot); reserved.add(`${spot.floorId}:${spot.id}:${spot.slot}`);
    }
  }
  for (const row of eligible) {
    if (assignments.has(row.id)) continue;
    const home = placementById.get(row.id);
    // Standing overflow workers go first; among them use stable canonical IDs.
    const choices = available.filter(item => !reserved.has(`${item.floorId}:${item.id}:${item.slot}`)
      && item.floorId !== home?.floorId && (!pressureIds.has(row.id) || ['rdc', 'gym'].includes(item.floorId)));
    const kinds = [...new Set(choices.map(item => item.kind))].sort();
    const preferred = kinds[parseInt(digest(spatialIdentity(row.id)).slice(0, 8), 16) % kinds.length];
    const spot = choices.find(item => item.kind === preferred) || choices[0];
    if (!spot) continue;
    assignments.set(row.id, spot); reserved.add(`${spot.floorId}:${spot.id}:${spot.slot}`);
  }
  const usedIds = new Set(occupants.map(row => spatialIdentity(row.id)));
  for (const id of tracker?.relocations?.keys?.() || []) if (!usedIds.has(id)) tracker.relocations.delete(id);
  const updated = placements.map(home => {
    const row = byId.get(home.id), spot = assignments.get(home.id), previous = tracker?.relocations?.get(spatialIdentity(home.id));
    const homeTarget = homeTargetFor(home, floorById.get(home.floorId), index);
    if (!row || !spot) {
      if (previous?.activityId && tracker?.relocations) {
        const fromFloor = floorById.get(previous.floorId);
        const toFloor = floorById.get(home.floorId);
        const departure = transitionTarget(fromFloor, index, previous.target);
        const arrival = transitionTarget(toFloor, index, homeTarget);
        tracker.relocations.set(spatialIdentity(home.id), { activityId: null, floorId: home.floorId, target: homeTarget,
          travel: previous.floorId === home.floorId ? null : { id: `travel:${digest(`${spatialIdentity(home.id)}|${previous.activityId}|return`)}`, fromFloorId: previous.floorId, toFloorId: home.floorId, departure, arrival } });
      }
      const state = tracker?.relocations?.get(spatialIdentity(home.id));
      return { ...home, homeTarget, sceneTarget: allocatedTargetFor(home, floorById.get(home.floorId), index), activity: null,
        sceneTravel: state?.activityId === null ? state.travel : null };
    }
    const slotId = spot.activityId;
    const activityId = `${row.stateSince}|${slotId}`;
    const sameActivity = previous?.activityId === activityId && previous?.stateSince === row.stateSince;
    const since = sameActivity && Number.isSafeInteger(previous?.since) ? previous.since
      : pressureIds.has(row.id) ? now : row.stateSince + thresholdMs;
    // A seated pause uses the existing canonical idle activity; the supplied
    // target mode/contact distinguishes seating without a new VM vocabulary.
    const activityKind = spot.kind === 'seat' ? 'idle' : spot.kind;
    const activity = { id: `activity:${digest(`${spatialIdentity(home.id)}|${activityId}`)}`, kind: activityKind, spotId: spot.id, since,
      label: { key: `office.activity.${activityKind}` } };
    let travel = previous?.travel || null;
    const previousFloorId = previous?.activityId ? previous.floorId : home.floorId;
    if (previous?.activityId !== activityId && previousFloorId !== spot.floorId) {
      const fromFloor = floorById.get(previousFloorId);
      const toFloor = floorById.get(spot.floorId);
      const departure = transitionTarget(fromFloor, index, previous?.target || homeTarget);
      const arrival = transitionTarget(toFloor, index, spot.target);
      travel = { id: `travel:${digest(`${spatialIdentity(home.id)}|${previous?.activityId || 'home'}|${activityId}`)}`, fromFloorId: previousFloorId, toFloorId: spot.floorId, departure, arrival };
    } else if (previous?.activityId === activityId) travel = previous.travel || null;
    else if (previousFloorId === spot.floorId) travel = null;
    tracker?.relocations?.set(spatialIdentity(home.id), { activityId, slotId, stateSince: row.stateSince, since,
      floorId: spot.floorId, target: spot.target, travel });
    return { ...home, floorId: spot.floorId, stationUid: null, standingPoint: { x: Math.floor(spot.target.point.x), y: Math.floor(spot.target.point.y) }, homeTarget, sceneTarget: spot.target, activity, sceneTravel: travel };
  });
  return updated;
}

/**
 * @param {{index:object,layout:object,occupants:object[]}} input
 * @returns {{placements:{id:string,floorId:string,stationUid:string|null,standingPoint:{x:number,y:number}|null}[],floors:object[],unseatedTeams:object[]}}
 */
function planOfficePlacement({ index, layout, occupants, now = Date.now(), tracker = null, homeAssignments = null }) {
  // The scoped API persists these private hashes in the store. Unscoped OfficeVM
  // projections still need stable homes between polls, so retain the same
  // planner output in the server-side tracker when no durable store is present.
  const savedHomes = homeAssignments && typeof homeAssignments === 'object'
    ? homeAssignments : tracker?.homeAssignments;
  const plan = planFloors(index, layout, occupants, savedHomes);
  if (tracker && plan.homeAssignments) tracker.homeAssignments = plan.homeAssignments;
  const placements = new Map(plan.occupants.map(o => [o.id, {
    id: o.id, floorId: o.floorId, stationUid: o.stationUid ?? null,
    ...(Object.hasOwn(o, '_homeWant') ? { _homeWant: o._homeWant } : {}),
    standingPoint: o.floorTravel?.phase === 'team-standing' ? { ...o.floorTravel.point } : null,
  }]));
  const byId = new Map(occupants.map(o => [o.id, o]));
  const primary = occupants.find(o => canonicalRole(o.role) === 'primary');
  // Deskless conversation rows follow an explicit canonical host, never a display name/provider.
  const hostFloor = o => {
    const seen = new Set([o.id]);
    let parent = byId.get(o.parentId);
    while (parent && !seen.has(parent.id)) {
      const placed = placements.get(parent.id);
      if (placed) return placed.floorId;
      seen.add(parent.id); parent = byId.get(parent.parentId);
    }
    return placements.get(primary?.id)?.floorId ?? '1';
  };
  const homePlacements = occupants.map(o => placements.get(o.id) ?? {
    id: o.id, floorId: hostFloor(o), stationUid: null, standingPoint: null,
  });
  // A canonical team is placed on its lead's home floor before any ambient
  // relocation is considered. Break activities may then move an idle member.
  const homeById = new Map(homePlacements.map(row => [row.id, row]));
  const occupantById = new Map(occupants.map(row => [row.id, row]));
  for (const row of occupants) {
    if (!row.teamId || !row.parentId) continue;
    let lead = occupantById.get(row.parentId);
    const seen = new Set([row.id]);
    while (lead?.parentId && lead.teamId === row.teamId && !seen.has(lead.id)) {
      seen.add(lead.id); lead = occupantById.get(lead.parentId);
    }
    const leadHome = lead && homeById.get(lead.id), memberHome = homeById.get(row.id);
    if (leadHome && memberHome && memberHome.floorId !== leadHome.floorId) homeById.set(row.id, { ...memberHome,
      floorId: leadHome.floorId, stationUid: null, standingPoint: leadHome.standingPoint || null });
  }
  const atomicHomePlacements = homePlacements.map(row => homeById.get(row.id) || row);
  const pressureIds = new Set();
  for (const floor of plan.floors) {
    const hasActive = floor.occupants.some(row => !['unknown', 'idle', 'offline'].includes(row.state));
    if (!hasActive) continue;
    for (const row of floor.occupants) if (row.state === 'idle' && !row.stationUid) pressureIds.add(row.id);
  }
  const withActivity = relocateIdle(atomicHomePlacements, occupants, plan.floors, index, layout, now, tracker, pressureIds);
  const withActivityById = new Map(withActivity.map(row => [row.id, row]));
  // planFloors may sort internally for deterministic seat allocation and may
  // omit deskless conversation rows. The placement boundary must preserve the
  // canonical input sequence and retain every supplied identity.
  const activePlacements = occupants.map(row => withActivityById.get(row.id) || placements.get(row.id) || {
    id: row.id, floorId: hostFloor(row), stationUid: null, standingPoint: null,
  });
  const seatedTargets = new Set();
  const finalPlacements = activePlacements.map(row => {
    if (!row.stationUid || row.activity) return row;
    const floor = plan.byId.get(row.floorId);
    const allocatedTarget = allocatedTargetFor(row, floor, index);
    const normalized = row.sceneTarget?.floorId === row.floorId && row.sceneTarget?.stationUid === row.stationUid
      ? row : { ...row, sceneTarget: allocatedTarget };
    const key = `${row.floorId}:${row.stationUid}`;
    if (seatedTargets.has(key)) throw new Error(`office placement assigned duplicate seated target ${key}`);
    seatedTargets.add(key);
    return normalized;
  });
  const visitorById = visitorPlacements(occupants, finalPlacements, plan.floors, index);
  for (let i = 0; i < finalPlacements.length; i++) {
    const visitor = visitorById.get(finalPlacements[i].id);
    if (visitor) finalPlacements[i] = { ...finalPlacements[i], ...visitor };
  }
  return {
    // Input sequence stays intact; the VM owner retains rosterOrder and all parent/team/status fields.
    placements: finalPlacements.map(({ _homeWant, ...placement }) => placement),
    // Room rendering does not expose global owner appearance/name rules from layout.agents.
    floors: plan.floors.map(({ id, kind, layout: local, capacity }) => ({ id, kind,
      layout: { room: local.room, theme: local.theme, items: local.items }, capacity })),
    unseatedTeams: plan.unseatedTeams, homeAssignments: plan.homeAssignments,
  };
}

module.exports = { planOfficePlacement, visitorPlacements };
