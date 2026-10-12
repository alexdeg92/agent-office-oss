'use strict';
// Canonical grid footprints for backend placement and save validation. No rendering or animation.
function footprintFor(fp, orientation) {
  return orientation === 'se' ? { w: fp.d, d: fp.w } : { w: fp.w, d: fp.d };
}
function footprintTiles(x, y, fp) {
  const out = [];
  for (let dx = 0; dx < fp.w; dx++) for (let dy = 0; dy < fp.d; dy++) out.push({ x: x + dx, y: y + dy });
  return out;
}

module.exports = { footprintFor, footprintTiles };
