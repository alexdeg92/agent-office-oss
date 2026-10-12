'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { settingsFixture } = require('../helpers/settings-fixture');
const BASE = '/api/v3/settings';
const detection = (configPath, gatewayUrl) => [{ runtime: 'openclaw', name: 'OpenClaw', found: true, confidence: 'config', checkedPaths: [configPath], connection: { gatewayUrl, tokenSet: false }, agents: [{ id: 'found-agent', name: 'Found agent' }] }];

test('configured legacy OpenClaw and the same detected gateway produce one instance and one diagnostic', async t => {
  const h = await settingsFixture({ effectiveV3: true }); t.after(() => h.close());
  const r = await h.post(BASE + '/detect'); assert.equal(r.status, 200, r.text);
  const rows = r.json.data.vm.runtimes.filter(r => r.adapter === 'openclaw');
  assert.equal(rows.length, 1); assert.equal(rows[0].id, 'legacy'); assert.equal(rows[0].candidate, false);
  assert.equal(rows[0].confidence, 'config'); assert.deepEqual(rows[0].checkedPaths, [h.env.OC_CONFIG]);
  assert.equal(r.json.data.vm.diagnostics.filter(d => d.id.startsWith('runtime:') && d.label.params?.runtime === 'OpenClaw').length, 1);
});

test('normalized config path merges even when detected gateway differs from the live connection', async t => {
  const h = await settingsFixture({ effectiveV3: true, detect: ({ env }) => detection(path.join(env.HOME, '.openclaw', '..', '.openclaw', 'openclaw.json'), 'ws://127.0.0.1:19999') }); t.after(() => h.close());
  const r = await h.post(BASE + '/detect'); assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.data.vm.runtimes.filter(r => r.adapter === 'openclaw').map(r => r.id), ['legacy']);
});

test('normalized gateway merges without a matching config path', async t => {
  const h = await settingsFixture({ effectiveV3: true, detect: ({ env }) => {
    const cfg = JSON.parse(require('node:fs').readFileSync(path.join(env.HOME, 'config', 'unused.json'), 'utf8'));
    return detection(path.join(env.HOME, 'other', 'openclaw.json'), cfg.url + '/');
  }, config(config, { tmp, gw }) {
    require('node:fs').mkdirSync(path.join(tmp, 'config')); require('node:fs').writeFileSync(path.join(tmp, 'config', 'unused.json'), JSON.stringify({ url: gw.url }));
  } }); t.after(() => h.close());
  const r = await h.post(BASE + '/detect'); assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.data.vm.runtimes.filter(r => r.adapter === 'openclaw').map(r => r.id), ['legacy']);
});

test('a genuinely different detected OpenClaw remains a candidate and does not donate agents to legacy', async t => {
  const h = await settingsFixture({ effectiveV3: true, detect: ({ env }) => detection(path.join(env.HOME, 'other', 'openclaw.json'), 'ws://127.0.0.1:19999') }); t.after(() => h.close());
  const r = await h.post(BASE + '/detect'); assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.data.vm.runtimes.filter(r => r.adapter === 'openclaw').map(r => [r.id, r.candidate]), [['legacy', false], ['openclaw', true]]);
  assert.equal(r.json.data.vm.agents.some(a => a.runtime === 'legacy' && a.agentId === 'found-agent'), false);
});

test('inactive demo is absent; enabled demo remains visible', async t => {
  const h = await settingsFixture({ effectiveV3: true }); t.after(() => h.close());
  assert.equal((await h.get(BASE)).json.data.runtimes.some(r => r.adapter === 'demo'), false);
  await h.reauth(); const r = await h.put(BASE + '/runtimes', { expectedRevision: 1, runtimes: [{ id: 'demo-team', adapter: 'demo', enabled: true }] });
  assert.equal(r.status, 200, r.text); assert.ok(r.json.data.vm.runtimes.some(r => r.id === 'demo-team' && r.enabled));
});

test('several configured sources keep their stable identities; an unmatched candidate cannot collide with a saved ID', () => {
  const { runtimeDetections } = require('../../src/settings/runtime-detections');
  const config = { runtimes: [{ id: 'openclaw', adapter: 'openclaw', enabled: true }, { id: 'lab', adapter: 'openclaw', enabled: true }] };
  const cfg = { runtimeInstances: config.runtimes.map((r, i) => ({ id: r.id, cfg: { gatewayUrl: 'ws://127.0.0.1:' + (19000 + i) } })) };
  let rows = runtimeDetections({ config, cfg, detections: detection('/tmp/synthetic-config/openclaw.json', 'ws://127.0.0.1:19001') });
  assert.deepEqual(rows.filter(r => r.entry.adapter === 'openclaw').map(r => [r.entry.id, !!r.detection]), [['openclaw', false], ['lab', true]]);
  rows = runtimeDetections({ config, cfg, detections: detection('/tmp/synthetic-other/openclaw.json', 'ws://127.0.0.1:19999') });
  const candidates = rows.filter(r => r.entry.adapter === 'openclaw');
  assert.equal(candidates.length, 3); assert.equal(new Set(candidates.map(r => r.entry.id)).size, 3);
  assert.equal(candidates.filter(r => !r.entry.candidate && r.detection).length, 0);
});
