'use strict';
// O9: the whole roster is represented across registered floors; only the selected floor is mounted in the scene.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { launch, findChrome } = require('./helpers/browser');

const skip = findChrome() ? false : 'no Chrome/Chromium binary (set CHROME_BIN)';
let browser;
before(async () => { if (!skip) browser = await launch(); });
after(async () => { await browser?.close(); });

describe('30 agents across Bureau floors (O9)', { skip, timeout: 120_000 }, () => {
  it('lists everyone once by home floor and opens an off-floor agent on that floor', async () => {
    const p = await browser.page('/public/v2/office/bureau-dev.html?tick=600000&nom=Orion&scenario=foule');
    await p.waitFor(`document.querySelectorAll('.ao-roster').length === 30 && document.querySelectorAll('.ao-floor-picker__floor').length >= 2`);
    const initial = await p.eval(`const groups=[...document.querySelectorAll('.ao-floor-roster__group')];
      const picker=[...document.querySelectorAll('.ao-floor-picker__floor')];
      return { groups:groups.map(g=>({id:g.dataset.rosterFloor,n:g.querySelectorAll('.ao-roster').length})),
        picker:picker.map(b=>({id:b.dataset.floor,n:Number.parseInt(b.querySelector('.ao-floor-picker__count').textContent,10)})),
        total:document.querySelectorAll('.ao-roster').length, floor:document.querySelector('.ao-bureau__stage').dataset.floor,
        hscroll:document.documentElement.scrollWidth>document.documentElement.clientWidth };`);
    assert.equal(initial.total, 30);
    assert.ok(initial.groups.length >= 2, 'occupants are grouped by floor');
    assert.equal(initial.groups.reduce((n,g)=>n+g.n,0),30,'everyone appears in one roster group');
    assert.equal(initial.picker.reduce((n,f)=>n+f.n,0),30,'floor picker counts every occupant');
    assert.equal(initial.hscroll,false,'no horizontal overflow');

    const target = await p.eval(`const cards=[...document.querySelectorAll('.ao-roster')]; const card=cards.at(-1);
      const floor=card.closest('[data-roster-floor]').dataset.rosterFloor; const id=card.dataset.occupant; card.click(); return {floor,id};`);
    await p.waitFor(`document.querySelector('.ao-bureau__stage')?.dataset.floor === ${JSON.stringify(target.floor)} && document.querySelector('.ao-char[data-occupant='+CSS.escape(${JSON.stringify(target.id)})+']')`);
    await p.waitFor(`document.querySelector('.bu-drawer #ao-drawer-title')`);
    assert.equal(await p.eval(`return new URLSearchParams(location.search).get('etage')`), target.floor === '1' ? null : target.floor);
    assert.equal(await p.eval(`return document.querySelector('.ao-char[data-occupant='+CSS.escape(${JSON.stringify(target.id)})+']')?.dataset.occupant`), target.id);
    assert.deepEqual(p.logs.filter(l=>/Unhandled|EXC/.test(l)),[]);
    await p.close();
  });
});
