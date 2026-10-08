'use strict';
// O9 in the Bureau (harness, scenario « foule »: 30 agents): the office fills its desks, the rest sit in annex rooms
// below it; every character is framed by its own stage; the roster lists all 30 with a desk; a click (or a tap) on
// an agent in an annex opens its card.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { launch, findChrome } = require('./helpers/browser');

const skip = findChrome() ? false : 'no Chrome/Chromium binary (set CHROME_BIN)';
let browser;
before(async () => { if (!skip) browser = await launch(); });
after(async () => { await browser?.close(); });

describe('30 agents in the Bureau (O9)', { skip, timeout: 120_000 }, () => {
  it('office + annexes seat everyone, framed, listed with a desk; an annex agent opens its card', async () => {
    const p = await browser.page('/public/v2/office/bureau-dev.html?tick=600000&nom=Orion&scenario=foule');
    await p.waitFor(`document.querySelectorAll('.ao-char').length >= 30 && document.querySelectorAll('.ao-bureau__annex').length >= 1`);
    await p.eval(`await new Promise((r) => setTimeout(r, 800));`);   // walks done, fit applied
    const r = await p.eval(`
      const stages = [...document.querySelectorAll('.bu-stage')].filter((s) => s.querySelector('.ao-viewport'));
      const per = stages.map((s) => {
        const b = s.getBoundingClientRect();
        const chars = [...s.querySelectorAll('.ao-char')];
        const out = chars.filter((c) => { const r = c.getBoundingClientRect(); return r.left < b.left - 1 || r.right > b.right + 1 || r.top < b.top - 1 || r.bottom > b.bottom + 1; });
        return { n: chars.length, out: out.map((c) => c.dataset.occupant) };
      });
      const ids = [...document.querySelectorAll('.ao-char')].map((c) => c.dataset.occupant);
      return { per, unique: new Set(ids).size, total: ids.length,
        titles: [...document.querySelectorAll('.ao-bureau__annex h3')].map((h) => h.textContent),
        roster: [...document.querySelectorAll('.ao-roster')].map((b) => b.innerText.replace(/\\n/g, ' | ')),
        hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth };`);
    assert.equal(r.total, 30); assert.equal(r.unique, 30, 'each agent in one room');
    assert.ok(r.per.length >= 2, 'office and at least one annex');
    assert.ok(r.per.slice(1).every((s) => s.n <= 12), 'an annex seats 12 at most');
    for (const s of r.per) assert.deepEqual(s.out, [], 'every character inside its stage (fit)');
    assert.match(r.titles[0], /^Annexe 1 · \d+ agents$/);
    assert.equal(r.roster.length, 30);
    assert.ok(r.roster.every((t) => !/sans poste/.test(t)), r.roster.find((t) => /sans poste/.test(t)));
    assert.equal(r.hscroll, false, 'no horizontal overflow');
    // a room below the fold is paused like a hidden tab (no frame loops, no CSS animation) and resumes in view
    const paused = await p.eval(`const st = [...document.querySelectorAll('.ao-bureau__annex .ao-office')].pop();
      window.scrollTo(0, 0); await new Promise((r) => setTimeout(r, 300)); const off = st.hasAttribute('data-paused');
      st.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 300)); const on = st.hasAttribute('data-paused');
      window.scrollTo(0, 0); await new Promise((r) => setTimeout(r, 300)); return { off, on, office: document.querySelector('.ao-office:not(.ao-bureau__annexstage)').hasAttribute('data-paused') };`);
    assert.deepEqual(paused, { off: true, on: false, office: false });
    // drawn small (a phone), a crowded room's plates shrink to their dot; a selected one shows its name; names stay whole
    const compact = await p.eval(`const a = document.querySelector('.ao-bureau__annex'); const st = a.querySelector('.ao-office');
      const wide = st.hasAttribute('data-plates-compact');
      a.style.width = '340px'; await new Promise((r) => setTimeout(r, 300));
      const plates = [...st.querySelectorAll('.ao-plate')];
      const out = { wide, small: st.hasAttribute('data-plates-compact'), hiddenNames: plates.filter((pl) => getComputedStyle(pl.querySelector('.ao-plate__name')).display === 'none').length,
        n: plates.length, labels: plates.every((pl) => /^Agent \\d+, /.test(pl.getAttribute('aria-label'))) };
      plates[0].setAttribute('aria-current', 'true'); out.selectedName = getComputedStyle(plates[0].querySelector('.ao-plate__name')).display !== 'none';
      plates[0].removeAttribute('aria-current'); a.style.width = ''; await new Promise((r) => setTimeout(r, 300));
      out.back = st.hasAttribute('data-plates-compact'); return out;`);
    assert.deepEqual(compact, { wide: false, small: true, hiddenNames: 12, n: 12, labels: true, selectedName: true, back: false });
    // a click on an agent in the last annex opens its card
    const who = await p.eval(`const a = [...document.querySelectorAll('.ao-bureau__annex')].pop();
      a.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 200));
      const c = a.querySelector('.ao-char'); const b = c.getBoundingClientRect();
      const at = { clientX: b.left + b.width / 2, clientY: b.top + b.height * 0.6, pointerId: 7, pointerType: 'mouse', bubbles: true, button: 0 };
      const vp = a.querySelector('.ao-viewport');
      vp.dispatchEvent(new PointerEvent('pointerdown', at)); vp.dispatchEvent(new PointerEvent('pointerup', at));
      return c.dataset.occupant;`);
    await p.waitFor(`document.querySelector('.bu-drawer #ao-drawer-title')`);
    const card = await p.eval(`return document.querySelector('#ao-drawer-title').innerText;`);
    assert.match(card, /^Agent \d+$/, `${who} → ${card}`);
    await p.close();
  });
});
