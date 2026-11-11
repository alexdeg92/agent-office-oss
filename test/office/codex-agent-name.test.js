'use strict';
// A codex project agent with a live conversation must not appear twice in Office under the same
// project name (the second copy numbered " · 2" with a phantom "…'s team").
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { settingsFixture } = require('../helpers/settings-fixture'), { waitFor } = require('../helpers/harness');

test('one codex project agent with no team is named once, without a " · 2" twin', async t => {
  const h = await settingsFixture({ effectiveV3: true }); t.after(() => h.close());
  const home = path.join(h.tmp, '.codex'), cwd = path.join(h.tmp, 'Dev', 'synthetic-codex-project');
  const rollout = path.join(home, 'sessions', '2026', '11', '11', 'rollout-2026-11-11T10-00-00-11111111-1111-4111-8111-111111111111.jsonl');
  fs.mkdirSync(path.dirname(rollout), { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  const at = new Date().toISOString();
  fs.writeFileSync(rollout, [
    { type: 'session_meta', payload: { id: '11111111-1111-4111-8111-111111111111', timestamp: at, cwd, originator: 'codex-cli', cli_version: '0.synthetic', source: 'cli', model_provider: 'openai' } },
    { type: 'turn_context', payload: { model: 'gpt-synthetic', cwd, current_date: '2026-11-11', timezone: 'UTC', approval_policy: 'never', sandbox_policy: 'synthetic' } },
    { type: 'response_item', timestamp: at, payload: { type: 'message', id: 'u1', role: 'user', content: [{ type: 'input_text', text: 'Synthetic codex task' }], status: 'completed' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  // Codex keeps thread names outside the rollout, in $CODEX_HOME/session_index.jsonl.
  fs.writeFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', thread_name: 'Synthetic thread', updated_at: at }) + '\n');
  await h.reauth();
  const saved = await h.put('/api/v3/settings/runtimes', { expectedRevision: 1, runtimes: [{ id: 'legacy', adapter: 'openclaw', enabled: true, gatewayUrl: h.gw.url },
    { id: 'codex', adapter: 'codex', enabled: true, home, include: '', exclude: '', agentGrouping: 'project' }] });
  assert.equal(saved.status, 200, saved.text);
  await waitFor(() => h.engine.sessions().some(s => s.key.startsWith('rt:codex:') && s.displayName));
  for (const v of [2, 3]) {
    const office = await h.get(`/api/v${v}/views/office`); assert.equal(office.status, 200, office.text);
    const names = office.json.data.occupants.map(row => typeof row.name === 'string' ? row.name : row.name?.params?.text ?? row.title?.params?.text ?? null);
    assert.ok(!names.some(name => / · \d+$/.test(name || '') && /synthetic/.test(name)), `v${v} no numbered twin: ${names}`);
    assert.equal(names.filter(name => name === 'synthetic-codex-project').length, 1, `v${v} the project agent keeps its folder name once`);
    assert.ok(names.includes('Synthetic thread'), `v${v} the live conversation is named by its codex thread: ${names}`);
  }
});
