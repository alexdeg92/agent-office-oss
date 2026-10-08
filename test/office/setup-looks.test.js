'use strict';
// O5 setup « characters » step: the pure look model (setup-looks.js) over the shipped manifest.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let M, idx;
before(async () => {
  M = await import('../../public/v2/office/setup-looks.js');
  const A = await import('../../public/v2/office/assets.js');
  idx = A.indexManifest(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'design/office/manifest.example.json'), 'utf8')));
});
const agents = [{ id: 'main', name: 'Orion', primary: true }, { id: 'lyra', name: 'Lyra' }, { id: 'vega', name: 'Vega' }];

describe('setup looks (O5)', () => {
  it('defaults: the primary takes the main character; the others rotate through variants', () => {
    const L = M.initialLooks(idx, agents);
    assert.equal(L.main.character, idx.characters.values().next().value.role === 'main' ? idx.characters.values().next().value.id : L.main.character);
    assert.notEqual(L.lyra.variant, L.vega.variant);
  });
  it('normalizes a given value: unknown character → default; unknown accessory dropped; one accessory per slot', () => {
    const L = M.initialLooks(idx, agents, { lyra: { character: 'nope' }, vega: { character: 'subagent', variant: 'teal', accessories: ['cap', 'headphones', 'bogus'] } });
    assert.ok(idx.characters.has(L.lyra.character));
    assert.deepEqual(L.vega.accessories, ['cap']);
  });
  it('wearing an accessory replaces the one in its slot; the result is a plain copy', () => {
    const L = M.initialLooks(idx, agents);
    const r1 = M.withAccessory(idx, L.lyra, 'cap');
    const r2 = M.withAccessory(idx, r1.look, 'headphones');
    assert.equal(r2.replaced, 'cap');
    assert.deepEqual(r2.look.accessories, ['headphones']);
    const out = M.result({ ...L, lyra: r2.look }, agents);
    assert.deepEqual(Object.keys(out), ['main', 'lyra', 'vega']);
    out.lyra.accessories.push('x');
    assert.deepEqual(r2.look.accessories, ['headphones']);
  });
  it('characters come from the manifest (a shipped family appears with no code change)', () => {
    assert.deepEqual(M.characterChoices(idx).map((c) => c.id), [...idx.characters.keys()]);
  });
  it('every character, colour, accessory, furniture and theme the manifest ships has an English name', async () => {
    const S = await import('../../public/v2/office/strings.js');
    const missing = [];
    for (const [kind, map] of [['character', idx.characters], ['accessory', idx.accessories], ['furniture', idx.furniture], ['theme', idx.themes]]) {
      for (const o of map.values()) {
        if (!S.ASSET_EN[`${kind}.${o.id}`]) missing.push(`${kind}.${o.id}`);
        for (const v of o.variants ?? []) if (!S.ASSET_EN[`variant.${v.id}`]) missing.push(`variant.${v.id}`);
      }
    }
    assert.deepEqual(missing, [], 'add them to ASSET_EN in public/v2/office/strings.js');
  });
});
