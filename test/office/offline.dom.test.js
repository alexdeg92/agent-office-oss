'use strict';
// R27-02 (office side): with the stream retrying or offline, the Bureau is not live. The headline is the stale one,
// the roster has no live colours, and the selected floor scene freezes (paused, dimmed) under « Hors ligne depuis X ».
// Back online, everything resumes.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { launch, findChrome } = require('./helpers/browser');

const skip = findChrome() ? false : 'no Chrome/Chromium binary (set CHROME_BIN)';
let browser;
before(async () => { if (!skip) browser = await launch(); });
after(async () => { await browser?.close(); });

const read = `const st = document.querySelector('.ao-bureau__stage');
  const scenes = [...document.querySelectorAll('.ao-office')];
  return { kind: document.querySelector('.ao-bureau__lead').dataset.kind, live: document.querySelectorAll('.ao-roster__state--live').length,
    frozen: scenes.map((s) => s.hasAttribute('data-frozen') && s.hasAttribute('data-paused')), dim: getComputedStyle(st).filter !== 'none',
    connection: window.officeBench.services.stream.status.get().conn,
    sourceMarkers: document.querySelectorAll('.ao-agentcard[data-source-stale]').length,
    chip: document.querySelector('.ao-bureau__stagecap')?.innerText ?? null,
    chipOnTop: (() => { const c = document.querySelector('.ao-bureau__stagecap'); if (!c) return null; c.scrollIntoView({ block: 'center' }); c.style.pointerEvents = 'auto';
      const b = c.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + 4, b.top + b.height / 2); c.style.pointerEvents = ''; return c.contains(hit); })(), label: st.getAttribute('aria-label') };`;

describe('the Bureau when the stream is down (R27-02)', { skip, timeout: 120_000 }, () => {
  for (const conn of ['retrying', 'offline']) {
    it(`${conn}: stale headline, no live colours, frozen and dimmed selected floor, « Hors ligne depuis … »`, async () => {
      const p = await browser.page(`/public/v2/office/bureau-dev.html?tick=600000&nom=Orion&scenario=foule&conn=${conn}`);
      await p.waitFor(`document.querySelectorAll('.ao-roster').length >= 30 && document.querySelector('.ao-bureau__stage.ao-office')`);
      const r = await p.eval(read);
      assert.equal(r.kind, 'stale');
      assert.equal(r.live, 0);
      assert.ok(r.frozen.length >= 1 && r.frozen.every(Boolean), JSON.stringify(r.frozen));
      assert.ok(r.dim);
      assert.match(r.chip, /^Hors ligne depuis (une minute|1 minute|2 minutes)$/);
      assert.match(r.label, /dernier état observé/);
      assert.equal(r.chipOnTop, true, 'the chip is painted above the stage');
      // back online: live again
      const back = await p.eval(`const S = window.officeBench.services.stream.status; S.set({ ...S.get(), conn: 'open' });
        await new Promise((r) => setTimeout(r, 300)); ${read}`);
      assert.notEqual(back.kind, 'stale');
      assert.ok(back.live > 0);
      assert.ok(back.frozen.every((f) => !f), JSON.stringify(back.frozen));
      assert.equal(back.chip, null);
      await p.close();
    });
  }

  it('a stale secondary source marks its own agents while the live stream and scene continue', async () => {
    const p = await browser.page('/public/v2/office/bureau-dev.html?scenario=1&stale=transcripts&tick=600000');
    await p.waitFor("document.querySelectorAll('.ao-char').length >= 1 && document.querySelector('.ao-agentcard[data-source-stale]')");
    const r = await p.eval(read);
    assert.notEqual(r.kind, 'stale');
    assert.equal(r.connection, 'open');
    assert.ok(r.frozen.every(f => !f), JSON.stringify(r.frozen));
    assert.equal(r.dim, false);
    assert.ok(r.sourceMarkers > 0);
    assert.equal(r.chip, null);
    await p.close();
  });
});
