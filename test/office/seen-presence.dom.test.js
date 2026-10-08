'use strict';
// O8 in the Bureau (harness, contract 3.0): an agent that leaves the stage stays greyed at its desk with « vu il y a X »
// (plate, tooltip, roster), not on 2.x; turning presence off in the editor's Thème tab walks it out.
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
  it('3.0: Scout, gone from the stage, stays greyed with « Vu il y a … » (plate, tooltip, roster)', async () => {
    const p = await page('api=3');
    const r = await p.eval(`${U}(() => document.querySelector('.ao-char[data-presence="seen"]'));
      const plate = document.querySelector('.ao-plate[data-presence="seen"]');
      const row = document.querySelector('.ao-roster[data-presence="seen"]');
      return { char: document.querySelector('.ao-char[data-presence="seen"]').dataset.occupant, label: plate.getAttribute('aria-label'), title: plate.title,
        row: row.innerText.replace(/\\n/g, ' | '), grey: getComputedStyle(document.querySelector('.ao-char[data-presence="seen"]')).opacity, headline: document.querySelector('.ao-bureau__lead').innerText };`);
    assert.equal(r.char, 'subagent:scout');
    assert.match(r.label, /^Scout, Vu il y a /);
    assert.match(r.title, /^Vu il y a /);
    assert.match(r.row, /Scout .*Vu il y a /);
    assert.ok(Number(r.grey) < 0.8, 'greyed');
    assert.doesNotMatch(r.headline, /Scout/, 'the headline speaks of the stage only');
    await p.close();
  });

  it('2.x: no seen agents (the inventory is a 3.0 feature)', async () => {
    const p = await page('');
    await p.eval(`await new Promise((r) => setTimeout(r, 400));`);
    assert.equal(await p.eval(`return document.querySelectorAll('[data-presence="seen"]').length;`), 0);
    await p.close();
  });

  it('turning presence off in the editor (Thème) and saving walks the seen agent out', async () => {
    const p = await page('api=3');
    await p.eval(`${U}(() => document.querySelector('.ao-char[data-presence="seen"]'));
      document.querySelector('.ao-controls [data-page-control]').click();
      ${U}(() => document.querySelector('.ao-editbar'));
      [...document.querySelectorAll('.ao-editbar .bu-segmented__opt')].find((b) => b.textContent === 'Thème').click();
      const sel = await window.officeBench.until(() => [...document.querySelectorAll('.ao-editpanel label.bu-field')].find((l) => l.textContent.includes('Agents vus récemment'))?.querySelector('select'));
      sel.value = '0'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      ${U}(() => document.querySelector('.ao-editbar .bu-chip'));
      document.querySelector('.ao-editbar .bu-btn--primary').click();
      ${U}(() => !document.querySelector('.ao-editbar'));`);
    const r = await p.eval(`${U}(() => !document.querySelector('[data-presence="seen"]'));
      return { presence: window.officeBench.om.layoutVM().layout.data.presence, roster: [...document.querySelectorAll('.ao-roster__name')].map((n) => n.textContent) };`);
    assert.deepEqual(r.presence, { seenMinutes: 0 });
    assert.ok(!r.roster.includes('Scout'));
    await p.close();
  });
});
