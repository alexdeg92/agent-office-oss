'use strict';
// office-dev-21 · the Boutique's pure parts: the catalog (tabs and items from the manifest, badges), agent looks
// (rows, patch, effective looks) and the draft (undo/redo, save, 409).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { indexManifest } = require(path.join(ROOT, 'public/v2/office/assets.js'));
const C = require(path.join(ROOT, 'public/v2/office/catalog.js'));
const A = require(path.join(ROOT, 'public/v2/office/agent-looks.js'));
const { createDraft } = require(path.join(ROOT, 'public/v2/office/draft.js'));
const R = require(path.join(ROOT, 'public/v2/office/layout-rules.js'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/manifest.example.json'), 'utf8'));
const layout = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/layout.example.json'), 'utf8'));
const idx = indexManifest(manifest);
const live = [{ id: 'main', role: 'main', name: 'Orion' }, { id: 'subagent:scout', role: 'subagent', name: 'Scout' }];
const rows = A.agentRows(layout, live, [], (id) => 'rule ' + id);

describe('Boutique catalog (office-dev-21)', () => {
  it('every furniture asset is in exactly one of Mobilier / Décoration, from the manifest; counts are the office copies', () => {
    const mob = C.furnitureItems(idx, layout, 'mobilier'), deco = C.furnitureItems(idx, layout, 'decoration');
    assert.equal(mob.length + deco.length, manifest.furniture.length);
    assert.ok(mob.some((x) => x.id === 'desk') && mob.some((x) => x.id === 'sofa'));
    assert.ok(deco.some((x) => x.id === 'plant-large') && deco.some((x) => x.id === 'window'));
    assert.equal(mob.find((x) => x.id === 'desk').count, layout.items.filter((i) => i.asset === 'desk').length);
    assert.equal(C.tabOfCategory('something-new'), 'decoration', 'an unknown category still shows up');
    // a new asset in the manifest appears with no code change
    const m2 = structuredClone(manifest); m2.furniture.push({ ...manifest.furniture.find((f) => f.id === 'lamp'), id: 'lamp-2', label: 'Lampe 2' });
    assert.ok(C.furnitureItems(indexManifest(m2), layout, 'decoration').some((x) => x.id === 'lamp-2'));
  });

  it('characters, colours and accessories are built for the chosen agent, with « worn by » badges', () => {
    const looks = A.looksOf(layout, idx, rows);
    const scout = looks['subagent:scout'];
    const chars = C.characterItems(idx, scout, rows, looks);
    assert.deepEqual(chars.map((c) => c.id), manifest.characters.map((c) => c.id));
    assert.equal(chars.filter((c) => c.on).length, 1);
    assert.ok(chars.find((c) => c.id === scout.character).wornBy.includes('subagent:scout'));
    const colours = C.colourItems(idx, scout, rows, looks);
    assert.ok(colours.length >= 2 && colours.every((c) => c.look.variant === c.id));
    const acc = C.accessoryItems(idx, scout, rows, looks);
    assert.deepEqual(acc.map((a) => a.id), manifest.accessories.map((a) => a.id));
    const cap = acc.find((a) => a.id === 'cap');
    assert.ok(cap.toggled.accessories.includes('cap') !== cap.on, 'trying it toggles it');
    assert.deepEqual(C.themeChoices(idx).seasons.map((s) => s.id), manifest.themes.filter((t) => t.kind === 'season').map((t) => t.id));
  });

  it('applying a look writes the agent rule (created from the resolved look); gear equal to the defaults stays « default »', () => {
    const row = rows.find((r) => r.id === 'subagent:scout');
    const looks = A.looksOf(layout, idx, rows);
    const want = C.accessoryItems(idx, looks[row.id], rows, looks).find((a) => a.id === 'scarf').toggled;
    const next = A.patchAgent(layout, idx, row, A.lookPatch(idx, want));
    assert.deepEqual(R.validateLayout(next, idx), []);
    assert.deepEqual(A.looksOf(next, idx, rows)[row.id].accessories.includes('scarf'), true);
    const back = A.patchAgent(next, idx, row, A.lookPatch(idx, looks[row.id]));
    assert.equal(back.agents.find((a) => a.agentId === row.id).accessories, undefined, 'back to the colour defaults');
  });

  it('the draft: undo/redo, a counted change, save (revision), and a 409 kept for « Recharger »', async () => {
    const vm = { manifest, layout: { revision: 3, data: layout } };
    let fail = false;
    const store = { put: async (body) => { if (fail) throw { error: { code: 'conflict', current: { revision: 9, vm: { ...vm, layout: { revision: 9, data: layout } } } } }; return { revision: body.expectedRevision + 1 }; } };
    const d = createDraft(vm, idx, store);
    assert.equal(d.dirty, false);
    const added = { ...layout, items: [...layout.items, { uid: 'p9', asset: 'plant-small', x: 1, y: 8 }] };
    d.commit(added, 'placed');
    assert.equal(d.dirty, true); assert.equal(d.count, 1); assert.equal(d.announcement, 'placed');
    d.undo(); assert.equal(d.dirty, false); d.redo(); assert.equal(d.dirty, true);
    const r = await d.save();
    assert.deepEqual([r.ok, r.revision, d.dirty, d.count], [true, 4, false, 0]);
    d.commit(layout); fail = true;
    const c = await d.save();
    assert.equal(c.conflict, true); assert.equal(d.conflict.revision, 9); assert.equal(d.dirty, true, 'the draft is kept');
    d.reloadFromConflict();
    assert.deepEqual([d.vm.layout.revision, d.dirty, d.conflict], [9, false, null]);
  });
});
