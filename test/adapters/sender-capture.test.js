'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSenderCapture, DEBOUNCE_MS, MAX_PENDING } = require('../../src/adapters/openclaw/sender-capture');
const { structuredSender, resolveSender, messageKey } = require('../../src/adapters/openclaw/sender');
const { createRuntime } = require('../../src/adapters/openclaw');
const { createEngine } = require('../../src/engine');
const KEY = 'agent:atlas:discord:channel:synthetic-workshop';
const ctx = { sessionKey: KEY, session: { class: { kind: 'conversation-group', channel: 'discord' } } };
const message = (id = 'mira', name = 'Mira', key = 'turn-a') => ({ role: 'user', content: 'Synthetic content', idempotencyKey: key,
  __openclaw: { id: 'message-a', idempotencyKey: key, senderId: id, senderName: name, senderUsername: 'alias',
    senderIdentity: { type: 'observation', pluginId: 'discord', accountId: 'synthetic-account', senderKind: 'human', id } } });
function repo() {
  const values = new Map(); return { values, putMany: (entries) => { for (const e of entries) values.set(JSON.stringify([e.runtime, e.sessionKey, e.eventKey]), e.sender); return entries.length; },
    get: (...key) => values.get(JSON.stringify(key)) || null };
}
test('producer metadata yields the correct per-message author and username fallback; owner flags cannot attribute a group', () => {
  for (const [id, name] of [['mira', 'Mira'], ['jules', 'Jules'], ['noor', 'Noor']]) assert.equal(resolveSender(message(id, name), ctx).name, name);
  assert.equal(resolveSender(message('mira', ''), ctx).name, 'alias');
  assert.equal(resolveSender({ role: 'user', __openclaw: { senderIsOwner: true } }, ctx).name, null);
  assert.equal(resolveSender({ ...message(), __openclaw: { ...message().__openclaw, senderIdentity: { ...message().__openclaw.senderIdentity, senderKind: 'bot' } } }, ctx).kind, 'agent');
});
test('current nested Conversation info context resolves its per-message sender without treating a room label as a name', () => {
  const content = 'Conversation info (untrusted metadata):\n```json\n' + JSON.stringify({ sender: { id: 'mira', name: 'Mira', username: 'alias' }, conversation_label: 'Workshop' }) + '\n```\nSynthetic content';
  const value = resolveSender({ role: 'user', content }, ctx);
  assert.equal(value.id, 'discord-user:mira'); assert.equal(value.name, 'Mira');
  assert.equal(require('../../src/adapters/openclaw/sender').stripEnvelope(content), 'Synthetic content');
});
test('mismatched identity, channel, provenance and hidden inputs cannot be captured; only exact stable keys resolve', () => {
  const m = message(), capture = createSenderCapture(repo());
  for (const invalid of [
    { ...m, __openclaw: { ...m.__openclaw, senderIdentity: { ...m.__openclaw.senderIdentity, id: 'other' } } },
    { ...m, __openclaw: { ...m.__openclaw, senderIdentity: { ...m.__openclaw.senderIdentity, pluginId: 'telegram' } } },
    { ...m, provenance: { kind: 'inter_session' } }, { ...m, display: false }, { ...m, role: 'assistant' },
  ]) { assert.equal(structuredSender(invalid, ctx), null); assert.equal(capture.observe(KEY, [invalid], ctx.session), 0); }
  assert.equal(messageKey({ ...m, __openclaw: { ...m.__openclaw, idempotencyKey: 'different' } }), null);
  capture.observe(KEY, [m], ctx.session);
  assert.equal(resolveSender({ role: 'user', idempotencyKey: 'turn-a' }, { ...ctx, capturedSender: capture.lookup }).name, 'Mira');
  assert.equal(resolveSender({ role: 'user', idempotencyKey: 'turn-b' }, { ...ctx, capturedSender: capture.lookup }).name, null);
  assert.equal(resolveSender({ role: 'user', idempotencyKey: 'turn-a' }, { ...ctx, sessionKey: 'other', capturedSender: capture.lookup }).name, null);
  assert.equal(messageKey({ role: 'user', __openclaw: { id: 'persisted-id' } }), 'message:persisted-id');
});
test('bound adapter captures before engine normalisation and recovers metadata-free messages without runtime storage', () => {
  const cache = repo(), runtime = createRuntime({ readonly: true, identityPath: '/nonexistent/synthetic-identity', stateDbPath: '/nonexistent/synthetic.sqlite' }, { senderCaptures: cache });
  const engine = createEngine({ adapter: runtime.definition });
  const ingest = (m) => engine.ingest({ source: 'gateway', channel: 'gw.rpc.sessions.get', receivedAt: Date.UTC(2026, 9, 8), context: { key: KEY }, body: { kind: 'json', value: { messages: [m] } } });
  try {
    ingest(message()); assert.equal(engine.transcript(KEY).events[0].senderInfo.name, 'Mira');
    ingest({ role: 'user', content: 'Synthetic content', idempotencyKey: 'turn-a' });
    assert.equal(engine.transcript(KEY).events[0].senderInfo.name, 'Mira');
    assert.equal(engine.runtime().capabilities.senderCapture, true);
    assert.equal(cache.values.size, 1);
  } finally { runtime.close(); }
  for (const cfg of [{ senderCapture: false }, { readonlyStore: true }]) {
    const disabled = createRuntime({ ...cfg, identityPath: '/nonexistent/synthetic-identity', stateDbPath: '/nonexistent/synthetic.sqlite' }, { senderCaptures: cache });
    assert.equal(disabled.definition.capabilities().senderCapture, false); disabled.close();
  }
  assert.equal(require('../../src/adapters/demo').definition.capabilities().senderCapture, undefined);
});
test('events capture immediately; group changes debounce reads, skip direct sessions, disconnect and close cancel work', async () => {
  const gw = new EventEmitter(), cache = repo(), capture = createSenderCapture(cache), calls = [];
  gw.connected = true; gw.call = async (method, params) => { calls.push({ method, params }); return { messages: [message('jules', 'Jules', 'turn-b')] }; };
  const stop = capture.watch(gw);
  gw.emit('gwevent', 'session.message', { sessionKey: KEY, message: message() });
  assert.equal(capture.lookup(KEY, messageKey(message())).name, 'Mira');
  for (let i = 0; i < 10; i++) gw.emit('gwevent', 'sessions.changed', { sessionKey: KEY });
  gw.emit('gwevent', 'sessions.changed', { sessionKey: 'agent:atlas:discord:direct:synthetic-peer' });
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
  assert.deepEqual(calls, [{ method: 'sessions.get', params: { key: KEY } }]);
  assert.equal(capture.lookup(KEY, 'idempotency:turn-b').name, 'Jules');
  gw.emit('gwevent', 'sessions.changed', { sessionKey: KEY }); gw.emit('close');
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100)); assert.equal(calls.length, 1);
  gw.emit('gwevent', 'sessions.changed', { sessionKey: KEY }); stop();
  assert.equal(gw.listenerCount('gwevent'), 0);
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100)); assert.equal(calls.length, 1);
});
test('capture storage errors do not break gateway event delivery or transcript identity', () => {
  const gw = new EventEmitter(), runtime = createRuntime({ identityPath: '/nonexistent/synthetic-identity' }, { senderCaptures: { putMany() { throw new Error('synthetic failure'); }, get() { return null; } } });
  try { assert.equal(runtime.definition.normalise.transcript(KEY, { messages: [message()] }, 1).events[0].senderInfo.name, 'Mira'); } finally { runtime.close(); }
  const stop = createSenderCapture({ putMany() { throw new Error('synthetic failure'); } }).watch(gw);
  try { assert.doesNotThrow(() => gw.emit('gwevent', 'session.message', { sessionKey: KEY, message: message() })); } finally { stop(); }
});
test('a burst of group changes cannot create more than the bounded pending read set', async () => {
  const gw = new EventEmitter(), capture = createSenderCapture(repo()), calls = [];
  gw.connected = true; gw.call = async (_, params) => { calls.push(params.key); return { messages: [] }; };
  const stop = capture.watch(gw);
  try {
    for (let i = 0; i < MAX_PENDING + 10; i++) gw.emit('gwevent', 'sessions.changed', { sessionKey: KEY + '-' + i });
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100)); assert.equal(calls.length, MAX_PENDING);
  } finally { stop(); }
});
