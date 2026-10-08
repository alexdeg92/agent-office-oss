'use strict';
// O10: past 12 agents, « Les présences » is grouped by state (en erreur, en attente, actifs, inactifs) with counts;
// errors open, the rest collapsed; a group opens for the selected agent; the reader's own toggles hold across updates.
// 12 or fewer: the flat list, as before.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { launch, findChrome } = require('./helpers/browser');

const skip = findChrome() ? false : 'no Chrome/Chromium binary (set CHROME_BIN)';
let browser;
before(async () => { if (!skip) browser = await launch(); });
after(async () => { await browser?.close(); });

const groups = `return [...document.querySelectorAll('.ao-roster-group')].map((g) => ({ id: g.dataset.group, open: g.open,
  n: g.querySelectorAll('.ao-roster').length, count: Number(g.querySelector('.ao-roster-group__count').innerText),
  sr: g.querySelector('summary .bu-sr-only').textContent, states: [...g.querySelectorAll('.ao-roster__state')].map((s) => s.dataset.agentState) }));`;

describe('the roster grouped by state (O10)', { skip, timeout: 120_000 }, () => {
  it('30 agents: four groups with counts, errors open, the rest collapsed; selection and toggles', async () => {
    const p = await browser.page('/public/v2/office/bureau-dev.html?tick=600000&nom=Orion&scenario=foule');
    await p.waitFor(`document.querySelectorAll('.ao-roster-group').length >= 3`);
    const g = await p.eval(groups);
    assert.deepEqual(g.map((x) => x.id), ['error', 'waiting', 'active', 'inactive']);
    assert.deepEqual(g.map((x) => x.open), [true, false, false, false]);
    assert.equal(g.reduce((s, x) => s + x.n, 0), 30, 'everyone listed once');
    for (const x of g) { assert.equal(x.count, x.n); assert.equal(x.sr, `${x.n} agents`); }
    assert.ok(g[0].states.every((s) => s === 'error'));
    assert.ok(g[1].states.every((s) => s === 'waiting'));
    assert.ok(g[2].states.every((s) => !['error', 'waiting', 'idle', 'offline'].includes(s)));
    assert.equal(await p.eval(`return document.querySelector('.ao-roster-group__head').innerText.split('\\n')[0];`), 'En erreur');
    // selecting an active agent (from the scene) opens its group
    await p.eval(`const B = window.officeBench; const o = (await B.om.officeVM()).occupants.find((x) => x.state === 'working' && x.id !== 'main');
      B.services.router.setQuery({ agent: o.id }); await new Promise((r) => setTimeout(r, 300));`);
    assert.equal(await p.eval(`return document.querySelector('.ao-roster-group[data-group="active"]').open;`), true, 'the selected agent’s group opens');
    // the reader closes errors (keyboard on the summary): it stays closed across live updates
    await p.eval(`window.officeBench.services.router.setQuery({ agent: null }); await new Promise((r) => setTimeout(r, 300));
      document.querySelector('.ao-roster-group[data-group="error"] summary').focus();`);
    await p.key('Enter');
    await p.eval(`const B = window.officeBench; for (let i = 0; i < 3; i++) { B.om.tick(); await B.publish('office'); await new Promise((r) => setTimeout(r, 150)); }`);
    assert.equal(await p.eval(`return document.querySelector('.ao-roster-group[data-group="error"]').open;`), false);
    await p.close();
  });

  it('12 agents or fewer: the flat list', async () => {
    const p = await browser.page('/public/v2/office/bureau-dev.html?tick=600000&nom=Orion');
    await p.waitFor(`document.querySelectorAll('.ao-roster').length >= 1`);
    assert.equal(await p.eval(`return document.querySelectorAll('.ao-roster-group').length;`), 0);
    await p.close();
  });
});
