'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normaliseTranscript } = require('../../src/adapters/openclaw/normalise/transcript');
const { completionResults, indexOf, isFinal } = require('../../src/projects/session-results');
const { buildChatVM } = require('../../src/api/v2/vm/chat');
const { resolveSender } = require('../../src/engine/model/sender');
const { Transcript } = require('../../src/engine/model/canonical');
const { validate } = require('../../src/schema');
const { scopedId } = require('../../src/runtime-ids');

const parent = 'agent:main:portal-chat', child = 'agent:main:subagent:review';
const resultBody = 'Shared synthetic result';
const envelope = '[Subagent Context] results\nChild completion results:\nChild task 1:\n<prompt-data>Synthetic review</prompt-data>\nstatus: ok\nChild result 1:\n<prompt-data>' + resultBody + '</prompt-data>';
const context = {
  runtime: 'openclaw', agent: require('../fixtures/senders/group.json').body.value.agent,
  session: { key: parent, class: { kind: 'explicit', explicitKey: 'portal-chat' } },
  sessionOf: key => key === child ? { key, class: { kind: 'subagent' }, label: 'Synthetic review' } : null,
};
function transcript(messages) {
  return normaliseTranscript(parent, { messages }, 12000, Infinity, () => {}, context);
}

test('typed adapter results reach the generic project completion consumer by canonical identity', () => {
  const t = transcript([{ role: 'user', timestamp: 11000, content: envelope,
    provenance: { kind: 'internal_system', sourceSessionKey: child } }]);
  assert.equal(validate(Transcript, t).ok, true);
  assert.equal(t.events.length, 1);
  assert.equal(t.events[0].kind, 'subagent-result');
  const [actual] = completionResults(t.events);
  assert.equal(actual.id, t.events[0].id);
  assert.equal(actual.kind, 'subagent-result');
  assert.equal(actual.senderInfo.delegation.sessionKey, child);
  assert.equal(actual.text, resultBody);
  assert.equal(actual.at, 11000);
});

test('typed results are idempotent by event id, kind and author, never by body text', () => {
  const author = { kind: 'agent', id: 'agent:reviewer', runtime: 'foreign', channel: null, avatarHint: null,
    delegation: { sessionKey: 'session:reviewer', label: null } };
  const otherAuthor = { ...author, id: 'agent:inspector', delegation: { sessionKey: 'session:inspector', label: null } };
  const event = (id, senderInfo, body) => ({ id, kind: 'subagent-result', status: 'completed', senderInfo, body, text: body, at: 11000 });
  const result = completionResults([
    event('ev:1:0', author, resultBody), event('ev:1:0', author, 'duplicate replay'),
    event('ev:2:0', otherAuthor, resultBody),
  ]);
  assert.deepEqual(result.map(row => row.id), ['ev:1:0', 'ev:2:0']);
  assert.deepEqual(result.map(row => row.text), [resultBody, resultBody]);
});

test('legacy completion envelopes keep stable result ids when transcript pages are replayed', () => {
  const event = { id: 'ev:7:0', kind: 'system', text: envelope, at: 11000 };
  const results = completionResults([event, event]);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'ev:7:0:0', 'preserve the deployed legacy result id');
  assert.equal(results[0].text, resultBody);
});

test('a child card cannot consume a same-text buffered primary reply, but a primary echo can', () => {
  const childOnly = transcript([{ role: 'user', timestamp: 11000, content: envelope,
    provenance: { kind: 'internal_system', sourceSessionKey: child } }]);
  const local = [{ id: 'reply_turn', role: 'assistant', since: 10000, at: 12000, text: resultBody,
    senderInfo: resolveSender({ role: 'assistant' }, context) }];
  const childVm = buildChatVM({ sessionKey: parent, transcript: childOnly, senderContext: context, local });
  assert.deepEqual(childVm.messages.map(message => message.kind), ['subagent-result', 'message']);
  assert.equal(childVm.messages[1].id, 'reply_turn');

  const withPrimaryEcho = transcript([
    { role: 'user', timestamp: 11000, content: envelope, provenance: { kind: 'internal_system', sourceSessionKey: child } },
    { role: 'assistant', timestamp: 11500, content: resultBody },
  ]);
  const vm = buildChatVM({ sessionKey: parent, transcript: withPrimaryEcho, senderContext: context, local });
  assert.deepEqual(vm.messages.map(message => message.kind), ['subagent-result', 'message']);
  assert.equal(vm.messages[1].id, 'ev:1:0');
});

test('session event positions survive runtime-scoped event identities without treating unknown IDs as zero', () => {
  const nativeSession = 'demo:nova:ao-projet-bulletin';
  const event = (id) => ({ id: scopedId('two', 'event', JSON.stringify([nativeSession, id])) });
  assert.equal(indexOf(event('ev:2:0')), 2);
  assert.equal(indexOf({ id: 'ev:3:1' }), 3);
  assert.equal(indexOf(event('not-an-event-index')), null);
  assert.equal(indexOf({ id: 'rt:two:event:bm90LWEtc2NvcGVkLWV2ZW50' }), null);
  const unknownAssistant = { ...event('unknown'), kind: 'assistant', text: 'reply', stopReason: 'stop' };
  const unknownTool = { ...event('unknown'), kind: 'tool' };
  assert.equal(isFinal(unknownAssistant, [unknownAssistant, unknownTool]), true,
    'unknown event indexes do not make unrelated tool events appear to match');
});
