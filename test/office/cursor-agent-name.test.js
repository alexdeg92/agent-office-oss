'use strict';
// A Cursor project agent with a live chat must not appear twice in Office under the same
// project name (the second copy numbered " · 2"). The chat title is a runtime summarySource.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { settingsFixture } = require('../helpers/settings-fixture'), { waitFor } = require('../helpers/harness');

test('one Cursor project agent with no team is named once, without a " · 2" twin', async t => {
  const h = await settingsFixture({ effectiveV3: true }); t.after(() => h.close());
  const home = path.join(h.tmp, '.cursor'), cwd = path.join(h.tmp, 'Dev', 'synthetic-cursor-project');
  const ws = 'a'.repeat(32), chatId = '11111111-1111-4111-8111-111111111111';
  const dir = path.join(home, 'chats', ws, chatId);
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  const at = Date.now();
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    schemaVersion: 1, createdAtMs: at - 60_000, updatedAtMs: at - 1_000,
    hasConversation: true, title: 'Synthetic Cursor thread', cwd,
  }));
  const db = new DatabaseSync(path.join(dir, 'store.db'));
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);');
  db.close();
  await h.reauth();
  const saved = await h.put('/api/v3/settings/runtimes', { expectedRevision: 1, runtimes: [{ id: 'legacy', adapter: 'openclaw', enabled: true, gatewayUrl: h.gw.url },
    { id: 'cursor', adapter: 'cursor', enabled: true, home, include: '', exclude: '', agentGrouping: 'project' }] });
  assert.equal(saved.status, 200, saved.text);
  await waitFor(() => h.engine.sessions().some(s => s.key.startsWith('rt:cursor:') && s.displayName && s.summarySource === 'runtime'));
  for (const v of [2, 3]) {
    const office = await h.get(`/api/v${v}/views/office`); assert.equal(office.status, 200, office.text);
    const names = office.json.data.occupants.map(row => typeof row.name === 'string' ? row.name : row.name?.params?.text ?? row.title?.params?.text ?? null);
    assert.ok(!names.some(name => / · \d+$/.test(name || '') && /synthetic/i.test(name || '')), `v${v} no numbered twin: ${names}`);
    assert.equal(names.filter(name => name === 'synthetic-cursor-project').length, 1, `v${v} the project agent keeps its folder name once`);
    assert.ok(names.includes('Synthetic Cursor thread'), `v${v} the live chat is named by its Cursor title: ${names}`);
  }
});
