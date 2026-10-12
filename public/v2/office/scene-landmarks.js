import { landmarksFor } from './assets.js';
import { s as tr } from './strings.js';

/** SVG overlay of head landmarks on the pose canvas (image px). Missing landmarks draw a "no data" tag. */
export function landmarkSvg(ch, variant, pose) {
  const lm = landmarksFor(ch, variant, pose);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'ao-landmarks');
  svg.setAttribute('viewBox', `0 0 ${ch.canvas.w} ${ch.canvas.h}`);
  const add = (tag, attrs) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.append(n);
    return n;
  };
  add('circle', { cx: ch.anchor.x, cy: ch.anchor.y, r: 3, class: 'lm-anchor' });
  if (!lm) {
    add('text', { x: 4, y: 12, class: 'lm-none' }).textContent = tr('scene.noLandmarks');
    return svg;
  }
  const pt = (p, cls) => p && add('circle', { cx: p.x, cy: p.y, r: 3.5, class: cls });
  if (lm.headBox) add('rect', { x: lm.headBox.x, y: lm.headBox.y, width: lm.headBox.w, height: lm.headBox.h, class: 'lm-box', transform: lm.tilt && lm.headCentre ? `rotate(${lm.tilt} ${lm.headCentre.x} ${lm.headCentre.y})` : '' });
  if (lm.eyeLine) add('line', { x1: lm.eyeLine.a.x, y1: lm.eyeLine.a.y, x2: lm.eyeLine.b.x, y2: lm.eyeLine.b.y, class: 'lm-eyes' });
  pt(lm.headCentre, 'lm-centre'); pt(lm.earLeft, 'lm-ear'); pt(lm.earRight, 'lm-ear'); pt(lm.neck, 'lm-neck'); pt(lm.chest, 'lm-chest');
  return svg;
}
