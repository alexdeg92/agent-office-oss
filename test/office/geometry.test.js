'use strict';
// Office scene geometry: 2:1 projection, image anchoring, wall points and depth sort
// (design/office/README.md §1–3). The modules are browser ES modules loaded with require(esm).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const OFFICE = path.resolve(__dirname, '..', '..', 'public', 'v2', 'office');
const G = require(path.join(OFFICE, 'geometry.js'));
const PROJ = { tileWidth: 96, tileHeight: 48, artScale: 2, wallHeight: 144 };

describe('projection', () => {
  it('maps the grid to 2:1 screen space', () => {
    assert.deepEqual(G.project(0, 0, PROJ), { sx: 0, sy: 0 });
    assert.deepEqual(G.project(1, 0, PROJ), { sx: 48, sy: 24 }); // x → bottom-right
    assert.deepEqual(G.project(0, 1, PROJ), { sx: -48, sy: 24 }); // y → bottom-left
    assert.deepEqual(G.project(12, 10, PROJ), { sx: 96, sy: 528 });
  });

  it('unproject inverts project, including fractional points', () => {
    for (const [x, y] of [[0, 0], [3, 7], [11.5, 0.25], [6.4, 9.5]]) {
      const p = G.project(x, y, PROJ);
      const g = G.unproject(p.sx, p.sy, PROJ);
      assert.ok(Math.abs(g.x - x) < 1e-9 && Math.abs(g.y - y) < 1e-9, `${x},${y}`);
    }
  });

  it('tileAt picks the tile under a point and rejects points outside the room', () => {
    const c = G.project(4.5, 2.5, PROJ);
    assert.deepEqual(G.tileAt(c.sx, c.sy, PROJ, 12, 10), { x: 4, y: 2 });
    const out = G.project(-0.5, 3, PROJ);
    assert.equal(G.tileAt(out.sx, out.sy, PROJ, 12, 10), null);
  });

  it('places an image so its anchor (image px at artScale 2) lands on the point', () => {
    // desk.png: canvas 307×325, anchor (103,177) per anchors.json
    const b = G.imageBox(100, 50, { x: 103, y: 177 }, { w: 307, h: 325 }, PROJ);
    assert.deepEqual(b, { left: 100 - 51.5, top: 50 - 88.5, width: 153.5, height: 162.5 });
    // unbaked render scale multiplies size and anchor offset together
    const s = G.imageBox(0, 0, { x: 96, y: 276 }, { w: 192, h: 288 }, PROJ, 0.5);
    assert.deepEqual(s, { left: -24, top: -69, width: 48, height: 72 });
  });

  it('wall items anchor bottom-left on their wall plane, raised by elevation', () => {
    // right wall runs along y = 0: bottom-left is at (offset, 0)
    assert.deepEqual(G.wallPoint('right', 3, 2, 48, PROJ), { sx: 144, sy: 72 - 48 });
    // left wall runs along x = 0: bottom-left is the far end (0, offset + length)
    assert.deepEqual(G.wallPoint('left', 4, 2, 40, PROJ), { sx: -288, sy: 144 - 40 });
  });

  it('rotation swaps the footprint', () => {
    assert.deepEqual(G.footprintFor({ w: 3, d: 1 }, 'se'), { w: 1, d: 3 });
    assert.deepEqual(G.footprintFor({ w: 3, d: 1 }, 'sw'), { w: 3, d: 1 });
    assert.equal(G.footprintTiles(2, 3, { w: 2, d: 2 }).length, 4);
  });
});

describe('depth sort', () => {
  it('item depth is the footprint front corner plus layerBias', () => {
    assert.equal(G.itemDepth(6, 1, { w: 2, d: 1 }), 8);
    assert.equal(G.itemDepth(9, 8, { w: 3, d: 1 }), 19);
    assert.equal(G.itemDepth(11, 6, { w: 1, d: 1 }, 0.1), 17.1);
  });

  it('a character in tile (tx,ty) has depth tx + ty + 0.5', () => {
    assert.equal(G.characterDepth(4.5, 2.5), 6.5);
    assert.equal(G.characterDepth(0.5, 0.5), 0.5);
  });

  it('a character in front of a desk draws over it; one behind draws under it', () => {
    const desk = { id: 'desk', depth: G.itemDepth(6, 4, { w: 2, d: 1 }), x: 6 };
    const front = { id: '~a', depth: G.characterDepth(7.5, 5.5), sub: 5, x: 7.5 };
    const behind = { id: '~b', depth: G.characterDepth(7.5, 3.5), sub: 5, x: 7.5 };
    assert.deepEqual(G.sortScene([front, desk, behind]).map((e) => e.id), ['~b', 'desk', '~a']);
  });

  it('station composites keep their stack order at equal depth', () => {
    const parts = ['character', 'chair', 'monitor', 'desk'].map((name) => ({ id: `st:${name}`, depth: 8, sub: ['desk', 'monitor', 'chair', 'character'].indexOf(name), x: 6 }));
    assert.deepEqual(G.sortScene(parts).map((e) => e.id), ['st:desk', 'st:monitor', 'st:chair', 'st:character']);
  });

  it('ties break by sub-order, then x, then id, and the sort is stable for equal keys', () => {
    const e = [
      { id: 'c', depth: 5, sub: 0, x: 2 },
      { id: 'b', depth: 5, sub: 0, x: 1 },
      { id: 'a', depth: 5, sub: 0, x: 2 },
      { id: 'z', depth: 5, sub: -1, x: 9 },
      { id: 'y', depth: 4.5, sub: 9, x: 9 },
    ];
    assert.deepEqual(G.sortScene(e).map((x) => x.id), ['y', 'z', 'b', 'a', 'c']);
    assert.deepEqual(e.map((x) => x.id), ['c', 'b', 'a', 'z', 'y'], 'input not mutated');
  });

  it('a walking character crosses a row of furniture in the right order', () => {
    const plant = { id: 'plant', depth: G.itemDepth(5, 5, { w: 1, d: 1 }), x: 5 };
    const order = [];
    for (let t = 0; t <= 1; t += 0.25) {
      const walker = { id: '~w', depth: G.characterDepth(4.5 + t, 4.5 + t), sub: 5, x: 4.5 + t };
      order.push(G.sortScene([plant, walker])[0].id);
    }
    // behind the plant until it reaches the plant's tile diagonal, then in front
    assert.deepEqual(order, ['~w', '~w', '~w', 'plant', 'plant']);
  });
});
