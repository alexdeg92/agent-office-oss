'use strict';
/*
 * VM → delta ops (api.md §4.5). Paths are arrays of field names and { id } selectors; no number segments.
 *   diff(a, b) → DeltaOp[] | null      null = not expressible (a removed field, a type change at the root):
 *                                       the caller sends a snapshot instead
 *   apply(vm, ops) → new vm             the client algorithm, used by tests and the reference for consumers
 * A Collection is an array whose elements are all objects with a unique string `id`. Collections get
 * remove / upsert / move ops (granular nested ops for a changed item); anything else gets `set`.
 * Every op is idempotent (§4.5): set to the same value, upsert of a present item at its index, remove of an
 * absent id and move to the current index change nothing.
 */
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isCollection = (arr) => Array.isArray(arr) && arr.every((x) => isObj(x) && typeof x.id === 'string') && new Set(arr.map((x) => x.id)).size === arr.length;

function diff(a, b, path = [], ops = []) {
  if (same(a, b)) return ops;
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) if (!(k in b)) return null;            // a field never disappears from a VM
    for (const k of Object.keys(b)) {
      if (!(k in a)) { ops.push({ op: 'set', path: path.concat(k), value: b[k] }); continue; }
      if (diff(a[k], b[k], path.concat(k), ops) === null) return null;
    }
    return ops;
  }
  if (Array.isArray(a) && Array.isArray(b) && (a.length || b.length) && isCollection(a) && isCollection(b)) {
    const bIds = new Set(b.map((x) => x.id));
    const cur = [];
    for (const x of a) { if (bIds.has(x.id)) cur.push(x.id); else ops.push({ op: 'remove', path, id: x.id }); }
    const before = new Map(a.map((x) => [x.id, x]));
    b.forEach((item, i) => {
      if (!before.has(item.id)) { ops.push({ op: 'upsert', path, item, index: i }); cur.splice(i, 0, item.id); return; }
      const at = cur.indexOf(item.id);
      if (at !== i) { ops.push({ op: 'move', path, id: item.id, index: i }); cur.splice(at, 1); cur.splice(i, 0, item.id); }
      if (!same(before.get(item.id), item)) {
        const nested = diff(before.get(item.id), item, path.concat({ id: item.id }), []);
        if (nested === null) ops.push({ op: 'upsert', path, item, index: i });
        else ops.push(...nested);
      }
    });
    return ops;
  }
  if (path.length === 0) return null;                                       // the root is never replaced by a set
  ops.push({ op: 'set', path, value: b });
  return ops;
}

// ---- client reference ---------------------------------------------------------------------
function resolve(root, path) {
  let parent = null, key = null, node = root;
  for (const seg of path) {
    parent = node;
    if (isObj(seg)) { key = Array.isArray(node) ? node.findIndex((x) => x && x.id === seg.id) : -1; if (key < 0) throw new Error('no element ' + seg.id); }
    else key = seg;
    node = parent[key];
  }
  return { parent, key, node };
}
function apply(vm, ops) {
  const out = JSON.parse(JSON.stringify(vm));
  for (const o of ops) {
    if (o.op === 'set') { const { parent, key } = resolve(out, o.path); parent[key] = JSON.parse(JSON.stringify(o.value)); continue; }
    const { node: list } = resolve(out, o.path);
    if (!Array.isArray(list)) throw new Error('not a collection');
    const at = list.findIndex((x) => x.id === (o.op === 'upsert' ? o.item.id : o.id));
    if (o.op === 'remove') { if (at >= 0) list.splice(at, 1); }
    else if (o.op === 'upsert') { if (at >= 0) list.splice(at, 1); list.splice(o.index, 0, JSON.parse(JSON.stringify(o.item))); }
    else if (o.op === 'move') { if (at >= 0) { const [x] = list.splice(at, 1); list.splice(o.index, 0, x); } }
  }
  return out;
}

module.exports = { diff, apply, isCollection };
