// Structural diff for the mock SSE (api.md 2.0 §4.5): paths are arrays of field names and { id } selectors.
// Collections (arrays whose items all have a string id): remove / move / upsert by id; an item that stays at the
// same place is diffed field by field (so a board move is « remove from todo.cards, upsert into in-progress.cards »,
// as in the §4.6 example). Plain objects recurse; anything else that changed is a `set`.
const isCollection = (a) => Array.isArray(a) && a.every((x) => x && typeof x === 'object' && typeof x.id === 'string');
const isObject = (o) => o && typeof o === 'object' && !Array.isArray(o);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function diff(prev, next, path = []) {
  if (same(prev, next)) return [];
  if (path.length && isCollection(prev) && isCollection(next)) {
    const ops = [];
    const ids = new Set(next.map((x) => x.id));
    for (const x of prev) if (!ids.has(x.id)) ops.push({ op: 'remove', path, id: x.id });
    const cur = prev.filter((x) => ids.has(x.id));  // simulated client state while emitting ops
    next.forEach((item, index) => {
      const at = cur.findIndex((x) => x.id === item.id);
      if (at === -1) { ops.push({ op: 'upsert', path, item, index }); cur.splice(index, 0, item); return; }
      if (at !== index) { ops.push({ op: 'move', path, id: item.id, index }); const [m] = cur.splice(at, 1); cur.splice(index, 0, m); }
      if (!same(cur[index], item)) {
        const inner = isObject(cur[index]) && isObject(item) ? diff(cur[index], item, [...path, { id: item.id }]) : null;
        if (inner && inner.length) ops.push(...inner);
        else ops.push({ op: 'upsert', path, item, index });
        cur[index] = item;
      }
    });
    return ops;
  }
  if (isObject(prev) && isObject(next)) {
    const ops = [];
    for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) ops.push(...diff(prev[k], next[k], [...path, k]));
    return ops;
  }
  return [{ op: 'set', path, value: next }];
}
