'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadScenario, readFixture, gatewayHandlers } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');
const { engineRegistry } = require('../../src/api/v2/projects');
const { normaliseTranscript } = require('../../src/adapters/openclaw/normalise/transcript');
const { buildChatVM } = require('../../src/api/v2/vm/chat');
const { projectEvents } = require('../../src/engine/model/sender');
const { CONTRACT_VERSION, CONTRACT_VERSION_V3 } = require('../../src/api/v2/envelope');
const fixture = require('../fixtures/senders/group.json').body.value;
const GROUP = 'agent:main:discord:channel:100000000000000099', DM = 'agent:main:telegram:direct:generic-peer', OP = 'agent:main:explicit:portal-chat';
const DELEGATED_DM = 'agent:main:discord:direct:synthetic-peer';
const CHILDREN = Array.from({ length: 9 }, (_, i) => 'agent:main:subagent:synthetic-' + i);
const CHAT_CHILD = CHILDREN[0];
const chatMessages = [messagesForHuman(),
  { role: 'assistant', content: [{ type: 'toolCall', id: 'chat-spawn', name: 'sessions_spawn', arguments: { taskName: 'Review the chat result' } }] },
  { role: 'toolResult', toolCallId: 'chat-spawn', content: JSON.stringify({ status: 'accepted', childSessionKey: CHAT_CHILD }) },
  { role: 'user', content: '[Subagent Context]\nChild completion results:\nChild task 1:\n<prompt-data>Review the chat result</prompt-data>\nstatus: ok\nChild result 1:\n<prompt-data>**Ready**\n\n| Check | Result |\n| --- | --- |\n| tests | pass |</prompt-data>',
    provenance: { kind: 'internal_system' } },
];
const delegatedMessages = [messagesForHuman(), ...CHILDREN.flatMap((key, i) => [
  { role: 'assistant', content: [{ type: 'toolCall', id: 'spawn-' + i, name: 'sessions_spawn', arguments: { label: 'Task ' + i } }] },
  { role: 'toolResult', toolCallId: 'spawn-' + i, content: JSON.stringify({ status: 'accepted', childSessionKey: key }) },
  { role: 'user', content: 'Completed', provenance: { kind: 'inter_session', sourceSessionKey: key } },
]), { role: 'user', content: 'Duplicate report', provenance: { kind: 'inter_session', sourceSessionKey: CHILDREN[0] } },
{ role: 'assistant', content: 'The **review** is complete for `main`.' }];
function messagesForHuman() { return { role: 'user', senderId: 'synthetic-peer', senderName: 'Mira', content: 'Bonjour' }; }
const messages = fixture.humans.map((p, i) => ({ role: 'user', timestamp: 1791223100000 + i, content: `Sender (untrusted metadata):\n\`\`\`json\n${JSON.stringify(p)}\n\`\`\`\nMessage ${i}` })).concat([{ role: 'assistant', timestamp: 1791223100004, content: 'Le compte rendu est prêt.' }]);
describe('sender identities through the real server, v2 and v3', () => {
  let h;
  before(async () => {
    const sc = loadScenario('synthetic-basic'), list = readFixture(sc.rpc['sessions.list']).body.value, tpl = list.sessions.find((s) => s.key === 'agent:main:main');
    const rows = [GROUP, DM, OP, DELEGATED_DM, ...CHILDREN].map((key) => ({ ...tpl, key, isMain: false, sessionId: key, classification: undefined,
      // A result remains in ChatVM after the child leaves the short-lived office
      // stage. Its portrait still resolves from that child's canonical identity.
      ...(key === CHAT_CHILD ? { updatedAt: sc.now - 60 * 60 * 1000, status: 'ok', hasActiveRun: false } : {}),
      ...(CHILDREN.includes(key) ? { parentSessionKey: DELEGATED_DM, label: key === CHILDREN[0] ? 'Canonical review' : undefined } : {}) }));
    const original = gatewayHandlers(sc)['sessions.get'];
    h = await startServer(sc, { env: { PORTAL_DISPLAY_NAME: 'Camille', AO_ENRICHERS: '', AO_PROJECTS_OWNERS: 'generic-org' }, handlers: {
      'sessions.list': () => ({ ...list, sessions: list.sessions.concat(rows), totalCount: list.sessions.length + rows.length }),
      'sessions.get': (p) => p.key === DELEGATED_DM ? { messages: delegatedMessages } : [GROUP, DM, OP].includes(p.key) ? { messages: p.key === GROUP ? messages : p.key === OP ? chatMessages : [{ role: 'user', timestamp: sc.now - 1, content: 'Bonjour' }] } : original(p),
    } });
  });
  after(async () => { await h?.stop(); });
  it('the group keeps three humans and an agent; no envelope leaks into the VM', async () => {
    for (const v of [2, 3]) {
      const r = await h.get(`/api/v${v}/views/sessions/${encodeURIComponent(GROUP)}`); assert.equal(r.status, 200, r.text);
      const vm = r.json.data; assert.deepEqual(vm.events.filter((e) => e.kind === 'user').map((e) => e.senderInfo.name), ['Mira', 'Jules', 'Noor']);
      assert.equal(vm.participants.length, 4); assert.doesNotMatch(JSON.stringify(vm), /untrusted|```/);
    }
  });
  it('unknown DM has stable channel-scoped ID and no raw ID name; operator shows the stored owner', async () => {
    const dm = (await h.get('/api/v3/views/sessions/' + encodeURIComponent(DM))).json.data;
    assert.equal(dm.events[0].senderInfo.id, 'telegram-user:generic-peer'); assert.equal(dm.events[0].senderInfo.name, null);
    const op = (await h.get('/api/v2/views/sessions/' + encodeURIComponent(OP))).json.data;
    assert.equal(op.events[0].senderInfo.name, 'Camille'); assert.equal(op.participants[0].name, 'Camille');
    const response = await h.get('/api/v2/views/chat'); assert.equal(response.status, 200, response.text);
    assert.equal(response.json.data.messages[0].senderInfo.name, 'Camille');
    for (const v of [2, 3]) {
      const chat = await h.get(`/api/v${v}/views/chat`); assert.equal(chat.status, 200, chat.text);
      const result = chat.json.data.messages.find(m => m.kind === 'subagent-result');
      assert.ok(result); assert.equal(result.role, 'assistant'); assert.equal(result.status, 'completed');
      assert.equal(result.senderInfo.delegation.sessionKey, CHAT_CHILD);
      assert.equal(result.collapsedByDefault, true); assert.equal(result.body.text, result.text);
      assert.match(result.body.text, /\| tests \| pass \|/);
      assert.ok(Object.hasOwn(result, 'avatar'));
      const office = await h.get(`/api/v${v}/views/office`); assert.equal(office.status, 200, office.text);
      const author = office.json.data.occupants.find(o => o.sessionKey === CHAT_CHILD);
      assert.equal(author, undefined, 'the completed child is outside the office presence window');
      assert.ok(result.avatar, 'result portrait resolves from its canonical child occupant identity after it leaves the stage');
    }
  });
  it('the contract versions advertise the identity extension', async () => {
    assert.equal((await h.get('/api/v2/meta')).json.data.contractVersion, CONTRACT_VERSION);
    assert.equal((await h.get('/api/v3/meta')).json.data.contractVersion, CONTRACT_VERSION_V3);
  });
  it('a DM counts the human and primary agent separately from nine named delegated sessions on v2 and v3', async () => {
    const { compareExample } = require('../helpers/contract-shape');
    for (const v of [2, 3]) {
      const r = await h.get(`/api/v${v}/views/sessions/${encodeURIComponent(DELEGATED_DM)}`);
      assert.equal(r.status, 200, r.text);
      const vm = r.json.data;
      assert.equal(vm.participants.length, 2); assert.equal(vm.subagents.length, 9);
      assert.equal(vm.subagents[0].delegation.label, 'Canonical review');
      assert.equal(vm.subagents[1].delegation.label, 'Task 1');
      const result = vm.events.find(e => e.kind === 'subagent-result');
      assert.ok(result, 'trusted child output has its own event kind');
      assert.equal(result.senderInfo.delegation.sessionKey, CHILDREN[0]);
      assert.deepEqual(compareExample('session-vm', vm, { version: v }), []);
    }
  });
});

it('repeated canonical event ids keep one first-position event and only fill missing sender metadata', () => {
  const first = { id: 'event:shared', kind: 'user', at: 10, sender: null, text: 'First delivery', truncated: false,
    senderInfo: { kind: 'human', id: 'human:opaque', name: null, runtime: 'foreign', channel: null, avatarHint: null } };
  const redelivery = { ...first, at: 11, text: 'Redelivered child completion',
    senderInfo: { ...first.senderInfo, name: 'Mira', avatarHint: 'portrait:mira' } };
  const projected = projectEvents([first, redelivery]);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].text, 'First delivery', 'a repeated stable id must not replace the first event body');
  assert.equal(projected[0].at, 10);
  assert.equal(projected[0].senderInfo.name, 'Mira', 'later duplicate may fill absent attribution metadata');
  assert.equal(projected[0].senderInfo.avatarHint, 'portrait:mira');
});

it('completion results use canonical event ids so redelivery cannot duplicate a child result', () => {
  const { completionResults } = require('../../src/projects/session-results');
  const text='[Subagent Context]\nChild result: <prompt-data>Weather update</prompt-data>';
  const results=completionResults([
    {id:'ev:2:0',kind:'system',text,at:20},
    {id:'ev:2:0',kind:'system',text,at:21},
  ]);
  assert.deepEqual(results,[{id:'ev:2:0:0',text:'Weather update',at:20}]);
});

it('an opaque-key canonical runtime can annotate delegates or use canonical session relationships', () => {
  const { buildSessionVM } = require('../../src/api/v2/vm/logs');
  const { project3x } = require('../../src/api/v2/project3x');
  const session = { key: 'conversation/opaque', class: { kind: 'conversation-direct', channel: null }, model: null, provider: null,
    usage: { total: 0 }, updatedAt: null, cwd: null, run: { status: 'idle', endReason: null } };
  const sender = (id, kind = 'agent', name = null) => ({ id, kind, name, runtime: 'foreign', channel: null, avatarHint: null });
  const delegated = { ...sender('child/opaque'), delegation: { sessionKey: 'child/opaque', label: 'Review' } };
  const otherChild = { key: 'other/opaque', class: { kind: 'subagent' }, label: 'Inspect' };
  const t = { participants: [sender('shared', 'human', 'Mira'), sender('shared'), delegated, { ...delegated, channel: 'other' }, sender(otherChild.key)], events: [], window: { from: 2, to: 2 }, messageCount: 2 };
  const vm = buildSessionVM(session, t, { senderContext: () => ({ runtime: 'foreign', sessionOf: (k) => k === otherChild.key ? otherChild : null }) }, 'fresh', project3x);
  assert.equal(vm.participants.length, 2, 'same ID on different sender kinds is not lost');
  assert.equal(vm.subagents.length, 2); assert.deepEqual(vm.subagents.map((p) => p.delegation.label), ['Review', 'Inspect']);
});
it('project history, Request summary and provisional chat messages reuse the same core sender', () => {
  const session = { key: GROUP, class: { kind: 'conversation-group', agentId: 'atlas', channel: 'discord' }, usage: { total: 1 } };
  const t = normaliseTranscript(GROUP, { messages }, 1, Infinity, () => {}, { session, agent: fixture.agent });
  const engine = { session: () => session, transcript: () => t, agents: () => [{ id: 'atlas', name: 'Atlas' }], cronJobs: () => [] };
  const info = engineRegistry(engine).sessionInfo(GROUP);
  assert.deepEqual(info.people.filter((p) => p.kind === 'human').map((p) => p.name), ['Mira', 'Jules', 'Noor']);
  const windowed = engineRegistry({ ...engine, transcript: () => ({ ...t, events: t.events.slice(-1) }) }).sessionInfo(GROUP);
  assert.deepEqual(windowed.people.filter((p) => p.kind === 'human').map((p) => p.name), ['Mira', 'Jules', 'Noor'], 'history retains participants outside the displayed window');
  assert.match(info.summary, /^Mira : Message 0/); assert.doesNotMatch(info.summary, /metadata/);
  const chat = buildChatVM({ sessionKey: OP, pending: { turnId: 'turn-a', since: 1, text: 'Bonjour' }, senderContext: { operator: fixture.operator, runtime: 'generic' } });
  assert.equal(chat.messages[0].senderInfo.name, 'Camille');
});
it('ChatVM preserves result markdown and supplies the agent portrait without deriving one for humans', () => {
  const { buildChatVM } = require('../../src/api/v2/vm/chat');
  const agent = { kind: 'agent', id: 'agent:child-1', name: 'Review', runtime: 'generic', channel: null,
    avatarHint: null, delegation: { sessionKey: 'child/opaque', label: 'Review' } };
  const human = { kind: 'human', id: 'person:owner', name: 'Mira', runtime: 'generic', channel: null, avatarHint: null };
  const look = { character: 'fox', variant: 'night', accessories: ['glasses'] };
  const chat = buildChatVM({ sessionKey: 'conversation/opaque', senderContext: {}, avatarFor: sender => sender.kind === 'agent' ? look : null,
    transcript: { events: [
      { id: 'ev:0:0', kind: 'user', at: 1, text: 'Bonjour', senderInfo: human },
      { id: 'ev:1:0', kind: 'subagent-result', at: 2, title: 'Review', status: 'completed', body: '| Check | Result |\n| --- | --- |\n| tests | **pass** |', text: '| Check | Result |\n| --- | --- |\n| tests | **pass** |', senderInfo: agent },
    ] } });
  assert.equal(chat.messages[0].kind, 'message'); assert.equal(chat.messages[0].avatar, null);
  assert.equal(chat.messages[1].kind, 'subagent-result'); assert.equal(chat.messages[1].role, 'assistant');
  assert.deepEqual(chat.messages[1].avatar, look); assert.equal(chat.messages[1].collapsedByDefault, true);
  assert.equal(chat.messages[1].statusLabel.key, 'chat.result.status.completed');
  assert.equal(chat.messages[1].body.text, chat.messages[1].text);
  assert.match(chat.messages[1].body.text, /\| tests \| \*\*pass\*\* \|/);
  const { VM_SCHEMAS, VM_SCHEMAS_V3 } = require('../../src/api/v2/vm/schemas');
  const { validate } = require('../../src/schema');
  assert.equal(validate(VM_SCHEMAS.chat, chat).ok, true);
  assert.equal(validate(VM_SCHEMAS_V3.chat, chat).ok, true);
});
it('stored people expose neutral identities on an open channel and keep the same avatar hint', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { openStore } = require('../../src/store');
  const { knownSender } = require('../../src/engine/model/sender');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-sender-people-'));
  const store = openStore({ dir, instance: 'test', ownerName: 'Camille', log: () => {} });
  try {
    store.db.prepare('INSERT INTO person_identities (person_id, family, external_id, created_at) VALUES (?, ?, ?, ?)').run(store.owner.id, 'matrix', 'generic-peer', 1);
    const resolved = knownSender({ kind: 'human', id: 'matrix-user:generic-peer', name: 'Alias', channel: 'matrix', runtime: 'generic', avatarHint: null }, { people: store.persons.senderPeople() });
    assert.equal(resolved.name, 'Camille'); assert.equal(resolved.avatarHint, 'person:' + store.owner.id);
    assert.ok(!('identities' in store.persons.list()[0]), 'existing Person wire projection stays intact');
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
