// Head landmarks (Accessory contract v2, BRIEF decisions log): normalise what the artist writes in
// design/assets/anchors.json into the manifest shape. Pure; used by design/office/build-manifest.mjs.
//
// Manifest shape (image px on the pose canvas, artScale 2):
//   { headCentre:{x,y}, headBox:{x,y,w,h}, tilt:deg, earLeft:{x,y}, earRight:{x,y},
//     eyeLine:{a:{x,y}, b:{x,y}}, neck:{x,y}, chest:{x,y} }
// Accepted input spellings: camelCase or snake_case keys; points as [x,y] or {x,y};
// boxes as [x0,y0,x1,y1] or {x,y,w,h}; eye line as [[x,y],[x,y]], {a,b} or {left,right};
// ears as earLeft/earRight or ears|earPoints:{left,right}; tilt as tilt or tiltDegreesClockwise.

const pick = (o, ...keys) => {
  for (const k of keys) if (o?.[k] != null) return o[k];
  return undefined;
};

export function toPoint(v) {
  if (v == null) return undefined;
  if (Array.isArray(v) && v.length >= 2 && v.every((n) => typeof n === 'number')) return { x: v[0], y: v[1] };
  if (typeof v === 'object' && typeof v.x === 'number' && typeof v.y === 'number') return { x: v.x, y: v.y };
  return undefined;
}

export function toBox(v) {
  if (v == null) return undefined;
  if (Array.isArray(v) && v.length === 4) return { x: v[0], y: v[1], w: v[2] - v[0], h: v[3] - v[1] };
  if (typeof v === 'object' && ['x', 'y', 'w', 'h'].every((k) => typeof v[k] === 'number')) return { x: v.x, y: v.y, w: v.w, h: v.h };
  if (typeof v === 'object' && ['x0', 'y0', 'x1', 'y1'].every((k) => typeof v[k] === 'number')) return { x: v.x0, y: v.y0, w: v.x1 - v.x0, h: v.y1 - v.y0 };
  return undefined;
}

function toLine(v) {
  if (v == null) return undefined;
  if (Array.isArray(v) && v.length === 2) {
    const a = toPoint(v[0]), b = toPoint(v[1]);
    return a && b ? { a, b } : undefined;
  }
  const a = toPoint(pick(v, 'a', 'left', 'start')), b = toPoint(pick(v, 'b', 'right', 'end'));
  return a && b ? { a, b } : undefined;
}

/** @returns normalised landmarks, or null when the input has none of the known fields. */
export function normalizeLandmarks(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ears = pick(raw, 'ears', 'earPoints', 'ear_points');
  const out = {
    headCentre: toPoint(pick(raw, 'headCentre', 'headCenter', 'head_centre', 'head_center')),
    headBox: toBox(pick(raw, 'headBox', 'head_box')),
    tilt: (() => { const t = pick(raw, 'tilt', 'tiltDeg', 'tilt_deg', 'tiltDegreesClockwise', 'angle'); return typeof t === 'number' ? t : undefined; })(),
    earLeft: toPoint(pick(raw, 'earLeft', 'ear_left') ?? pick(ears, 'left', 'l')),
    earRight: toPoint(pick(raw, 'earRight', 'ear_right') ?? pick(ears, 'right', 'r')),
    eyeLine: toLine(pick(raw, 'eyeLine', 'eye_line', 'eyes')),
    neck: toPoint(pick(raw, 'neck', 'neckPoint', 'neck_point')),
    chest: toPoint(pick(raw, 'chest', 'chestPoint', 'chest_point')),
  };
  if (!out.headCentre && out.headBox) out.headCentre = { x: out.headBox.x + out.headBox.w / 2, y: out.headBox.y + out.headBox.h / 2 };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : null;
}
