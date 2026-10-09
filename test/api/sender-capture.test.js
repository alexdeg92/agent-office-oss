'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, waitFor } = require('../helpers/harness');
const { loadScenario, readFixture } = require('../helpers/scenario');
const KEY = 'agent:main:discord:channel:synthetic-workshop';
const sc = loadScenario('synthetic-basic'), list = readFixture(sc.rpc['sessions.list']).body.value;
const tpl = list.sessions.find((s) => s.key === 'agent:main:main');
const raw = (id, name, key) => ({ role: 'user', content: 'Synthetic content', timestamp: sc.now - 1, idempotencyKey: key,
  __openclaw: { senderId: id, senderName: name, senderIdentity: { type: 'observation', pluginId: 'discord', accountId: 'synthetic', senderKind: 'human', id }, idempotencyKey: key } });
const path = (v) => `/api/v${v}/views/sessions/${encodeURIComponent(KEY)}`;
test('real server captures live group events before a view opens, resolves exact keys in v2/v3, and exposes only Sender', async (t) => {
  const messages = [raw('mira', 'Mira', 'turn-a'), raw('jules', 'Jules', 'turn-b'), raw('noor', 'Noor', 'turn-c')];
  let payload = messages;
  const h = await startServer(sc, { env: { AO_ENRICHERS: '', PORTAL_DISPLAY_NAME: 'Camille' }, handlers: {
    'sessions.list': () => ({ ...list, sessions: [...list.sessions, { ...tpl, key: KEY, isMain: false, sessionId: 'synthetic-session', classification: undefined }] }),
    'sessions.get': () => ({ messages: payload }),
  } });
  t.after(() => h.stop());
  assert.equal((await h.get('/api/v3/meta')).json.data.runtime.capabilities.senderCapture, true);
  h.gw.emit('session.message', { sessionKey: KEY, message: messages[0] });
  await waitFor(() => h.withStore((db) => db.prepare('SELECT count(*) n FROM sender_captures').get().n === 1));
  h.gw.emit('sessions.changed', { sessionKey: KEY, reason: 'activity' });
  await waitFor(() => h.withStore((db) => db.prepare('SELECT count(*) n FROM sender_captures').get().n === 3));
  payload = messages.map(({ __openclaw, ...m }) => m).concat([{ role: 'user', content: 'Synthetic unknown', timestamp: sc.now, idempotencyKey: 'missing' }]);
  for (const v of [2, 3]) {
    const response = await h.get(path(v)); assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.json.data.events.map((e) => e.senderInfo.name), ['Mira', 'Jules', 'Noor', null]);
    assert.doesNotMatch(JSON.stringify(response.json.data), /senderIdentity|accountId|idempotencyKey/);
  }
  h.withStore((db) => { const rows = db.prepare('SELECT * FROM sender_captures').all(); assert.equal(rows.length, 3); assert.doesNotMatch(JSON.stringify(rows), /Synthetic content|accountId|senderIdentity/); });
});
test('disabled capture advertises false, writes no attribution cache, and still uses present producer metadata', async (t) => {
  let payload = [raw('mira', 'Mira', 'turn-a')];
  const h = await startServer(sc, { env: { AO_ENRICHERS: '', AO_SENDER_CAPTURE: '0' }, handlers: {
    'sessions.list': () => ({ ...list, sessions: [...list.sessions, { ...tpl, key: KEY, isMain: false, sessionId: 'synthetic-session', classification: undefined }] }),
    'sessions.get': () => ({ messages: payload }),
  } });
  t.after(() => h.stop());
  assert.equal((await h.get('/api/v3/meta')).json.data.runtime.capabilities.senderCapture, false);
  assert.equal((await h.get(path(3))).json.data.events[0].senderInfo.name, 'Mira');
  payload = [{ role: 'user', content: 'Synthetic content', timestamp: sc.now, idempotencyKey: 'turn-a' }];
  assert.equal((await h.get(path(3))).json.data.events[0].senderInfo.name, null);
  h.withStore((db) => assert.equal(db.prepare('SELECT count(*) n FROM sender_captures').get().n, 0));
});
