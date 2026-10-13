'use strict';
const { isDeepStrictEqual } = require('node:util');
const crypto = require('node:crypto');
// Floor layouts share appearance rules; furniture, themes and station IDs are local to a floor.
const { canonicalRuleId, canonicalRole, ruleFor, resolveOccupants, homeStations, validateLayout, checkPlacement, unreachableStations, seatTile, elevatorAccess, MAX_ITEMS } = require('./layout-rules.js');
const isVisitor = o => ['direct', 'group', 'conversation'].includes(canonicalRole(o.role));
const { buildGrid, isWalkable, findPath } = require('./pathfind.js');

function floorId(value) {
  if (typeof value !== 'string') return null;
  const id = value;
  return id === 'rdc' || id === 'gym' || (/^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) <= 10000) ? id : null;
}
// Persisted home-floor assignments are intentionally much smaller than the addressable domain.
// This bounds untrusted saves while leaving room for generated overflow floors for large offices.
const MAX_PINNED_FLOOR = 128;
const pinnedFloorId = value => floorId(value) && Number(value) <= MAX_PINNED_FLOOR;
const floorKind = id => id === 'rdc' ? 'lobby' : id === 'gym' ? 'gym' : 'office';
const canon = a => canonicalRuleId(a.agentId) ?? a.agentId;
// Placement identities are private database keys, not OfficeVM fields. Canonicalizing
// first keeps v2 aliases and v3 ids on the same assignment without storing raw ids.
const placementToken = value => crypto.createHash('sha256').update(String(canonicalRuleId(value) ?? value)).digest('hex');
const placementTeamKey = unit => placementToken(unit.parent.teamId || unit.parent.id);
const rootData = ({ floors, ...data }) => data;
const localRules = (agents, id) => agents.map(a => ({ ...a, station: (a.homeFloor ?? '1') === id ? a.station ?? 'auto' : 'auto' }));
const item = (uid, asset, x, y) => ({ uid, asset, x, y, orientation: 'sw' });
const generatedTemplates = new WeakMap();

// Expand only generated rooms. Owner furniture stays in place; every extra desk must pass the same
// collision, elevator-aisle and seat-reachability rules as an editor placement.
function generatedTemplate(base, index) {
  let byIndex = generatedTemplates.get(base);
  if (!byIndex) generatedTemplates.set(base, byIndex = new WeakMap());
  if (byIndex.has(index)) return byIndex.get(index);
  let layout = { ...rootData(base), items: base.items.map(i => ({ ...i })), agents: [] };
  if (index.furniture.has('elevator-door') && !layout.items.some(i => i.asset === 'elevator-door')) layout.items.unshift({ uid: 'floor-elevator', asset: 'elevator-door', wall: 'right', offset: 0 });
  const source = layout.items.find(i => index.furniture.get(i.asset)?.station?.kind === 'desk');
  const room = index.rooms.get(layout.room);
  let count = 0;
  if (source && room) for (let y = 0; y < room.rows; y++) for (let x = 0; x < room.cols; x++) {
    if (layout.items.length >= MAX_ITEMS) break;
    while (layout.items.some(i => i.uid === `team-desk-${count + 1}`)) count++;
    const cand = { uid: `team-desk-${count + 1}`, asset: source.asset, x, y, orientation: source.orientation ?? 'sw' };
    if (!checkPlacement(layout, index, cand).ok) continue;
    const next = { ...layout, items: [...layout.items, cand] };
    if (unreachableStations(next, index).length) continue;
    layout = next; count++;
  }
  byIndex.set(index, layout);
  return layout;
}

/** Canonical parent links form atomic worker teams. Conversations can bridge a lineage without owning seats. */
function floorTeams(occupants) {
  const byId = new Map();
  for (const o of occupants) if (!byId.has(o.id)) byId.set(o.id, o);
  const workers = [...byId.values()].filter(o => !isVisitor(o) && !o.gone);
  const roots = new Map(), children = new Map();
  for (const o of workers) {
    let cursor = o, root = null;
    const seen = new Set(), path = [];
    for (;;) {
      if (roots.has(cursor.id)) { root = roots.get(cursor.id); break; }
      if (seen.has(cursor.id)) break;
      seen.add(cursor.id); path.push(cursor.id);
      if (!cursor.parentId) { root = isVisitor(cursor) || cursor.gone ? null : cursor.id; break; }
      const parent = byId.get(cursor.parentId);
      if (!parent) break;
      cursor = parent;
    }
    // Cache the whole validated lineage, keeping deep teams and malformed cycles linear in size.
    for (const id of path) roots.set(id, root);
    if (root && root !== o.id) { const rows = children.get(root) ?? []; rows.push(o); children.set(root, rows); }
  }
  return workers.filter(o => !roots.get(o.id) || roots.get(o.id) === o.id).map(parent => ({ parent, children: children.get(parent.id) ?? [] }));
}

function defaultsFor(base, index, id) {
  const items = [];
  if (index.furniture.has('elevator-door')) items.push({ uid: 'floor-elevator', asset: 'elevator-door', wall: 'right', offset: 0 });
  if (id === 'rdc') {
    if (index.furniture.has('reception-counter')) items.push(item('floor-reception', 'reception-counter', 3, 1));
    if (index.furniture.has('pause-shelter')) items.push(item('floor-pause-shelter', 'pause-shelter', 8, 7));
    if (index.furniture.has('ash-receptacle')) items.push(item('floor-ash-receptacle', 'ash-receptacle', 11, 6));
    for (const [uid, asset, x, y] of [
      ['floor-waiting-left', 'armchair', 2, 3], ['floor-waiting-right', 'armchair', 4, 3],
      ['floor-waiting-rug', 'runner-rug', 2, 5], ['floor-mail-cubbies', 'cube-shelf', 2, 0],
      ['floor-welcome-tree', 'indoor-tree', 0, 0], ['floor-reception-plant', 'monstera', 6, 1],
      ['floor-waiting-light', 'arc-lamp', 0, 4], ['floor-waiting-coffee', 'coffee-machine', 0, 6],
      ['floor-terrace-bench', 'bench', 9, 2], ['floor-terrace-planter', 'plant-large', 11, 3],
      ['floor-terrace-light', 'lamp', 11, 5],
    ]) if (index.furniture.has(asset)) items.push(item(uid, asset, x, y));
  } else if (id === 'gym') {
    if (index.furniture.has('treadmill')) items.push(item('floor-treadmill', 'treadmill', 8, 6));
    if (index.furniture.has('weight-rack')) items.push(item('floor-weight-rack', 'weight-rack', 2, 3));
    if (index.furniture.has('exercise-bench')) items.push(item('floor-exercise-bench', 'exercise-bench', 4, 7));
    if (index.furniture.has('exercise-mat')) items.push(item('floor-exercise-mat', 'exercise-mat', 4, 4));
    for (const [uid, asset, x, y] of [
      ['floor-stretch-mat', 'exercise-mat', 6, 4], ['floor-gym-water', 'water-cooler', 0, 6],
      ['floor-gym-storage', 'cube-shelf', 2, 0], ['floor-gym-plant', 'monstera', 0, 0],
      ['floor-gym-tree', 'indoor-tree', 11, 0], ['floor-gym-light', 'lamp', 11, 4],
    ]) if (index.furniture.has(asset)) items.push(item(uid, asset, x, y));
  }
  return { room: id === 'gym' ? 'gym' : index.rooms.has('lobby') ? 'lobby' : base.room, theme: base.theme, items };
}

/** Read a stored or generated floor without duplicating owner appearance rules. */
function floorLayout(base, index, id) {
  if (!floorId(id)) throw new TypeError('invalid floor id');
  const stored = base.floors?.find(f => f.id === id);
  let local;
  if (id === '1') local = rootData(base);
  else if (stored) local = stored.layout;
  else if (floorKind(id) !== 'office') local = defaultsFor(base, index, id);
  else {
    let deskNumber = 0;
    local = { room: base.room, theme: base.theme, items: generatedTemplate(base, index).items.map(i => ({ ...i,
      uid: i.asset === 'elevator-door' ? 'floor-elevator'
        : index.furniture.get(i.asset)?.station?.kind === 'desk' ? `floor-${id}-desk-${++deskNumber}` : `floor-${id}-${i.uid}`,
    })) };
  }
  const items = [...local.items];
  if (index.furniture.has('elevator-door') && !items.some(it => it.asset === 'elevator-door')) items.unshift({ uid: 'floor-elevator', asset: 'elevator-door', wall: 'right', offset: 0 });
  return { ...rootData(base), ...local, room: id === 'gym' ? 'gym' : local.room, items, agents: localRules(base.agents, id) };
}

/** Save the selected floor while retaining other floors and global owner looks. */
function saveFloor(base, index, id, draft) {
  if (!floorId(id)) throw new TypeError('invalid floor id');
  const previous = floorLayout(base, index, id);
  const original = new Map(base.agents.map(a => [canon(a), a]));
  const viewed = new Map(previous.agents.map(a => [canon(a), a]));
  const agents = draft.agents.map(a => {
    const old = original.get(canon(a)), view = viewed.get(canon(a));
    const { station, homeFloor, ...appearance } = a;
    if (old && (station ?? 'auto') === (view.station ?? 'auto')) return { ...appearance, station: old.station ?? 'auto', ...(old.homeFloor && { homeFloor: old.homeFloor }) };
    if (floorKind(id) !== 'office' && station !== 'auto' && station != null) throw new TypeError('visit floors cannot own home stations');
    return { ...appearance, station: station ?? 'auto', ...(floorKind(id) === 'office' && id !== '1' && { homeFloor: id }) };
  });
  if (id === '1') return { ...rootData(draft), agents, ...(base.floors && { floors: base.floors }) };
  const entry = { id, kind: floorKind(id), layout: { room: draft.room, theme: draft.theme, items: draft.items } };
  const floors = (base.floors ?? []).filter(f => f.id !== id);
  return { ...base, agents, floors: [...floors, entry] };
}

/** Existing layout rules apply to every floor; destinations alone may omit a work desk. */
function validateFloors(base, index, { previous = null } = {}) {
  const errors = [], entries = base.floors ?? [], ids = new Set(['1']);
  if (!Array.isArray(entries)) return [{ code: 'floors' }];
  for (const f of entries) {
    if (!f || !floorId(f.id) || (floorKind(f.id) === 'office' && !pinnedFloorId(f.id)) || ids.has(f.id) || f.kind !== floorKind(f.id) || Object.keys(f).some(k => !['id', 'kind', 'layout'].includes(k)) || !f.layout || !Array.isArray(f.layout.items)
      || typeof f.layout.room !== 'string' || !f.layout.theme || Object.keys(f.layout).some(k => !['room', 'theme', 'items'].includes(k))) {
      errors.push({ code: 'floor', floorId: f?.id ?? null }); continue;
    }
    ids.add(f.id);
  }
  // Numbered office floors are generated on demand; a pin to floor N does not require an explicit layout entry.
  for (const a of base.agents) if (a.homeFloor != null && (!pinnedFloorId(a.homeFloor) || floorKind(a.homeFloor) !== 'office')) errors.push({ code: 'home-floor', agentId: a.agentId });
  if (errors.length) return errors;
  const spatial = new Set(['elevator-access', 'occupied', 'outside', 'unreachable']);
  for (const id of ids) {
    const local = floorLayout(base,index,id);
    const existed = previous && (id === '1' || previous.floors?.some(f=>f.id===id));
    const old = existed && floorLayout(previous,index,id);
    // New placement rules must not reject untouched, already persisted rooms
    // during a theme/look edit or a scoped save on a different floor.
    const unchanged = old && local.room === old.room && isDeepStrictEqual(local.items,old.items);
    for (const error of validateLayout(local, index)) {
      if (error.code === 'no-desk' && floorKind(id) !== 'office') continue;
      if (unchanged && spatial.has(error.code)) continue;
      errors.push({ ...error, floorId: id });
    }
  }
  return errors;
}

/** Plan all floors as data. The page chooses one of these records to mount. */
function planFloors(index, base, occupants, homeAssignments = {}) {
  const groups = new Map(), overflowTeams = [], unseatedTeams = [];
  const units = floorTeams(occupants).map(({ parent, children }) => {
    const pin = ruleFor(base, parent.layoutRuleId || parent.id, parent.role)?.homeFloor;
    const teamKey = placementTeamKey({ parent });
    const saved = homeAssignments?.[teamKey];
    const savedFloor = floorId(saved?.floorId) && floorKind(saved.floorId) === 'office' ? saved.floorId : null;
    return { parent, people: [parent, ...children], teamKey,
      pin: pinnedFloorId(pin) && floorKind(pin) === 'office' ? pin : savedFloor,
      stationAssignments: saved?.stations && typeof saved.stations === 'object' ? saved.stations : {} };
  }).sort((a, b) => a.teamKey.localeCompare(b.teamKey));
  function ensure(id) {
    if (groups.has(id)) return groups.get(id);
    const layout = floorLayout(base, index, id);
    const record = { id, kind: floorKind(id), layout, occupants: [], capacity: homeStations(layout, index).length };
    groups.set(id, record); return record;
  }
  ensure('1');
  for (const f of base.floors ?? []) ensure(f.id);
  for (const unit of units) if (unit.pin) ensure(unit.pin);
  const generatedCapacity = homeStations(generatedTemplate(base, index), index).length;
  let next = 2;
  function freshRoom() {
    while (groups.has(String(next)) && next <= 10000) next++;
    return next > 10000 ? null : ensure(String(next++));
  }
  function available(size, preferred) {
    if (preferred) {
      const room = ensure(preferred);
      if (room.capacity - room.occupants.length >= size) return room;
    }
    const room = [...groups.values()].filter(f => f.kind === 'office').sort((a,b) => Number(a.id) - Number(b.id))
      .find(f => f.capacity - f.occupants.length >= size);
    if (room) return room;
    // Don't scan empty rooms forever when none can seat the whole team.
    if (size > generatedCapacity || next > 10000) return null;
    return freshRoom();
  }
  function seat(unit) {
    const room = available(unit.people.length, unit.pin);
    if (room) { room.occupants.push(...unit.people); return; }
    // A team larger than the room's real station capacity still shares one floor. Reserve an empty
    // room with the best available capacity, then keep the remaining people near its desk island.
    const pinned = unit.pin && ensure(unit.pin);
    const empty = [...groups.values()].filter(f => f.kind === 'office' && !f.occupants.length)
      .sort((a,b) => b.capacity - a.capacity || Number(a.id) - Number(b.id))[0];
    const target = pinned && !pinned.occupants.length && pinned.capacity >= generatedCapacity ? pinned
      : empty && empty.capacity >= generatedCapacity ? empty : freshRoom() ?? empty ?? groups.get('1');
    target.occupants.push(...unit.people);
    overflowTeams.push({ unit, floorId: target.id });
  }
  // Reserve pinned leads first. Member pins never split the canonical lead's team.
  for (const unit of units.filter(u => u.pin && u.pin !== '1')) seat(unit);
  for (const unit of units.filter(u => !u.pin || u.pin === '1')) seat(unit);
  for (const id of ['rdc', 'gym']) ensure(id);
  for (const f of groups.values()) {
    // Stable first-time seating is independent of source polling order. Persisted seats
    // take precedence, while explicit layout station rules remain authoritative.
    const unitFor = new Map();
    for (const unit of units) for (const person of unit.people) unitFor.set(person.id, unit);
    const ordered = [...f.occupants].sort((a, b) => placementToken(a.id).localeCompare(placementToken(b.id)));
    const presentTokens = new Set(ordered.map(o => placementToken(o.id)));
    const floorUnits = new Set(f.occupants.map(o => unitFor.get(o.id)).filter(Boolean));
    const reservedStationUids = [...new Set([...floorUnits].flatMap(unit => Object.entries(unit.stationAssignments || {})
      .filter(([token]) => !presentTokens.has(token)).map(([, station]) => station)))];
    const resolvedOrdered = resolveOccupants(f.layout, index, ordered.map(o => ({ ...o, sourceName: o.sourceName ?? o.name })), {
      stationAssignments: Object.fromEntries(ordered.flatMap(o => {
        const station = unitFor.get(o.id)?.stationAssignments?.[placementToken(o.id)];
        return typeof station === 'string' ? [[o.id, station]] : [];
      })),
      reservedStationUids,
    });
    const resolvedById = new Map(resolvedOrdered.map(row => [row.id, row]));
    const resolved = f.occupants.map(o => resolvedById.get(o.id));
    f.occupants = f.occupants.map((o,i) => ({ ...o, stationUid: resolved[i].stationUid, floorId: f.id }));
  }
  for (const { unit, floorId: id } of overflowTeams) {
    const f = groups.get(id), ids = new Set(unit.people.map(o => o.id));
    const standing = f.occupants.filter(o => ids.has(o.id) && !o.stationUid);
    if (!standing.length) continue;
    const room = index.rooms.get(f.layout.room), items = new Map(f.layout.items.map(i => [i.uid,i]));
    const seats = f.occupants.filter(o => o.stationUid).map(o => {
      const i = items.get(o.stationUid); return seatTile(i,index.furniture.get(i.asset));
    });
    const grid = buildGrid(room.cols,room.rows,f.layout.items,index.furniture);
    const key = p => p.x + ',' + p.y;
    const occupied = new Set(seats.map(key)), reserved = new Set((elevatorAccess(f.layout,index)?.tiles ?? []).map(key));
    const points = [], entrance = room.entrance ?? {x:0,y:room.rows-1};
    for (let y = 0; y < room.rows; y++) for (let x = 0; x < room.cols; x++) {
      const p = {x,y};
      if (!isWalkable(grid,x,y) || occupied.has(key(p)) || reserved.has(key(p)) || key(p) === key(entrance)) continue;
      if (seats.length && !findPath(grid,seats[0],p)) continue;
      points.push(p);
    }
    const distance = p => seats.length ? Math.min(...seats.map(s => Math.abs(p.x-s.x)+Math.abs(p.y-s.y))) : 0;
    points.sort((a,b) => distance(a)-distance(b) || a.y-b.y || a.x-b.x);
    const positions = new Map(standing.map((o,i) => [o.id,points[i % points.length]]));
    f.occupants = f.occupants.map(o => positions.get(o.id) ? { ...o, floorTravel: {phase:'team-standing',point:positions.get(o.id)} } : o);
    unseatedTeams.push({ parentId:unit.parent.id, floorId:id, count:standing.length, capacity:f.capacity });
  }
  const order = id => id === 'rdc' ? -1 : id === 'gym' ? Infinity : Number(id);
  const floors = [...groups.values()].sort((a,b) => order(a.id) - order(b.id));
  const placedById = new Map(floors.flatMap(f => f.occupants).map(row => [row.id, row]));
  const nextHomeAssignments = {};
  for (const unit of units) {
    const lead = placedById.get(unit.parent.id);
    if (!lead) continue;
    nextHomeAssignments[unit.teamKey] = {
      floorId: lead.floorId,
      stations: Object.fromEntries(unit.people.flatMap(person => {
        const placed = placedById.get(person.id);
        return placed?.stationUid ? [[placementToken(person.id), placed.stationUid]] : [];
      })),
    };
  }
  return { floors, byId: new Map(floors.map(f => [f.id, f])), occupants: floors.flatMap(f => f.occupants), unseatedTeams,
    homeAssignments: nextHomeAssignments };
}

module.exports = { floorId, floorKind, floorTeams, floorLayout, saveFloor, validateFloors, planFloors, placementToken, placementTeamKey };
