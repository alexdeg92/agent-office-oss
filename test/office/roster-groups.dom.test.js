'use strict';
// With numbered floors, « Les présences » groups all agents by home floor and links each group to its scene.
// A small roster on one floor remains a flat list within its floor group.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { launch, findChrome } = require('./helpers/browser');

const skip = findChrome() ? false : 'no Chrome/Chromium binary (set CHROME_BIN)';
let browser;
before(async () => { if (!skip) browser = await launch(); });
after(async () => { await browser?.close(); });

describe('the roster grouped by floor (O10)', { skip, timeout: 120_000 }, () => {
  it('30 agents: floor groups have accurate counts and jump to the selected scene', async () => {
    const p = await browser.page('/public/v2/office/bureau-dev.html?tick=600000&nom=Orion&scenario=foule');
    await p.waitFor(`document.querySelectorAll('.ao-floor-roster__group').length >= 2`);
    const groups = await p.eval(`return [...document.querySelectorAll('.ao-floor-roster__group')].map(g=>({
      id:g.dataset.rosterFloor,count:Number.parseInt(g.querySelector('.ao-floor-roster__jump span:nth-child(2)').textContent,10),
      n:g.querySelectorAll('.ao-roster').length,allNamed:[...g.querySelectorAll('.ao-roster__name')].every(n=>n.textContent.trim()) }));`);
    assert.equal(groups.reduce((s,g)=>s+g.n,0),30,'everyone appears once');
    assert.ok(groups.every(g=>g.count===g.n&&g.allNamed));
    assert.ok(new Set(groups.map(g=>g.id)).size>=2);
    const floor = groups.at(-1).id;
    await p.eval(`document.querySelector('.ao-floor-roster__group[data-roster-floor="${floor}"] .ao-floor-roster__jump').click()`);
    await p.waitFor(`document.querySelector('.ao-bureau__stage')?.dataset.floor === ${JSON.stringify(floor)}`);
    assert.equal(await p.eval(`return new URLSearchParams(location.search).get('etage')`), floor === '1' ? null : floor);
    await p.close();
  });

  it('12 agents or fewer: the flat list', async () => {
    const p = await browser.page('/public/v2/office/bureau-dev.html?tick=600000&nom=Orion');
    await p.waitFor(`document.querySelectorAll('.ao-roster').length >= 1`);
    assert.equal(await p.eval(`return document.querySelectorAll('.ao-roster-group').length;`), 0);
    await p.close();
  });
});
