// Platform direction (BRIEF, PM on Owner's product direction): the agent's name is data. UI code (pages, components,
// shell, router) must not contain « Timmy »; mocks and the office (office-dev) are out of scope here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uiCodeFiles } from './helpers/ui-files.js';

const V2 = fileURLToPath(new URL('../../public/v2/', import.meta.url));
function timmyHits(root) {
  const hits = [];
  for (const f of uiCodeFiles(root)) readFileSync(join(root, f), 'utf8').split('\n').forEach((line, i) => { if (/timmy/i.test(line) && !/with-timmy/.test(line)) hits.push(`${f}:${i + 1}`); });
  return hits;
}

test('no « Timmy » literal in /v2 UI code', () => {
  const files = uiCodeFiles(V2);
  for (const name of ['index', 'switch', 'styles', 'control-id']) assert.ok(files.includes(`components/bureau/${name}.js`), name+' is checked');
  const hits = timmyHits(V2);
  assert.deepEqual(hits, [], 'use agentName() / withAgent() from i18n.js');
});

test('platform scan detects literals in nested components and ignores directories and out-of-scope mocks', () => {
  const root = mkdtempSync(join(tmpdir(), 'ao-platform-'));
  const canary = 'Tim' + 'my'; // Assemble intentional test data, as the portability scanner does.
  try {
    for (const dir of ['pages', 'components/bureau/deep/empty.js', 'mock']) mkdirSync(join(root, dir), {recursive:true});
    writeFileSync(join(root, 'app.js'), 'export const title="Bureau";');
    writeFileSync(join(root, 'components/bureau/deep/switch.js'), `export const label="${canary}";`);
    writeFileSync(join(root, 'mock/agent.js'), `export const name="${canary}";`);
    assert.deepEqual(uiCodeFiles(root), ['app.js', 'components/bureau/deep/switch.js']);
    assert.deepEqual(timmyHits(root), ['components/bureau/deep/switch.js:1']);
  } finally { rmSync(root, {recursive:true, force:true}); }
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
