'use strict';
require('../../helpers/scratch-home.cjs').refuseEntry(__filename);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkAccessoryPack, accessoryPlacement } = require('../../../public/v2/office/accessory-packs');
const root = path.resolve(__dirname, '../../../design');
const packs = new Map();
const directions = ['sw', 'se', 'ne', 'nw'];

// Lazy accessories register canonical per-frame contacts rather than emitted layers.
function assertLazyAccessoryFrame(accessory, key, pose, frame, frameCount, anchors) {
  const file = path.join(root, accessory.packManifest);
  if (!packs.has(file)) {
    const raw = fs.readFileSync(file), pack = JSON.parse(raw);
    assert.deepEqual(checkAccessoryPack(pack, { metadataBytes: raw.length }).errors, []);
    packs.set(file, pack);
  }
  const pack = packs.get(file), label = key + '/' + accessory.id + '/' + pose + '/' + frame;
  const item = pack.items.find(a => a.id === accessory.id);
  assert.ok(item, label + ' enabled item');
  const records = pack.fits[key]?.[pose];
  assert.equal(records?.length, frameCount, label + ' body frame count');
  const record = records[frame];
  const facing = anchors.facing ?? directions.find(d => pose.endsWith('-' + d)) ?? (pose === 'working' ? 'ne' : 'sw');
  assert.equal(record[0], directions.indexOf(facing), label + ' facing');
  const near = (actual, expected, name) => {
    assert.equal(actual.length, expected.length, label + ' ' + name);
    actual.forEach((n, i) => assert.ok(Math.abs(n - expected[i]) <= .0051, label + ' ' + name + '[' + i + ']'));
  };
  near(record.slice(5, 7), anchors.head, 'head');
  near(record.slice(7, 9), anchors.neck, 'neck');
  near(record.slice(13, 17), [...anchors.earLeft, ...anchors.earRight], 'ears');
  near(record.slice(17, 21), [...anchors.handLeft, ...anchors.handRight], 'hands');
  if (anchors.eyes?.line) near(record.slice(9, 13), anchors.eyes.line.flat(), 'eyes');
  else assert.deepEqual(record.slice(9, 13), [null, null, null, null], label + ' occluded eyes');
  if (anchors.headBox) {
    const [x, y, right, bottom] = anchors.headBox;
    near(record.slice(1, 5), [x, y, right - x, bottom - y], 'head box');
  }
  const placement = accessoryPlacement(item, record);
  assert.equal(placement.view, item.views[facing], label + ' authored view');
  for (const mode of ['day', 'night']) assert.ok(fs.statSync(path.join(path.dirname(file), placement.view[mode])).size > 0, label + '/' + mode);
  if (item.fit.hideRear && record[0] > 1) assert.equal(placement.pieces.length, 0, label + ' rear occlusion');
  else assert.ok(placement.pieces.length > 0, label + ' visible placement');
  for (const p of placement.pieces) {
    assert.ok(Number.isFinite(p.scale) && p.scale > 0, label + ' positive uniform scale');
    const [w, h] = p.rect?.slice(2) ?? placement.view.size;
    assert.ok(p.dest[0] - p.origin[0] * p.scale >= -1e-8 && p.dest[1] - p.origin[1] * p.scale >= -1e-8, label + ' canvas start');
    assert.ok(p.dest[0] + (w - p.origin[0]) * p.scale <= 192 + 1e-8 && p.dest[1] + (h - p.origin[1]) * p.scale <= 288 + 1e-8, label + ' canvas end');
  }
}

function nativeFrameAnchors(meta) {
  const lm = meta.headLandmarks;
  return { head: lm.headCentre, neck: lm.neckPoint, headBox: lm.headBox,
    eyes: { line: lm.eyeLine }, earLeft: lm.earPoints.left, earRight: lm.earPoints.right,
    handLeft: meta.handLeft ?? meta.handAnchor ?? [0, 0], handRight: meta.handRight ?? meta.handAnchor ?? [192, 288] };
}
module.exports = { assertLazyAccessoryFrame, nativeFrameAnchors };
