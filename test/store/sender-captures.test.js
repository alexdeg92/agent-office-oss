'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { openStore } = require('../../src/store');
const { createSenderCapturesRepo } = require('../../src/store/repos/sender-captures');
const DAY = 86400000;
const sender = { kind: 'human', id: 'matrix-user:mira', name: 'Mira', runtime: 'future-runtime', channel: 'matrix', avatarHint: 'https://example.invalid/avatar' };
const entry = (eventKey = 'message:a', overrides = {}) => ({ runtime: sender.runtime, sessionKey: 'room:workshop', eventKey, sender, ...overrides });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-sender-cache-'));
  let at = Date.UTC(2026, 9, 8);
  const store = openStore({ dir, instance: 'test', ownerName: 'Camille', now: () => at, log: () => {} });
  t.after(() => { if (store.db.isOpen) store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, dir, now: () => at, advance: (ms) => { at += ms; } };
}
test('capture persists exact runtime/session/event scope across reopen and whitelists minimal identity', (t) => {
  const f = fixture(t), repo = f.store.senderCaptures;
  repo.putMany([entry('message:a', { sender: { ...sender, content: 'DO NOT STORE', token: 'DO NOT STORE' }, body: 'DO NOT STORE' })]);
  const expected = { ...sender, avatarHint: null };
  assert.deepEqual(repo.get(sender.runtime, 'room:workshop', 'message:a'), expected);
  for (const args of [['other-runtime', 'room:workshop', 'message:a'], [sender.runtime, 'room:other', 'message:a'], [sender.runtime, 'room:workshop', 'message:b']]) assert.equal(repo.get(...args), null);
  assert.doesNotMatch(JSON.stringify(f.store.db.prepare('SELECT * FROM sender_captures').all()), /DO NOT STORE|https:/);
  f.store.close();
  const reopened = openStore({ dir: f.dir, instance: 'test', ownerName: 'Camille', now: f.now, log: () => {} });
  try { assert.deepEqual(reopened.senderCaptures.get(sender.runtime, 'room:workshop', 'message:a'), expected); } finally { reopened.close(); }
});
test('retention expires on lookup, replay does not extend TTL or overwrite identity, maintenance removes rows', (t) => {
  const f = fixture(t), repo = createSenderCapturesRepo(f.store.db, { now: f.now, retentionDays: 1 });
  repo.putMany([entry()]); f.advance(DAY - 1);
  repo.putMany([entry('message:a', { sender: { ...sender, id: 'matrix-user:jules', name: 'Jules' } })]);
  assert.equal(repo.get(sender.runtime, 'room:workshop', 'message:a').name, 'Mira');
  f.advance(1); assert.equal(repo.get(sender.runtime, 'room:workshop', 'message:a'), null);
  assert.equal(repo.prune(), 1); assert.equal(f.store.db.prepare('SELECT count(*) n FROM sender_captures').get().n, 0);
});
test('both record count and UTF-8 byte caps evict oldest; oversized and malformed identities are rejected', (t) => {
  const f = fixture(t);
  const repo = createSenderCapturesRepo(f.store.db, { now: f.now, maxEntries: 2 });
  repo.putMany([entry('a'), entry('b'), entry('c')]);
  assert.equal(repo.get(sender.runtime, 'room:workshop', 'a'), null);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM sender_captures').get().n, 2);
  f.store.db.exec('DELETE FROM sender_captures');
  const small = createSenderCapturesRepo(f.store.db, { now: f.now, maxBytes: 400 });
  small.putMany([entry('a'), entry('b'), entry('c')]);
  assert.ok(f.store.db.prepare('SELECT coalesce(sum(size_bytes),0) bytes FROM sender_captures').get().bytes <= 400);
  assert.equal(small.get(sender.runtime, 'room:workshop', 'a'), null);
  const before = f.store.db.prepare('SELECT count(*) n FROM sender_captures').get().n;
  small.putMany([entry('x'.repeat(1025)), entry('bad', { sender: { ...sender, runtime: 'different' } }), entry('huge', { sender: { ...sender, id: 'x'.repeat(513) } })]);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM sender_captures').get().n, before);
  assert.ok(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='sender_captures_retention'").get());
});
