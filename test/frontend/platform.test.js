// Platform direction (BRIEF, PM on Owner's product direction): the agent's name is data. UI code (pages, components,
// shell, router) must not contain « Timmy »; mocks and the office (office-dev) are out of scope here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const V2 = fileURLToPath(new URL('../../public/v2/', import.meta.url));
const files = [...readdirSync(V2).filter((f) => f.endsWith('.js')), ...['pages', 'components'].flatMap((d) => readdirSync(join(V2, d)).map((f) => join(d, f)))];

test('no « Timmy » literal in /v2 UI code', () => {
  const hits = [];
  for (const f of files) readFileSync(join(V2, f), 'utf8').split('\n').forEach((line, i) => { if (/timmy/i.test(line) && !/with-timmy/.test(line)) hits.push(`${f}:${i + 1}`); });
  assert.deepEqual(hits, [], 'use agentName() / withAgent() from i18n.js');
});

test('agentName / withAgent: data first, the localized noun otherwise (never an id)', async () => {
  const i18n = await import('../../public/v2/i18n.js');
  i18n.setMeta({ labels: {}, enums: {} });
  assert.equal(i18n.agentName(), 'l’agent');
  assert.equal(i18n.withAgent('{agent} a terminé.'), 'L’agent a terminé.');
  assert.equal(i18n.withAgent('Parler avec {agent}.'), 'Parler avec l’agent.');
  i18n.setLang('en');
  assert.equal(i18n.withAgent('{agent} finished.'), 'The agent finished.');
  i18n.setLang('fr');
  i18n.setMeta({ labels: {}, enums: {}, primaryAgent: { id: 'atlas', name: 'Nova', avatarUrl: null } });
  assert.equal(i18n.withAgent('Que font {agent} et ses sous-agents ?'), 'Que font Nova et ses sous-agents ?');
  i18n.setMeta({ labels: {}, enums: {}, primaryAgent: { id: 'a1', name: 'éloïse', avatarUrl: null } });
  assert.equal(i18n.withAgent('{agent} a terminé.'), 'éloïse a terminé.', 'a supplied name keeps its own case (explorer-06)');
  assert.equal(i18n.msg('projects.risk', { name: 'chez lucie', reason: 'x' }).startsWith('chez lucie'), true);
  i18n.setMeta({ labels: {}, enums: {}, primaryAgent: { id: 'atlas', name: 'Nova', avatarUrl: null } });
  assert.equal(i18n.agentAvatar(), null);
});
