'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FloorTrips } = require('../../public/v2/office/floor-trips.js');
const { wanderCount } = require('../../public/v2/office/life.js');
const config = { idleAfterMs: 100, intervalMs: 1, cooldownMs: 100, stepMs: 10, rideMs: 5, stayMs: 30, maxWanderers: 2 };
const routeFor = () => ({ out: [{ x: 0, y: 0 }, { x: 1, y: 0 }], arrival: [{ x: 0, y: 0 }, { x: 0, y: 1 }] });
const agent = n => ({ id: 'agent:foreign-' + n, role: 'agent', state: 'idle', stateSince: 0, floorId: '1' });
const plan = people => ({ occupants: people, byId: new Map([['1', { id: '1', kind: 'office' }], ['rdc', { id: 'rdc', kind: 'lobby' }], ['gym', { id: 'gym', kind: 'gym' }]]) });
test('idle trip walks, rides, arrives, returns; destination label appears only after arrival', t => {
  const trips = new FloorTrips({ config, routeFor, random: () => 0 }); t.after(() => trips.destroy());
  const people = [agent(0)]; trips.update(people, plan(people), 100);
  assert.equal(trips.view(people[0].id, 100).phase, 'depart');
  assert.equal(trips.view(people[0].id, 110).floorId, '1');
  assert.equal(trips.view(people[0].id, 115).presenceKey, null);
  assert.equal(trips.view(people[0].id, 125).presenceKey, 'pause');
  assert.equal(trips.view(people[0].id, 155).phase, 'return');
  assert.equal(trips.view(people[0].id, 175).phase, 'home');
  trips.update(people, plan(people), 180);
  assert.equal(trips.view(people[0].id, 180), null);
  assert.equal(wanderCount(), 0);
});
test('real activity, waiting/error/offline/seen status and absence immediately preempt an ambient trip', () => {
  for (const patch of [{ state: 'working' }, { state: 'waiting' }, { state: 'error' }, { state: 'offline' }, { presence: 'seen' }, { destination: { stationUid: 'server' } }, null]) {
    const trips = new FloorTrips({ config, routeFor, random: () => 1 });
    try {
      const o = agent(0); trips.update([o], plan([o]), 100);
      assert.equal(trips.view(o.id, 125).presenceKey, 'gym');
      const next = patch ? [{ ...o, ...patch }] : [];
      trips.update(next, plan(next), 126);
      assert.equal(trips.view(o.id, 126), null);
      assert.equal(wanderCount(), 0);
    } finally { trips.destroy(); }
  }
});
test('blocked elevator paths prevent trips; only agents visit; bounded trips share the existing life resource', t => {
  const blocked = new FloorTrips({ config, routeFor: () => null }); t.after(() => blocked.destroy());
  const people = Array.from({ length: 50 }, (_, n) => agent(n));
  blocked.update(people, plan(people), 100); assert.equal(blocked.trips.size, 0);
  const trips = new FloorTrips({ config, routeFor, random: () => 0 }); t.after(() => trips.destroy());
  const mixed = [{ ...agent(100), role: 'direct' }, ...people];
  trips.update(mixed, plan(mixed), 100);
  assert.equal(trips.trips.size, 2); assert.equal(wanderCount(), 2);
  assert.equal(trips.view('agent:foreign-100', 125), null);
});
