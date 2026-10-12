'use strict';
// T-0062: Claude Code sub-agents (the Task/Agent tool) become canonical child sessions of their parent conversation,
// with parentKey/childKeys and spawnedBy. Temporary synthetic home only; never a real ~/.claude.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const A = require('../../src/adapters/claude-code');
const { createEngine } = require('../../src/engine');
const { buildOfficeVM, createStateTracker } = require('../../src/api/v2/vm/office');
const { buildSessionVM } = require('../../src/api/v2/vm/logs');
const { project3x } = require('../../src/api/v2/project3x');

const NOW = 1791600000000, SECRET = 'synthetic-secret-canary';
const at = (s) => new Date(NOW - s * 1000).toISOString();
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-claude-subagents-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (rel, rows) => { const f = path.join(dir, 'projects', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); return f; };
  return { dir, write };
}
const PARENT = 'parent-session';
const parentRows = [
  { type: 'user', uuid: 'u1', sessionId: PARENT, timestamp: at(60), cwd: '/synthetic/project-x', isSidechain: false, message: { role: 'user', content: 'Revois le module de paiement' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: PARENT, timestamp: at(50), isSidechain: false,
    message: { role: 'assistant', model: 'model-synthetic', content: [{ type: 'tool_use', id: 'call-1', name: 'Task', input: { description: 'Audit des tests', prompt: 'Lis les tests', subagent_type: 'general-purpose' } }] } },
  { type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: PARENT, timestamp: at(10), isSidechain: false, toolUseResult: { status: 'completed', agentId: 'abc123' },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Rapport : 3 tests fragiles.' }] } },
];
const subRows = (agentId, prompt) => [
  { type: 'user', uuid: agentId + '-u', sessionId: PARENT, agentId, isSidechain: true, timestamp: at(45), message: { role: 'user', content: prompt } },
  { type: 'assistant', uuid: agentId + '-a', parentUuid: agentId + '-u', sessionId: PARENT, agentId, isSidechain: true, timestamp: at(20),
    message: { role: 'assistant', model: 'model-synthetic', content: [{ type: 'text', text: 'Trois tests sont fragiles.' }] } },
];

async function runtimeFor(t, dir) {
  const runtime = A.createRuntime({ runtimeConfig: { claudeCode: { home: dir } } }, { now: () => NOW });
  const engine = createEngine({ adapter: runtime.definition, now: () => NOW });
  t.after(() => runtime.close()); runtime.attach(engine); await runtime.start(engine);
  return { runtime, engine };
}

test('a Task sub-agent transcript is a canonical subagent session of its parent, titled by the task description', async (t) => {
  const h = home(t);
  h.write(`synthetic-project/${PARENT}.jsonl`, parentRows);
  h.write(`synthetic-project/${PARENT}/subagents/agent-abc123.jsonl`, subRows('abc123', 'Lis les tests'));
  h.write(`synthetic-project/${PARENT}/subagents/agent-def456.jsonl`, subRows('def456', `Vérifie la config token=${SECRET}`));
  const { engine, runtime } = await runtimeFor(t, h.dir);
  assert.equal(engine.runtime().capabilities.subagents, true, 'the adapter declares the capability');
  const sessions = engine.sessions(), parent = sessions.find(s => s.class.kind === 'conversation');
  const subs = sessions.filter(s => s.class.kind === 'subagent').sort((a, b) => a.class.subagentId.localeCompare(b.class.subagentId));
  assert.equal(subs.length, 2);
  assert.deepEqual(subs.map(s => s.class.subagentId), ['abc123', 'def456']);
  for (const s of subs) {
    assert.equal(s.parentKey, parent.key); assert.equal(s.class.agentId, parent.class.agentId, 'same project agent');
    assert.equal(s.spawnedBy.sessionKey, parent.key); assert.equal(s.spawnedBy.agentId, parent.class.agentId); assert.equal(s.spawnedBy.via, 'subagent-tool');
  }
  assert.deepEqual([...parent.childKeys].sort(), subs.map(s => s.key).sort());
  assert.equal(parent.sessionId, PARENT); assert.ok(subs.every(s => s.sessionId === null), 'the native session id stays unique to the conversation (exact dedupe)');
  assert.equal(subs[0].displayName, 'Audit des tests', 'the parent tool call description names the sub-agent');
  assert.equal(subs[0].spawnedBy.label, 'Audit des tests');
  assert.equal(subs[1].displayName, null, 'no tool-call link: no invented title');
  assert.match(subs[1].spawnedBy.label, /^Vérifie la config token=…$/, 'falls back to its own first prompt, redacted');
  assert.ok(!JSON.stringify(engine.sessions()).includes(SECRET));
  assert.equal(engine.agents().length, 1, 'sub-agent transcripts never become another project agent');
  assert.equal(engine.agents()[0].mainSessionKey, parent.key, 'the project agent keeps its own conversation');

  // the parent's session view lists its sub-agents; the office places them under the parent conversation
  const vm = buildSessionVM(parent, engine.transcript(parent.key), { delegatedSessions: (p) => engine.sessions().filter(c => c.class.kind === 'subagent' && (c.parentKey === p.key || p.childKeys.includes(c.key))) }, 'fresh', project3x);
  assert.deepEqual(vm.subagents.map(x => x.delegation.sessionKey).sort(), subs.map(x => x.key).sort(), 'the parent session view lists its sub-agents');
  assert.ok(vm.subagents.some(x => x.delegation.label === 'Audit des tests'));
  // a sub-agent that is working right now is on stage, under its project agent (OccupantVM.parentId)
  fs.appendFileSync(path.join(h.dir, 'projects', `synthetic-project/${PARENT}/subagents/agent-abc123.jsonl`), JSON.stringify({ type: 'assistant', uuid: 'abc123-live', parentUuid: 'abc123-a',
    sessionId: PARENT, agentId: 'abc123', isSidechain: true, timestamp: new Date(NOW - 500).toISOString(), message: { role: 'assistant', model: 'model-synthetic', content: [{ type: 'text', text: 'Encore un test.' }] } }) + '\n');
  await runtime.cycle();
  const office = buildOfficeVM({ engine, now: NOW, tracker: createStateTracker(), canReadSessions: true, actorOf: x => x, P: project3x });
  const sub = office.occupants.find(o => o.role === 'subagent');
  assert.ok(sub, 'the working sub-agent is an occupant: ' + JSON.stringify(office.occupants.map(o => [o.id, o.role, o.state])));
  assert.equal(sub.name, 'Sous-agent', 'a Task description is not presented as a session title');
  assert.equal(JSON.stringify(office).includes('Audit des tests'), false, 'OfficeVM omits the task description');
  assert.equal(JSON.stringify(office).includes('Lis les tests'), false, 'OfficeVM omits the first prompt');
  const agentOccupant = engine.primaryAgent()?.id === parent.class.agentId ? 'primary' : 'agent:' + parent.class.agentId;
  assert.equal(sub.parentId, agentOccupant, 'its parent is the occupant of the project agent that spawned it');
  assert.equal(buildOfficeVM({ engine, now: NOW, tracker: createStateTracker(), canReadSessions: false, actorOf: x => x, P: project3x }).occupants.some(o => o.parentId), false);
});

test('nested-location containment: symlinked subagents dirs, odd names and a cap are refused or bounded', async (t) => {
  const h = home(t);
  h.write(`synthetic-project/${PARENT}.jsonl`, parentRows);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-claude-outside-')); t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'agent-zzz.jsonl'), subRows('zzz', 'outside').map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.mkdirSync(path.join(h.dir, 'projects', 'synthetic-project', 'linked'), { recursive: true });
  fs.symlinkSync(outside, path.join(h.dir, 'projects', 'synthetic-project', 'linked', 'subagents'));
  h.write(`synthetic-project/${PARENT}/subagents/not-an-agent.jsonl`, subRows('nope', 'ignored'));
  h.write(`synthetic-project/${PARENT}/subagents/agent-ok.jsonl`, subRows('ok', 'kept'));
  const { engine } = await runtimeFor(t, h.dir);
  const subs = engine.sessions().filter(s => s.class.kind === 'subagent');
  assert.deepEqual(subs.map(s => s.class.subagentId), ['ok'], 'only agent-<id>.jsonl in a real (non-symlinked) subagents directory');
});

test('security-187: nested sub-agent enumeration is bounded per directory and per scan, and reports truncation', async (t) => {
  const { createFiles, BOUNDS } = require('../../src/adapters/claude-code/files');
  const h = home(t);
  h.write(`synthetic-project/${PARENT}.jsonl`, parentRows);
  // a small, clean directory: every valid child is admitted, in sorted order
  for (const id of ['ccc', 'aaa', 'bbb']) h.write(`synthetic-project/${PARENT}/subagents/agent-${id}.jsonl`, subRows(id, 'synthetic'));
  // many noisy session directories: ignored entries must count against the budgets
  const noisyDirs = Math.ceil(BOUNDS.subagentEntriesPerScan / BOUNDS.subagentEntriesPerDir) + 4;
  for (let d = 0; d < noisyDirs; d++) {
    const dir = path.join(h.dir, 'projects', 'synthetic-project', 'noisy-' + d, 'subagents'); fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < BOUNDS.subagentEntriesPerDir + 50; i++) fs.writeFileSync(path.join(dir, `noise-${i}.jsonl`), '');
  }
  const files = createFiles({ home: h.dir }); t.after(() => files.close());
  const rows = await files.scan();
  const topLevel = 1 + 1 + noisyDirs;   // parent transcript + its session dir + the noisy session dirs
  assert.ok(files.stats.entries <= topLevel + BOUNDS.subagentEntriesPerScan + noisyDirs, `entries visited ${files.stats.entries}`);
  assert.equal(files.stats.truncated, true, 'discovery reports truncation');
  assert.equal(files.stats.nestedTruncated, true);
  // the clean directory is enumerated first or last depending on the FS; when inspected, its children are sorted
  const clean = rows.filter(r => r.subagent).map(r => r.subagent);
  if (clean.length) assert.deepEqual(clean, [...clean].sort());
  // a second scan stays within the same bounds (cycles every two seconds)
  const before = files.stats.entries; await files.scan();
  assert.ok(files.stats.entries - before <= topLevel + BOUNDS.subagentEntriesPerScan + noisyDirs);
});

test('security-187: a clean session keeps all its valid children, sorted, without truncation', async (t) => {
  const { createFiles } = require('../../src/adapters/claude-code/files');
  const h = home(t);
  h.write(`synthetic-project/${PARENT}.jsonl`, parentRows);
  for (const id of ['ccc', 'aaa', 'bbb']) h.write(`synthetic-project/${PARENT}/subagents/agent-${id}.jsonl`, subRows(id, 'synthetic'));
  const files = createFiles({ home: h.dir }); t.after(() => files.close());
  const rows = await files.scan();
  assert.deepEqual(rows.filter(r => r.subagent).map(r => r.subagent).sort(), ['aaa', 'bbb', 'ccc']);
  assert.equal(files.stats.truncated, false);
});

test('critic-250: one noisy directory is capped locally and does not starve the other sessions', async (t) => {
  const { createFiles, BOUNDS } = require('../../src/adapters/claude-code/files');
  const h = home(t);
  h.write(`synthetic-project/${PARENT}.jsonl`, parentRows);
  const noisy = path.join(h.dir, 'projects', 'synthetic-project', 'noisy-session', 'subagents'); fs.mkdirSync(noisy, { recursive: true });
  for (let i = 0; i < 1000; i++) fs.writeFileSync(path.join(noisy, `noise-${i}.jsonl`), '');
  for (const id of ['aaa', 'bbb']) h.write(`synthetic-project/${PARENT}/subagents/agent-${id}.jsonl`, subRows(id, 'synthetic'));
  const files = createFiles({ home: h.dir }); t.after(() => files.close());
  const rows = await files.scan();
  const topLevel = 3;   // parent transcript, its session dir, the noisy session dir
  assert.ok(files.stats.entries <= topLevel + BOUNDS.subagentEntriesPerDir + 2 + 1, `entries visited ${files.stats.entries}`);
  assert.equal(files.stats.nestedTruncated, true, 'the noisy directory reports truncation');
  assert.deepEqual(rows.filter(r => r.subagent).map(r => r.subagent).sort(), ['aaa', 'bbb'], 'the other session keeps its children');
});
