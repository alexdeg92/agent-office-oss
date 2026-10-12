'use strict';
// Walkable grid and 4-neighbour A* (design/office/README.md §1, §4.2 walking). Pure; no DOM.
const { footprintFor, footprintTiles } = require('./geometry.js');

/**
 * Build the walkability grid for a room from layout items and the manifest's furniture index.
 * Floor items block their footprint unless `walkable`; decals never block; stations add `blocks`.
 * @returns {{ cols: number, rows: number, blocked: Uint8Array, owner: (string|null)[] }}
 */
function buildGrid(cols, rows, items, furnitureById) {
  const blocked = new Uint8Array(cols * rows);
  const owner = new Array(cols * rows).fill(null);
  const mark = (t, uid) => {
    if (t.x < 0 || t.y < 0 || t.x >= cols || t.y >= rows) return;
    blocked[t.y * cols + t.x] = 1;
    owner[t.y * cols + t.x] = uid;
  };
  for (const it of items) {
    const f = furnitureById.get(it.asset);
    if (!f || f.placement !== 'floor' || f.walkable) continue;
    for (const t of footprintTiles(it.x, it.y, footprintFor(f.footprint, it.orientation))) mark(t, it.uid);
    for (const b of f.station?.blocks ?? []) mark({ x: it.x + b.x, y: it.y + b.y }, it.uid);
  }
  return { cols, rows, blocked, owner };
}

function isWalkable(grid, x, y) {
  return x >= 0 && y >= 0 && x < grid.cols && y < grid.rows && !grid.blocked[y * grid.cols + x];
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * A* on tiles, 4-neighbour, unit cost, Manhattan heuristic.
 * Start and goal may be blocked (a seat inside a sofa footprint, a character standing in a footprint
 * after a layout change); every other tile on the path must be walkable.
 * Ties prefer straight lines (fewer turns), so walks look deliberate.
 * @returns {{x:number,y:number}[] | null} tiles from start to goal inclusive, or null when unreachable.
 */
function findPath(grid, start, goal) {
  const { cols, rows } = grid;
  const inside = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows;
  if (!inside(start.x, start.y) || !inside(goal.x, goal.y)) return null;
  const key = (x, y) => y * cols + x;
  const sk = key(start.x, start.y);
  const gk = key(goal.x, goal.y);
  if (sk === gk) return [{ x: start.x, y: start.y }];

  const g = new Float64Array(cols * rows).fill(Infinity);
  const came = new Int32Array(cols * rows).fill(-1);
  const dirOf = new Int8Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);
  const h = (x, y) => Math.abs(x - goal.x) + Math.abs(y - goal.y);
  // Small binary heap of [f, turnPenalty, seq, key]
  const heap = [];
  let seq = 0;
  const less = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const push = (n) => {
    heap.push(n);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(heap[i], heap[p]) >= 0) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m]) < 0) m = l;
        if (r < heap.length && less(heap[r], heap[m]) < 0) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };

  g[sk] = 0;
  push([h(start.x, start.y), 0, seq++, sk]);
  while (heap.length) {
    const [, , , k] = pop();
    if (closed[k]) continue;
    if (k === gk) break;
    closed[k] = 1;
    const x = k % cols, y = (k - x) / cols;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
      if (!inside(nx, ny)) continue;
      const nk = key(nx, ny);
      if (closed[nk]) continue;
      if (nk !== gk && grid.blocked[nk]) continue;
      const turn = dirOf[k] !== -1 && dirOf[k] !== d ? 1 : 0;
      const ng = g[k] + 1 + turn * 1e-3;
      if (ng < g[nk]) {
        g[nk] = ng;
        came[nk] = k;
        dirOf[nk] = d;
        push([ng + h(nx, ny), turn, seq++, nk]);
      }
    }
  }
  if (came[gk] === -1) return null;
  const out = [];
  for (let k = gk; k !== -1; k = came[k]) {
    const x = k % cols;
    out.push({ x, y: (k - x) / cols });
    if (k === sk) break;
  }
  return out.reverse();
}

/** Nearest walkable tile to (x, y) by BFS ring, for spawn points and seats inside footprints. */
function nearestWalkable(grid, x, y) {
  if (isWalkable(grid, x, y)) return { x, y };
  for (let r = 1; r < grid.cols + grid.rows; r++) {
    for (let dx = -r; dx <= r; dx++) {
      const dy = r - Math.abs(dx);
      for (const yy of dy === 0 ? [y] : [y - dy, y + dy]) if (isWalkable(grid, x + dx, yy)) return { x: x + dx, y: yy };
    }
  }
  return null;
}

module.exports = { buildGrid, isWalkable, findPath, nearestWalkable };
