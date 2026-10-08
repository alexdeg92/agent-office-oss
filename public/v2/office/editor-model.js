// Office editor model (design/office/editor.md): immutable edit operations and undo history.
// Pure; no DOM. Every rule (placement, validation, resolution) lives in layout-rules.js, shared with
// the server, so the editor's preview and the saved result can't disagree.
import {
  checkPlacement, roomOf, wallLength, defaultAccessoriesFor, sortAccessories,
} from './layout-rules.js';

export {
  MAX_ITEMS, NAME_MAX, ROLE_MAX, collisionTiles, footprintOf, wallSpan, seatTile, itemName, unreachableStations,
  checkPlacement, validateLayout, resolveOccupants, ruleFor, homeStations, defaultAccessoriesFor, ruleKind,
} from './layout-rules.js';

const clone = (o) => structuredClone(o);

// ---------- operations (immutable; each returns a new layout) ----------

export function nextUid(layout, asset) {
  const base = asset.replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'item';
  const used = new Set(layout.items.map((i) => i.uid));
  for (let n = 1; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function addItem(layout, item) {
  const next = clone(layout);
  const uid = item.uid ?? nextUid(layout, item.asset);
  next.items.push({ ...item, uid });
  return { layout: next, uid };
}

export function moveItem(layout, uid, pos) {
  const next = clone(layout);
  const it = next.items.find((i) => i.uid === uid);
  Object.assign(it, pos);
  return next;
}

/** Removing a station sends the agents that used it back to « Automatique ». */
export function removeItem(layout, uid) {
  const next = clone(layout);
  next.items = next.items.filter((i) => i.uid !== uid);
  for (const a of next.agents) if (a.station === uid) a.station = 'auto';
  return next;
}

export function renameItem(layout, uid, label) {
  const next = clone(layout);
  const it = next.items.find((i) => i.uid === uid);
  const v = (label ?? '').trim().slice(0, 48);
  if (v) it.label = v; else delete it.label;
  return next;
}

/** Nearest valid spot for an item, scanning rings around `near` (duplicate, keyboard placement). */
export function findFreeSpot(layout, index, cand, near) {
  const room = roomOf(layout, index);
  const f = index.furniture.get(cand.asset);
  if (f.placement === 'wall') {
    for (const side of [f.wall?.side ?? 'right', f.wall?.side ? null : 'left'].filter(Boolean)) {
      const len = wallLength(room, side);
      const start = Math.max(0, Math.min(len - 1, near?.offset ?? Math.floor(len / 2)));
      for (let d = 0; d < len; d++) for (const off of [start + d, start - d]) {
        const c = { ...cand, wall: side, offset: off };
        delete c.x; delete c.y;
        if (off >= 0 && checkPlacement(layout, index, c).ok) return c;
      }
    }
    return null;
  }
  const cx = near?.x ?? Math.floor(room.cols / 2), cy = near?.y ?? Math.floor(room.rows / 2);
  for (let r = 0; r < room.cols + room.rows; r++) {
    for (let dx = -r; dx <= r; dx++) {
      const dy = r - Math.abs(dx);
      for (const y of dy === 0 ? [cy] : [cy - dy, cy + dy]) {
        const c = { ...cand, x: cx + dx, y };
        if (checkPlacement(layout, index, c).ok) return c;
      }
    }
  }
  return null;
}

export function duplicateItem(layout, index, uid) {
  const it = layout.items.find((i) => i.uid === uid);
  const cand = { ...clone(it) };
  delete cand.uid;
  delete cand.label;
  const spot = findFreeSpot(layout, index, cand, it.wall != null ? { offset: it.offset + 1 } : { x: it.x + 1, y: it.y + 1 });
  if (!spot) return null;
  return addItem(layout, spot);
}

export function updateAgent(layout, agentId, patch) {
  const next = clone(layout);
  const a = next.agents.find((x) => x.agentId === agentId);
  if (a) Object.assign(a, patch);
  else {
    const at = next.agents.findIndex((x) => x.agentId.startsWith('*'));
    next.agents.splice(at < 0 ? next.agents.length : at, 0, { agentId, character: 'subagent', ...patch });
  }
  return next;
}

export function updateTheme(layout, patch) {
  const next = clone(layout);
  next.theme = { ...next.theme, ...patch };
  if (next.theme.mode === 'auto') delete next.theme.fixed;
  return next;
}

/**
 * Toggle an accessory, keeping at most one per slot (README §4: body → neck → face → head → badge).
 * @returns {{ accessories: string[], replaced: string|null }}
 */
export function toggleAccessory(index, accessories, id) {
  const list = [...(accessories ?? [])];
  if (list.includes(id)) return { accessories: list.filter((x) => x !== id), replaced: null };
  const slot = index.accessories.get(id)?.slot;
  const clash = list.find((x) => index.accessories.get(x)?.slot === slot) ?? null;
  const out = list.filter((x) => x !== clash);
  out.push(id);
  return { accessories: sortAccessories(index, out), replaced: clash };
}

/** Effective accessories of a rule: explicit list, else the variant's default gear (omitted ≠ []). */
export function effectiveAccessories(index, rule) {
  return rule.accessories != null ? rule.accessories : defaultAccessoriesFor(index, rule.character, rule.variant ?? null);
}

// ---------- undo history ----------

export class History {
  constructor(initial, limit = 200) {
    this.stack = [clone(initial)];
    this.i = 0;
    this.limit = limit;
    this.saved = JSON.stringify(initial);
  }
  get current() { return this.stack[this.i]; }
  get canUndo() { return this.i > 0; }
  get canRedo() { return this.i < this.stack.length - 1; }
  get dirty() { return JSON.stringify(this.current) !== this.saved; }
  push(next) {
    if (JSON.stringify(next) === JSON.stringify(this.current)) return false;
    this.stack.length = this.i + 1;
    this.stack.push(clone(next));
    if (this.stack.length > this.limit) this.stack.shift();
    this.i = this.stack.length - 1;
    return true;
  }
  undo() { if (this.canUndo) this.i--; return this.current; }
  redo() { if (this.canRedo) this.i++; return this.current; }
  /** After a save or a reload: the given document becomes the clean baseline (history is kept). */
  markSaved(doc) { this.saved = JSON.stringify(doc); }
}
