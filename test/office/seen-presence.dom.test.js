'use strict';
// Historical agent inventory must never create occupants in the Bureau scene or roster.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { launch, findChrome } = require('./helpers/browser');

const skip = findChrome() ? false : 'no Chrome/Chromium binary (set CHROME_BIN)';
let browser;
before(async () => { if (!skip) browser = await launch(); });
after(async () => { await browser?.close(); });

const U = 'await window.officeBench.until';
// Advance the script until Scout has left the stage (step 7), publishing both topics as the server would.
async function page(query) {
  const p = await browser.page(`/public/v2/office/bureau-dev.html?tick=600000&nom=Orion&${query}`);
  await p.waitFor(`document.querySelectorAll('.ao-plate').length >= 1`);
  // advance until Scout has been on stage and has left it (the script's step 8), publishing both topics like the server
  await p.eval(`const B = window.officeBench;
    const gone = async () => !(await B.om.officeVM()).occupants.some((o) => /scout/.test(o.id)) && B.om.layoutVM().agentsSeen.some((a) => /scout/.test(a.id));
    for (let i = 0; i < 14 && !(await gone()); i++) { B.om.tick(); await B.publish('office'); await B.publish('layout'); }`);
  return p;
}

describe('seen-agent presence in the Bureau (O8)', { skip, timeout: 120_000 }, () => {
  it('3.0: a historical Scout remains in the inventory but never returns to the stage or roster', async () => {
    const p = await page('api=3');
    const r = await p.eval(`${U}(() => !document.querySelector('.ao-char[data-occupant="subagent:scout"]'));
      return { chars: document.querySelectorAll('.ao-char[data-occupant="subagent:scout"]').length,
        plates: document.querySelectorAll('.ao-plate[data-occupant="subagent:scout"]').length,
        roster: [...document.querySelectorAll('.ao-roster__name')].map(node => node.textContent),
        inventory: window.officeBench.om.layoutVM().agentsSeen.some(row => row.id === 'subagent:scout') };`);
    assert.equal(r.inventory, true, 'history remains available for editing');
    assert.equal(r.chars, 0); assert.equal(r.plates, 0);
    assert.ok(!r.roster.includes('Scout'));
    await p.close();
  });

  it('2.x: no seen agents (the inventory is a 3.0 feature)', async () => {
    const p = await page('');
    await p.eval(`await new Promise((r) => setTimeout(r, 400));`);
    assert.equal(await p.eval(`return document.querySelectorAll('[data-presence="seen"]').length;`), 0);
    await p.close();
  });

  it('the theme editor no longer offers a misleading historical-presence control', async () => {
    const p = await page('api=3');
    await p.eval(`${U}(() => document.querySelector('.ao-controls [data-page-control]'));
      document.querySelector('.ao-controls [data-page-control]').click();
      ${U}(() => document.querySelector('.ao-editbar'));
      [...document.querySelectorAll('.ao-editbar .bu-segmented__opt')].find((b) => b.textContent === 'Thème').click();
      ${U}(() => document.querySelector('.ao-editpanel'));
      return document.querySelector('.ao-editpanel').innerText;`);
    assert.doesNotMatch(await p.eval('return document.querySelector(".ao-editpanel").innerText;'), /Agents vus récemment/i);
    await p.close();
  });
});
