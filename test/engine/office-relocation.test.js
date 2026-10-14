'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { officeDefaults, createStateTracker } = require('../../src/api/v2/vm/office');
const { projectOfficePlacement } = require('../../src/api/v2/vm/office-roster');
const { projectOfficeOccupant } = require('../../src/api/orchestrator-team-projection');
const { planFloors } = require('../../src/engine/office/floors');
const { resolveOccupants } = require('../../src/engine/office/layout-rules');
const { planOfficePlacement } = require('../../src/engine/office/placement');
const { buildGrid, isWalkable, findPath } = require('../../src/engine/office/pathfind');
const { elevatorAccess, seatTile } = require('../../src/engine/office/layout-rules');
const { project2x } = require('../../src/api/v2/project2x');
const { project3x } = require('../../src/api/v2/project3x');

const NOW = 1_800_000_000_000;
const defaults = officeDefaults();
const layout = structuredClone(defaults.layout);
function deskPressureLayout(source, count, prefix) {
  const station = item => !!defaults.index.furniture.get(item.asset)?.station;
  const desks = source.items.filter(item => defaults.index.furniture.get(item.asset)?.station?.kind === 'desk').slice(0, count);
  const result = structuredClone(source);
  result.items = source.items.filter(item => !station(item)).concat(desks);
  for (let index = desks.length; index < count; index++) {
    result.items.push({ uid: `${prefix}-${index + 1}`, asset: 'desk', x: 9, y: 1, orientation: 'sw' });
  }
  let filler = 0;
  while (result.items.length < require('../../src/engine/office/layout-rules').MAX_ITEMS)
    result.items.push({ uid: `${prefix}-rug-${filler++}`, asset: 'rug', x: 0, y: 0 });
  return result;
}
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
  assert.ok(['idle','coffee','smoke','gym'].includes(first.occupants[0].activity.kind));
  assert.deepEqual(second.occupants[0].sceneTarget, first.occupants[0].sceneTarget);
  assert.equal(second.occupants[0].activity.id, first.occupants[0].activity.id);
  assert.equal(second.occupants[0].sceneTravel.id, first.occupants[0].sceneTravel.id);
  assert.equal(first.occupants[0].homeTarget.floorId, '1');
  assert.notEqual(first.occupants[0].floorId, first.occupants[0].homeTarget.floorId);
});

test('display-working team members get desks first and longest-idle overflow moves immediately in v2 and v3', () => {
  const sevenDeskLayout = deskPressureLayout(layout, 7, 'budget');
  const teamRows = [
    { ...occupant('lead', 'primary', NOW - 60_000), state: 'working', stateActive: false },
    { ...occupant('active-1', 'agent', NOW - 50_000, 'lead'), state: 'working', stateActive: false },
    ...Array.from({ length: 3 }, (_, i) => ({ ...occupant(`new-${i + 1}`, 'agent', NOW - 10_000 + i, 'lead'), state: 'working', stateActive: false })),
    ...[
      // All five are below the ordinary 15-minute threshold: only desk-pressure
      // overflow may move the three oldest, while the two newest keep their desks.
      ['idle-1', NOW - 5 * 60_000], ['idle-2', NOW - 4 * 60_000], ['idle-3', NOW - 3 * 60_000],
      ['idle-4', NOW - 2 * 60_000], ['idle-5', NOW - 60_000],
    ].map(([id, since]) => ({ ...occupant(id, 'agent', since, 'lead'), state: 'idle' })),
  ];
  for (const P of [project2x, project3x]) {
    const occupants = teamRows.map(row => ({ ...row, id: P.occupantId(row.id),
      parentId: row.parentId ? P.occupantId(row.parentId) : null, role: P.occupantRole(row.role) }));
    const vm = projectOfficePlacement(office(occupants), { layout: sevenDeskLayout, index: defaults.index, now: NOW,
      tracker: createStateTracker(), projectOccupantId: P.occupantId });
    assert.equal(vm.rosterFloors.find(floor => floor.id === '1').capacity, 7, `${P.version} uses the seven-desk pressure fixture`);
    const active = vm.occupants.filter(row => row.state === 'working');
    assert.equal(active.length, 5);
    assert.ok(active.every(row => row.floorId === '1' && row.stationUid), `${P.version} keeps every display-working agent seated`);
    const idle = vm.occupants.filter(row => row.state === 'idle');
    const moved = idle.filter(row => row.floorId !== '1');
    assert.deepEqual(moved.map(row => row.id).sort(), ['idle-1', 'idle-2', 'idle-3'].map(P.occupantId).sort(),
      `${P.version} moves the three longest-idle occupants first`);
    assert.ok(moved.every(row => ['rdc', 'gym'].includes(row.floorId) && row.activity), `${P.version} immediately assigns lobby/gym idle spots`);
    assert.ok(moved.every(row => row.activity.since === NOW), `${P.version} starts pressure relocation immediately, before the ordinary idle threshold`);
    assert.ok(idle.filter(row => row.floorId === '1').every(row => row.stationUid), `${P.version} leaves only the two seated idle occupants on the pressured floor`);
  }
});

test('displayed host-working state wins over idle runtime bookkeeping when assigning desks', () => {
  const runtime = { ...occupant('host-worker', 'agent', NOW), state: 'idle', stateActive: false,
    execution: { status: 'idle', evidence: { level: 'verified', observedAt: NOW - 1, expiresAt: NOW + 60_000 } } };
  const host = { id: 'pane-worker', status: 'working', role: 'delegate', observedAt: NOW, staleAfter: NOW + 60_000 };
  const projected = projectOfficeOccupant(runtime, host,
    { agentId: 'runtime-worker', hostAgentId: host.id, confidence: 'exact', evidence: 'shared-runtime-session-ref' },
    { role: 'admin' }, { sourceEnabled: true, agentId: 'runtime-worker', observedAt: NOW });
  const vm = build([projected]);
  assert.equal(vm.occupants[0].state, 'working', 'the fresh host report determines the displayed state over idle runtime evidence');
  assert.ok(vm.occupants[0].stationUid, 'desk allocation follows the displayed active state');
  assert.equal(vm.occupants[0].activity, null);
});

test('saved idle pins select the most recently idle survivor before assigning desks', () => {
  const twoDeskLayout = structuredClone(layout);
  twoDeskLayout.items = twoDeskLayout.items.filter(item => !defaults.index.furniture.get(item.asset)?.station
    || ['st-timmy', 'st-2'].includes(item.uid));
  const rows = [
    { ...occupant('active', 'agent', NOW), state: 'working' },
    { ...occupant('old-idle', 'agent', NOW - 2 * 60 * 60_000), state: 'idle' },
    { ...occupant('new-idle', 'agent', NOW - 60 * 60_000), state: 'idle' },
  ];
  const resolved = resolveOccupants(twoDeskLayout, defaults.index, rows, {
    stationAssignments: { 'old-idle': 'st-2', 'new-idle': 'st-timmy' },
  });
  const byId = new Map(resolved.map(row => [row.id, row]));
  assert.equal(byId.get('active').stationUid, 'st-2', 'active work uses the other free desk before borrowing an idle occupant home');
  assert.equal(byId.get('new-idle').stationUid, 'st-timmy', 'the newest idle occupant keeps its saved home while another desk can serve active work');
  assert.equal(byId.get('old-idle').stationUid, null, 'the longest-idle occupant is the overflow candidate');
});

test('pressure activity onset stays stable across advancing snapshots', () => {
  const sevenDeskLayout = deskPressureLayout(layout, 7, 'pressure');
  const source = [
    { ...occupant('lead', 'primary', NOW - 60_000), state: 'working' },
    ...Array.from({ length: 4 }, (_, i) => ({ ...occupant(`active-${i}`, 'agent', NOW - 50_000, 'lead'), state: 'working' })),
    ...Array.from({ length: 5 }, (_, i) => occupant(`idle-${i}`, 'agent', NOW - (5 - i) * 60 * 60_000, 'lead')),
  ];
  const tracker = createStateTracker();
  const first = build(source, tracker, { layout: sevenDeskLayout, now: NOW });
  const next = build(source, tracker, { layout: sevenDeskLayout, now: NOW + 10_000 });
  const firstById = new Map(first.occupants.map(row => [row.id, row]));
  for (const row of next.occupants.filter(item => item.activity)) {
    assert.equal(row.activity.since, firstById.get(row.id).activity.since);
    assert.equal(row.activity.id, firstById.get(row.id).activity.id);
  }
});

test('declared activity spot capacities are enforced and every relocated target is walkable', () => {
  const tracker = createStateTracker();
  const team = Array.from({ length: 13 }, (_, index) => occupant(index ? `worker-${index}` : 'lead', index ? 'subagent' : 'primary', NOW - 60 * 60_000, index ? 'lead' : null));
  const overflow = new Set(planFloors(defaults.index, layout, team).occupants.filter(row => row.floorTravel?.phase === 'team-standing').map(row => row.id));
  const vm = build(team, tracker);
  const relocated = vm.occupants.filter(row => row.activity);
  assert.equal(relocated.length, 11, 'four registered seats, one coffee slot, two outdoor smoking slots and four gym slots');
  assert.equal(new Set(relocated.map(row => `${row.activity.spotId}:${row.sceneTarget.floorId}:${row.sceneTarget.point.x},${row.sceneTarget.point.y}`)).size, 11);
  assert.equal(relocated.filter(row => row.floorId === 'rdc').length, 7);
  assert.equal(relocated.filter(row => row.floorId === 'gym').length, 4);
  assert.equal(vm.occupants.filter(row=>!row.activity).length,2,'full room falls back to reserved home targets');
  for (const row of relocated) {
    const floor = vm.rosterFloors.find(f => f.id === row.floorId);
    const room = defaults.index.rooms.get(floor.layout.room);
    const grid = buildGrid(room.cols, room.rows, floor.layout.items, defaults.index.furniture);
    const access = elevatorAccess(floor.layout, defaults.index);
    const walk = row.sceneTarget.mode === 'sofa' ? row.sceneTarget.approachPoint : row.sceneTarget.point;
    const point = { x: Math.floor(walk.x), y: Math.floor(walk.y) };
    if(row.sceneTarget.mode==='sofa'){const p=row.sceneTarget.point;assert.equal(grid.owner[Math.floor(p.y)*grid.cols+Math.floor(p.x)],row.sceneTarget.stationUid,'seat belongs to its registered furniture');assert.ok(row.sceneTarget.seatContact);}
    assert.ok(isWalkable(grid, point.x, point.y), `${row.id}: free activity tile`);
    assert.ok(findPath(grid, access.cell, point), `${row.id}: reachable from elevator`);
    assert.ok(!access.tiles.some(t => t.x === point.x && t.y === point.y), `${row.id}: outside the elevator aisle`);
    for (const item of floor.layout.items.filter(i => i.uid!==row.sceneTarget.stationUid && defaults.index.furniture.get(i.asset)?.station && i.wall == null)) {
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
  assert.deepEqual(retained.sceneTarget, oldRetained.sceneTarget, 'an unchanged available activity slot remains assigned');
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

test('a returning active occupant regains its saved home floor and desk after an idle relocation', () => {
  const homeLayout = structuredClone(layout);
  const primaryRule = homeLayout.agents.find(row => row.agentId === 'main');
  primaryRule.homeFloor = '2';
  primaryRule.station = 'auto';
  const tracker = createStateTracker();
  const idle = [{ ...occupant('main', 'primary', NOW - 60 * 60_000), state: 'idle' }];
  const awayPlan = planOfficePlacement({ index: defaults.index, layout: homeLayout, occupants: idle, now: NOW, tracker });
  const away = awayPlan.placements[0];
  assert.equal(away.homeTarget.floorId, '2');
  const savedHomeStation = away.homeTarget.stationUid;
  assert.ok(savedHomeStation);
  assert.notEqual(away.floorId, away.homeTarget.floorId);
  const resumed = planOfficePlacement({ index: defaults.index, layout: homeLayout,
    occupants: [{ ...idle[0], state: 'working', stateSince: NOW + 1 }], now: NOW + 1, tracker,
    homeAssignments: awayPlan.homeAssignments });
  const returned = resumed.placements[0];
  assert.equal(returned.floorId, '2');
  assert.equal(returned.stationUid, savedHomeStation);
  assert.equal(returned.sceneTarget.floorId, '2');
  assert.equal(returned.sceneTarget.stationUid, savedHomeStation);
  assert.equal(returned.activity, null);
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

const largeIdleTeam=()=>Array.from({length:13},(_,i)=>occupant(i?`worker-${i}`:'lead',i?'subagent':'primary',NOW-60*60_000,i?'lead':null));

test('lobby pauses interact with registered furniture and smoking stays on two separate outdoor slots',()=>{
  const source=largeIdleTeam(),vm=build(source);
  const lobby=vm.occupants.filter(o=>o.floorId==='rdc');
  assert.equal(lobby.length,7);
  const seated=lobby.filter(o=>o.sceneTarget.mode==='sofa');assert.equal(seated.length,4);
  assert.equal(seated.filter(o=>o.sceneTarget.stationUid==='floor-terrace-bench').length,2);
  assert.equal(seated.filter(o=>o.sceneTarget.stationUid.startsWith('floor-waiting-')).length,2);
  assert.ok(seated.every(o=>o.activity.kind==='idle'&&o.sceneTarget.seatContact&&o.sceneTarget.approachPoint));
  const coffee=lobby.filter(o=>o.activity.kind==='coffee');assert.equal(coffee.length,1);
  assert.equal(coffee[0].sceneTarget.stationUid,'floor-waiting-coffee');assert.deepEqual(coffee[0].sceneTarget.point,{x:.5,y:7.5});
  const smokers=lobby.filter(o=>o.activity.kind==='smoke');assert.equal(smokers.length,2);
  assert.ok(smokers.every(o=>o.sceneTarget.point.x>=8&&o.sceneTarget.floorId==='rdc'));
  assert.notDeepEqual(smokers[0].sceneTarget.point,smokers[1].sceneTarget.point);
  assert.ok(vm.occupants.filter(o=>o.activity).every(o=>o.floorId!==o.homeTarget.floorId));
});

test('moved or removed furniture invalidates its interaction instead of using stale coordinates',()=>{
  const source=largeIdleTeam(),tracker=createStateTracker();
  const first=build(source,tracker),lobby=first.rosterFloors.find(f=>f.id==='rdc').layout;
  const changed=structuredClone(layout);
  changed.floors=[{id:'rdc',layout:{...lobby,items:lobby.items.filter(i=>!['floor-waiting-coffee','floor-waiting-left','floor-waiting-right'].includes(i.uid)).map(i=>i.uid==='floor-ash-receptacle'?{...i,x:1,y:7}:i.uid==='floor-terrace-bench'?{...i,orientation:'se'}:i)}}];
  const updated=build(source,tracker,{layout:changed});
  assert.ok(updated.occupants.every(o=>!['smoke','coffee'].includes(o.activity?.kind)),'ash receptacle moved indoors cannot create indoor smoking');
  assert.ok(updated.occupants.every(o=>o.activity?.kind==='gym'||!o.activity),'removed or rotated furniture cannot retain seats');
  for(const o of updated.occupants.filter(o=>!o.activity))assert.deepEqual(o.sceneTarget,o.homeTarget);
});
