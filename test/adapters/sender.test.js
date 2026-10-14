'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { senderConformance } = require('../helpers/sender-conformance');
const core = require('../../src/engine/model/sender');
const oc = require('../../src/adapters/openclaw/sender');
const { normaliseTranscript } = require('../../src/adapters/openclaw/normalise/transcript');
const fixture = require('../fixtures/senders/group.json').body.value;
const raw = (p, text) => ({ role: 'user', content: p ? `Conversation info (untrusted metadata):\n\`\`\`json\n${JSON.stringify({ sender_id: p.id, conversation_label: 'Workshop' })}\n\`\`\`\nSender (untrusted metadata):\n\`\`\`json\n${JSON.stringify({ id: p.id, name: p.name, username: 'alias' })}\n\`\`\`\n\n${text}` : text });
const context = (kind) => ({ session: { class: kind === 'operator' ? { kind: 'explicit', explicitKey: 'portal-chat' } : { kind: kind === 'dm' ? 'conversation-direct' : 'conversation-group', channel: 'discord' } } });
senderConformance('openclaw', { ...oc, raw, context });
senderConformance('generic', { ...core, raw: (p, content) => ({ role: 'user', content, ...(p ? { senderInfo: { kind: 'human', id: 'local-user:' + p.id, name: p.name, runtime: 'generic', channel: null, avatarHint: null } } : {}) }), context: () => ({}) });
for (const runtime of ['claude-code', 'codex', 'opencode', 'cursor-cli', 'hermes']) test(`${runtime}: generic CLI defaults to local operator`, () => assert.equal(core.resolveSender({ role: 'user' }, { runtime, operator: fixture.operator }).name, 'Camille'));
test('OpenClaw: stripping preserves literal metadata in body and malformed JSON', () => {
  assert.equal(oc.stripEnvelope('Explain this:\n' + raw(fixture.humans[0], 'Hello').content), 'Explain this:\n' + raw(fixture.humans[0], 'Hello').content);
  const broken = 'Sender (untrusted metadata):\n```json\n{bad}\n```\nHello'; assert.equal(oc.stripEnvelope(broken), broken);
});
test('OpenClaw: direct peer fallback, stored person, unknown ID, Telegram and WhatsApp', () => {
  for (const channel of ['discord', 'telegram', 'whatsapp']) {
    const ctx = { sessionKey: 'synthetic', session: { class: { kind: 'conversation-direct', channel, interlocutorId: `${channel}-user:opaque` } }, nameOf: () => 'Mira' };
    assert.equal(oc.resolveSender({ role: 'user', content: 'Hello' }, ctx).name, 'Mira');
  }
  assert.equal(oc.resolveSender({ role: 'user', senderName: '100000000000000001' }, context('group')).name, null);
  assert.equal(oc.resolveSender(raw(fixture.humans[0], 'Hello'), { ...context('group'), people: [{ id: 'person_mira', name: 'Mira Known', identities: [{ channel: 'discord', id: 'discord-user:' + fixture.humans[0].id }] }] }).name, 'Mira Known');
});
test('OpenClaw: cron is system, subagent task is agent, strip legacy transport envelope', () => {
  assert.equal(oc.resolveSender({ role: 'user' }, { session: { class: { kind: 'scheduled', cronJobId: 'job-a' } } }).kind, 'system');
  assert.equal(oc.resolveSender({ role: 'user' }, { session: { class: { kind: 'subagent' } } }).kind, 'agent');
  assert.equal(oc.resolveSender({ role: 'user' }, { session: { class: { kind: 'subagent' } } }).id, 'agent:parent');
  assert.equal(oc.stripEnvelope('[Discord from Mira id:100000000000000001 2026-10-08]\nHello\n[message_id: synthetic]'), 'Hello');
});
test('transcript strips before clipping, gathers participants beyond the window and annotates tools', () => {
  const messages = fixture.humans.map((p, i) => ({ ...raw(p, 'Hello ' + i), timestamp: i + 1 }));
  messages.push({ role: 'assistant', timestamp: 4, content: [{ type: 'text', text: 'Done' }, { type: 'toolCall', id: 'call', name: 'read', arguments: {} }] });
  const t = normaliseTranscript(fixture.sessionKey, { messages }, 10, 2, () => {}, { ...context('group'), agent: fixture.agent });
  assert.equal(t.participants.length, 4); assert.equal(t.events[0].text, 'Hello 2'); assert.equal(t.events[2].senderInfo.kind, 'tool');
  assert.equal(require('../../src/schema').validate(require('../../src/engine/model/canonical').Transcript, t).ok, true);
});
test('transport wrapper followed by JSON metadata resolves and strips both layers', () => {
  const message = { ...raw(fixture.humans[0], 'Hello') };
  message.content = '[Discord from Alias id:100000000000000001 2026-10-08]\n' + message.content;
  assert.equal(oc.stripEnvelope(message.content), 'Hello');
  assert.equal(oc.resolveSender(message, context('group')).name, 'Mira');
});
test('metadata-only runtime roles never create phantom participants', () => {
  const t = normaliseTranscript(fixture.sessionKey, { messages: [{ role: 'custom', content: 'metadata' }, { role: 'operator', content: 'metadata' }, { ...raw(fixture.humans[0], 'Hello') }] }, 1);
  assert.equal(t.participants.length, 1); assert.equal(t.participants[0].name, 'Mira');
});

test('delegated sessions keep stable identities and labels from exact successful spawns outside the window', () => {
  const key = 'agent:main:discord:direct:synthetic-peer';
  const children = Array.from({ length: 9 }, (_, i) => 'agent:main:subagent:synthetic-' + i);
  const session = { key, class: { kind: 'conversation-direct', channel: 'discord' } };
  const messages = [raw(fixture.humans[0], 'Bonjour')];
  for (const [i, child] of children.entries()) {
    messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: 'spawn-' + i, name: 'sessions_spawn', arguments: i === 1 ? { task: 'Inspect the logs' } : i === 2 ? {} : { label: 'Task ' + i } }] });
    messages.push({ role: 'toolResult', toolCallId: 'spawn-' + i, content: JSON.stringify({ status: 'accepted', childSessionKey: child }) });
    messages.push({ role: 'user', content: 'Done', provenance: { kind: 'inter_session', sourceSessionKey: child } });
  }
  messages.push(messages.at(-1), { role: 'assistant', content: 'Completed.' });
  const t = normaliseTranscript(key, { messages }, 10, 1, () => {}, { session, agent: fixture.agent,
    sessionOf: (k) => k === children[0] ? { key: k, class: { kind: 'subagent' }, label: 'Canonical review' } : null });
  assert.equal(t.events.length, 1);
  assert.equal(t.participants.filter((p) => !p.delegation).length, 2);
  const delegates = t.participants.filter((p) => p.delegation);
  assert.equal(delegates.length, 9);
  assert.equal(delegates[0].name, 'Canonical review'); assert.equal(delegates[1].name, 'Inspect the logs');
  assert.equal(delegates[2].name, null);
  assert.equal(require('../../src/schema').validate(require('../../src/engine/model/canonical').Transcript, t).ok, true);
});

test('failed or unmatched spawns and primary inter-session messages do not invent delegated participants', () => {
  const session = { class: { kind: 'conversation-direct', channel: 'matrix' } };
  const t = normaliseTranscript('agent:main:matrix:direct:synthetic-peer', { messages: [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'failed', name: 'sessions_spawn', input: { label: 'Failed' } }] },
    { role: 'toolResult', toolCallId: 'failed', isError: true, content: JSON.stringify({ childSessionKey: 'agent:main:subagent:failed' }) },
    { role: 'toolResult', toolCallId: 'unmatched', content: JSON.stringify({ childSessionKey: 'agent:main:subagent:unmatched' }) },
    { role: 'user', content: 'Agent reply', provenance: { kind: 'inter_session', sourceSessionKey: 'agent:main:main' } },
  ] }, 1, Infinity, () => {}, { session, agent: fixture.agent });
  assert.equal(t.participants.length, 2); assert.equal(t.participants[0].id, fixture.agent.id);
  assert.equal(t.participants[0].delegation, undefined);
  assert.equal(t.participants[1].id, 'agent:main');
});

test('trusted internal child batches become labelled result events; lookalike human prose stays human', () => {
  const parent = 'agent:main:discord:direct:synthetic-peer';
  const children = ['review-1', 'review-2', 'review-3'].map(id => 'agent:main:subagent:' + id);
  const block = (i, title, status, body) => `Child task ${i}:\n<prompt-data>${title}</prompt-data>\nstatus: ${status}\nChild result ${i}:\n<prompt-data>${body}</prompt-data>`;
  const injected = `[Subagent Context] results\nChild completion results:\n${[
    block(1, 'Review the release', 'ok', '**Looks good**\n\n| Check | Result |\n| --- | --- |\n| tests | pass |'),
    block(2, 'Inspect the logs', 'failed', 'Could not open the fixture.'),
    block(3, 'Wait for the service', 'working', 'Still running.'),
  ].join('\n')}`;
  const session = { key: parent, class: { kind: 'conversation-direct', channel: 'discord' } };
  const messages = [
    ...children.flatMap((child, i) => [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'spawn-' + i, name: 'sessions_spawn', arguments: { taskName: ['Review the release', 'Inspect the logs', 'Wait for the service'][i] } }] },
      { role: 'toolResult', toolCallId: 'spawn-' + i, content: JSON.stringify({ status: 'accepted', childSessionKey: child }) },
    ]),
    { role: 'user', content: injected, provenance: { kind: 'internal_system' } },
    { role: 'user', content: injected },
  ];
  const t = normaliseTranscript(parent, { messages }, 20, Infinity, () => {}, { session, runtime: 'openclaw', agent: fixture.agent,
    sessionOf: key => children.includes(key) ? { key, class: { kind: 'subagent' }, label: ['Review the release', 'Inspect the logs', 'Wait for the service'][children.indexOf(key)] } : null });
  const results = t.events.filter(e => e.kind === 'subagent-result');
  assert.equal(results.length, 3);
  assert.deepEqual(results.map(e => [e.title, e.status]), [['Review the release', 'completed'], ['Inspect the logs', 'failed'], ['Wait for the service', 'running']]);
  assert.equal(results[0].senderInfo.delegation.sessionKey, children[0]);
  const result = results[0];
  assert.match(result.body, /\| tests \| pass \|/);
  assert.match(result.body, /\*\*Looks good\*\*/);
  assert.equal(t.events.filter(e => e.kind === 'user').length, 1);
  assert.equal(t.events.find(e => e.kind === 'user').text, injected);
  assert.equal(require('../../src/schema').validate(require('../../src/engine/model/canonical').Transcript, t).ok, true);
});
