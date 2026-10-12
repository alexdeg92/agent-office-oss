'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { settingsFixture } = require('../helpers/settings-fixture');
const BASE = '/api/v3/settings';

test('detected Claude candidate uses its synthetic home and connection test reports projects', async t => {
  const h = await settingsFixture({ effectiveV3: true }); t.after(() => h.close());
  const home = path.join(h.tmp, '.claude'), project = path.join(home, 'projects', 'synthetic-project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'synthetic-session.jsonl'), JSON.stringify({ type: 'user', uuid: 'synthetic-event', sessionId: 'synthetic-session',
    timestamp: new Date().toISOString(), message: { role: 'user', content: 'Synthetic transcript' } }) + '\n');
  const detected = await h.post(BASE + '/detect'); assert.equal(detected.status, 200, detected.text);
  const row = detected.json.data.vm.runtimes.find(r => r.adapter === 'claude-code');
  assert.ok(row?.found, 'Claude Code is detected in the synthetic HOME');
  assert.equal(row.values.home.value, home, 'the connection draft is prefilled from the checked Claude directory');
  await h.reauth();
  const check = await h.post(BASE + '/check', { runtime: { id: row.id, adapter: 'claude-code', home: row.values.home.value,
    include: row.values.include.value || '', exclude: row.values.exclude.value || '', agentGrouping: row.values.agentGrouping.value || 'project' } });
  assert.equal(check.status, 200, check.text); assert.equal(check.json.data.result.ok, true);
  assert.equal(check.json.data.result.projectCount, 1);
  assert.equal(check.json.data.result.fileCount, 1);
  const saved = await h.put(BASE + '/runtimes', { expectedRevision: detected.json.data.vm.revision, runtimes: [
    { id: 'legacy', adapter: 'openclaw', enabled: true, gatewayUrl: h.gw.url },
    { id: row.id, adapter: 'claude-code', enabled: true, home: row.values.home.value, include: '', exclude: '', agentGrouping: 'project' },
  ] });
  assert.equal(saved.status, 200, saved.text);
  await require('../helpers/harness').waitFor(() => h.engine.agents().some(a => a.id.startsWith('rt:claude-code:')));
  assert.equal(h.engine.agents().filter(a => a.id.startsWith('rt:claude-code:')).length, 1);
});

test('Claude connection check explains a fully unsupported synthetic transcript without exposing its contents', async t => {
  const h = await settingsFixture({ effectiveV3: true }); t.after(() => h.close());
  const home = path.join(h.tmp, '.claude'), project = path.join(home, 'projects', 'synthetic-unknown-project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'synthetic-unknown-session.jsonl'), [
    { type: 'mode', privateValue: 'SYNTHETIC_PRIVATE_SENTINEL' },
    { type: 'future-line-type', privateValue: 'SYNTHETIC_PRIVATE_SENTINEL' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  await h.reauth();
  const check = await h.post(BASE + '/check', { runtime: { id: 'claude-local', adapter: 'claude-code', home,
    include: '', exclude: '', agentGrouping: 'project' } });
  assert.equal(check.status, 200, check.text);
  assert.deepEqual(check.json.data.result, { ok: false, status: 'unsupported-format', protocol: null, latencyMs: null,
    projectCount: 1, fileCount: 1, ignoredLineCount: 2, unknownLineTypeCount: 1, unknownKeyCount: 2,
    unknownContentBlockCount: 0, reasonCode: 'no-recognizable-session-lines' });
  assert.equal(JSON.stringify(check.json).includes('SYNTHETIC_PRIVATE_SENTINEL'), false);
});
