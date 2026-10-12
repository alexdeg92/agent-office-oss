// Habilitations (F6, explorer-qa-03 Q03-F02/F06/F07): rules over AccessVM, in fr/en.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setMeta, setLang, msg, label } from '../../public/v2/i18n.js';
import * as rules from '../../public/v2/pages/access-rules.js';

const { LABELS } = createRequire(import.meta.url)('../../src/i18n/fr.js');
setMeta({ labels: LABELS, enums: {} });
const NB = ' ';
const EX = JSON.parse(readFileSync(new URL('../../docs/architecture/examples/access-vm.json', import.meta.url), 'utf8')).data;
const say = (list) => list.map((s) => msg(s.key, s.params)).join(' ');
const both = (fn) => { const fr = fn(); setLang('en'); const en = fn(); setLang('fr'); return { fr, en }; };
const text = (x) => ('msg' in x ? msg(x.msg, x.params) : label(x));

test('agents: inherited models are labelled; explicit and unknown models are plain; harness always wins (fr/en)', () => {
  const execution = (a) => { const x = rules.agentExecution(a); return typeof x === 'string' ? x : msg(x.msg, x.params); };
  assert.deepEqual(both(() => execution({ model: 'vendor/model', modelSource: 'inherited', runtime: null })),
    { fr: 'vendor/model (par défaut)', en: 'vendor/model (default)' });
  for (const modelSource of ['explicit', null]) assert.equal(execution({ model: 'vendor/model', modelSource }), 'vendor/model');
  assert.equal(execution({ model: 'vendor/model', modelSource: 'inherited', runtime: 'unlisted-harness' }), 'unlisted-harness');
  assert.equal(execution({ model: null, modelSource: 'inherited' }), 'Modèle par défaut');
  assert.equal(execution({ model: null, modelSource: null }), 'Non renseigné');
});

test('lead: the direct-message rule as received; the caveat that presence is not authorization', () => {
  const l = rules.lead(EX);
  assert.deepEqual(both(() => say(l.head)), { fr: `Politique des messages directs${NB}: appairage.`, en: 'Direct-message policy: pairing.' });
  assert.match(say(l.stand), /ne confirme pas son autorisation\.$/);
  assert.deepEqual(both(() => say(rules.lead({ policy: { dm: null, group: null, channelsEnabled: 0, channelsTotal: 0, execSecurity: null } }).head)),
    { fr: 'Les règles d’accès n’ont pas été reçues.', en: 'The access rules have not been received.' });
});

test('Q03-F06: access comes first and unknown stays unknown (never a yes or a no)', () => {
  const s = (access) => say(rules.accessSentences({ access }));
  assert.equal(s({ policy: 'pairing', enabled: null, requireMention: null }), `L’accès n’est pas confirmé. Politique reçue${NB}: appairage.`);
  assert.equal(s({ policy: 'allowlist', enabled: false, requireMention: true }), `Désactivé selon la configuration reçue. Politique reçue${NB}: liste autorisée. Une mention est requise.`);
  assert.equal(rules.accessSentences({ access: { enabled: null } })[0].tone, 'warning');
});

test('Q03-F07: a channel name gets exactly one « # »; nameless interlocutors get a localized short id', () => {
  assert.equal(rules.interlocutorName({ kind: 'discord-channel', name: '#projets' }), '#projets');
  assert.equal(rules.interlocutorName({ kind: 'discord-channel', name: 'projets' }), '#projets');
  assert.equal(rules.interlocutorName({ kind: 'discord-user', name: 'Guest' }), 'Guest');
  assert.deepEqual(both(() => text(rules.interlocutorName({ kind: 'discord-user', name: null, id: 'discord-user:100000000000000004' }))), { fr: 'Utilisateur …000004', en: 'User …000004' });
  assert.equal(text(rules.rules({ policy: { dm: null } })[0][1]), 'Non renseigné');
});
