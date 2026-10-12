'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { launch, findChrome } = require('./helpers/browser');
const { listMigrations } = require('../../src/store/db');
const { createOfficeRepo } = require('../../src/store/repos/office');
const { indexManifest } = require('../../public/v2/office/assets.js');
const { resolveOccupants } = require('../../public/v2/office/layout-rules.js');
const manifest = require('../../design/office/manifest.example.json');
const layout = require('../../design/office/layout.example.json');

test('persisted automatic looks: scene, roster and editor agree; owner edit saves; desktop/mobile captures', { skip: !findChrome(), timeout: 120000 }, async () => {
  const db = new DatabaseSync(':memory:');
  for (const m of listMigrations()) db.exec(m.sql);
  const repo = createOfficeRepo(db);
  const browser = await launch();
  const out = process.env.AO_LOOKS_CAPTURE_DIR;
  if (out) fs.mkdirSync(out, { recursive: true });
  try {
    const p = await browser.page('/public/v2/office/bureau-dev.html?tick=600000&nom=Atlas&scenario=foule');
    await p.waitFor('window.officeBench && document.querySelectorAll(".ao-roster").length === 30');
    const occupants = await p.eval('return (await officeBench.om.officeVM()).occupants;');
    const resolved = resolveOccupants(layout, indexManifest(manifest), occupants.map(o => ({ ...o, sourceName: o.name,
      appearanceId: o.role === 'main' || o.role === 'primary' ? 'agent:atlas' : o.id })), { assignLook: (id, idx, opts) => repo.automaticLook(id, idx, opts) });
    const assignments = Object.fromEntries(resolved.map(o => [o.id, { look: o.look, automaticLook: o.automaticLook }]));
    const showFloorFor = async id => {
      const floor = await p.eval(`return document.querySelector('.ao-roster[data-occupant='+CSS.escape(${JSON.stringify(id)})+']')?.closest('.ao-floor-roster__group')?.dataset.rosterFloor || '1'`);
      await p.eval(`officeBench.services.router.setQuery({ etage: ${JSON.stringify(floor)}, agent: null });`);
      await p.waitFor(`document.querySelector('.ao-bureau__stage')?.dataset.floor === ${JSON.stringify(floor)}`);
    };
    await p.eval(`const B = officeBench, original = B.om.officeVM.bind(B.om), looks = ${JSON.stringify(assignments)};
      const { resolveOccupants } = await import('/public/v2/office/layout-rules.js');
      const { indexManifest } = await import('/public/v2/office/assets.js');
      B.om.officeVM = async () => { const vm = await original(), L = B.om.layoutVM();
        const resolved = resolveOccupants(L.layout.data, indexManifest(L.manifest), vm.occupants.map(o=>({...o,sourceName:o.name,automaticLook:looks[o.id].automaticLook})));
        vm.occupants.forEach((o,i)=>Object.assign(o,{look:resolved[i].look,automaticLook:resolved[i].automaticLook})); return vm; };
      B.om.externalEdit(d=>{d.theme={mode:'fixed',fixed:'day'}}); await B.publish('layout'); await B.publish('office');`);
    for (const o of resolved) {
      await showFloorFor(o.id);
      const ch = indexManifest(manifest).characters.get(o.look.character), v = ch.variants?.find(v => v.id === o.look.variant);
      const pose = v?.poses?.idle ?? ch.poses.idle;
      const portrait = v?.portrait ?? v?.thumbnail ?? (v ? null : ch.portrait ?? ch.thumbnail) ?? (typeof pose === 'string' ? pose : pose.image);
      const posePath = typeof pose === 'string' ? pose : pose.image;
      const directory = ch.packManifest ? 'assets/Characters/' + ch.id + '/' + o.look.variant + '/' : posePath.slice(0, posePath.lastIndexOf('/') + 1);
      await p.waitFor(`document.querySelector('.ao-char[data-occupant='+CSS.escape(${JSON.stringify(o.id)})+'] [data-layer=body][src*=${JSON.stringify(directory)}]')?.naturalWidth > 0`);
      await p.waitFor(`document.querySelector('.ao-roster[data-occupant='+CSS.escape(${JSON.stringify(o.id)})+'] .bu-avatar img')?.getAttribute('src').includes(${JSON.stringify(portrait)})`);
      assert.ok(await p.eval(`return document.querySelector('.ao-roster[data-occupant='+CSS.escape(${JSON.stringify(o.id)})+'] .bu-avatar img').getAttribute('src').includes(${JSON.stringify(portrait)});`), 'same family and variant in roster: ' + o.id);
    }
    if (out) {
      await p.viewport(1440, 1000);
      await p.waitFor('[...document.querySelectorAll(".ao-bureau__stagewrap .ao-char [data-layer=body]")].every(img=>img.complete && img.naturalWidth>0)');
      fs.writeFileSync(path.join(out, 'desktop-day.png'), await p.screenshot());
      fs.writeFileSync(path.join(out, 'assignments.json'), JSON.stringify(resolved.map(o => ({ id: o.id, name: o.name, look: o.look })), null, 2));
    }
    const target = resolved.find(o => o.role !== 'main' && o.role !== 'primary');
    const targetName = occupants.find(o => o.id === target.id).name;
    await showFloorFor(target.id);
    await p.waitFor(`document.querySelector('.ao-controls [data-page-control]')`);
    await p.eval(`document.querySelector('.ao-controls [data-page-control]').click(); await officeBench.until(()=>document.querySelector('.ao-editbar'));
      [...document.querySelectorAll('.ao-editbar .bu-segmented__opt')].find(b=>b.textContent==='Personnages').click();`);
    await p.waitFor('document.querySelector(".ao-sc__list")');
    await p.eval(`[...document.querySelectorAll('.ao-sc__agent')].find(b=>b.querySelector('.ao-sc__name').textContent===${JSON.stringify(targetName)}).click();`);
    await p.waitFor(`document.querySelector('#ao-sc-editing').textContent.endsWith(${JSON.stringify(targetName)})`);
    assert.equal(await p.eval(`return document.querySelector('.ao-editpanel .ao-sc__card input:checked').value;`), target.look.character, 'editor starts with the same persisted family');
    await p.eval(`document.querySelector('.ao-editpanel .ao-sc__card input[value="fen"]').click();`);
    await p.waitFor('document.querySelector(".ao-editpanel .ao-sc__card input[value=fen]").checked');
    await p.eval(`document.querySelector('.ao-editbar .bu-btn--primary').click();`);
    await p.waitFor('!document.querySelector(".ao-editbar")');
    await p.waitFor(`document.querySelector('.ao-char[data-occupant='+CSS.escape(${JSON.stringify(target.id)})+'] [data-layer=body][src*="/fen/"]')?.naturalWidth > 0`);
    assert.equal(await p.eval(`return document.querySelector('.ao-bureau__stage')?.dataset.floor`), await p.eval(`return new URLSearchParams(location.search).get('etage') || '1'`), 'the scene remains on the edited agent’s floor');
    const rule = await p.eval(`return officeBench.om.layoutVM().layout.data.agents.find(a=>a.agentId===${JSON.stringify(target.id)});`);
    assert.equal(rule.appearance, 'manual');
    assert.equal(rule.character, 'fen');
    if (out) {
      await p.viewport(390, 860);
      await p.eval('scrollTo(0,0);');
      fs.writeFileSync(path.join(out, 'mobile-day.png'), await p.screenshot());
      await p.eval(`officeBench.om.externalEdit(d=>{d.theme={mode:'fixed',fixed:'night'}}); await officeBench.publish('layout');`);
      await p.waitFor('document.querySelector(".ao-shell[src*=night]")?.complete && [...document.querySelectorAll(".ao-bureau__stagewrap img")].every(img=>img.complete && img.naturalWidth>0)');
      fs.writeFileSync(path.join(out, 'mobile-night.png'), await p.screenshot());
    }
    assert.deepEqual(p.logs, []);
  } finally { await browser.close(); db.close(); }
});
