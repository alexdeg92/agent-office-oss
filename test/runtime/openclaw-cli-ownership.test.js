'use strict';
// OpenClaw runs Claude Code as an agent backend and records the Claude session it resumes. Those recorded
// sessions are the OpenClaw agent's work: the Claude Code connector must not show them as an extra agent.
// Claude work OpenClaw did not record (even under .openclaw) stays visible.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { settingsFixture } = require('../helpers/settings-fixture'), { waitFor } = require('../helpers/harness');

const uuid = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const CANARY = 'PRIVATE_OPENCLAW_SUMMARY_CANARY';
function claudeSession(home, cwd, sessionId) {
  const dir = path.join(home, 'projects', cwd.replace(/[/.]/g, '-')); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sessionId + '.jsonl'), JSON.stringify({ type: 'user', uuid: 'u-' + sessionId, sessionId, cwd,
    timestamp: new Date().toISOString(), message: { role: 'user', content: 'Synthetic' } }) + '\n');
}
function openclawStore(state, agentId, rows) {
  const file = path.join(state, 'agents', agentId, 'agent', 'openclaw-agent.sqlite'); fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, entry_json TEXT)');
  for (const [key, entry] of rows) db.prepare('INSERT INTO session_nodes VALUES (?, ?)').run(key, JSON.stringify(entry));
  db.close();
  return file;
}

test('Claude sessions OpenClaw recorded as its CLI runs are not a second agent; unbound Claude work under .openclaw and elsewhere stays', async t => {
  let workspace, store, kept;
  // The OpenClaw store and Claude transcripts exist before boot, as on a real install: OpenClaw reads its
  // CLI bindings once its agent list is known, then every minute.
  const h = await settingsFixture({ effectiveV3: true, config: (config, { tmp }) => {
    const state = path.join(tmp, '.openclaw'), home = path.join(tmp, '.claude');
    // The workspace the OpenClaw gateway reports for its agent (fake gateway scenario); transcripts only record it.
    workspace = '/srv/acme/workspace-atlas';
    const oldLayout = path.join(state, 'openclaw', 'workspace'), personal = path.join(state, 'personal-project'), other = path.join(tmp, 'Dev', 'unrelated-project');
    for (const dir of [oldLayout, personal, other]) fs.mkdirSync(dir, { recursive: true });
    const bound = uuid('a'), resumed = uuid('b'), old = uuid('c'), unrelated = uuid('d'), own = uuid('e');
    claudeSession(home, workspace, bound); claudeSession(home, workspace, resumed); claudeSession(home, oldLayout, old); claudeSession(home, other, unrelated); claudeSession(home, personal, own);
    store = openclawStore(state, 'atlas', [['agent:atlas:main', { sessionId: 'oc-1', activitySummary: CANARY,
      cliSessionIds: { 'claude-cli': bound }, cliSessionBindings: { 'claude-cli': { sessionId: bound, cwdHash: 'x' } } }],
      ['agent:atlas:older', { sessionId: 'oc-2', cliSessionBindings: { 'claude-cli': { sessionId: resumed } } }]]);
  } }); t.after(() => h.close());
  const home = path.join(h.tmp, '.claude');
  const before = fs.readdirSync(path.dirname(store)).sort();
  await h.reauth();
  const saved = await h.put('/api/v3/settings/runtimes', { expectedRevision: 1, runtimes: [{ id: 'legacy', adapter: 'openclaw', enabled: true, gatewayUrl: h.gw.url },
    { id: 'claude', adapter: 'claude-code', enabled: true, home, include: '', exclude: '', agentGrouping: 'project' }] });
  assert.equal(saved.status, 200, saved.text);
  await waitFor(() => h.engine.agents().some(a => a.id.startsWith('rt:claude:') && a.name === 'unrelated-project'));
  kept = ['personal-project', 'unrelated-project', 'workspace'];
  // The OpenClaw runtime reads its CLI bindings itself once its agent list is known.
  await waitFor(() => !h.engine.agents().some(a => a.id.startsWith('rt:claude:') && !kept.includes(a.name)));
  const claudeAgents = h.engine.agents().filter(a => a.id.startsWith('rt:claude:'));
  assert.deepEqual(claudeAgents.map(a => a.name).sort(), kept, 'only the recorded OpenClaw runs leave; unbound runs (old layout, personal, unrelated) stay');
  assert.equal(h.engine.sessions().filter(s => s.key.startsWith('rt:claude:')).length, 3, 'the two bound sessions leave the Claude connector');
  assert.ok(h.engine.sessions().some(s => s.key.startsWith('rt:legacy:')), 'OpenClaw keeps its own sessions');
  for (const v of [2, 3]) {
    const office = await h.get(`/api/v${v}/views/office`); assert.equal(office.status, 200, office.text);
    const names = office.json.data.occupants.map(row => row.name);
    assert.ok(names.includes('unrelated-project') && names.includes('personal-project'), `v${v}: ${names}`);
    assert.ok(!names.includes('workspace-atlas'), `v${v} no CLI twin of the OpenClaw agent: ${names}`);
    assert.ok(!JSON.stringify(office.json).includes(CANARY));
  }
  assert.deepEqual(fs.readdirSync(path.dirname(store)).sort(), before, 'the OpenClaw store is read with nothing written beside it');
});
