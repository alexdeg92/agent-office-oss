'use strict';
// O5: the first-run setup « characters » step in headless Chrome (public/v2/office/setup-dev.html): defaults for every
// detected agent, keyboard-only editing, live announcements, FR/EN, a given value, and the empty/failed states.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { launch, findChrome } = require('./helpers/browser');

const skip = findChrome() ? false : 'no Chrome/Chromium binary (set CHROME_BIN)';
let browser;
before(async () => { if (!skip) browser = await launch(); });
after(async () => { await browser?.close(); });

async function step(query = '') {
  const p = await browser.page(`/public/v2/office/setup-dev.html?${query}`);
  await p.waitFor(`window.setupValue && document.querySelectorAll('.ao-sc__agent').length >= 4`);
  return p;
}
const until = (cond) => `await new Promise((res, rej) => { const t0 = performance.now(); const tick = () => { if (${cond}) return res(); if (performance.now() - t0 > 20000) return rej(new Error('timed out: ${cond.replace(/'/g, '')}')); setTimeout(tick, 10); }; tick(); });`;

describe('setup « characters » step (O5)', { skip, timeout: 120_000 }, () => {
  it('every detected agent gets a valid default look; characters are the manifest’s (no hard-coded family)', async () => {
    const p = await step();
    const r = await p.eval(`const { indexManifest } = await import('/public/v2/office/assets.js');
      const m = await (await fetch('/design/office/manifest.example.json')).json(); const idx = indexManifest(m);
      return { value: window.setupValue, chars: [...document.querySelectorAll('.ao-sc__card input')].map((i) => i.value), manifest: [...idx.characters.keys()],
        broken: [...document.querySelectorAll('.ao-sc img')].filter((i) => !i.naturalWidth).length };`);
    assert.deepEqual(Object.keys(r.value), ['orion', 'lyra', 'vega', 'atlas']);
    assert.deepEqual(r.chars, r.manifest);
    for (const look of Object.values(r.value)) assert.ok(r.manifest.includes(look.character) && Array.isArray(look.accessories));
    assert.notEqual(r.value.lyra.variant, r.value.vega.variant, 'other agents are told apart');
    assert.equal(r.broken, 0);
    await p.close();
  });

  it('keyboard only: arrows move between agents; radios pick character and colour; buttons wear gear; changes are announced', async () => {
    const p = await step();
    await p.eval(`document.getElementById('ao-sc-agent-0').focus();`);
    await p.key('ArrowDown');
    assert.equal(await p.eval(`${until("document.activeElement.id === 'ao-sc-agent-1'")} return document.querySelector('#ao-sc-editing').innerText;`), 'Apparence de Lyra');
    // the character radio group: focus the checked radio, arrow to the next one
    await p.eval(`document.querySelector('.ao-sc__card input:checked').focus();`);
    const before = await p.eval(`return window.setupValue.lyra.character;`);
    await p.key('ArrowRight');
    const afterChar = await p.eval(`${until(`window.setupValue.lyra.character !== '${before}'`)} return { c: window.setupValue.lyra.character, live: document.querySelector('.ao-sc__live').innerText };`);
    assert.match(afterChar.live, /^Lyra : personnage /);
    // wear the cap, then headphones (same slot): one replaces the other, and the replacement is announced
    for (const label of ['Casquette', 'Casque d’écoute']) {
      await p.eval(`[...document.querySelectorAll('.ao-sc__acc')].find((b) => b.innerText === '${label}').focus();`);
      await p.key('Enter');
    }
    const g = await p.eval(`${until("window.setupValue.lyra.accessories.includes('headphones')")} return { acc: window.setupValue.lyra.accessories, live: document.querySelector('.ao-sc__live').innerText,
      pressed: [...document.querySelectorAll('.ao-sc__acc[aria-pressed=true]')].map((b) => b.innerText) };`);
    assert.deepEqual(g.acc, ['headphones']);
    assert.deepEqual(g.pressed, ['Casque d’écoute']);
    assert.match(g.live, /Casquette remplacé par Casque d’écoute/);
    // reset restores the suggested look
    await p.eval(`document.querySelector('.ao-sc__reset').click();`);
    assert.equal(await p.eval(`${until(`window.setupValue.lyra.character === '${before}'`)} return window.setupValue.lyra.accessories.includes('headphones');`), false);
    await p.close();
  });

  it('English: the step is English only (agent names are data)', async () => {
    const p = await step('lang=en');
    const text = await p.eval(`return document.querySelector('.ao-sc').innerText;`);
    assert.match(text, /A look for each agent\./);
    assert.match(text, /Main agent/);
    assert.doesNotMatch(text.replace(/Orion|Lyra|Vega|Atlas/g, ''), /\b(Personnage|Couleur|Accessoires|Agent principal|Rétablir|Aperçu|Au repos|Sous-agent|Robot principal|Casquette)\b/);
    await p.close();
  });

  it('English setup uses each pack’s character and variant names', async () => {
    const p = await step('lang=en');
    try {
      const result = await p.eval(`const m=await (await fetch('/design/office/manifest.example.json')).json();
        return m.characterPacks.packs.map(pack=>({expected:pack.names.en,
          actual:document.querySelector('.ao-sc__card input[value="'+pack.id+'"]')?.closest('label').innerText}));`);
      for (const row of result) assert.equal(row.actual.trim(), row.expected);
      await p.eval(`document.querySelector('.ao-sc__card input[value="orbit"]').click();`);
      await p.waitFor(`document.querySelector('.ao-sc__swatch input[value="pearl"]')`);
      assert.match(await p.eval(`return document.querySelector('.ao-sc__swatch input[value="pearl"]').closest('label').innerText;`), /Pearl/);
      assert.deepEqual(p.logs, []);
    } finally { await p.close(); }
  });

  it('a given value is kept where valid and repaired where not', async () => {
    const value = encodeURIComponent(JSON.stringify({ lyra: { character: 'subagent', variant: 'teal', accessories: ['cap', 'headphones', 'bogus'] }, vega: { character: 'gone' } }));
    const p = await step(`value=${value}`);
    const v = await p.eval(`return window.setupValue;`);
    assert.deepEqual(v.lyra, { character: 'subagent', variant: 'teal', accessories: ['cap'] });
    assert.notEqual(v.vega.character, 'gone');
    await p.close();
  });

  it('no detected agent → the way back is said; a manifest that can’t be loaded → an error with a retry', async () => {
    let p = await browser.page('/public/v2/office/setup-dev.html?agents=0');
    await p.waitFor(`document.querySelector('.ao-sc__help')`);
    assert.match(await p.eval(`return document.querySelector('.ao-sc').innerText;`), /Aucun agent n’a été détecté/);
    await p.close();
    p = await browser.page('/public/v2/office/setup-dev.html?manifest=404');
    await p.waitFor(`document.querySelector('.ao-sc [role=alert]')`);
    assert.match(await p.eval(`return document.querySelector('.ao-sc').innerText;`), /n’ont pas pu être chargés[\s\S]*Réessayer/);
    await p.close();
  });
});
