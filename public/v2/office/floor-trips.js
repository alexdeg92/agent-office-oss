// Ambient trips are presentation state. Engine activity always preempts them.
import { canIdle, LIFE, acquireWander, releaseWander } from './life.js';
import { canonicalRole, seatTile } from './layout-rules.js';
import { buildGrid, findPath, nearestWalkable } from './pathfind.js';

export function floorTripRoute(o, home, destination, index) {
  const routeWithin = (floor, fromItem, targetAsset) => {
    const room = index.rooms.get(floor.layout.room);
    if (!room) return null;
    const grid = buildGrid(room.cols, room.rows, floor.layout.items, index.furniture);
    const elevator = nearestWalkable(grid, room.cols - 2, Math.floor(room.rows / 2));
    const e = room.entrance ?? { x: 0, y: room.rows - 1 };
    const start = fromItem && index.furniture.has(fromItem.asset) ? seatTile(fromItem, index.furniture.get(fromItem.asset)) : nearestWalkable(grid, e.x, e.y);
    let goal = elevator;
    if (targetAsset) {
      const target = floor.layout.items.find(i => i.asset === targetAsset);
      if (target) goal = nearestWalkable(grid, target.x, target.y) ?? goal;
    }
    if (!start || !goal) return null;
    return { grid, elevator, start, goal };
  };
  const homeItem = home.layout.items.find(i => i.uid === o.stationUid);
  const a = routeWithin(home, homeItem);
  const destinationAsset = destination.id === 'gym' ? 'treadmill' : 'pause-shelter';
  const b = routeWithin(destination, null, destinationAsset);
  if (!a || !b) return null;
  const out = findPath(a.grid, a.start, a.elevator), arrival = findPath(b.grid, b.elevator, b.goal);
  return out && arrival ? { out, arrival } : null;
}

export class FloorTrips {
  constructor({ random = Math.random, routeFor, config = {} } = {}) {
    this.random = random; this.routeFor = routeFor;
    this.config = { ...LIFE, stayMs: 12_000, rideMs: 380, stepMs: 450, ...config };
    this.trips = new Map(); this.cooldowns = new Map(); this.nextCheck = 0;
  }
  cancel(id, now) {
    const trip = this.trips.get(id);
    if (trip) { releaseWander(trip); this.trips.delete(id); this.cooldowns.set(id, now); }
  }
  destroy() { for (const trip of this.trips.values()) releaseWander(trip); this.trips.clear(); this.cooldowns.clear(); }
  update(occupants, plan, now) {
    const people = new Map(occupants.map(o => [o.id, o]));
    const homes = new Map(plan.occupants.map(o => [o.id, o.floorId]));
    for (const [id, trip] of this.trips) {
      const o = people.get(id);
      if (!canIdle(o) || homes.get(id) !== trip.home || !plan.byId.has(trip.to) || now >= trip.end) this.cancel(id, now);
    }
    for (const [id, at] of this.cooldowns) if (!people.has(id) && now - at >= this.config.cooldownMs) this.cooldowns.delete(id);
    if (now < this.nextCheck) return;
    this.nextCheck = now + this.config.intervalMs;
    const targets = ['rdc', 'gym'].filter(id => plan.byId.has(id));
    if (!targets.length) return;
    for (const o of occupants) {
      if (this.trips.size >= this.config.maxWanderers) break;
      const home = homes.get(o.id);
      if (this.trips.has(o.id) || !canIdle(o) || !['primary', 'agent', 'subagent', 'scheduled'].includes(canonicalRole(o.role))
        || plan.byId.get(home)?.kind !== 'office' || now - o.stateSince < this.config.idleAfterMs
        || now - (this.cooldowns.get(o.id) ?? -Infinity) < this.config.cooldownMs) continue;
      const to = targets[Math.min(targets.length - 1, Math.floor(this.random() * targets.length))];
      const route = this.routeFor?.(o, plan.byId.get(home), plan.byId.get(to));
      // The scene adapter supplies both validated elevator paths; no route means no trip.
      if (!route?.out?.length || !route?.arrival?.length) continue;
      const walk = Math.max(1, route.out.length - 1) * this.config.stepMs;
      const destinationWalk = Math.max(1, route.arrival.length - 1) * this.config.stepMs;
      const trip = { id: o.id, home, to, route, start: now, walk, destinationWalk };
      trip.arrive = now + walk + this.config.rideMs + destinationWalk;
      trip.leave = trip.arrive + this.config.stayMs;
      trip.end = trip.leave + destinationWalk + this.config.rideMs + walk;
      if (acquireWander(trip, [], this.config.maxWanderers)) this.trips.set(o.id, trip);
    }
  }
  view(id, now) {
    const trip = this.trips.get(id);
    if (!trip || now >= trip.end) return null;
    let phase, floorId;
    if (now < trip.start + trip.walk) { phase = 'depart'; floorId = trip.home; }
    else if (now < trip.start + trip.walk + this.config.rideMs) { phase = 'ride'; floorId = trip.home; }
    else if (now < trip.arrive) { phase = 'approach'; floorId = trip.to; }
    else if (now < trip.leave) { phase = 'arrived'; floorId = trip.to; }
    else if (now < trip.leave + trip.destinationWalk) { phase = 'return'; floorId = trip.to; }
    else if (now < trip.leave + trip.destinationWalk + this.config.rideMs) { phase = 'ride-home'; floorId = trip.home; }
    else { phase = 'home'; floorId = trip.home; }
    return { ...trip, phase, floorId, presenceKey: phase === 'arrived' ? (trip.to === 'gym' ? 'gym' : 'pause') : null };
  }
}
