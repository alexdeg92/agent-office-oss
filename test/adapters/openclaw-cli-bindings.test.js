'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { readCliBindings, LIMITS } = require('../../src/adapters/openclaw/cli-bindings');

const CANARY = 'PRIVATE_OPENCLAW_SUMMARY_CANARY';
function store(state, agentId, rows) {
  const file = path.join(state, 'agents', agentId, 'agent', 'openclaw-agent.sqlite'); fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, entry_json TEXT NOT NULL)');
  for (const [key, entry] of rows) db.prepare('INSERT INTO session_nodes VALUES (?, ?)').run(key, typeof entry === 'string' ? entry : JSON.stringify(entry));
  db.close(); for (const name of fs.readdirSync(path.dirname(file))) if (name !== path.basename(file)) fs.rmSync(path.join(path.dirname(file), name));
  return file;
}
const sorted = rows => [...rows].sort((a, b) => a.sessionRef.localeCompare(b.sessionRef));

test('OpenClaw CLI bindings claim only the CLI session ids OpenClaw recorded, read-only', async t => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-oc-bindings-'))); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const state = path.join(tmp, '.openclaw'), workspace = path.join(state, 'workspace'); fs.mkdirSync(workspace, { recursive: true });
  const file = store(state, 'main', [
    ['a', { activitySummary: CANARY, cliSessionIds: { 'claude-cli': 'ref-1' }, cliSessionBindings: { 'claude-cli': { sessionId: 'ref-1' }, 'unknown-cli': { sessionId: 'ref-x' } } }],
    ['b', { cliSessionBindings: { 'codex-cli': { sessionId: 'ref-2' } } }],
    ['c', 'not json'], ['d', { cliSessionBindings: { 'claude-cli': { sessionId: 'bad ref with spaces' } } }],
  ]);
  const result = await readCliBindings({ stateDir: state, agents: [{ id: 'main', workspace }, { id: '../escape', workspace }] });
  assert.deepEqual(sorted(result.sessions), [{ agentId: 'main', runtimeKind: 'claude-code', sessionRef: 'ref-1' }, { agentId: 'main', runtimeKind: 'codex', sessionRef: 'ref-2' }]);
  assert.deepEqual(Object.keys(result), ['sessions'], 'ids only: no folder is ever claimed');
  assert.ok(!JSON.stringify(result).includes(CANARY), 'summaries never leave SQLite');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)], 'no -wal/-shm written beside the store');
  const linkDir = path.join(state, 'agents', 'linked', 'agent'); fs.mkdirSync(linkDir, { recursive: true }); fs.symlinkSync(file, path.join(linkDir, 'openclaw-agent.sqlite'));
  assert.deepEqual((await readCliBindings({ stateDir: state, agents: [{ id: 'linked' }] })).sessions, [], 'a symlinked store is refused');
  assert.deepEqual(await readCliBindings({ stateDir: 'relative', agents: [{ id: 'main' }] }), { sessions: [] });
});

test('the bindings read is bounded per store and stops opening stores once the claim budget is spent', async t => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-oc-bindings-bounds-')); t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  store(state, 'first', Array.from({ length: 50 }, (_, n) => ['k' + n, { cliSessionIds: { 'claude-cli': 'ref-' + String(n).padStart(2, '0') } }]));
  store(state, 'second', [['k', { cliSessionIds: { 'claude-cli': 'ref-second' } }]]);
  const newest = await readCliBindings({ stateDir: state, agents: [{ id: 'first' }], limits: { ...LIMITS, rowsPerStore: 3 } });
  assert.deepEqual(newest.sessions.map(row => row.sessionRef), ['ref-49', 'ref-48', 'ref-47'], 'only the newest rows of a store are read');
  const budget = await readCliBindings({ stateDir: state, agents: [{ id: 'first' }, { id: 'second' }], limits: { ...LIMITS, claims: 5 } });
  assert.equal(budget.sessions.length, 5); assert.ok(!budget.sessions.some(row => row.agentId === 'second'), 'the second store is not read once the budget is spent');
  const capped = await readCliBindings({ stateDir: state, agents: [{ id: 'first' }, { id: 'second' }], limits: { ...LIMITS, stores: 1 } });
  assert.ok(!capped.sessions.some(row => row.agentId === 'second'), 'stores beyond the cap are never opened');
});
