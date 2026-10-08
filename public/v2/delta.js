// Applies SSE delta ops to a view model (api.md 2.0 §4.5). Pure and immutable: returns a new VM, sharing the
// untouched branches, so Preact sees new references only where something changed.
// A path is an array of segments: a string (object field) or { id } (the element of a Collection with that id).
// Number segments are not allowed.

export class DeltaError extends Error {
  constructor(message, op) { super(message); this.name = 'DeltaError'; this.op = op; }
}

const isIdSeg = (s) => s && typeof s === 'object' && typeof s.id === 'string';

function checkPath(path, op) {
  if (!Array.isArray(path)) throw new DeltaError('path must be an array', op);
  for (const s of path) if (typeof s !== 'string' && !isIdSeg(s)) throw new DeltaError('bad path segment ' + JSON.stringify(s), op);
}

function getIn(obj, path, op) {
  let cur = obj;
  for (const seg of path) {
    if (isIdSeg(seg)) {
      if (!Array.isArray(cur)) throw new DeltaError(`{id:${seg.id}} on a non-collection`, op);
      cur = cur.find((x) => x && x.id === seg.id);
      if (cur === undefined) throw new DeltaError(`no element {id:${seg.id}}`, op);
    } else {
      if (cur == null || typeof cur !== 'object' || Array.isArray(cur)) throw new DeltaError(`no object at "${seg}"`, op);
      cur = cur[seg];
    }
  }
  return cur;
}

// Returns a copy of `obj` with fn(old) at `path`. Field segments may create missing objects; {id} segments must exist.
function updateIn(obj, path, fn, op) {
  if (path.length === 0) return fn(obj);
  const [seg, ...rest] = path;
  if (isIdSeg(seg)) {
    if (!Array.isArray(obj)) throw new DeltaError(`{id:${seg.id}} on a non-collection`, op);
    const i = obj.findIndex((x) => x && x.id === seg.id);
    if (i === -1) throw new DeltaError(`no element {id:${seg.id}}`, op);
    const copy = obj.slice();
    copy[i] = updateIn(obj[i], rest, fn, op);
    return copy;
  }
  const base = obj == null ? {} : obj;
  if (typeof base !== 'object' || Array.isArray(base)) throw new DeltaError(`cannot set field "${seg}" on ${Array.isArray(base) ? 'an array' : typeof base}`, op);
  return { ...base, [seg]: updateIn(base[seg], rest, fn, op) };
}

function collectionAt(vm, op) {
  const list = getIn(vm, op.path, op);
  if (!Array.isArray(list)) throw new DeltaError('no collection at ' + JSON.stringify(op.path), op);
  return list;
}

const clampIndex = (i, len) => (Number.isInteger(i) ? Math.max(0, Math.min(i, len)) : len);

/** Applies one op. Throws DeltaError when the op doesn't fit the VM (the caller then resyncs). */
export function applyOp(vm, op) {
  if (!op || typeof op !== 'object') throw new DeltaError('bad op', op);
  checkPath(op.path, op);
  switch (op.op) {
    case 'set':
      if (op.path.length && isIdSeg(op.path[op.path.length - 1]) && (!op.value || op.value.id !== op.path[op.path.length - 1].id)) {
        throw new DeltaError('set on {id} must keep the id', op);
      }
      return updateIn(vm, op.path, () => op.value, op);
    case 'upsert': {
      if (!op.item || typeof op.item.id !== 'string') throw new DeltaError('upsert without item.id', op);
      collectionAt(vm, op);
      return updateIn(vm, op.path, (list) => {
        const rest = list.filter((x) => x.id !== op.item.id);
        rest.splice(clampIndex(op.index, rest.length), 0, op.item);
        return rest;
      }, op);
    }
    case 'remove': {
      const list = collectionAt(vm, op);
      if (!list.some((x) => x.id === op.id)) return vm; // already gone: idempotent
      return updateIn(vm, op.path, (l) => l.filter((x) => x.id !== op.id), op);
    }
    case 'move': {
      const list = collectionAt(vm, op);
      const item = list.find((x) => x.id === op.id);
      if (!item) throw new DeltaError(`move: no item "${op.id}"`, op);
      return updateIn(vm, op.path, (l) => {
        const rest = l.filter((x) => x.id !== op.id);
        rest.splice(clampIndex(op.index, rest.length), 0, item);
        return rest;
      }, op);
    }
    default:
      throw new DeltaError(`unknown op "${op.op}"`, op);
  }
}

/** Applies a frame's ops in order; the frame is atomic (all or nothing). */
export function applyOps(vm, ops) {
  return ops.reduce(applyOp, vm);
}

/**
 * Topic state machine for one topic: { rev, data } (api.md 2.0 §4.3).
 * Returns { state, needResync }: needResync is true when the frame can't be applied (rev gap or an op that doesn't fit);
 * the caller then asks the server for a snapshot (resync) and ignores deltas until it arrives (rev = null).
 */
export function reduceFrame(state, frame) {
  const resync = { state: { ...state, rev: null }, needResync: true };
  if (!frame || typeof frame !== 'object') return resync;
  if (frame.type === 'snapshot') {
    if (!Number.isInteger(frame.rev) || frame.rev < 1 || frame.data === undefined) return resync; // malformed (R4-17)
    return { state: { rev: frame.rev, data: frame.data }, needResync: false };
  }
  if (frame.type !== 'delta') return { state, needResync: false };
  if (state.rev == null) return { state, needResync: false }; // waiting for a snapshot: ignore
  // Malformed deltas (R4-17): revisions must be integers with rev = baseRev + 1, and ops an array.
  if (!Number.isInteger(frame.rev) || !Number.isInteger(frame.baseRev) || frame.rev !== frame.baseRev + 1 || !Array.isArray(frame.ops)) return resync;
  if (frame.rev <= state.rev) return { state, needResync: false }; // already applied (replay after resume)
  if (frame.baseRev !== state.rev) return resync;
  try {
    return { state: { rev: frame.rev, data: applyOps(state.data, frame.ops) }, needResync: false };
  } catch {
    return resync; // any op that doesn't fit, DeltaError or not
  }
}
