// Grid projection, image placement and depth sorting (design/office/README.md §1–3).
// World space = CSS px at zoom 1, with grid (0,0) at the origin. Pure functions; no DOM.

/** @typedef {{ tileWidth: number, tileHeight: number, artScale: number, wallHeight: number }} Projection */

/** Grid point → world px. */
export function project(x, y, proj) {
  return { sx: ((x - y) * proj.tileWidth) / 2, sy: ((x + y) * proj.tileHeight) / 2 };
}

/** World px → fractional grid point (inverse of project). */
export function unproject(sx, sy, proj) {
  const a = sx / (proj.tileWidth / 2);
  const b = sy / (proj.tileHeight / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** Tile under a world point, or null when outside cols × rows. */
export function tileAt(sx, sy, proj, cols, rows) {
  const g = unproject(sx, sy, proj);
  const x = Math.floor(g.x);
  const y = Math.floor(g.y);
  return x >= 0 && y >= 0 && x < cols && y < rows ? { x, y } : null;
}

/**
 * CSS box of an image whose anchor (image px) must land on world point (sx, sy).
 * `scale` multiplies the CSS size (sub-agents whose scale is not baked).
 */
export function imageBox(sx, sy, anchor, size, proj, scale = 1) {
  const k = scale / proj.artScale;
  return { left: sx - anchor.x * k, top: sy - anchor.y * k, width: size.w * k, height: size.h * k };
}

/**
 * World point of a wall item's anchor (its bottom-left point on the wall plane).
 * Right wall runs along y = 0, left wall along x = 0. Bottom-left is the point nearest the
 * left edge of the screen: (offset, 0) on the right wall, (0, offset + length) on the left wall.
 */
export function wallPoint(side, offset, length, elevation, proj) {
  const p = side === 'right' ? project(offset, 0, proj) : project(0, offset + length, proj);
  return { sx: p.sx, sy: p.sy - elevation };
}

/** Rotating a footprint swaps w and d. */
export function footprintFor(fp, orientation) {
  return orientation === 'se' ? { w: fp.d, d: fp.w } : { w: fp.w, d: fp.d };
}

/** Depth of a floor item: its footprint front corner (README §3). */
export function itemDepth(x, y, fp, layerBias = 0) {
  return x + fp.w - 1 + (y + fp.d - 1) + layerBias;
}

/**
 * Depth of a character whose feet are at fractional grid point (fx, fy).
 * README §3 writes it px + py + 0.5 with (px, py) the fractional tile position; the feet sit at the
 * tile centre (px + .5, py + .5), hence fx + fy − 0.5. A character in tile (tx, ty) gets tx + ty + .5,
 * so it draws over everything whose front corner is on its diagonal or behind it.
 */
export function characterDepth(fx, fy) {
  return fx + fy - 0.5;
}

/**
 * Sort scene entries back to front.
 * Entry: { id, depth, sub = 0, x = 0 }. Ties: sub-order, then x, then id.
 */
export function compareDepth(a, b) {
  return (a.depth - b.depth) || ((a.sub ?? 0) - (b.sub ?? 0)) || ((a.x ?? 0) - (b.x ?? 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function sortScene(entries) {
  return [...entries].sort(compareDepth);
}

/** Every tile covered by a footprint at (x, y). */
export function footprintTiles(x, y, fp) {
  const out = [];
  for (let dx = 0; dx < fp.w; dx++) for (let dy = 0; dy < fp.d; dy++) out.push({ x: x + dx, y: y + dy });
  return out;
}

/** World bounds of the room shell (for fit-to-stage). */
export function roomBounds(room, shellSize, proj) {
  return imageBox(0, 0, room.anchor, shellSize, proj);
}
