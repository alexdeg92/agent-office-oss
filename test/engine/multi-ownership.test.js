'use strict';
// A runtime that launches another runtime's CLI claims the CLI sessions it recorded; the CLI connector drops
// exactly those. Folders are never evidence: a session started by hand in the same directory stays.
const { test } = require('node:test'), assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { createMultiEngine } = require('../../src/engine/multi');
const { scopedId } = require('../../src/runtime-ids');

const NOW = Date.now();
const adapter = id => ({ id, name: id, schemas: {}, routes: {}, normalise: { session: row => ({ session: row }), runtimeHealth: () => ({ version: null, pluginsLoaded: null, eventLoop: null }) },
  classifySession: () => ({ kind: 'unrecognized' }), capabilities: () => ({ sessions: true }) });
const session = (key, agentId, sessionId) => ({ key, sessionId, class: { kind: 'conversation', ruleId: 'synthetic', agentId, channel: null, heartbeatOf: null, background: false, rawClassification: null },
  displayName: null, model: null, provider: null, usage: { total: 0, input: null, output: null }, updatedAt: NOW,
  run: { status: 'idle', endReason: null, evidence: 'none', startedAt: null, endedAt: null, hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null },
  costUsd: null, parentKey: null, childKeys: [], goal: null, cwd: null, messageCount: null, interactive: true, group: null });
const agent = (id, workspace = null) => ({ id, name: id, displayName: null, workspace, model: null, fallbackModels: [], isPrimary: false, mainSessionKey: null });
const A = local => scopedId('claude', 'agent', local), S = local => scopedId('claude', 'session', local);

function cliEngine(rows) {
  const cli = createEngine({ adapter: adapter('claude-code'), now: () => NOW, runtimeId: 'claude' });
  cli.ingestCanonical('agents', [...new Set(rows.map(row => row[1]))].map(id => agent(id)));
  cli.ingestCanonical('sessions.snapshot', rows.map(([key, agentId, ref]) => session(key, agentId, ref)));
  cli.setIdentitySessionRefs(rows.map(([sessionKey, agentId, sessionRef]) => ({ sessionKey, agentId, sessionRef })));
  return cli;
}

test('only CLI sessions OpenClaw recorded leave the CLI connector; an agent leaves only when all its sessions did', t => {
  const owner = createEngine({ adapter: adapter('openclaw'), now: () => NOW, runtimeId: 'legacy' });
  owner.ingestCanonical('agents', [agent('main', '/srv/synthetic/workspace')]);
  // workspace: every run recorded. mixed: one recorded run plus one started by hand in the same directory.
  const cli = cliEngine([['ws-1', 'workspace', 'ref-1'], ['ws-2', 'workspace', 'ref-2'], ['by-hand', 'mixed', 'ref-3'], ['recorded', 'mixed', 'ref-4'], ['other', 'other', 'ref-5']]);
  const engine = createMultiEngine({ instances: [{ id: 'legacy', adapter: 'openclaw', enabled: true, engine: owner }, { id: 'claude', adapter: 'claude-code', enabled: true, engine: cli }] });
  t.after(() => engine.close());
  owner.setForeignClaims({ sessions: ['ref-1', 'ref-2', 'ref-4'].map(sessionRef => ({ agentId: 'main', runtimeKind: 'claude-code', sessionRef })),
    roots: [{ path: '/srv/synthetic/workspace' }] });
  assert.deepEqual(engine.agents().map(row => row.id).filter(id => id.startsWith('rt:claude:')).sort(), [A('mixed'), A('other')].sort());
  assert.deepEqual(engine.sessions().map(row => row.key).filter(key => key.startsWith('rt:claude:')).sort(), [S('by-hand'), S('other')].sort(),
    'a hand-started session stays even where OpenClaw works; folders are not evidence');
  assert.deepEqual(Object.keys(owner.foreignClaims()), ['sessions'], 'a folder passed by a caller is ignored');
  assert.ok(engine.agents().some(row => row.id === scopedId('legacy', 'agent', 'main')));
});

test('a runtime never hides its own sessions through its own claims', t => {
  const cli = cliEngine([['s', 'ws', 'ref-1']]);
  const engine = createMultiEngine({ instances: [{ id: 'claude', adapter: 'claude-code', enabled: true, engine: cli }] });
  t.after(() => engine.close());
  cli.setForeignClaims({ sessions: [{ runtimeKind: 'claude-code', sessionRef: 'ref-1' }] });
  assert.equal(engine.agents().length, 1);
});
