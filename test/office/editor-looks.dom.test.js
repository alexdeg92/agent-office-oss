'use strict';
// O6: looks are changed after install with the setup step's component inside the Bureau editor (Personnages), saved
// through PUT /office/layout (the agent's rule), and shown in the office at once. Bureau harness (bureau-dev.html).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
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
    ${U}(() => document.querySelector('.ao-editpanel .ao-sc__list'));`);
  return p;
}
const pick = (name) => `[...document.querySelectorAll('.ao-sc__agent')].find((b) => b.querySelector('.ao-sc__name').textContent === '${name}').click();
  ${U}(() => /${name}$/.test(document.querySelector('#ao-sc-editing')?.textContent || ''));`;
const atlasImgs = `[...document.querySelectorAll('.ao-char[data-occupant="subagent:atlas"] img')].map((i) => i.getAttribute('src')).join(' ')`;

describe('Bureau editor: looks with the setup component (O6)', { skip, timeout: 120_000 }, () => {
  it('the editor’s Personnages mode is the setup component: every agent and default rule, the manifest’s characters', async () => {
    const p = await openCharacters();
    const r = await p.eval(`return { agents: [...document.querySelectorAll('.ao-editpanel .ao-sc__name')].map((n) => n.textContent),
      chars: [...document.querySelectorAll('.ao-editpanel .ao-sc__card input')].map((i) => i.value), title: !!document.querySelector('.ao-editpanel #ao-sc-title') };`);
    assert.ok(['Orion', 'Scout', 'Plume', 'Atlas'].every((n) => r.agents.includes(n)), r.agents.join(','));
    assert.ok(r.agents.includes('Nouveaux sous-agents'), 'default rules are editable too');
    assert.ok(r.chars.includes('family-b'), 'a shipped family is offered');
    assert.equal(r.title, false, 'embedded: no setup heading');
    // the default rule's colour rotation holds (agents are resolved together, in roster order)
    const looks = await p.eval(`return ['Scout', 'Plume', 'Atlas'].map((n) => [...document.querySelectorAll('.ao-editpanel .ao-sc__agent')].find((b) => b.querySelector('.ao-sc__name').textContent === n).querySelector('.ao-sc__look').textContent);`);
    assert.equal(new Set(looks).size, 3, looks.join(' | '));
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
    // redo, wear a scarf, save
    await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }));
      ${U}(() => document.querySelector('.ao-editpanel .ao-sc__card input:checked')?.value === 'family-b');
      [...document.querySelectorAll('.ao-editpanel .ao-sc__acc')].find((b) => b.textContent === 'Foulard').click();
      ${U}(() => [...document.querySelectorAll('.ao-editpanel .ao-sc__acc[aria-pressed=true]')].some((b) => b.textContent === 'Foulard'));
      document.querySelector('.ao-editbar .bu-btn--primary').click();
      ${U}(() => !document.querySelector('.ao-editbar'));`);
    // The scene swaps sprites once the new images decode (never a blank figure), so it is awaited, not sampled.
    const r = await p.eval(`const vm = window.officeBench.om.layoutVM(); const rule = vm.layout.data.agents.find((a) => a.agentId === 'subagent:atlas');
      const scene = await ${U}(() => { const s = ${atlasImgs}; return s.includes('family-b') && s; });
      return { rule, rev: vm.layout.revision, scene };`);
    assert.equal(r.rule.character, 'family-b');
    assert.ok(r.rule.accessories.includes('scarf'));
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

  it('O7: in the editor the agents are compact one-line chips, with role and look still in their accessible text', async () => {
    const p = await openCharacters();
    const r = await p.eval(`await ${U}(() => [...document.querySelectorAll('link[rel=stylesheet]')].some((l) => /setup-characters\.css/.test(l.href) && l.sheet));
      const chips = [...document.querySelectorAll('.ao-editpanel .ao-sc__agent')];
      return { heights: chips.map((c) => Math.round(c.getBoundingClientRect().height)), text: chips[0].textContent, select: !!document.querySelector('.ao-editpanel .ao-sc__pick')?.offsetParent,
        editorTop: Math.round(document.querySelector('#ao-sc-editing').getBoundingClientRect().top - document.querySelector('.ao-editpanel').getBoundingClientRect().top) };`);
    assert.ok(r.heights.every((h) => h >= 44 && h <= 56), r.heights.join(','));
    assert.match(r.text, /Orion.*Agent principal/);
    assert.equal(r.select, false, 'the select is for narrow panels only');
    // agents and default rules under two headings
    const groups = await p.eval(`return [...document.querySelectorAll('.ao-editpanel .ao-sc__group')].map((g) => [g.textContent, [...g.nextElementSibling.querySelectorAll('.ao-sc__name')].map((n) => n.textContent)]);`);
    assert.deepEqual(groups.map((g) => g[0]), ['Agents', 'Règles par défaut']);
    assert.ok(groups[0][1].includes('Orion') && !groups[0][1].includes('Nouveaux sous-agents'));
    assert.ok(groups[1][1].includes('Nouveaux sous-agents') && !groups[1][1].includes('Orion'));
    assert.ok(r.editorTop < 400, `the look editor starts high in the panel (${r.editorTop}px)`);
    await p.close();
  });
  it('api-v3 D3/D4: on 3.0 data the Bureau and its editor work the same (one primary row, saves in 3.0 names)', async () => {
    const p = await openCharacters('api=3');
    const r = await p.eval(`return { plates: [...document.querySelectorAll('.ao-plate__name')].map((n) => n.textContent), roster: [...document.querySelectorAll('.ao-roster__name')].map((n) => n.textContent),
      rows: [...document.querySelectorAll('.ao-editpanel .ao-sc__name')].map((n) => n.textContent) };`);
    assert.ok(r.plates.includes('Orion'), 'the primary shows its name');   // (the roster is hidden while editing)
    assert.equal(r.rows.filter((n) => n === 'Orion').length, 1, 'one primary row (occupant primary ≡ rule primary)');
    assert.ok(r.rows.includes('Tâches planifiées') && r.rows.includes('Conversations privées'), r.rows.join(','));
    await p.eval(`${pick('Atlas')}
      document.querySelector('.ao-editpanel .ao-sc__card input[value="family-b"]').click();
      ${U}(() => document.querySelector('.ao-editbar .bu-chip'));
      document.querySelector('.ao-editbar .bu-btn--primary').click();
      ${U}(() => !document.querySelector('.ao-editbar'));`);
    const saved = await p.eval(`return window.officeBench.om.layoutVM().layout.data.agents.map((a) => a.agentId);`);
    assert.ok(saved.includes('primary') && saved.includes('*scheduled') && !saved.includes('main'), saved.join(','));
    assert.ok(saved.includes('subagent:atlas'));
    await p.close();
  });
});
