// Floor layouts share appearance rules; furniture, themes and station IDs are local to a floor.
import { annexDesks, annexDecor } from './annex.js';
import { canonicalRuleId, ruleFor, resolveOccupants, homeStations, validateLayout } from './layout-rules.js';
import { resolveTheme } from './theme.js';

export function floorId(value) {
  if (typeof value !== 'string') return null;
  const id = value;
  return id === 'rdc' || id === 'gym' || (/^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) <= 10000) ? id : null;
}
// Persisted home-floor assignments are intentionally much smaller than the addressable domain.
// This bounds untrusted saves while leaving room for generated overflow floors for large offices.
const MAX_PINNED_FLOOR = 128;
const pinnedFloorId = value => floorId(value) && Number(value) <= MAX_PINNED_FLOOR;
export const floorKind = id => id === 'rdc' ? 'lobby' : id === 'gym' ? 'gym' : 'office';
const canon = a => canonicalRuleId(a.agentId) ?? a.agentId;
const rootData = ({ floors, ...data }) => data;
const localRules = (agents, id) => agents.map(a => ({ ...a, station: (a.homeFloor ?? '1') === id ? a.station ?? 'auto' : 'auto' }));
const item = (uid, asset, x, y) => ({ uid, asset, x, y, orientation: 'sw' });

function defaultsFor(base, index, id) {
  const items = [];
  if (index.furniture.has('elevator-door')) items.push({ uid: 'floor-elevator', asset: 'elevator-door', wall: 'right', offset: 0 });
  if (id === 'rdc') {
    if (index.furniture.has('reception-counter')) items.push(item('floor-reception', 'reception-counter', 0, 7));
    if (index.furniture.has('pause-shelter')) items.push(item('floor-pause-shelter', 'pause-shelter', 8, 7));
    if (index.furniture.has('ash-receptacle')) items.push(item('floor-ash-receptacle', 'ash-receptacle', 6, 7));
  } else if (id === 'gym') {
    if (index.furniture.has('treadmill')) items.push(item('floor-treadmill', 'treadmill', 8, 6));
    if (index.furniture.has('weight-rack')) items.push(item('floor-weight-rack', 'weight-rack', 1, 3));
    if (index.furniture.has('exercise-bench')) items.push(item('floor-exercise-bench', 'exercise-bench', 4, 7));
    if (index.furniture.has('exercise-mat')) items.push(item('floor-exercise-mat', 'exercise-mat', 4, 4));
  }
  return { room: id === 'gym' ? 'gym' : base.room, theme: base.theme, items };
}

/** Read a stored or generated floor without duplicating owner appearance rules. */
export function floorLayout(base, index, id) {
  if (!floorId(id)) throw new TypeError('invalid floor id');
  const stored = base.floors?.find(f => f.id === id);
  let local;
  if (id === '1') local = rootData(base);
  else if (stored) local = stored.layout;
  else if (floorKind(id) !== 'office') local = defaultsFor(base, index, id);
  else local = { room: base.room, theme: base.theme, items: [
    ...(index.furniture.has('elevator-door') ? [{ uid: 'floor-elevator', asset: 'elevator-door', wall: 'right', offset: 0 }] : []),
    ...annexDesks(index, base).map((d, n) => ({ ...d, uid: `floor-${id}-desk-${n + 1}` })),
    ...annexDecor(index, base, Number(id)).map((d, n) => ({ ...d, uid: `floor-${id}-decor-${n + 1}` })),
  ] };
  const items = [...local.items];
  if (index.furniture.has('elevator-door') && !items.some(it => it.asset === 'elevator-door')) items.unshift({ uid: 'floor-elevator', asset: 'elevator-door', wall: 'right', offset: 0 });
  return { ...rootData(base), ...local, room: id === 'gym' ? 'gym' : local.room, items, agents: localRules(base.agents, id) };
}

/** Save the selected floor while retaining other floors and global owner looks. */
export function saveFloor(base, index, id, draft) {
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
export function validateFloors(base, index) {
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
  for (const id of ids) for (const error of validateLayout(floorLayout(base, index, id), index)) {
    if (error.code === 'no-desk' && floorKind(id) !== 'office') continue;
    errors.push({ ...error, floorId: id });
  }
  return errors;
}

/** A floor-scoped adapter keeps the persisted LayoutVM canonical while the caller reads or writes one projected floor. */
export function createFloorStore(vm, index, id, store, timeZone = undefined) {
  let base = vm.layout.data;
  let revision = vm.layout.revision;
  const project = source => {
    const data = floorLayout(source.layout.data, index, id);
    return { ...source, layout: { ...source.layout, data },
      default: source.default && { ...source.default, data: floorLayout(source.default.data, index, id) },
      theme: source.theme && { ...source.theme, mode: data.theme.mode, resolved: resolveTheme(data.theme, new Date(), timeZone), season: data.theme.season ?? null } };
  };
  const sync = source => {
    if (source?.layout?.data && Number(source.layout.revision) >= revision) { base = source.layout.data; revision = source.layout.revision; }
  };
  async function get() {
    const source = await store.get();
    sync(source);
    return project(source);
  }
  async function getRevision(rev) {
    const source = await store.getRevision(rev);
    return source?.data ? { ...source, data: floorLayout(source.data, index, id) } : source;
  }
  async function put({ expectedRevision, data }) {
    try {
      const result = await store.put({ expectedRevision, data: saveFloor(base, index, id, data) });
      if (result.vm) sync(result.vm);
      return { ...result, vm: result.vm ? project(result.vm) : result.vm };
    } catch (error) {
      const current = error?.current ?? error?.error?.current;
      if (current?.vm) {
        sync(current.vm);
        const wrapped = error.error ? { ...error, error: { ...error.error, current: { ...current, vm: project(current.vm) } } }
          : { ...error, current: { ...current, vm: project(current.vm) } };
        throw wrapped;
      }
      throw error;
    }
  }
  return {
    get,
    getRevision,
    put,
    putTheme: ({ expectedRevision, theme }) => {
      const data = floorLayout(base, index, id); data.theme = theme;
      return put({ expectedRevision, data });
    },
    sync,
    project,
  };
}

/** Plan all floors as data. The page chooses one of these records to mount. */
export function planFloors(index, base, occupants) {
  const groups = new Map(), overflow = [], pins = new Map();
  for (const o of occupants) {
    const id = ruleFor(base, o.id, o.role)?.homeFloor;
    if (id && id !== '1' && pinnedFloorId(id) && floorKind(id) === 'office') {
      if (!pins.has(id)) pins.set(id, []);
      pins.get(id).push(o);
    } else overflow.push(o);
  }
  function place(id, people) {
    const layout = floorLayout(base, index, id);
    const resolved = resolveOccupants(layout, index, people.map(o => ({ ...o, sourceName: o.sourceName ?? o.name })));
    const placed = people.map((o, i) => ({ ...o, stationUid: resolved[i].stationUid, floorId: id }));
    const record = { id, kind: floorKind(id), layout, occupants: placed, capacity: homeStations(layout, index).length };
    groups.set(id, record); return record;
  }
  const main = place('1', overflow);
  let rest = main.occupants.filter(o => !o.stationUid);
  main.occupants = main.occupants.filter(o => o.stationUid);
  let n = 2;
  // Empty gaps are implicit: don't materialize every floor between the overflow and a sparse pin.
  // When overflow remains, each pass seats at least one occupant; remaining pins are placed directly below.
  while (rest.length) {
    const id = String(n++), requested = pins.get(id) ?? [];
    pins.delete(id);
    const capacity = homeStations(floorLayout(base, index, id), index).length;
    if (!capacity) { main.occupants.push(...requested, ...rest); rest = []; break; }
    const pinned = requested.slice(0, capacity), overflow = requested.slice(capacity);
    const take = Math.max(0, capacity - pinned.length);
    if (pinned.length || take) place(id, [...pinned, ...rest.slice(0, take)]);
    rest = [...overflow, ...rest.slice(take)];
  }
  for (const [id, people] of pins) place(id, people);
  for (const f of base.floors ?? []) if (!groups.has(f.id)) place(f.id, []);
  for (const id of ['rdc', 'gym']) if (!groups.has(id)) place(id, []);
  const order = id => id === 'rdc' ? -1 : id === 'gym' ? Infinity : Number(id);
  const floors = [...groups.values()].sort((a, b) => order(a.id) - order(b.id));
  return { floors, byId: new Map(floors.map(f => [f.id, f])), occupants: floors.flatMap(f => f.occupants) };
}
