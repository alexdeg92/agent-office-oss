'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { indexManifest } = require('../../public/v2/office/assets.js');
const { floorId, floorLayout, saveFloor, validateFloors, planFloors, createFloorStore } = require('../../public/v2/office/floors.js');
const { createMockLayoutStore } = require('../../public/v2/office/mock-store.js');
const { floorLayout: backendFloorLayout, validateFloors: validateBackendFloors } = require('../../src/engine/office/floors.js');
const read = p => JSON.parse(readFileSync(path.join(__dirname, p)));
const index = indexManifest(read('../../design/office/manifest.example.json'));
const base = read('../../design/office/layout.example.json');
const person = n => ({ id: 'agent:foreign-' + n, role: 'agent', name: 'Nova ' + n, state: 'working', look: { character: 'subagent', variant: 'teal', accessories: [] } });

test('floor IDs admit bounded numbered office floors and visit destinations, reject unsafe/deep-link values', () => {
  assert.equal(floorId('2'), '2'); assert.equal(floorId('rdc'), 'rdc'); assert.equal(floorId('gym'), 'gym');
  assert.equal(floorId('10000'), '10000');
  for (const id of ['0', '-1', '02', '../2', '<script>', '10001', '9007199254740991', null, 2]) assert.equal(floorId(id), null);
});
test('overflow fills numbered floors without losing identities, states or looks; no fixed agent limit', () => {
  const people = Array.from({ length: 2000 }, (_, n) => person(n));
  const plan = planFloors(index, base, people);
  assert.equal(plan.occupants.length, people.length);
  assert.equal(new Set(plan.occupants.map(o => o.id)).size, people.length);
  assert.ok(plan.byId.has('2')); assert.ok(plan.floors.length > 100);
  for (const f of plan.floors.filter(f => f.kind === 'office')) {
    assert.ok(f.occupants.length <= f.capacity);
    assert.equal(new Set(f.occupants.map(o => o.stationUid)).size, f.occupants.length);
    assert.ok(f.occupants.every(o => o.state === 'working' && o.look === people.find(p => p.id === o.id).look));
  }
});
test('saving floor furniture/theme retains the main layout and shared owner appearances', () => {
  const draft = floorLayout(base, index, '2');
  draft.theme = { mode: 'fixed', fixed: 'night' };
  draft.agents.push({ agentId: 'agent:foreign-0', character: 'fen', variant: 'moss', accessories: [], station: 'auto', appearance: 'manual' });
  const saved = saveFloor(base, index, '2', draft);
  assert.deepEqual(saved.items, base.items);
  assert.deepEqual(saved.theme, base.theme);
  assert.equal(floorLayout(saved, index, '2').theme.fixed, 'night');
  assert.equal(floorLayout(saved, index, '1').agents.at(-1).character, 'fen');
  assert.deepEqual(validateFloors(saved, index), []);
});
test('floor store reads and revision history project one floor while saves and conflicts retain the root revision', async () => {
  const originalTheme = { mode: 'auto', day: 'day', night: 'night', nightFrom: '19:00', nightTo: '07:00' };
  const data = saveFloor(base, index, '2', { ...floorLayout(base, index, '2'), theme: originalTheme });
  const root = createMockLayoutStore({ data, defaultData: base, manifest: read('../../design/office/manifest.example.json') });
  const scoped = createFloorStore(await root.get(), index, '2', root, 'UTC');
  const current = await scoped.get();
  assert.equal(current.layout.revision, 1);
  assert.deepEqual(current.layout.data.theme, originalTheme);
  assert.equal(current.layout.data.room, floorLayout(data, index, '2').room);
  assert.equal(current.theme.resolved, require('../../public/v2/office/theme.js').resolveTheme(originalTheme, new Date(), 'UTC'));

  const concurrentTheme = { mode: 'auto', day: 'dawn', night: 'dusk', nightFrom: '20:30', nightTo: '06:30' };
  const concurrent = saveFloor(data, index, '2', { ...floorLayout(data, index, '2'), theme: concurrentTheme });
  await root.put({ expectedRevision: 1, data: concurrent });
  const latest = await scoped.get();
  assert.equal(latest.layout.revision, 2);
  assert.deepEqual(latest.layout.data.theme, concurrentTheme);
  const old = await scoped.getRevision(1);
  assert.deepEqual(old.data.theme, originalTheme);
  const restored = await scoped.put({ expectedRevision: latest.layout.revision, data: old.data });
  assert.equal(restored.revision, 3);
  assert.equal(restored.vm.layout.data.theme.nightFrom, originalTheme.nightFrom);

  const changedAgainTheme = { mode: 'auto', day: 'sunrise', night: 'midnight', nightFrom: '21:15', nightTo: '05:15' };
  const changedAgain = saveFloor(root.vmNow().layout.data, index, '2', { ...floorLayout(root.vmNow().layout.data, index, '2'), theme: changedAgainTheme });
  await root.put({ expectedRevision: 3, data: changedAgain });
  let conflict;
  await assert.rejects(scoped.putTheme({ expectedRevision: 3, theme: { mode: 'fixed', fixed: 'night' } }), error => {
    conflict = error.error.current;
    assert.equal(conflict.revision, 4);
    assert.deepEqual(conflict.vm.layout.data.theme, changedAgainTheme);
    assert.equal(conflict.vm.theme.resolved, require('../../public/v2/office/theme.js').resolveTheme(changedAgainTheme, new Date(), 'UTC'));
    return true;
  });
  const retried = await scoped.putTheme({ expectedRevision: conflict.revision, theme: { ...conflict.vm.layout.data.theme, mode: 'fixed', fixed: 'night' } });
  assert.equal(retried.vm.layout.data.theme.fixed, 'night');
  assert.equal(retried.vm.layout.data.theme.nightFrom, '21:15');
  assert.equal(retried.vm.layout.data.theme.nightTo, '05:15');
  assert.equal(retried.vm.layout.revision, 5);
  assert.deepEqual(retried.vm.layout.data.items, floorLayout(changedAgain, index, '2').items);
  const canonical = root.vmNow().layout.data;
  assert.deepEqual(canonical.items, base.items);
  assert.deepEqual(canonical.theme, base.theme);
  assert.deepEqual(canonical.floors.find(f => f.id === '2').layout.theme, retried.vm.layout.data.theme);
});
test('home-floor station IDs are local; editing another floor never erases that home seat', () => {
  const draft = floorLayout(base, index, '2');
  draft.agents.push({ agentId: 'agent:foreign-0', character: 'subagent', variant: 'teal', station: 'floor-2-desk-1' });
  const saved = saveFloor(base, index, '2', draft);
  const rule = saved.agents.at(-1);
  assert.equal(rule.homeFloor, '2');
  assert.equal(floorLayout(saved, index, '1').agents.at(-1).station, 'auto');
  const mainEdit = floorLayout(saved, index, '1'); mainEdit.agents.at(-1).name = 'Renamed';
  const renamed = saveFloor(saved, index, '1', mainEdit);
  assert.equal(renamed.agents.at(-1).station, rule.station);
  assert.equal(renamed.agents.at(-1).homeFloor, '2');
  assert.deepEqual(validateFloors(renamed, index), []);
  assert.equal(planFloors(index, renamed, [person(0)]).occupants[0].floorId, '2');
});
test('sparse invalid home-floor pins are rejected and never materialize intervening floors', () => {
  const invalid = structuredClone(base);
  invalid.agents[0].homeFloor = '5000';
  assert.ok(validateFloors(invalid, index).some(e => e.code === 'home-floor'));
  const plan = planFloors(index, invalid, [{ id: 'main', role: 'main', name: 'Primary', state: 'working', look: { character: 'timmy' } }]);
  assert.equal(plan.byId.has('5000'), false);
  assert.deepEqual(plan.floors.map(f => f.id), ['rdc', '1', 'gym']);
});
test('a sparse maximum valid pin materializes its destination directly, without scanning floor gaps', () => {
  const sparse = structuredClone(base);
  sparse.agents[0].homeFloor = '128';
  const plan = planFloors(index, sparse, [{ id: 'main', role: 'main', name: 'Primary', state: 'working', look: { character: 'timmy' } }]);
  assert.deepEqual(plan.floors.map(f => f.id), ['rdc', '1', '128', 'gym']);
});
test('validate every registered layout; only lobby/gym can omit a work desk', () => {
  const gym = saveFloor(base, index, 'gym', floorLayout(base, index, 'gym'));
  assert.deepEqual(validateFloors(gym, index), []);
  const bad = structuredClone(gym); bad.floors[0].layout.items.push({ uid: 'escape', asset: 'desk', x: -20, y: 0, orientation: 'sw' });
  assert.ok(validateFloors(bad, index).some(e => e.floorId === 'gym'));
  const empty = saveFloor(base, index, '2', { ...floorLayout(base, index, '2'), items: [] });
  assert.ok(validateFloors(empty, index).some(e => e.code === 'no-desk' && e.floorId === '2'));
});
test('backend lobby and gym defaults use the registered pack gear and validate as visit destinations', () => {
  const lobby = backendFloorLayout(base, index, 'rdc'), gym = backendFloorLayout(base, index, 'gym');
  assert.ok(index.rooms.has('gym'));
  assert.equal(gym.room, 'gym');
  assert.equal(lobby.room, 'lobby');
  for (const asset of ['elevator-door', 'reception-counter', 'pause-shelter', 'ash-receptacle', 'armchair', 'coffee-machine', 'bench']) assert.ok(lobby.items.some(item => item.asset === asset), asset);
  for (const asset of ['elevator-door', 'treadmill', 'weight-rack', 'exercise-bench', 'exercise-mat', 'water-cooler']) assert.ok(gym.items.some(item => item.asset === asset), asset);
  assert.ok(lobby.items.find(item => item.asset === 'reception-counter').x < 8, 'reception stays inside the glazing');
  assert.ok(lobby.items.filter(item => ['pause-shelter', 'ash-receptacle', 'bench'].includes(item.asset)).every(item => item.x >= 8), 'terrace furniture stays outdoors');
  const withDestinations = { ...base, floors: [
    { id: 'rdc', kind: 'lobby', layout: { room: lobby.room, theme: lobby.theme, items: lobby.items } },
    { id: 'gym', kind: 'gym', layout: { room: gym.room, theme: gym.theme, items: gym.items } },
  ] };
  assert.deepEqual(validateBackendFloors(withDestinations, index), []);
});
