'use strict';
// Bureau headline (editorial guide §1–2) and the office string table (FR + EN).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/architecture/examples/office-vm.json'), 'utf8')).data;
const NOW = 1791223200000;
// Intl puts no-break spaces in « 12 minutes » (correct typography); compare on plain spaces.
const sp = (x) => (Array.isArray(x) ? x.map(sp) : String(x).replace(/[\u00a0\u202f]/g, ' '));
const load = () => Promise.all([import('../../public/v2/office/headline.js'), import('../../public/v2/office/strings.js')]);
const occ = (o) => ({ id: 'subagent:x', role: 'subagent', name: 'Scout', state: 'idle', stateSince: NOW - 600_000, ...o });
const main = (o) => ({ id: 'main', role: 'main', name: 'Orion', state: 'idle', stateSince: NOW - 720_000, ...o });
const vm = (occupants, extra = {}) => ({ ...example, connection: { gateway: 'up', since: NOW - 3_600_000 }, occupants, ...extra });

describe('Bureau headline', () => {
  it('follows the selection order: loading, unavailable, disconnected, error, active, neutral', async () => {
    const [{ headline }] = await load();
    const k = (v, o = {}) => headline(v, { now: NOW, locale: 'fr', ...o }).kind;
    assert.equal(k(undefined), 'loading');
    assert.equal(k(undefined, { error: new Error('x') }), 'unavailable');
    assert.equal(k(vm([main({ state: 'error' })], { connection: { gateway: 'down', since: NOW } })), 'disconnected');
    assert.equal(k(vm([main({ state: 'working' }), occ({ state: 'error' })])), 'error');
    assert.equal(k(vm([main({ state: 'idle' }), occ({ state: 'working' })])), 'active');
    assert.equal(k(vm([main()])), 'idle');
  });

  it('writes whole sentences in French and English, with Intl durations and lists', async () => {
    const [{ headline }] = await load();
    const v = vm([main({ state: 'working' }), occ({ state: 'researching' }), occ({ id: 'subagent:y', name: 'Plume', state: 'writing' }), occ({ id: 'subagent:z', name: 'Atlas', state: 'working' })]);
    const h1 = headline(v, { now: NOW, locale: 'fr' }); const fr = { lead: sp(h1.lead), deck: sp(h1.deck) };
    assert.equal(fr.lead, 'Orion travaille depuis 12 minutes.');
    assert.deepEqual(fr.deck, ['Scout fait une recherche.', 'Plume rédige.', 'Un autre agent est actif.']);
    const h2 = headline(v, { now: NOW, locale: 'en' }); const en = { lead: sp(h2.lead), deck: sp(h2.deck) };
    assert.equal(en.lead, 'Orion has been working for 12 minutes.');
    assert.deepEqual(en.deck, ['Scout is researching.', 'Plume is writing.', 'One more agent is active.']);
    const errs = vm([main({ state: 'error' }), occ({ state: 'error' })]);
    assert.equal(headline(errs, { now: NOW, locale: 'fr' }).lead, '2 agents signalent une erreur : Orion et Scout.');
    assert.equal(headline(errs, { now: NOW, locale: 'en' }).lead, '2 agents report an error: Orion and Scout.');
  });

  it('never shows a raw id or a literal agent name: « L’agent » / “The agent” without one', async () => {
    const [{ headline }] = await load();
    const v = vm([main({ name: 'main', state: 'working' })]);
    assert.equal(sp(headline(v, { now: NOW, locale: 'fr' }).lead), 'L’agent travaille depuis 12 minutes.');
    assert.equal(sp(headline(v, { now: NOW, locale: 'en' }).lead), 'The agent has been working for 12 minutes.');
    assert.equal(sp(headline(v, { now: NOW, locale: 'en', primaryName: 'Nova' }).lead), 'Nova has been working for 12 minutes.');
    const down = vm([main()], { connection: { gateway: 'down', since: null } });
    assert.equal(headline(down, { locale: 'fr' }).lead, 'La connexion à l’agent est interrompue.');
  });

  it('claims nothing without evidence: idle is a neutral fact, zero is not « un »; a stale stream qualifies the facts', async () => {
    const [{ headline }] = await load();
    const idle = headline(vm([main(), occ({ state: 'offline' })]), { now: NOW, locale: 'fr' });
    assert.equal(idle.lead, 'Aucune exécution en cours n’est signalée.');
    assert.deepEqual(idle.deck, ['Un agent est au bureau.']);
    assert.deepEqual(headline(vm([main({ state: 'offline' })]), { now: NOW, locale: 'en' }).deck, ['No agent is in the office.']);
    // Q02-01: stale → freshness leads; retained states are the last observation, past tense, no duration.
    const v = vm([main({ state: 'working' }), occ({ state: 'writing' }), occ({ id: 'subagent:e', name: 'Atlas', state: 'error' })]);
    const stale = headline(v, { now: NOW, locale: 'fr', meta: { stale: ['stream'], generatedAt: NOW }, date: () => '5 oct., 18 h 00' });
    assert.equal(stale.kind, 'stale');
    assert.equal(stale.lead, 'L’état actuel du bureau reste à confirmer.');
    assert.deepEqual(stale.deck, ['Dernier relevé reçu : 5 oct., 18 h 00.', 'Au dernier relevé, Atlas signalait une erreur.', 'Au dernier relevé, Orion travaillait.', 'Un autre agent était actif.']);
    const en = headline(v, { now: NOW, locale: 'en', meta: { stale: ['gateway'] } });
    assert.equal(en.lead, 'The office’s current state is unconfirmed.');
    assert.equal(en.deck[0], 'The time of the last snapshot is unknown.');
    for (const s of [stale.lead, ...stale.deck, en.lead, ...en.deck]) assert.doesNotMatch(s, /depuis|travaille\b|is working|has been|for \d|minute/, s);
    // A disconnected gateway also tells the retained states in the past.
    const down = headline({ ...v, connection: { gateway: 'down', since: NOW } }, { locale: 'en', time: () => '18:00' });
    assert.equal(down.kind, 'disconnected');
    assert.ok(down.deck.includes('At the last snapshot, Orion was working.'));
    assert.equal(headline(vm([main()]), { locale: 'fr', meta: { stale: ['stream'], generatedAt: NOW }, date: () => 'x' }).deck[1], 'Au dernier relevé, aucune exécution n’était signalée.');
    // The real OfficeVM example (S7b) produces a sentence in both languages.
    for (const locale of ['fr', 'en']) assert.ok(headline(example, { now: NOW, locale }).lead.endsWith('.'));
  });

  it('does not call an unknown execution idle, in either locale', async () => {
    const [{ headline }] = await load();
    const v = vm([main({ state: 'unknown' })]);
    const fr = headline(v, { now: NOW, locale: 'fr' });
    const en = headline(v, { now: NOW, locale: 'en' });
    assert.equal(fr.kind, 'unknown');
    assert.equal(fr.lead, 'L’état actuel du bureau reste à confirmer.');
    assert.deepEqual(fr.deck, []);
    assert.equal(en.kind, 'unknown');
    assert.equal(en.lead, 'The office’s current state is unconfirmed.');
    assert.deepEqual(en.deck, []);
  });

  it('R14-16: a sole primary agent is described by its own state (working, error, offline, idle), never by the occupant count', async () => {
    const [{ headline }] = await load();
    // The KPI strip the server sends (sub kpi.idle chosen from the count) is not an input: only occupant states are.
    const kpis = [{ id: 'active', label: { key: 'kpi.active' }, value: 1, unit: 'count', sub: { key: 'kpi.idle', params: { agent: 'Orion' } } }];
    const solo = (state) => headline(vm([main({ state })], { kpis }), { now: NOW, locale: 'fr' });
    assert.deepEqual([solo('working').kind, sp(solo('working').lead)], ['active', 'Orion travaille depuis 12 minutes.']);
    assert.deepEqual([solo('error').kind, solo('error').lead], ['error', 'Orion signale une erreur.']);
    assert.deepEqual([solo('offline').kind, solo('offline').lead, solo('offline').deck], ['idle', 'Aucune exécution en cours n’est signalée.', ['Aucun agent n’est au bureau.']]);
    assert.deepEqual([solo('idle').kind, solo('idle').deck], ['idle', ['Un agent est au bureau.']]);
    for (const state of ['thinking', 'researching', 'writing', 'calling', 'waiting']) assert.equal(solo(state).kind, 'active', state);
  });
});

describe('office strings (FR + EN)', () => {
  it('every key exists in both languages, with the same parameters', async () => {
    const [, { STRINGS }] = await load();
    const params = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    assert.deepEqual(Object.keys(STRINGS.en).sort(), Object.keys(STRINGS.fr).sort());
    for (const k of Object.keys(STRINGS.fr)) {
      if (/\.(one|zero)$/.test(k)) continue;   // a singular may spell the number out
      assert.equal(params(STRINGS.en[k]), params(STRINGS.fr[k]), k);
    }
  });

  it('no template embeds a runtime, an agent name or an id', async () => {
    const [, { STRINGS }] = await load();
    for (const [lang, d] of Object.entries(STRINGS)) for (const [k, v] of Object.entries(d)) assert.doesNotMatch(v, /Timmy|OpenClaw|\bmain:|« ?main ?»|\{main\}/, `${lang} ${k}`);
  });

  it('the validator speaks the UI language and stays French by default (server)', async () => {
    const [, S] = await load();
    const R = await import('../../public/v2/office/layout-rules.js');
    const { indexManifest } = await import('../../public/v2/office/assets.js');
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/manifest.example.json'), 'utf8'));
    const layout = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/layout.example.json'), 'utf8'));
    const idx = indexManifest(manifest);
    const bad = { ...layout, agents: layout.agents.filter((a) => a.agentId !== 'main') };
    const fmt = await import('../../public/v2/fmt.js');
    try {
      fmt.setLocale('en-CA');
      assert.equal(S.locale(), 'en');
      assert.ok(R.validateLayout(bad, idx).some((e) => e.code === 'no-main' && e.message === 'The main agent’s rule is missing'));
      fmt.setLocale('fr-CA');
      assert.ok(R.validateLayout(bad, idx).some((e) => e.code === 'no-main' && e.message === 'Il manque la règle de l’agent principal'));
    } finally { fmt.setLocale('fr-CA'); }
    assert.equal(R.RULES_FR['err.no-main'], 'Il manque la règle de l’agent principal');
  });
});
