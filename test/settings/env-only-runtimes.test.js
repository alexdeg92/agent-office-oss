'use strict';
// An env-only install (no config.json; OpenClaw from OC_GATEWAY_URL/OC_GATEWAY_TOKEN) lists its runtime under the
// adapter kind until the first v3 save. The owner enables Claude Code and Codex and saves without re-entering the token.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { settingsFixture } = require('../helpers/settings-fixture');
const BASE = '/api/v3/settings';
async function envOnly(t) {
  const h = await settingsFixture({ envOnly: true }); t.after(() => h.close());
  const project = path.join(h.tmp, '.claude', 'projects', 'synthetic-project'); fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'session.jsonl'), JSON.stringify({ type: 'user', uuid: 'event', sessionId: 'session', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Synthetic' } }) + '\n');
  const rollout = path.join(h.tmp, '.codex', 'sessions', '2026', '10', '10', 'rollout-synthetic.jsonl'), timestamp = '2026-10-11T04:00:00.000Z', cwd = '/synthetic/project';
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, [{ type: 'session_meta', payload: { id: 'synthetic-codex', timestamp, cwd, originator: 'codex-cli', cli_version: '0.synthetic', source: 'cli', model_provider: 'openai' } },
    { type: 'turn_context', payload: { model: 'gpt-synthetic', cwd, current_date: '2026-10-11', timezone: 'UTC', approval_policy: 'never', sandbox_policy: 'synthetic' } }].map(r => JSON.stringify(r)).join('\n') + '\n');
  const cursorChat = path.join(h.tmp, '.cursor', 'chats', 'a'.repeat(32), '11111111-2222-4333-8444-555555555555');
  fs.mkdirSync(cursorChat, { recursive: true });
  fs.writeFileSync(path.join(cursorChat, 'meta.json'), JSON.stringify({ schemaVersion: 1, createdAtMs: Date.parse(timestamp), updatedAtMs: Date.parse(timestamp), hasConversation: true, title: 'Synthetic Cursor', cwd }));
  return h;
}
const homeFor = (h, kind) => path.join(h.tmp, kind === 'codex' ? '.codex' : kind === 'cursor' ? '.cursor' : '.claude');
const local = (h, kind, enabled = true) => ({ id: kind, adapter: kind, home: homeFor(h, kind), include: '', exclude: '', agentGrouping: 'project', name: kind, enabled });
// Exactly what Settings > Connection sends: the env runtime under its kind, its write-only token omitted.
const openclaw = (h, extra = {}) => ({ id: 'openclaw', adapter: 'openclaw', gatewayUrl: h.gw.url, name: 'OpenClaw', enabled: true, ...extra });

test('env-only install: enable Claude Code, Codex and Cursor, save without the OpenClaw token, then plan/apply integrations on saved instances', async t => {
  const h = await envOnly(t);
  let vm = (await h.get(BASE)).json.data;
  const env = vm.runtimes.find(r => r.adapter === 'openclaw');
  assert.equal(env.id, 'openclaw'); assert.equal(env.enabled, true); assert.equal(env.values.token.tokenSet, true); assert.equal(env.values.token.value, null);
  assert.equal(fs.existsSync(h.paths.file), false, 'no config.json before the first save');
  for (const [kind, dir] of [['claude-code', '.claude'], ['codex', '.codex'], ['cursor', '.cursor']]) assert.equal(vm.runtimes.find(r => r.id === kind).values.home.value, path.join(h.tmp, dir), kind + ' default home follows the service HOME');
  await h.reauth();
  // (1) Save: the env runtime keeps its 'legacy' identity and env token; new runtimes are probed on their own merits.
  const saved = await h.put(BASE + '/runtimes', { expectedRevision: vm.revision, runtimes: [local(h, 'claude-code'), local(h, 'codex'), local(h, 'cursor'), openclaw(h)] });
  assert.equal(saved.status, 200, saved.text);
  vm = saved.json.data.vm;
  assert.deepEqual(vm.runtimes.filter(r => r.enabled).map(r => r.id).sort(), ['claude-code', 'codex', 'cursor', 'legacy']);
  assert.ok(!vm.runtimes.some(r => r.id === 'openclaw'), 'no duplicate OpenClaw instance');
  const config = JSON.parse(fs.readFileSync(h.paths.file)), secrets = JSON.parse(fs.readFileSync(h.paths.secrets));
  assert.equal(config.version, 3); assert.deepEqual(config.runtimes.map(r => r.id).sort(), ['claude-code', 'codex', 'cursor', 'legacy']);
  assert.equal(secrets.runtimes.legacy.runtimeToken, h.fake.token); assert.equal(secrets.runtimes['claude-code'].runtimeToken, null); assert.equal(secrets.runtimes.codex.runtimeToken, null); assert.equal(secrets.runtimes.cursor.runtimeToken, null);
  assert.ok(!JSON.stringify(vm).includes(h.fake.token));
  // (2) Plans target the saved instances: Claude Code / Cursor have no project integration, the OpenClaw instance does.
  const claudePlan = await h.post(BASE + '/integrations/plan', { runtime: 'claude-code' });
  assert.equal(claudePlan.status, 200, claudePlan.text); assert.ok(claudePlan.json.data.result.agents.every(a => a.status === 'unsupported' && !a.files.length));
  const cursorPlan = await h.post(BASE + '/integrations/plan', { runtime: 'cursor' });
  assert.equal(cursorPlan.status, 200, cursorPlan.text); assert.ok(cursorPlan.json.data.result.agents.every(a => a.status === 'unsupported' && !a.files.length));
  const plan = await h.post(BASE + '/integrations/plan', { runtime: 'legacy', locale: 'fr' });
  assert.equal(plan.status, 200, plan.text);
  const target = plan.json.data.result.agents.find(a => a.files.length); assert.ok(target, plan.text);
  // (3) Apply that plan.
  const applied = await h.post(BASE + '/integrations/apply', { planId: plan.json.data.result.planId, agentIds: [target.id], confirmed: true });
  assert.equal(applied.status, 200, applied.text);
  assert.ok(target.files.every(f => fs.existsSync(f)));
});

test('env-only install: a newly enabled runtime fails its own check, not on runtime.token', async t => {
  const h = await envOnly(t); await h.reauth();
  const missing = { ...local(h, 'codex'), home: path.join(h.tmp, 'absent-codex-home') };
  const r = await h.put(BASE + '/runtimes', { expectedRevision: 1, runtimes: [openclaw(h), local(h, 'claude-code'), missing] });
  assert.equal(r.status, 502, r.text); assert.ok(!r.text.includes('runtime.token'), r.text);
  assert.equal(fs.existsSync(h.paths.file), false);
});

test('env-only install: the env token never carries over to another gateway or an instance the owner adds', async t => {
  const h = await envOnly(t); await h.reauth();
  const moved = await h.put(BASE + '/runtimes', { expectedRevision: 1, runtimes: [openclaw(h, { gatewayUrl: 'ws://127.0.0.1:9' })] });
  assert.equal(moved.status, 400, moved.text); assert.match(moved.text, /runtime\.token/);
  const added = await h.put(BASE + '/runtimes', { expectedRevision: 1, runtimes: [openclaw(h), openclaw(h, { id: 'openclaw-2', name: 'Second' })] });
  assert.equal(added.status, 400, added.text); assert.match(added.text, /runtime\.token/);
  assert.equal(fs.existsSync(h.paths.file), false);
});

test('v3 Settings candidates default their home to the service HOME, never the server user home', async t => {
  const h = await settingsFixture({ effectiveV3: true }); t.after(() => h.close());
  const vm = (await h.get(BASE)).json.data;
  for (const [kind, dir] of [['claude-code', '.claude'], ['codex', '.codex'], ['cursor', '.cursor']]) assert.equal(vm.runtimes.find(r => r.adapter === kind && r.candidate).values.home.value, path.join(h.tmp, dir), kind);
});
