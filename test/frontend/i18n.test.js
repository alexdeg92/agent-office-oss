// LabelRef rendering (BRIEF, PM on frontend-02): params are raw data; a param may itself be a LabelRef.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setMeta, t, label, msg, rich, setLang, negotiate, messageKeys } from '../../public/v2/i18n.js';
import { MESSAGES, duplicateKeys } from '../../public/v2/messages.js';
import { LABELS_EN } from '../../public/v2/locales/labels.en.js';

const NB = ' ';
setMeta({ labels: {
  'historyKind.status': '{actor} a déplacé le projet : {from} → {to}.',
  'projectStatus.todo': 'À faire', 'projectStatus.in-progress': 'En cours',
  'historyKind.flow-run.failed': 'Flux {job} exécuté par {actor} : échec après {duration}.',
  'historyKind.session': 'Session {session} : {messages} messages, {tokens} jetons.',
  'risk.stale': 'Inactif depuis {n} j', 'historyKind.risk-raised': 'Risque levé : {risk}.',
  'loop': 'boucle {x}',
}, enums: {} });

test('status keys arrive as LabelRefs and resolve recursively', () => {
  assert.equal(t('historyKind.status', { actor: 'Owner', from: { key: 'projectStatus.todo' }, to: { key: 'projectStatus.in-progress' } }), 'Owner a déplacé le projet : À faire → En cours.');
  assert.equal(label({ key: 'historyKind.risk-raised', params: { risk: { key: 'risk.stale', params: { n: 21 } } } }), 'Risque levé : Inactif depuis 21 j.');
});

test('numbers use fr-CA grouping; ISO durations are spelled out', () => {
  assert.equal(label({ key: 'historyKind.session', params: { session: 'veille-2', messages: 14, tokens: 22104 } }), `Session veille-2 : 14 messages, 22${NB}104 jetons.`);
  assert.equal(label({ key: 'historyKind.flow-run.failed', params: { job: 'Factures', actor: 'Timmy', duration: 'PT45S' } }), `Flux Factures exécuté par Timmy : échec après 45${NB}s.`);
});

test('R12-07: an unknown key renders as « Autre (id) » / « Other (id) », never the raw key; recursion is bounded', () => {
  assert.equal(t('channel.signal'), 'Autre (signal)');
  assert.equal(t('provider.<b>x</b>'), 'Autre (bx/b)', 'the id is reduced to safe characters');
  setLang('en');
  assert.equal(t('channel.signal'), 'Other (signal)');
  setLang('fr');
  assert.equal(label('déjà du texte'), 'déjà du texte');
  assert.equal(label(null), '');
  let ref = { key: 'loop', params: { x: 'fin' } };
  for (let i = 0; i < 10; i++) ref = { key: 'loop', params: { x: ref } };
  assert.match(label(ref), /^boucle boucle boucle boucle boucle loop$/);
});

// ---- F6: the UI message registry and the en locale ----

const varsOf = (v) => (typeof v === 'string' ? { _: v } : Object.fromEntries(Object.entries(v).filter(([k]) => k !== '$count')));
const paramsOf = (str) => [...str.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('no key is defined twice across messages.js and the page-owned parts (messages/*.js)', () => {
  assert.deepEqual(duplicateKeys('fr'), []);
  assert.deepEqual(duplicateKeys('en'), []);
});

test('fr and en have the same keys, plural variants and (per variant) the same named params', () => {
  assert.deepEqual(messageKeys('en').sort(), messageKeys('fr').sort());
  for (const k of messageKeys('fr')) {
    const fr = varsOf(MESSAGES.fr[k]), en = varsOf(MESSAGES.en[k]);
    assert.deepEqual(Object.keys(en).sort(), Object.keys(fr).sort(), k + ': variants');
    for (const v of Object.keys(fr)) {
      // a variant may spell its count out (« un compte » / « one account ») instead of using {n}
      const strip = (s) => s.split(',').filter((p) => p !== (MESSAGES.fr[k].$count || 'n')).join(',');
      assert.equal(strip(paramsOf(en[v])), strip(paramsOf(fr[v])), `${k}.${v}: params`);
    }
    if (typeof MESSAGES.fr[k] === 'object') assert.equal(MESSAGES.en[k].$count, MESSAGES.fr[k].$count, k + ': $count');
  }
});

test('G3c: the server ships English for every label; the client mirror is a fallback that never invents keys', () => {
  const req = createRequire(import.meta.url);
  const { LABELS } = req('../../src/i18n/fr.js');
  const EN = req('../../src/i18n/en.js').LABELS;
  assert.deepEqual(Object.keys(LABELS).filter((k) => !(k in EN)), [], 'src/i18n/en.js covers fr.js');
  assert.deepEqual(Object.keys(LABELS_EN).filter((k) => !(k in LABELS)), [], 'no mirror key the server does not know');
});

test('G3c: labels that arrive in English (MetaVM.locale en) win over the mirror; French labels in an English UI fall back to it', () => {
  setLang('en');
  setMeta({ locale: 'en', labels: { 'healthCard.cpu': 'CPU (server)' }, enums: {} });
  assert.equal(t('healthCard.cpu'), 'CPU (server)');
  setMeta({ locale: 'fr', labels: { 'healthCard.cpu': 'Processeur' }, enums: {} });
  assert.equal(t('healthCard.cpu'), LABELS_EN['healthCard.cpu'], 'an older server or the mocks: the mirror fills in');
  setLang('fr');
  assert.equal(t('healthCard.cpu'), 'Processeur');
});

test('msg: plural variants, zero, typed params, lists, {agent}; rich keeps params apart', () => {
  setMeta({ labels: { 'source.cli': 'CLI OpenClaw', 'source.host': 'Hôte' }, enums: {} });
  assert.equal(msg('bulletin.stand.issues', { n: 0 }), 'Aucun problème de données n’est ouvert.');
  assert.equal(msg('bulletin.stand.issues', { n: 1 }), 'Un problème de données est ouvert.');
  assert.equal(msg('bulletin.stand.issues', { n: 1200 }), `1${NB}200 problèmes de données sont ouverts.`);
  assert.equal(msg('bulletin.head.sourcesStale', { n: 2, names: [{ key: 'source.cli' }, { key: 'source.host' }] }), `2 sources de données sont à actualiser${NB}: CLI OpenClaw et Hôte.`);
  assert.equal(msg('bulletin.card.cpu.cores', { value: { n: 17, unit: 'percent' }, cores: 8 }), `Utilisation du processeur${NB}: 17${NB}%. Nombre de cœurs${NB}: 8.`);
  assert.deepEqual(rich('bulletin.stand.sources', { fresh: 5, n: 6 }, (name, text) => `[${name}:${text}]`), [`Sources à jour${NB}: `, '[fresh:5]', ' sur ', '[n:6]', '.']);
  setLang('en');
  assert.equal(msg('bulletin.head.sourcesStale', { n: 2, names: [{ key: 'source.cli' }, { key: 'source.host' }] }), '2 data sources are out of date: Command-line interface and Host.');
  assert.equal(msg('bulletin.card.cpu.cores', { value: { n: 17, unit: 'percent' }, cores: 8 }), 'Processor usage: 17%. Core count: 8.');
  assert.equal(msg('bulletin.stand.issues', { n: 1200 }), '1,200 data issues are open.');
  assert.equal(msg('bulletin.stand.sources', { fresh: 1, n: 6 }), 'Up-to-date sources: 1 of 6.');
  setLang('fr');
});

test('language: the explicit FR/EN choice, else French; the browser language never decides (PM, 2026-10-06)', () => {
  assert.equal(negotiate('en'), 'en');
  assert.equal(negotiate('fr'), 'fr');
  assert.equal(negotiate(null, ['en-US', 'en']), 'fr', 'an English phone still gets French by default');
  assert.equal(negotiate('xx', ['en-GB']), 'fr');
  assert.equal(negotiate(undefined), 'fr');
});

test('frontend-27: missing localized messages fall back to French, unknown keys never leak, warning once', () => {
  const key='projects.prio.all', saved=MESSAGES.en[key], warnings=[], warn=console.warn;
  try {
    console.warn=(...args)=>warnings.push(args);
    delete MESSAGES.en[key];setLang('en');
    assert.equal(msg(key),MESSAGES.fr[key]);assert.equal(msg(key),MESSAGES.fr[key]);
    assert.equal(msg('missing.frontend27'),MESSAGES.fr['common.translationMissing']);
    assert.equal(msg('missing.frontend27'),MESSAGES.fr['common.translationMissing']);
    assert.equal(warnings.filter((w)=>w.includes(key)).length,1);
    assert.equal(warnings.filter((w)=>w.includes('missing.frontend27')).length,1);
  } finally {MESSAGES.en[key]=saved;console.warn=warn;setLang('fr');}
});
