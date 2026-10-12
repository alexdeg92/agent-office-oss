'use strict';
// G3c (explorer-06): the server's English labels, selected by preference then Accept-Language.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fr = require('../../src/i18n/fr');
const en = require('../../src/i18n/en');
const { resolveLocale, fromAcceptLanguage, labelsFor } = require('../../src/i18n');
const { openDatabase } = require('../../src/store/db');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');

const placeholders = (t) => [...String(t).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n · the English registry', () => {
  it('keeps the canonical conversation kind localized in the v2 client dictionary', () => {
    assert.equal(labelsFor('fr', 2)['sessionKind.conversation'], 'Conversation');
    assert.equal(labelsFor('en', 2)['sessionKind.conversation'], 'Conversation');
  });
  it('has exactly the French keys, the same placeholders, and no French left in it', () => {
    assert.deepEqual(Object.keys(en.LABELS).sort(), Object.keys(fr.LABELS).sort());
    const mismatched = Object.keys(fr.LABELS).filter((k) => placeholders(fr.LABELS[k]).join() !== placeholders(en.LABELS[k]).join());
    assert.deepEqual(mismatched, []);
    assert.equal(en.ENUMS, fr.ENUMS);
    const frenchy = Object.entries(en.LABELS).filter(([, v]) => /[àâçéèêëîïôûùœ]|« | »/.test(v)).map(([k]) => k);
    assert.deepEqual(frenchy, []);
  });
  it('no runtime name or agent name in generic labels (explorer-06)', () => {
    for (const L of [fr.LABELS, en.LABELS]) {
      const leaks = Object.entries(L).filter(([k, v]) => /OpenClaw|Timmy/.test(v) && !/^(channel|source\.github|discordChannelType)\./.test(k)).map(([k]) => k);
      assert.deepEqual(leaks, []);
    }
  });
  it('locale: the preference wins, else the best Accept-Language, else fr', () => {
    assert.equal(fromAcceptLanguage('en-CA,en;q=0.9,fr;q=0.8'), 'en');
    assert.equal(fromAcceptLanguage('fr-CA,fr;q=0.9,en;q=0.8'), 'fr');
    assert.equal(fromAcceptLanguage('de-DE,en;q=0.5'), 'en');
    assert.equal(fromAcceptLanguage('de-DE'), null);
    assert.equal(resolveLocale({ pref: 'fr', acceptLanguage: 'en' }), 'fr');
    assert.equal(resolveLocale({ pref: null, acceptLanguage: 'en-US' }), 'en');
    assert.equal(resolveLocale({}), 'fr');
  });
  it('locale: the language the client asks for wins over a preference stored from another device (frontend-23)', () => {
    assert.equal(resolveLocale({ explicit: 'fr', pref: 'en', acceptLanguage: 'en-US' }), 'fr');
    assert.equal(resolveLocale({ explicit: 'en', pref: 'fr' }), 'en');
    assert.equal(resolveLocale({ explicit: 'xx', pref: 'en' }), 'en', 'an unsupported value is ignored');
  });
});

describe('i18n · migration 006 keeps the preferences', () => {
  it('an existing uiTheme survives the table rebuild; locale is accepted after it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-006-'));
    try {
      const pre = openDatabase({ dir, instance: 'test', migrationsDir: (() => {
        const d = path.join(dir, 'm'); fs.mkdirSync(d);
        for (const f of fs.readdirSync(path.join(__dirname, '..', '..', 'src', 'store', 'migrations'))) if (Number(f.slice(0, 3)) < 6) fs.copyFileSync(path.join(__dirname, '..', '..', 'src', 'store', 'migrations', f), path.join(d, f));
        return d; })() });
      pre.db.exec(`INSERT INTO ui_prefs (key, value_json, updated_at) VALUES ('uiTheme', '"dark"', 1)`);
      assert.throws(() => pre.db.exec(`INSERT INTO ui_prefs (key, value_json, updated_at) VALUES ('locale', '"en"', 1)`), /CHECK/);
      pre.close();
      const h = openDatabase({ dir, instance: 'test' });
      assert.deepEqual(h.applied, require('../../src/store/db').listMigrations().filter(m => m.version >= 6).map(m => m.version));
      assert.equal(h.db.prepare("SELECT value_json FROM ui_prefs WHERE key = 'uiTheme'").get().value_json, '"dark"');
      h.db.exec(`INSERT INTO ui_prefs (key, value_json, updated_at) VALUES ('locale', '"en"', 1)`);
      h.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('i18n · GET /api/v2/meta by locale (real server)', () => {
  let h;
  before(async () => { h = await startServer(loadScenario('synthetic-basic')); });
  after(async () => { if (h) await h.stop(); });
  const meta = (lang) => fetch(h.base + '/api/v2/meta', { headers: lang ? { 'accept-language': lang } : {} }).then((r) => r.json().then((j) => ({ j, vary: r.headers.get('vary') })));
  it('fr by default, en for an English browser, the preference over the browser; Vary: Accept-Language', async () => {
    let { j, vary } = await meta();
    assert.equal(j.data.locale, 'fr'); assert.equal(j.data.labels['weekday.1'], 'lundi'); assert.match(vary, /Accept-Language/);
    ({ j } = await meta('en-CA,en;q=0.9'));
    assert.equal(j.data.locale, 'en'); assert.equal(j.data.labels['weekday.1'], 'Monday'); assert.equal(j.data.runtime, null, 'anonymous metadata omits runtime enrichment');
    const owner = await h.request('GET', '/api/v2/meta?locale=en');
    assert.equal(owner.json.data.runtime.gatewayLabel, 'OpenClaw gateway', 'owner metadata still localizes runtime labels');
    assert.equal((await h.request('PATCH', '/api/v2/prefs', { locale: 'fr' })).status, 200);
    ({ j } = await meta('en-CA'));
    assert.equal(j.data.locale, 'fr', 'the preference wins');
    assert.equal((await h.request('PATCH', '/api/v2/prefs', { locale: 'de' })).status, 400);
    assert.deepEqual((await h.request('PATCH', '/api/v2/prefs', { locale: null })).json.data.result, { uiTheme: 'system', locale: null });
  });
  it('frontend-23: ?locale= (the UI language on this device) wins over a stored en preference', async () => {
    assert.equal((await h.request('PATCH', '/api/v2/prefs', { locale: 'en' })).status, 200);
    try {
      const j = await fetch(h.base + '/api/v2/meta?locale=fr', { headers: { 'accept-language': 'en-US' } }).then((r) => r.json());
      assert.equal(j.data.locale, 'fr');
      assert.equal(j.data.labels['liveEvent.run.succeeded'], '{occupant} a terminé une exécution.');
      assert.equal((await fetch(h.base + '/api/v2/meta').then((r) => r.json())).data.locale, 'en', 'without ?locale the preference still applies');
    } finally { await h.request('PATCH', '/api/v2/prefs', { locale: null }); }
  });
});

describe('Q03-A01 · generated session titles follow the UI language; genuine names stay as they are', () => {
  const { sessionTitle, sessionLabel } = require('../../src/api/v2/vm/logs');
  const render = (L, ref) => (L[ref.key] || ref.key).replace(/\{(\w+)\}/g, (_, k) => { const v = ref.params && ref.params[k]; return v == null ? '' : typeof v === 'object' ? render(L, v) : String(v); });
  const s = (kind, cls = {}, extra = {}) => Object.assign({ key: 'k:' + kind, displayName: null, class: Object.assign({ kind, heartbeatOf: null }, cls) }, extra);
  const names = { flowName: () => 'Veille hebdomadaire', interlocutorName: () => null };
  it('EN renders generated parts in English; FR rendering equals the 2.x label', () => {
    const cases = [[s('subagent', { subagentId: 'ffff0001' }), 'Subagent ffff'], [s('scheduled', { cronJobId: 'j' }), 'Scheduled task · Veille hebdomadaire'],
      [s('primary'), 'Main session'], [s('conversation-group', { interlocutorId: 'discord-channel:100000000000000002' }), 'Unnamed group · Discord'],
      [s('primary', { heartbeatOf: 'agent:main:main' }), 'Main session · heartbeat'], [s('explicit', { explicitKey: 'x' }, { displayName: 'Mon chantier' }), 'Mon chantier']];
    for (const [session, en_] of cases) {
      assert.equal(render(en.LABELS, sessionTitle(session, names)), en_);
      assert.equal(render(fr.LABELS, sessionTitle(session, names)), sessionLabel(session, names));
    }
  });
});

it('scoped subagent identities keep their native short display label in both contracts',()=>{
  const {sessionTitle}=require('../../src/api/v2/vm/logs'),{scopedId}=require('../../src/runtime-ids');
  const raw={class:{kind:'subagent',subagentId:'synthetic-worker'}};
  const scoped={class:{...raw.class,subagentId:scopedId('runtime-one','agent',raw.class.subagentId)}};
  assert.deepEqual(sessionTitle(scoped),sessionTitle(raw));
  assert.equal(sessionTitle(scoped).params.id,'synt');
});
