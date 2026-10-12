'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { officeDefaults, createStateTracker } = require('../../src/api/v2/vm/office');
const { projectOfficePlacement } = require('../../src/api/v2/vm/office-roster');
const { planFloors } = require('../../src/engine/office/floors');
const { buildGrid, isWalkable, findPath } = require('../../src/engine/office/pathfind');
const { elevatorAccess, seatTile } = require('../../src/engine/office/layout-rules');

const NOW = 1_800_000_000_000;
const defaults = officeDefaults();
const layout = structuredClone(defaults.layout);
const occupant = (id, role, stateSince, parentId = null) => ({ id, role, name: id, state: 'idle', stateSince, parentId, teamId: parentId ? 'team:lead' : 'team:lead',
  rosterOrder: 0, stateActive: false, standingPoint: null, visitPhase: null });
const office = occupants => ({ occupants, rosterFloors: [], unseatedTeams: [] });
const build = (occupants, tracker = createStateTracker(), options = {}) => projectOfficePlacement(office(occupants), {
  layout: options.layout || layout, index: options.index || defaults.index, now: options.now ?? NOW, tracker,
  planningOccupants: options.planningOccupants || null,
});

test('idle relocations wait for the persisted threshold and remain stable across snapshots', () => {
  const tracker = createStateTracker();
  const source = [occupant('lead', 'primary', NOW - 15 * 60_000 + 1)];
  const early = build(source, tracker);
  assert.equal(early.occupants[0].activity, null);
  const eligible = [occupant('lead', 'primary', NOW - 15 * 60_000)];
  const first = build(eligible, tracker);
  const second = build(eligible, tracker);
  assert.ok(first.occupants[0].activity);
  assert.equal(first.occupants[0].activity.kind, 'idle');
  assert.deepEqual(second.occupants[0].sceneTarget, first.occupants[0].sceneTarget);
  assert.equal(second.occupants[0].activity.id, first.occupants[0].activity.id);
  assert.equal(second.occupants[0].sceneTravel.id, first.occupants[0].sceneTravel.id);
  assert.equal(first.occupants[0].homeTarget.floorId, '1');
  assert.notEqual(first.occupants[0].floorId, first.occupants[0].homeTarget.floorId);
});

test('declared activity spot capacities are enforced and every relocated target is walkable', () => {
  const tracker = createStateTracker();
  const team = Array.from({ length: 13 }, (_, index) => occupant(index ? `worker-${index}` : 'lead', index ? 'subagent' : 'primary', NOW - 60 * 60_000, index ? 'lead' : null));
  const overflow = new Set(planFloors(defaults.index, layout, team).occupants.filter(row => row.floorTravel?.phase === 'team-standing').map(row => row.id));
  const vm = build(team, tracker);
  const relocated = vm.occupants.filter(row => row.activity);
  assert.equal(relocated.length, 10, 'four lobby slots, two reachable office-floor slots, and four gym slots');
  assert.equal(new Set(relocated.map(row => `${row.activity.spotId}:${row.sceneTarget.floorId}:${row.sceneTarget.point.x},${row.sceneTarget.point.y}`)).size, 10);
  for (const id of ['rdc', 'gym']) assert.equal(relocated.filter(row => row.floorId === id).length, 4);
  for (const row of relocated) {
    const floor = vm.rosterFloors.find(f => f.id === row.floorId);
    const room = defaults.index.rooms.get(floor.layout.room);
    const grid = buildGrid(room.cols, room.rows, floor.layout.items, defaults.index.furniture);
    const access = elevatorAccess(floor.layout, defaults.index);
    const point = { x: Math.floor(row.sceneTarget.point.x), y: Math.floor(row.sceneTarget.point.y) };
    assert.ok(isWalkable(grid, point.x, point.y), `${row.id}: free activity tile`);
    assert.ok(findPath(grid, access.cell, point), `${row.id}: reachable from elevator`);
    assert.ok(!access.tiles.some(t => t.x === point.x && t.y === point.y), `${row.id}: outside the elevator aisle`);
    for (const item of floor.layout.items.filter(i => defaults.index.furniture.get(i.asset)?.station && i.wall == null)) {
      const seat = seatTile(item, defaults.index.furniture.get(item.asset));
      assert.ok(seat.x !== point.x || seat.y !== point.y, `${row.id}: not a reserved seat`);
    }
  }
  assert.ok(relocated.every(row => row.activity.since === NOW - 45 * 60_000));
  assert.ok(relocated.some(row => overflow.has(row.id)), 'the overflow standing members are considered first');
  assert.equal(vm.rosterFloors.reduce((sum, floor) => sum + floor.count, 0), team.length);
  assert.ok(relocated.every(row => row.sceneTarget.kind === 'lounge' || row.sceneTarget.kind === 'destination'));
});

test('admin and limited reader keep identical placement for every shared occupant', () => {
  const full = Array.from({ length: 13 }, (_, index) => occupant(index ? `worker-${index}` : 'lead', index ? 'subagent' : 'primary', NOW - 60 * 60_000, index ? 'lead' : null));
  const admin = build(full, createStateTracker());
  const readerRows = full.filter(row => ['lead', 'worker-1', 'worker-2', 'worker-4', 'worker-7'].includes(row.id));
  const reader = build(readerRows, createStateTracker(), { planningOccupants: full });
  const placements = vm => new Map(vm.occupants.map(row => [row.id, {
    floorId: row.floorId, stationUid: row.stationUid, standingPoint: row.standingPoint,
    sceneTarget: row.sceneTarget, activity: row.activity, sceneTravel: row.sceneTravel,
  }]));
  const adminById = placements(admin), readerById = placements(reader);
  for (const id of readerById.keys()) assert.deepEqual(readerById.get(id), adminById.get(id), `${id} has viewer-independent placement`);
});

test('a working lead cannot reshuffle retained idle team slots, and changed travel matches its target floor', () => {
  const tracker = createStateTracker();
  const team = Array.from({ length: 13 }, (_, index) => occupant(index ? `worker-${index}` : 'lead', index ? 'subagent' : 'primary', NOW - 60 * 60_000, index ? 'lead' : null));
  const first = build(team, tracker);
  const resumed = build(team.map(row => row.id === 'lead' ? { ...row, state: 'working', stateSince: NOW } : row), tracker);
  const before = new Map(first.occupants.map(row => [row.id, row]));
  const retained = resumed.occupants.find(row => row.id === 'worker-1');
  const oldRetained = before.get('worker-1');
  assert.deepEqual(retained.sceneTarget, oldRetained.sceneTarget, 'an unchanged available floor-1 slot remains assigned');
  assert.equal(retained.activity.id, oldRetained.activity.id);
  for (const row of resumed.occupants.filter(row => row.id !== 'lead' && row.activity)) {
    if (row.sceneTravel) {
      assert.equal(row.sceneTravel.toFloorId, row.sceneTarget.floorId);
      assert.equal(row.sceneTravel.arrival.floorId, row.sceneTarget.floorId);
    }
  }
});

test('a removed activity slot returns from the previous physical target with matching travel floors', () => {
  const tracker = createStateTracker();
  const team = Array.from({ length: 13 }, (_, index) => occupant(index ? `worker-${index}` : 'lead', index ? 'subagent' : 'primary', NOW - 60 * 60_000, index ? 'lead' : null));
  const first = build(team, tracker);
  const worker = first.occupants.find(row => row.id === 'worker-1');
  const removedFloor = worker.sceneTarget.floorId;
  const nextIndex = structuredClone(defaults.index);
  const floor = planFloors(defaults.index, layout, team).floors.find(row => row.id === removedFloor);
  const roomId = floor.layout.room;
  const oldRoom = nextIndex.rooms.get(roomId);
  nextIndex.rooms.set(roomId, { ...oldRoom, activitySpots: [] });
  const next = build(team, tracker, { index: nextIndex });
  const moved = next.occupants.find(row => row.id === 'worker-1');
  assert.equal(moved.activity, null);
  assert.equal(moved.sceneTarget.floorId, moved.homeTarget.floorId);
  assert.ok(moved.sceneTravel);
  assert.equal(moved.sceneTravel.fromFloorId, removedFloor);
  assert.equal(moved.sceneTravel.departure.floorId, removedFloor);
  assert.equal(moved.sceneTravel.toFloorId, moved.sceneTarget.floorId);
  assert.equal(moved.sceneTravel.arrival.floorId, moved.sceneTarget.floorId);
});

test('a state change returns the occupant to its reserved home target with a stable return trip', () => {
  const tracker = createStateTracker();
  const idle = [occupant('lead', 'primary', NOW - 60 * 60_000)];
  const away = build(idle, tracker).occupants[0];
  const working = [{ ...idle[0], state: 'working', stateSince: NOW }];
  const returned = build(working, tracker).occupants[0];
  const repeated = build(working, tracker).occupants[0];
  assert.equal(returned.activity, null);
  assert.deepEqual(returned.sceneTarget, away.homeTarget);
  assert.equal(returned.floorId, away.homeTarget.floorId);
  assert.ok(returned.sceneTravel);
  assert.notEqual(returned.sceneTravel.id, away.sceneTravel.id);
  assert.equal(repeated.sceneTravel.id, returned.sceneTravel.id);
});

test('activity assignment safely falls back home when a room declares no usable spots', () => {
  const index = structuredClone(defaults.index);
  index.rooms = new Map([...index.rooms].map(([id, room]) => [id, { ...room, activitySpots: [] }]));
  const row = occupant('lead', 'primary', NOW - 60 * 60_000);
  const vm = build([row], createStateTracker(), { index });
  assert.equal(vm.occupants[0].activity, null);
  assert.equal(vm.occupants[0].sceneTarget.floorId, vm.occupants[0].homeTarget.floorId);
});

test('an activity is cleared when the occupant leaves stage', () => {
  const tracker = createStateTracker();
  const away = build([occupant('lead', 'primary', NOW - 60 * 60_000)], tracker).occupants[0];
  const stillPresent = build([occupant('lead', 'primary', NOW - 60 * 60_000)], tracker);
  assert.equal(stillPresent.occupants.length, 1);
  assert.ok(away.activity);
  build([], tracker);
  assert.equal(tracker.relocations.has('lead'), false);
});
