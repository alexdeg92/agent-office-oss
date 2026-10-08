// O9: from 1 to 30 agents. The room's art has a fixed size, so the office can't grow; when its home stations run out,
// the agents without one (OccupantVM.stationUid null: the overflow) go to annex rooms, shown below the office. An annex
// is the same room with an automatic layout: desks placed so every seat stays reachable, and a little decor. Pure: no
// DOM; the page renders each annex with its own read-only OfficeScene (tested in test/office/annex.test.js).
import { checkPlacement, unreachableStations, resolveOccupants } from './layout-rules.js';

const cache = new Map();   // room id → desk positions that fit (computed once per room)

/** Desk positions for an automatic layout of `roomId`: a greedy scan, rows first, keeping every seat reachable. */
export function annexDesks(index, base) {
  const key = base.room;
  if (cache.has(key)) return cache.get(key);
  const room = index.rooms.get(base.room);
  const deskAsset = [...index.furniture.values()].find((f) => f.station?.kind === 'desk')?.id;
  let layout = { ...base, items: [], agents: [] };
  const desks = [];
  if (room && deskAsset) {
    for (let y = 0; y < room.rows; y++) {
      for (let x = 0; x < room.cols; x++) {
        // Aisles: a desk every third column and every third row, so plates and paths stay legible with 12+ agents.
        if (x % 3 !== 0 || y % 3 !== 0) continue;
        const cand = { uid: `annex-desk-${desks.length + 1}`, asset: deskAsset, x, y, orientation: 'sw' };
        if (!checkPlacement(layout, index, cand).ok) continue;
        const next = { ...layout, items: [...layout.items, cand] };
        if (unreachableStations(next, index).length) continue;
        layout = next;
        desks.push(cand);
      }
    }
  }
  cache.set(key, desks);
  return desks;
}

// O10: a little decor per annex (a plant, a lamp, a window or a whiteboard) so a room doesn't look bare. Only pieces
// that are not stations (an agent is never sent to them, capacity unchanged), each kept only if the layout still
// validates and every desk stays reachable. Two looks, alternating by annex number.
const DECOR = [
  [{ asset: 'window', wall: 'left', offset: 3 }, { asset: 'plant-large', x: 11, y: 0 }, { asset: 'plant-small', x: 0, y: 9 }, { asset: 'lamp', x: 11, y: 9 }],
  [{ asset: 'whiteboard', wall: 'right', offset: 5 }, { asset: 'plant-small', x: 11, y: 0 }, { asset: 'plant-large', x: 11, y: 9 }, { asset: 'lamp', x: 0, y: 9 }],
];
const decorCache = new Map();
/** The decor items for annex `n` of `base.room` (computed once per room and look). */
export function annexDecor(index, base, n) {
  const look = (n - 1) % DECOR.length;
  const key = `${base.room}:${look}`;
  if (decorCache.has(key)) return decorCache.get(key);
  let layout = { ...base, items: annexDesks(index, base).map((d) => ({ ...d })), agents: [] };
  const kept = [];
  DECOR[look].forEach((d, i) => {
    const f = index.furniture.get(d.asset);
    if (!f || f.station) return;
    const cand = { uid: `annex-decor-${i + 1}`, ...d };
    if (!checkPlacement(layout, index, cand).ok) return;
    const next = { ...layout, items: [...layout.items, cand] };
    if (unreachableStations(next, index).length) return;
    layout = next;
    kept.push(cand);
  });
  decorCache.set(key, kept);
  return kept;
}

/** How many agents one annex seats. */
export const annexCapacity = (index, base) => annexDesks(index, base).length;

/**
 * Split the office: occupants with a station stay in the office; the others fill annexes in roster order.
 * Each annex is { id, n, layout, occupants } with occupants placed at its desks. Looks and states are kept as given
 * (the server resolved them with the layout rules); only desks are assigned here. No overflow → no annex.
 * @param {object} index  indexManifest(manifest)
 * @param {object} base   the office's layout data (room, theme and rules are reused; desks are the annex's own)
 * @param {object[]} occupants  OccupantVM-like objects, office and seen agents together, in roster order
 */
export function planAnnexes(index, base, occupants) {
  const overflow = occupants.filter((o) => !o.stationUid);
  if (!overflow.length) return { office: occupants, annexes: [] };
  const desks = annexDesks(index, base);
  if (!desks.length) return { office: occupants, annexes: [] };
  const annexes = [];
  for (let i = 0; i < overflow.length; i += desks.length) {
    const group = overflow.slice(i, i + desks.length);
    const n = annexes.length + 1;
    // Rules keep styling the agents, but an annex has no stations of the office: every rule is « Automatique » here.
    const layout = { ...base, items: [...desks.map((d) => ({ ...d })), ...annexDecor(index, base, n).map((d) => ({ ...d }))], agents: base.agents.map((a) => ({ ...a, station: 'auto' })) };
    const placed = resolveOccupants(layout, index, group.map((o) => ({ id: o.id, role: o.role, sourceName: o.name })));
    annexes.push({ id: `annex-${n}`, n, layout, occupants: group.map((o, k) => ({ ...o, stationUid: placed[k].stationUid, destination: null })) });
  }
  return { office: occupants.filter((o) => o.stationUid), annexes };
}
