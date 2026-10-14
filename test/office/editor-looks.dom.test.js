'use strict';
// O6: looks are changed after install with the setup step's component inside the Bureau editor (Personnages), saved
// through PUT /office/layout (the agent's rule), and shown in the office at once. Bureau harness (bureau-dev.html).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launch, findChrome } = require('./helpers/browser');

const skip = findChrome() ? false : 'no Chrome/Chromium binary (set CHROME_BIN)';
let browser;
before(async () => { if (!skip) browser = await launch(); });
after(async () => { await browser?.close(); });

const U = 'await window.officeBench.until';
async function openCharacters(query = '') {
  const p = await browser.page(`/public/v2/office/bureau-dev.html?steps=6&tick=600000&nom=Orion&${query}`);
  await p.waitFor(`document.querySelectorAll('.ao-plate').length >= 4`);
  await p.eval(`document.querySelector('.ao-controls [data-page-control]').click();
    ${U}(() => document.querySelector('.ao-editbar'));
    [...document.querySelectorAll('.ao-editbar .bu-segmented__opt')].find((b) => b.getAttribute('aria-pressed') === 'false' && /Personnages|Characters/.test(b.textContent)).click();
    ${U}(() => document.querySelector('.ao-editpanel .ao-character-row'));
    ${U}(() => document.querySelector('.ao-editpanel .ao-sc__card'));`);
  return p;
}
const pick = (name) => `[...document.querySelectorAll('.ao-character-row')].find((b) => b.querySelector('strong').textContent === '${name}').click();
  ${U}(() => /${name}$/.test(document.querySelector('#ao-sc-editing')?.textContent || ''));`;
const atlasImgs = `[...document.querySelectorAll('.ao-char[data-occupant="subagent:atlas"] img')].map((i) => i.getAttribute('src')).join(' ')`;
async function typeText(page, value) {
  for (const char of value) {
    const key = char === ' ' ? ' ' : char.toUpperCase();
    await page.key(key, { code: char === ' ' ? 'Space' : `Key${key}`, text: char });
  }
}

describe('Bureau editor: looks with the setup component (O6)', { skip, timeout: 120_000 }, () => {
  it('the editor shows one backend row per office occupant and edits the selected look with the shared setup control', async () => {
    const p = await openCharacters();
    const r = await p.eval(`return { agents: [document.querySelector('#ao-sc-editing')?.textContent],
      roster: [...document.querySelectorAll('.ao-editpanel .ao-character-row')].map((n) => n.querySelector('strong').textContent),
      chars: [...document.querySelectorAll('.ao-editpanel .ao-sc__card input')].map((i) => i.value), title: !!document.querySelector('.ao-editpanel #ao-sc-title') };`);
    assert.ok(r.roster.includes('Orion') && r.roster.includes('Plume') && r.roster.includes('Atlas'), r.roster.join(','));
    assert.equal(r.roster.length, new Set(r.roster).size, 'there is only one row for each occupant');
    assert.equal(r.agents.length, 1, 'appearance controls do not repeat the roster');
    assert.ok(r.chars.includes('family-b'), 'a shipped family is offered');
    assert.equal(r.title, false, 'embedded: no setup heading');
    assert.ok(await p.eval(`return [...document.querySelectorAll('.ao-character-row')].every(row => row.textContent.includes('OpenClaw'));`));
    await p.close();
  });

  it('name and role accept ordinary typing, survive blur/save, and reload when the editor reopens', async () => {
    const p = await openCharacters();
    await p.eval(`${pick('Atlas')}
      const details = document.querySelector('.ao-character-identity'); details.open = true;
      ${U}(() => details.querySelectorAll('input').length === 2);
      details.querySelectorAll('input')[0].focus();`);
    await typeText(p, 'Vega');
    await p.key('Tab');
    await typeText(p, 'Lead engineer');
    await p.key('Tab');
    const draft = await p.eval(`const fields = [...document.querySelectorAll('.ao-character-identity__fields input')];
      return { name: fields[0].value, role: fields[1].value,
        saveDisabled: document.querySelector('.ao-characters__actions .bu-btn--primary').disabled };`);
    assert.deepEqual(draft, { name: 'Vega', role: 'Lead engineer', saveDisabled: false });
    await p.eval(`document.querySelector('.ao-characters__actions .bu-btn--primary').click(); ${U}(() => !document.querySelector('.ao-editbar'));`);
    await p.eval(`${U}(() => document.querySelector('.ao-controls [data-page-control]'));
      document.querySelector('.ao-controls [data-page-control]').click();
      ${U}(() => document.querySelector('.ao-editbar'));
      const characters = [...document.querySelectorAll('.ao-editbar .bu-segmented__opt')].find(b => /Personnages|Characters|Looks|Apparence/.test(b.textContent));
      if (characters?.getAttribute('aria-pressed') === 'false') characters.click();
      ${U}(() => document.querySelector('.ao-editpanel .ao-character-row')); ${pick('Vega')}
      document.querySelector('.ao-character-identity').open = true;`);
    const saved = await p.eval(`return [...document.querySelectorAll('.ao-character-identity__fields input')].map(input => input.value);`);
    assert.deepEqual(saved, ['Vega', 'Lead engineer']);
    await p.close();
  });

  it('the standalone harness gets filtered detected-agent structure from the server endpoint', async () => {
    const p = await openCharacters();
    const vm = await p.eval(`const office = await window.officeBench.om.officeVM();
      return await window.officeBench.services.officeCharacterVM({ scope: 'all', search: 'Archiviste' }, office);`);
    assert.equal(vm.scope, 'all');
    assert.equal(vm.search, 'Archiviste');
    assert.equal(vm.count, 1);
    assert.equal(vm.groups[0].id, 'detected');
    assert.equal(vm.groups[0].rows[0].name, 'Archiviste');
    assert.equal(vm.groups[0].rows[0].inOffice, false);
    await p.close();
  });

  it('a change previews live, undo brings it back, save persists the rule and the office shows it at once', async () => {
    const p = await openCharacters();
    const before = await p.eval(`return ${atlasImgs};`);
    await p.eval(`${pick('Atlas')}
      document.querySelector('.ao-editpanel .ao-sc__card input[value="family-b"]').click();
      ${U}(() => (${atlasImgs}).includes('family-b'));`);
    // undo: the component follows the draft
    await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      ${U}(() => document.querySelector('.ao-editpanel .ao-sc__card input:checked')?.value !== 'family-b');`);
    // redo, add an available accessory, save
    await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }));
      ${U}(() => document.querySelector('.ao-editpanel .ao-sc__card input:checked')?.value === 'family-b');
      const gear = document.querySelector('.ao-editpanel .ao-sc__acc[aria-pressed=false]'); if (!gear) throw new Error('no available accessory control'); const gearName = gear.getAttribute('aria-label'); gear.click();
      ${U}(() => [...document.querySelectorAll('.ao-editpanel .ao-sc__acc[aria-pressed=true]')].some((b) => b.getAttribute('aria-label') === gearName));
      document.querySelector('.ao-characters__actions .bu-btn--primary').click();
      ${U}(() => !document.querySelector('.ao-editbar'));`);
    // The scene swaps sprites once the new images decode (never a blank figure), so it is awaited, not sampled.
    const r = await p.eval(`const vm = window.officeBench.om.layoutVM(); const rule = vm.layout.data.agents.find((a) => a.agentId === 'subagent:atlas');
      const scene = await ${U}(() => { const s = ${atlasImgs}; return s.includes('family-b') && s; });
      return { rule, rev: vm.layout.revision, scene };`);
    assert.equal(r.rule.character, 'family-b');
    assert.ok(r.rule.accessories.length > 0);
    assert.equal(r.rev, 2);
    assert.match(r.scene, /family-b/);
    assert.notEqual(r.scene, before);
    await p.close();
  });

  it('English: the embedded component and the editor speak English', async () => {
    const p = await openCharacters('lang=en');
    const text = await p.eval(`return document.querySelector('.ao-editpanel').innerText;`);
    assert.match(text, /Character/i);
    assert.match(text, /Name, role and desk of/);
    assert.doesNotMatch(text.replace(/Orion|Scout|Plume|Atlas|Archiviste/g, ''), /\\b(Personnage|Couleur|Accessoires|Rétablir|Nouveaux sous-agents|Règle par défaut)\\b/);
    await p.close();
  });
  it('O7: « Plus d’actions » is a keyboard menu (Down opens, arrows move, Escape returns focus) and runs its item', async () => {
    const p = await openCharacters();
    await p.eval(`document.querySelector('.ao-more > button').focus();`);
    await p.key('ArrowDown');
    const r1 = await p.eval(`${U}(() => document.activeElement.matches('.ao-more__item')); return { expanded: document.querySelector('.ao-more > button').getAttribute('aria-expanded'), first: document.activeElement.textContent };`);
    assert.deepEqual(r1, { expanded: 'true', first: 'Versions' });
    await p.key('ArrowDown');
    assert.match(await p.eval(`return document.activeElement.textContent;`), /^Réinitialiser/);
    await p.key('Escape');
    const r2 = await p.eval(`${U}(() => !document.querySelector('.ao-more__menu') && document.activeElement.matches('.ao-more > button')); return true;`);
    assert.equal(r2, true, 'focus back on the menu button');
    await p.eval(`document.querySelector('.ao-more > button').click(); (${U}(() => [...document.querySelectorAll('.ao-more__item')].find((b) => b.textContent === 'Versions'))).click();
      ${U}(() => document.querySelector('#ao-modal-title')?.textContent === 'Versions enregistrées');`);
    await p.close();
  });

  it('O7: the roster and character editor use a clear phone drill-down with a persistent footer', async () => {
    const p = await openCharacters();
    const r = await p.eval(`await ${U}(() => [...document.querySelectorAll('link[rel=stylesheet]')].some((l) => /setup-characters\.css/.test(l.href) && l.sheet));
      const panel = document.querySelector('.ao-editpanel');
      Object.assign(panel.style, { height: '640px', maxHeight: '640px', width: '360px' });
      const chips = [...document.querySelectorAll('.ao-editpanel .ao-character-row')];
      return { heights: chips.map((c) => Math.round(c.getBoundingClientRect().height)), text: chips[0].textContent,
        lookLabel: document.querySelector('.ao-sc__card input:checked')?.closest('.ao-sc__card')?.textContent.trim(),
        select: !!document.querySelector('.ao-editpanel .ao-sc__pick')?.offsetParent,
        editorTop: Math.round(document.querySelector('#ao-sc-editing').getBoundingClientRect().top - document.querySelector('.ao-editpanel').getBoundingClientRect().top) };`);
    assert.ok(r.heights.every((h) => h >= 60 && h <= 70), r.heights.join(','));
    assert.match(r.text, /Orion.*OpenClaw/);
    assert.ok(r.lookLabel && r.text.includes(r.lookLabel), 'the row names its current character');
    assert.equal(r.select, false, 'the select is for narrow panels only');
    assert.equal(await p.eval(`return document.querySelectorAll('.ao-character-group').length;`), 1);
    assert.ok(r.editorTop < 400, `the look editor starts high in a fixed 640px inspector (${r.editorTop}px)`);
    for (const [name, width, height, panelHeight] of [['desktop', 1440, 900, 640], ['compact', 1280, 720, 460], ['mobile', 390, 844, 500], ['mobile375', 375, 812, 500]]) {
      await p.viewport(width, height);
      const metrics = await p.eval(`const panel = document.querySelector('.ao-editpanel');
        Object.assign(panel.style, { height: '${panelHeight}px', maxHeight: '${panelHeight}px', width: '${width <= 480 ? 'calc(100vw - 32px)' : '360px'}' });
        const list = panel.querySelector('.ao-characters__list'), fixed = panel.querySelector('.ao-characters__fixed'), footer = panel.querySelector('.ao-characters__actions');
        const fixedTop = fixed.getBoundingClientRect().top, footerGap = panel.getBoundingClientRect().bottom - footer.getBoundingClientRect().bottom;
        list.scrollTop = Math.min(64, list.scrollHeight - list.clientHeight);
        return { listHeight: list.clientHeight, scrolls: getComputedStyle(list).overflowY === 'auto', fixedStayed: fixed.getBoundingClientRect().top === fixedTop,
          footerGap: Math.round(footerGap), footerHeight: footer.getBoundingClientRect().height, footerText: footer.textContent };`);
      assert.ok(metrics.listHeight > 40, `${name}: roster has a usable scroll region (${JSON.stringify(metrics)})`);
      assert.ok(metrics.scrolls, `${name}: roster owns its internal scroll region`);
      assert.ok(metrics.fixedStayed, `${name}: title/search/filter stay pinned`);
      assert.ok(Math.abs(metrics.footerGap) <= 1, `${name}: actions stay on the inspector edge (${metrics.footerGap}px)`);
      assert.ok(metrics.footerHeight >= 60 && /Annuler|Cancel/.test(metrics.footerText), `${name}: persistent save/cancel footer is visible`);
      if (process.env.AO_T0105_CAPTURE === '1') {
        await p.eval('await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));');
        const dir = path.resolve(__dirname, '../../design/reports/office-dev-105'); fs.mkdirSync(dir, { recursive: true });
        await p.eval(`document.querySelector('.ao-characters__list').scrollTop = 0;`);
        const clip = await p.eval(`const r = document.querySelector('.ao-editpanel').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };`);
        if (name.startsWith('mobile')) await p.eval(`const panel = document.querySelector('.ao-editpanel'), aside = panel.parentElement;
          Object.assign(aside.style, { position: 'fixed', top: '0', left: '0', width: '100vw', height: '500px', zIndex: '99' });
          Object.assign(panel.style, { width: '100%', height: '100%', maxHeight: '100%' });
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));`);
        fs.writeFileSync(path.join(dir, `characters-${name}.png`), await p.screenshot(name.startsWith('mobile') ? undefined : clip));
        if (name === 'mobile') {
          await p.eval(`document.querySelector('.ao-character-row').click(); ${U}(() => document.querySelector('.ao-characters--mobile-detail'));`);
          await p.eval(`document.querySelector('.ao-sc__card input[value="family-b"]')?.click(); ${U}(() => !document.querySelector('.ao-characters__actions .bu-btn--primary').disabled);`);
          const detail = await p.eval(`return { roster: getComputedStyle(document.querySelector('[aria-labelledby="ao-agents-title"]')).display,
            profile: getComputedStyle(document.querySelector('.ao-character-profile')).display,
            footerGap: Math.round(document.querySelector('.ao-editpanel').getBoundingClientRect().bottom - document.querySelector('.ao-characters__actions').getBoundingClientRect().bottom),
            title: document.querySelector('.ao-character-profile h3').textContent };`);
          assert.equal(detail.roster, 'none', 'phone detail replaces the roster instead of squeezing it');
          assert.notEqual(detail.profile, 'none', 'selected agent gets a clear identity header');
          assert.ok(Math.abs(detail.footerGap) <= 1, 'save actions stay anchored during editing');
          assert.equal(detail.title, 'Orion');
          await p.eval('await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));');
          fs.writeFileSync(path.join(dir, 'characters-mobile-detail.png'), await p.screenshot());
          await p.eval(`document.querySelector('.ao-characters__back').click(); ${U}(() => !document.querySelector('.ao-characters--mobile-detail'));`);
        }
      }
    }
    await p.close();
  });
  it('api-v3 D3/D4: on 3.0 data the Bureau and its editor work the same (one primary row, saves in 3.0 names)', async () => {
    const p = await openCharacters('api=3');
    const r = await p.eval(`return { plates: [...document.querySelectorAll('.ao-plate__name')].map((n) => n.textContent), roster: [...document.querySelectorAll('.ao-roster__name')].map((n) => n.textContent),
      rows: [...document.querySelectorAll('.ao-editpanel .ao-character-row strong')].map((n) => n.textContent) };`);
    assert.ok(r.plates.includes('Orion'), 'the primary shows its name');   // (the roster is hidden while editing)
    assert.equal(r.rows.filter((n) => n === 'Orion').length, 1, 'one primary row (occupant primary ≡ rule primary)');
    await p.eval(`${pick('Atlas')}
      document.querySelector('.ao-editpanel .ao-sc__card input[value="family-b"]').click();
      ${U}(() => document.querySelector('.ao-editbar .bu-chip'));
      document.querySelector('.ao-characters__actions .bu-btn--primary').click();
      ${U}(() => !document.querySelector('.ao-editbar'));`);
    const saved = await p.eval(`return window.officeBench.om.layoutVM().layout.data.agents.map((a) => a.agentId);`);
    assert.ok(saved.includes('primary') && saved.includes('*scheduled') && !saved.includes('main'), saved.join(','));
    assert.ok(saved.includes('subagent:atlas'));
    await p.close();
  });
});
