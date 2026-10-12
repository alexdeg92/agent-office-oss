'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const { readDecorManifest, validateDecorPack, requireDecorRegistry } = require('../../packaging/decor-pack-registry');
const { checkDecorPack, decorDescriptors, installDecorPack, DECOR_BUDGETS } = require('../../public/v2/office/decor-packs');
const { indexManifest } = require('../../public/v2/office/assets');
const { findFreeSpot, addItem, checkPlacement, validateLayout } = require('../../public/v2/office/editor-model');
const dir = path.join(ROOT, 'design/assets/Decor/style-preview');
const { pack, metadataBytes } = readDecorManifest(path.join(dir, 'manifest.json'));
const base = 'assets/Decor/style-preview/';

test('six-item style pack admits all actual day/night sprites and thumbnails within unchanged budgets', () => {
  const result = validateDecorPack(pack, dir, metadataBytes);
  assert.deepEqual(result.errors, []); assert.ok(result.ok);
  assert.equal(pack.items.length, 6); assert.equal(result.files, 18);
  assert.ok(result.bytes < DECOR_BUDGETS.pack);
});
test('pack manifest rejects escaping paths, missing night/rotation art, duplicate ids and oversize metadata', () => {
  for (const mutate of [p => { p.items[0].image = '../escape.webp'; }, p => { delete p.items[0].images['sw@night']; }, p => { p.items[0].orientations.push('se'); }, p => { p.items[1].id = p.items[0].id; }]) {
    const bad = structuredClone(pack); mutate(bad); assert.equal(checkDecorPack(bad).ok, false);
  }
  assert.equal(checkDecorPack(pack, { metadataBytes: DECOR_BUDGETS.metadata + 1 }).ok, false);
  assert.throws(() => requireDecorRegistry(path.dirname(dir), ['style-preview','style-preview']), /unique/);
  assert.throws(() => requireDecorRegistry(path.dirname(dir), ['style-preview'], [pack.items[0].id]), /duplicate/);
});
test('registry remains thumbnail-only and installation validates all geometry before mutating any item', () => {
  const descriptors = decorDescriptors(pack, base);
  assert.ok(descriptors.every(f => f.image === f.thumbnail && !f.images && !f.provenance));
  const index = { furniture: new Map(descriptors.map(f => [f.id, f])) };
  assert.throws(() => installDecorPack(index, {...pack,items:pack.items.slice(1)}, base), /membership mismatch/);
  const bad = structuredClone(pack); bad.items.at(-1).anchor.x++;
  assert.throws(() => installDecorPack(index, bad, base), /geometry mismatch/);
  assert.ok([...index.furniture.values()].every(f => !f.packLoaded));
  installDecorPack(index, pack, base);
  assert.ok([...index.furniture.values()].every(f => f.packLoaded && f.images['sw@night'].startsWith(base)));
});
test('every style item fits and validates in the existing layout; floor and wall footprints collide', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT,'design/office/manifest.example.json')));
  const layout = JSON.parse(fs.readFileSync(path.join(ROOT,'design/office/layout.example.json')));
  manifest.furniture.push(...decorDescriptors(pack, base));
  const index = indexManifest(manifest);
  for (const f of pack.items) {
    const spot = findFreeSpot(layout, index, { asset:f.id }); assert.ok(spot, f.id);
    const added = addItem(layout, spot).layout;
    assert.deepEqual(validateLayout(added,index), [], f.id);
    assert.equal(checkPlacement(added,index,{...spot,uid:'second'}).ok,false,f.id);
    const outside = f.placement === 'wall' ? {...spot,offset:100} : {...spot,x:100};
    assert.equal(checkPlacement(layout,index,outside).ok,false,f.id);
    if (f.placement !== 'wall') assert.equal(checkPlacement(layout,index,{...spot,orientation:'se'}).code,'orientation',f.id);
  }
});
