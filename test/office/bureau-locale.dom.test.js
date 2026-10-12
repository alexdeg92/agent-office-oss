'use strict';
// The Bureau page in English and French (BRIEF: FR + EN; editorial guide §2, §7): the editorial frame
// (headline, « Les présences », the Carnet), the scene's controls and the editor speak the UI language,
// with nothing of the other language left over (data names excepted). Also the S14b fallback: without
// GET /office/layout the page draws the shipped layout, read-only, and never subscribes the `layout` topic.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  it('labels unknown and observed execution in the chosen language without a live pulse', async () => {
    for (const [lang, labels] of [['fr', ['Inconnu', 'Activité observée']], ['en', ['Unknown', 'Activity observed']]]) {
      const p = await bureau(`lang=${lang}`);
      await p.eval(`const om=window.officeBench.om, original=om.officeVM.bind(om); om.officeVM=async()=>{const vm=await original();
        vm.occupants[0].state='unknown'; vm.occupants[0].stateSince=null; vm.occupants[0].stateActive=false; vm.occupants[0].stateLabel={key:'agentState.unknown'}; vm.occupants[0].stateDetailLabel={key:'agentState.unknown'}; vm.occupants[0].execution={status:'unknown',evidence:{level:'unknown',observedAt:null,expiresAt:null}};
        return vm;}; await window.officeBench.publish('office');`);
      await p.waitFor(`document.querySelector('.ao-roster__state')?.dataset.agentState === 'unknown'`);
      const unknown = await p.eval(`const n=document.querySelector('.ao-roster__state[data-agent-state="unknown"]'); return { label:n?.innerText, live:n?.classList.contains('ao-roster__state--live') };`);
      assert.match(unknown.label, new RegExp(labels[0]));
      assert.equal(unknown.live, false);
      await p.eval(`const om=window.officeBench.om, original=om.officeVM.bind(om); om.officeVM=async()=>{const vm=await original();
        vm.occupants[0].state='observed'; vm.occupants[0].stateSince=null; vm.occupants[0].stateActive=false; vm.occupants[0].stateLabel={key:'agentState.observed'}; vm.occupants[0].stateDetailLabel={key:'agentState.observed'}; vm.occupants[0].execution={status:'unknown',evidence:{level:'observed',observedAt:Date.now(),expiresAt:Date.now()+30000}};
        return vm;}; await window.officeBench.publish('office');`);
      await p.waitFor(`document.querySelector('.ao-roster__state')?.dataset.agentState === 'observed'`);
      const observed = await p.eval(`const n=document.querySelector('.ao-roster__state[data-agent-state="observed"]'); return { label:n?.innerText, live:n?.classList.contains('ao-roster__state--live') };`);
      assert.match(observed.label, new RegExp(labels[1]));
      assert.equal(observed.live, false);
      await p.close();
    }
  });

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

  it('session identity: shows the bounded activity summary in FR/EN, hides unknown tokens and keeps keys collapsed', async () => {
    for (const [lang, label, captions] of [['fr', 'En cours', ['Projet', 'Moteur', 'Modèle']], ['en', 'In progress', ['Project', 'Runtime', 'Model']]]) {
      const p = await bureau(`lang=${lang}&agent=main`);
      await p.eval(`const om = window.officeBench.om, original = om.officeVM.bind(om);
        om.officeVM = async () => { const vm = await original(); const o = vm.occupants[0]; o.summary = 'Synthèse synthétique — réviser le plan'; o.tokensKnown = false; o.project = 'agent-office-portal'; o.runtime = 'Claude Code'; o.model = 'model-test'; return vm; };
        await window.officeBench.publish('office');`);
      await p.waitFor(`document.querySelector('.ao-roster__summary')?.textContent.includes('réviser le plan')`);
      const r = await p.eval(`const d=document.querySelector('.bu-drawer'), tech=d?.querySelector('.ao-drawer__technical'); return {
        card: document.querySelector('.ao-roster__summary')?.innerText, drawer: d?.innerText,
        heading: d?.querySelector('.ao-drawer__activity h3')?.innerText, open: tech?.open,
        session: tech?.innerText, tokenRows: [...d.querySelectorAll('.bu-kv__row')].filter(x => /Tokens|Jetons/.test(x.innerText)).length };`);
      assert.equal(r.card, 'Synthèse synthétique — réviser le plan');
      assert.match(r.drawer, /Synthèse synthétique — réviser le plan/);
      assert.equal(r.heading, label);
      assert.equal(r.open, false);
      assert.equal(r.tokenRows, 0);
      assert.doesNotMatch(r.drawer, /agent:main:main/);
      // critic-164 / designer-63: project, runtime and model captions come from the office catalog, never « Autre (…) »
      const rows = await p.eval(`return [...document.querySelectorAll('.bu-drawer .bu-kv__row')].map(x => [x.querySelector('dt')?.innerText, x.querySelector('dd')?.innerText]);`);
      for (const [caption, value] of [[captions[0], 'agent-office-portal'], [captions[1], 'Claude Code'], [captions[2], 'model-test']])
        assert.ok(rows.some(([dt, dd]) => dt === caption && dd === value), `${lang}: ${caption} row in ${JSON.stringify(rows)}`);
      assert.doesNotMatch(r.drawer, /Autre \(|Other \(/);
      if (lang === 'en') fs.writeFileSync(path.resolve(__dirname, '../../design/reports/agent-identity-1-drawer.png'), await p.screenshot());
      await p.close();
    }
  });

  it('session identity: roster cards show the name, then the summary or « dans <projet> », in FR/EN', async () => {
    for (const [lang, inProject] of [['fr', 'dans agent-office-portal'], ['en', 'in agent-office-portal']]) {
      const p = await bureau(`lang=${lang}`);
      await p.viewport(1280, 900, 2);
      await p.eval(`const om = window.officeBench.om, original = om.officeVM.bind(om);
        om.officeVM = async () => { const vm = await original(); vm.occupants[0].summary = 'Plan de migration'; vm.occupants[0].project = 'agent-office-portal';
          if (vm.occupants[1]) { delete vm.occupants[1].summary; vm.occupants[1].project = 'agent-office-portal'; } return vm; };
        await window.officeBench.publish('office');`);
      await p.waitFor(`document.querySelector('.ao-roster__summary')?.textContent.includes('Plan de migration')`);
      const cards = await p.eval(`return [...document.querySelectorAll('.ao-roster__summary')].slice(0, 2).map(sub => { const card = sub.closest('button, li'); return { name: card?.querySelector('.ao-roster__name')?.innerText, sub: sub.innerText }; });`);
      assert.ok(cards[0].name && cards[0].name !== cards[0].sub, JSON.stringify(cards));
      assert.equal(cards[0].sub, 'Plan de migration');
      if (cards[1]) assert.equal(cards[1].sub, inProject);
      assert.ok(!cards.some(c => /Autre \(|Other \(/.test(c.sub)), JSON.stringify(cards));
      if (lang === 'fr') {
        const box = await p.eval(`const r = document.querySelector('.ao-bureau__side').getBoundingClientRect(); return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y + scrollY - 8), width: r.width + 16, height: Math.min(r.height + 16, 640) };`);
        fs.writeFileSync(path.resolve(__dirname, '../../design/reports/agent-identity-1-roster.png'), await p.screenshot(box));
      }
      await p.close();
    }
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
