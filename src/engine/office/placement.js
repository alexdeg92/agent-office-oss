'use strict';
// Spatial allocation only. Canonical identity, membership, order and status are supplied by the caller.
const { planFloors } = require('./floors.js');
const { canonicalRole, elevatorAccess, seatTile } = require('./layout-rules.js');
const { buildGrid, findPath, isWalkable } = require('./pathfind.js');
const crypto = require('node:crypto');

const DEFAULT_IDLE_RELOCATION_MINUTES = 15;
const SPOT_KINDS = new Set(['idle', 'gym', 'smoke', 'coffee']);
const RELOCATABLE_ROLES = new Set(['primary', 'main', 'agent', 'subagent', 'host', 'team-host', 'member', 'team-member']);
const facingFor = value => ['ne', 'se', 'sw'].includes(value) ? value : 'sw';
const center = p => ({ x: p.x + 0.5, y: p.y + 0.5 });
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 20);

function target({ kind, floorId, stationUid = null, point, approachPoint = null, seatContact = null, mode = 'stand', seatIndex = null, facing = 'sw' }) {
  return { kind, floorId, stationUid, point: { x: point.x, y: point.y }, approachPoint: approachPoint && { x: approachPoint.x, y: approachPoint.y },
    seatContact: seatContact && { x: seatContact.x, y: seatContact.y }, mode, seatIndex, facing: facingFor(facing) };
}

function homeTargetFor(placement, floor, index) {
  const station = placement.stationUid && floor.layout.items.find(row => row.uid === placement.stationUid);
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
    return [`${point.x},${point.y}`];
  });
  for (const key of seats) forbidden.add(key);
  const used = new Set();
  const declared = index.rooms.get(floor.layout.room)?.activitySpots || [];
  return declared.flatMap(spot => {
    if (!SPOT_KINDS.has(spot.kind) || !Array.isArray(spot.points) || spot.capacity !== spot.points.length) return [];
    return spot.points.slice(0, spot.capacity).flatMap((p, slot) => {
      if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) return [];
      const x = Math.floor(p.x), y = Math.floor(p.y), key = `${x},${y}`;
      if (!isWalkable(grid, x, y) || forbidden.has(key) || used.has(key) || !findPath(grid, start, { x, y })) return [];
      used.add(key);
      return [{ id: spot.id, activityId: `${floor.id}:${spot.id}:${slot}`, kind: spot.kind, capacity: spot.capacity, slot, floorId: floor.id,
        target: target({ kind: spot.kind === 'gym' ? 'destination' : 'lounge', floorId: floor.id, point: p, approachPoint: center({ x, y }), mode: 'stand' }) }];
    });
  });
}

function transitionTarget(floor, index, fallback) {
  if (!floor?.layout) return fallback;
  const room = index.rooms.get(floor.layout.room);
  const endpoint = elevatorAccess(floor.layout, index)?.cell || room?.entrance;
  return endpoint ? target({ kind: 'destination', floorId: floor.id, point: center(endpoint), approachPoint: center(endpoint) }) : fallback;
}

function relocateIdle(placements, occupants, floors, index, layoutData, now, tracker) {
  const configured = layoutData?.idleRelocationMinutes;
  const thresholdMs = (Number.isInteger(configured) && configured >= 1 && configured <= 1440 ? configured : DEFAULT_IDLE_RELOCATION_MINUTES) * 60_000;
  const byId = new Map(occupants.map(row => [row.id, row]));
  const placementById = new Map(placements.map(row => [row.id, row]));
  const floorById = new Map(floors.map(row => [row.id, row]));
  const available = floors.flatMap(floor => activitySpotsFor(floor, index));
  const assignments = new Map();
  const reserved = new Set();
  const eligible = occupants.filter(row => RELOCATABLE_ROLES.has(canonicalRole(row.role) || row.role) && row.state === 'idle'
    && Number.isFinite(row.stateSince) && now - row.stateSince >= thresholdMs
    && !row.visitPhase && !row.gone).sort((a, b) => {
    const standingA = !placementById.get(a.id)?.stationUid ? 0 : 1;
    const standingB = !placementById.get(b.id)?.stationUid ? 0 : 1;
    return standingA - standingB || a.id.localeCompare(b.id);
  });
  // Retain valid assignments first so repeated snapshots cannot reshuffle occupants.
  for (const row of eligible) {
    const old = tracker?.relocations?.get(row.id);
    if (!old?.activityId || old.stateSince !== row.stateSince) continue;
    const spot = available.find(item => item.activityId === old.slotId);
    if (spot && !reserved.has(`${spot.floorId}:${spot.id}:${spot.slot}`)) {
      assignments.set(row.id, spot); reserved.add(`${spot.floorId}:${spot.id}:${spot.slot}`);
    }
  }
  for (const row of eligible) {
    if (assignments.has(row.id)) continue;
    const home = placementById.get(row.id);
    // Standing overflow workers go first; among them use stable canonical IDs.
    const spot = available.find(item => !reserved.has(`${item.floorId}:${item.id}:${item.slot}`)
      && (item.floorId !== home?.floorId || item.target.kind === 'lounge'));
    if (!spot) continue;
    assignments.set(row.id, spot); reserved.add(`${spot.floorId}:${spot.id}:${spot.slot}`);
  }
  const usedIds = new Set(occupants.map(row => row.id));
  for (const id of tracker?.relocations?.keys?.() || []) if (!usedIds.has(id)) tracker.relocations.delete(id);
  const updated = placements.map(home => {
    const row = byId.get(home.id), spot = assignments.get(home.id), previous = tracker?.relocations?.get(home.id);
    const homeTarget = homeTargetFor(home, floorById.get(home.floorId), index);
    if (!row || !spot) {
      if (previous?.activityId && tracker?.relocations) {
        const fromFloor = floorById.get(previous.floorId);
        const toFloor = floorById.get(home.floorId);
        const departure = transitionTarget(fromFloor, index, previous.target);
        const arrival = transitionTarget(toFloor, index, homeTarget);
        tracker.relocations.set(home.id, { activityId: null, floorId: home.floorId, target: homeTarget,
          travel: previous.floorId === home.floorId ? null : { id: `travel:${digest(`${home.id}|${previous.activityId}|return`)}`, fromFloorId: previous.floorId, toFloorId: home.floorId, departure, arrival } });
      }
      const state = tracker?.relocations?.get(home.id);
      return { ...home, homeTarget, sceneTarget: homeTarget, activity: null, sceneTravel: state?.activityId === null ? state.travel : null };
    }
    const slotId = spot.activityId;
    const activityId = `${row.stateSince}|${slotId}`;
    const since = row.stateSince + thresholdMs;
    const activity = { id: `activity:${digest(`${home.id}|${activityId}`)}`, kind: spot.kind, spotId: spot.id, since,
      label: { key: `office.activity.${spot.kind}` } };
    let travel = previous?.travel || null;
    const previousFloorId = previous?.activityId ? previous.floorId : home.floorId;
    if (previous?.activityId !== activityId && previousFloorId !== spot.floorId) {
      const fromFloor = floorById.get(previousFloorId);
      const toFloor = floorById.get(spot.floorId);
      const departure = transitionTarget(fromFloor, index, previous?.target || homeTarget);
      const arrival = transitionTarget(toFloor, index, spot.target);
      travel = { id: `travel:${digest(`${home.id}|${previous?.activityId || 'home'}|${activityId}`)}`, fromFloorId: previousFloorId, toFloorId: spot.floorId, departure, arrival };
    } else if (previous?.activityId === activityId) travel = previous.travel || null;
    else if (previousFloorId === spot.floorId) travel = null;
    tracker?.relocations?.set(home.id, { activityId, slotId, stateSince: row.stateSince, floorId: spot.floorId, target: spot.target, travel });
    return { ...home, floorId: spot.floorId, stationUid: null, standingPoint: { x: Math.floor(spot.target.point.x), y: Math.floor(spot.target.point.y) }, homeTarget, sceneTarget: spot.target, activity, sceneTravel: travel };
  });
  return updated;
}

/**
 * @param {{index:object,layout:object,occupants:object[]}} input
 * @returns {{placements:{id:string,floorId:string,stationUid:string|null,standingPoint:{x:number,y:number}|null}[],floors:object[],unseatedTeams:object[]}}
 */
function planOfficePlacement({ index, layout, occupants, now = Date.now(), tracker = null }) {
  const plan = planFloors(index, layout, occupants);
  const placements = new Map(plan.occupants.map(o => [o.id, {
    id: o.id, floorId: o.floorId, stationUid: o.stationUid ?? null,
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
  const withActivity = relocateIdle(atomicHomePlacements, occupants, plan.floors, index, layout, now, tracker);
  const withActivityById = new Map(withActivity.map(row => [row.id, row]));
  // planFloors may sort internally for deterministic seat allocation and may
  // omit deskless conversation rows. The placement boundary must preserve the
  // canonical input sequence and retain every supplied identity.
  const activePlacements = occupants.map(row => withActivityById.get(row.id) || placements.get(row.id) || {
    id: row.id, floorId: hostFloor(row), stationUid: null, standingPoint: null,
  });
  return {
    // Input sequence stays intact; the VM owner retains rosterOrder and all parent/team/status fields.
    placements: activePlacements,
    // Room rendering does not expose global owner appearance/name rules from layout.agents.
    floors: plan.floors.map(({ id, kind, layout: local, capacity }) => ({ id, kind,
      layout: { room: local.room, theme: local.theme, items: local.items }, capacity })),
    unseatedTeams: plan.unseatedTeams,
  };
}

module.exports = { planOfficePlacement };
