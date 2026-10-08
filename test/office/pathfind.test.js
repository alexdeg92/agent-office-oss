'use strict';
// 4-neighbour A* and the walkable grid (design/office/README.md §1, §4.2).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const OFFICE = path.resolve(__dirname, '..', '..', 'public', 'v2', 'office');
const { buildGrid, findPath, isWalkable, nearestWalkable } = require(path.join(OFFICE, 'pathfind.js'));

const grid = (rows) => {
  const cols = rows[0].length;
  const blocked = new Uint8Array(cols * rows.length);
  rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === '#') blocked[y * cols + x] = 1; }));
  return { cols, rows: rows.length, blocked, owner: [] };
};
const isPath = (g, p, s, t) => {
  assert.deepEqual(p[0], s);
  assert.deepEqual(p.at(-1), t);
  for (let i = 1; i < p.length; i++) {
    assert.equal(Math.abs(p[i].x - p[i - 1].x) + Math.abs(p[i].y - p[i - 1].y), 1, 'only 4-neighbour steps');
    if (i < p.length - 1) assert.ok(isWalkable(g, p[i].x, p[i].y), `walkable ${p[i].x},${p[i].y}`);
  }
};

describe('findPath', () => {
  it('finds a shortest Manhattan path in an open room', () => {
    const g = grid(['.....', '.....', '.....']);
    const p = findPath(g, { x: 0, y: 0 }, { x: 4, y: 2 });
    isPath(g, p, { x: 0, y: 0 }, { x: 4, y: 2 });
    assert.equal(p.length, 7);
  });

  it('prefers fewer turns among equal-length paths', () => {
    const g = grid(['.....', '.....', '.....']);
    const p = findPath(g, { x: 0, y: 0 }, { x: 4, y: 2 });
    let turns = 0;
    for (let i = 2; i < p.length; i++) {
      const a = [p[i - 1].x - p[i - 2].x, p[i - 1].y - p[i - 2].y];
      const b = [p[i].x - p[i - 1].x, p[i].y - p[i - 1].y];
      if (a[0] !== b[0] || a[1] !== b[1]) turns++;
    }
    assert.equal(turns, 1);
  });

  it('routes around obstacles and never cuts corners', () => {
    const g = grid([
      '.....',
      '.###.',
      '.#...',
      '.#.#.',
      '...#.',
    ]);
    const p = findPath(g, { x: 2, y: 2 }, { x: 0, y: 0 });
    isPath(g, p, { x: 2, y: 2 }, { x: 0, y: 0 });
    assert.equal(p.length, 9);
  });

  it('allows a blocked start or goal (a seat inside a sofa footprint)', () => {
    const g = grid(['..#..', '..#..', '.....']);
    const p = findPath(g, { x: 0, y: 0 }, { x: 2, y: 0 });
    isPath(g, p, { x: 0, y: 0 }, { x: 2, y: 0 });
    assert.ok(p.every((t, i) => i === p.length - 1 || !(t.x === 2 && t.y === 1)), 'does not pass through the other blocked tile');
    const q = findPath(g, { x: 2, y: 1 }, { x: 4, y: 0 });
    isPath(g, q, { x: 2, y: 1 }, { x: 4, y: 0 });
  });

  it('returns null when the goal is walled off or outside the room', () => {
    const g = grid(['..#..', '..#..', '..#..']);
    assert.equal(findPath(g, { x: 0, y: 0 }, { x: 4, y: 0 }), null);
    assert.equal(findPath(g, { x: 0, y: 0 }, { x: 9, y: 0 }), null);
  });

  it('returns the start alone when start equals goal', () => {
    const g = grid(['...']);
    assert.deepEqual(findPath(g, { x: 1, y: 0 }, { x: 1, y: 0 }), [{ x: 1, y: 0 }]);
  });

  it('nearestWalkable finds the closest free tile', () => {
    const g = grid(['###', '#.#', '###']);
    assert.deepEqual(nearestWalkable(g, 0, 0), { x: 1, y: 1 });
    assert.deepEqual(nearestWalkable(g, 1, 1), { x: 1, y: 1 });
  });
});

describe('buildGrid', () => {
  const furniture = new Map([
    ['desk', { id: 'desk', placement: 'floor', footprint: { w: 2, d: 1 }, station: { blocks: [{ x: 0, y: 1 }] } }],
    ['rug', { id: 'rug', placement: 'decal', footprint: { w: 3, d: 2 }, walkable: true }],
    ['sofa', { id: 'sofa', placement: 'floor', footprint: { w: 3, d: 1 } }],
  ]);

  it('blocks floor footprints and station extra tiles, never decals', () => {
    const g = buildGrid(6, 5, [
      { uid: 'd', asset: 'desk', x: 1, y: 1 },
      { uid: 'r', asset: 'rug', x: 0, y: 3 },
      { uid: 's', asset: 'sofa', x: 3, y: 3, orientation: 'se' }, // rotated: 1 × 3, clipped at the room edge
    ], furniture);
    const blocked = [];
    for (let y = 0; y < 5; y++) for (let x = 0; x < 6; x++) if (!isWalkable(g, x, y)) blocked.push(`${x},${y}`);
    assert.deepEqual(blocked, ['1,1', '2,1', '1,2', '3,3', '3,4']);
    assert.equal(g.owner[1 * 6 + 2], 'd');
  });
});
