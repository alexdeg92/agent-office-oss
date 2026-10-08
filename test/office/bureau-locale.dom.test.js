'use strict';
// The Bureau page in English and French (BRIEF: FR + EN; editorial guide §2, §7): the editorial frame
// (headline, « Les présences », the Carnet), the scene's controls and the editor speak the UI language,
// with nothing of the other language left over (data names excepted). Also the S14b fallback: without
// GET /office/layout the page draws the shipped layout, read-only, and never subscribes the `layout` topic.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { launch, findChrome } = require('./helpers/browser');

const skip = findChrome() ? false : 'no Chrome/Chromium binary (set CHROME_BIN)';
let browser;
before(async () => { if (!skip) browser = await launch(); });
after(async () => { await browser?.close(); });

// Words that only appear in French UI text (not in the mock's data names or the art).
const FRENCH = /\b(depuis|travaille|bureau|présences|carnet|thème|personnaliser|agents? principal|sous-agent|exécute|réfléchit|rédige|automatique|jour|nuit|relevé|prochain|aucune?|zoom avant|ajuster)\b/i;
const ENGLISH = /\b(has been|working for|present|notebook|office theme|customize|main agent|sub-agent|automatic|day|night|snapshot|coming up|zoom in|fit to)\b/i;
// Data, not UI: the mock's names and job names stay in their own language.
const DATA = /Timmy|Scout|Plume|Atlas|Veille hebdomadaire|Résumé du matin|Tâche planifiée [^.]* (started|déclenchée)/g;

async function bureau(query) {
  const p = await browser.page(`/public/v2/office/bureau-dev.html?steps=6&tick=600000&${query}`);
  await p.waitFor(`document.querySelectorAll('.ao-roster').length >= 4 && document.querySelectorAll('.ao-plate').length >= 4`);
  return p;
}
const uiText = `return [document.querySelector('.ao-bureau__lead').textContent, document.querySelector('.ao-bureau__top').innerText, document.querySelector('.ao-bureau__side').innerText,
  document.querySelector('.ao-bureau__theme').innerText, document.querySelector('.ao-bureau__feed').innerText,
  ...[...document.querySelectorAll('.ao-controls button, .ao-bureau__stage, .ao-viewport, .ao-roster')].map((b) => b.getAttribute('aria-label') ?? '')].join('\\n');`;

describe('Bureau page, FR and EN', { skip, timeout: 120_000 }, () => {
  it('English: the KPIs, the roster cards, the Journal and the scene controls are English only', async () => {
    const p = await bureau('lang=en');
    const text = (await p.eval(uiText)).replace(DATA, '');
    assert.match(text, /has been working for|is working|No active run/);
    assert.match(text, /TOTAL TOKENS|Total tokens/);
    assert.match(text, /Journal/);
    assert.match(text, /Scheduled tasks/);
    assert.doesNotMatch(text, FRENCH, 'no French UI text in English');
    // The editor too.
    const ed = await p.eval(`document.querySelector('.ao-controls [data-page-control]').click();
      await window.officeBench.until(() => document.querySelector('.ao-editbar'));
      return document.querySelector('.ao-editbar').innerText + '\\n' + document.querySelector('.ao-editpanel').innerText;`);
    assert.match(ed, /Customize the office/);
    assert.doesNotMatch(ed.replace(DATA, ''), /\b(Disposition|Personnages|Enregistrer|Mobilier|Réinitialiser|Tout est en ordre)\b/);
    await p.close();
  });

  it('French: the same frame, French only', async () => {
    const p = await bureau('lang=fr');
    const text = (await p.eval(uiText)).replace(DATA, '');
    assert.match(text, /travaille depuis|Aucune exécution/);
    assert.match(text, /JETONS CUMULÉS|Jetons cumulés/);
    assert.match(text, /Journal/);
    assert.match(text, /Tâches planifiées/);
    assert.doesNotMatch(text, ENGLISH, 'no English UI text in French');
    await p.close();
  });

  it('Q02-01: a stale stream leads with freshness; roster and scene say « last observed », never a running duration', async () => {
    for (const [lang, lead, roster, label] of [['fr', 'L’état actuel du bureau reste à confirmer.', /au dernier relevé\.$/, /au dernier état observé$/], ['en', 'The office’s current state is unconfirmed.', /at the last snapshot\.$/, /as last observed$/]]) {
      const p = await bureau(`lang=${lang}&conn=retrying`);
      const r = await p.eval(`return { lead: document.querySelector('.ao-bureau__lead').textContent,
        states: [...document.querySelectorAll('.ao-roster__state')].map((n) => n.title), live: document.querySelectorAll('.ao-roster__state--live').length,
        label: document.querySelector('.ao-bureau__stage').getAttribute('aria-label'), caption: !!document.querySelector('.ao-bureau__stagecap') };`);
      // office-dev-18: the status sentence is the page's sr-only heading (lead, then its deck)
      assert.ok(r.lead.startsWith(lead), r.lead);
      assert.doesNotMatch(r.lead.slice(lead.length), /depuis|has been|minute/);
      assert.ok(r.states.length >= 4 && r.states.every((s) => roster.test(s)), r.states.join(' | '));
      assert.equal(r.live, 0);
      assert.match(r.label, label);
      assert.equal(r.caption, true);
      await p.close();
    }
  });

  it('Q03-O02: a read-only instance offers no customization or theme write, with the reason; zoom and the drawer stay', async () => {
    const p = await bureau('lang=fr&lecture=1&agent=main');
    await p.waitFor(`document.querySelector('#ao-drawer-title')`);
    const r = await p.eval(`return { customize: !!document.querySelector('.ao-controls [data-page-control]'), zoom: document.querySelectorAll('.ao-controls button').length,
      theme: !!document.querySelector('.ao-bureau__theme'), reason: document.querySelector('.ao-bureau__ro')?.innerText,
      drawerButtons: [...document.querySelectorAll('.bu-drawer .bu-modal__footer .bu-btn')].map((b) => b.innerText.trim()),
      state: document.querySelector('.ao-drawer__state')?.innerText, station: [...document.querySelectorAll('.bu-drawer .bu-kv__row')].map((r) => r.innerText.split(String.fromCharCode(10)).join(' : ')) };`);
    assert.equal(r.customize, false);
    assert.ok(r.zoom >= 3, 'zoom and fit stay');
    assert.equal(r.theme, false);
    assert.equal(r.reason, 'Instance de test : la personnalisation du bureau est désactivée.');
    assert.ok(!r.drawerButtons.some((b) => /Personnaliser/.test(b)), r.drawerButtons.join(','));
    // Q03-O03: one state sentence, no « Desk / Desk ».
    assert.match(r.state, /^(Travaille|Inactif|Réfléchit|Rédige|Fait une recherche|Utilise un outil|Attend une réponse|Signale une erreur|Hors ligne)/);
    assert.ok(!r.station.some((s) => /^Poste : Poste de travail$/.test(s)), r.station.join(' | '));
    // Q03-O01: recurrences are labelled as such, not as a chronological queue.
    assert.match(await p.eval(`return document.querySelector('.ao-bureau__tabs').innerText;`), /Tâches planifiées/);
    await p.close();
  });

  it('S14b not deployed: GET /office/layout 404 → the shipped layout, read-only, no `layout` topic', async () => {
    const p = await browser.page('/public/v2/office/bureau-dev.html?steps=6&tick=600000&layout=404');
    await p.waitFor(`document.querySelectorAll('.ao-plate').length >= 4`);
    const r = await p.eval(`return { topics: [...window.officeBench.subscribed], customize: !!document.querySelector('.ao-controls [data-page-control]'),
      theme: !!document.querySelector('.ao-bureau__theme'), roster: document.querySelectorAll('.ao-roster').length };`);
    assert.deepEqual(r, { topics: ['office'], customize: false, theme: false, roster: 4 });
    await p.close();
  });
});
