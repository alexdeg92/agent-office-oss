'use strict';
const { withTx } = require('../db');
const { Sender, nameOf } = require('../../engine/model/sender');
const { validate } = require('../../schema');
const DAY = 86400000;
const DEFAULTS = Object.freeze({ retentionDays: 30, maxEntries: 10000, maxBytes: 8 * 1024 * 1024 });
const bounded = (v, n) => typeof v === 'string' && v.trim().length > 0 && v.length <= n;

// Adapters supply exact message keys and neutral Sender values. This repo knows no runtime grammar.
function createSenderCapturesRepo(db, { now = () => Date.now(), retentionDays = DEFAULTS.retentionDays, maxEntries = DEFAULTS.maxEntries, maxBytes = DEFAULTS.maxBytes } = {}) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365 || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000
    || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULTS.maxBytes)
    throw new RangeError('invalid sender capture bounds');
  const get = db.prepare('SELECT sender_json FROM sender_captures WHERE runtime=? AND session_key=? AND event_key=? AND captured_at>?');
  const put = db.prepare('INSERT INTO sender_captures (runtime,session_key,event_key,sender_json,size_bytes,captured_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING');
  const expired = db.prepare('DELETE FROM sender_captures WHERE captured_at<=?');
  const excess = db.prepare(`DELETE FROM sender_captures WHERE rowid IN (
    SELECT id FROM (SELECT rowid AS id, row_number() OVER (ORDER BY captured_at DESC,rowid DESC) AS position,
      sum(size_bytes) OVER (ORDER BY captured_at DESC,rowid DESC) AS bytes FROM sender_captures)
    WHERE position>? OR bytes>?)`);
  const validKey = (runtime, sessionKey, eventKey) => bounded(runtime, 128) && bounded(sessionKey, 1024) && bounded(eventKey, 1024);
  function prune() { return withTx(db, () => Number(expired.run(now() - retentionDays * DAY).changes) + Number(excess.run(maxEntries, maxBytes).changes)); }
  function read(runtime, sessionKey, eventKey) {
    if (!validKey(runtime, sessionKey, eventKey)) return null;
    const row = get.get(runtime, sessionKey, eventKey, now() - retentionDays * DAY);
    if (!row) return null;
    try { const r = validate(Sender, JSON.parse(row.sender_json)); return r.ok && r.value.runtime === runtime ? r.value : null; } catch { return null; }
  }
  function putMany(entries) {
    return withTx(db, () => {
      prune();
      let added = 0;
      for (const { runtime, sessionKey, eventKey, sender } of entries) {
        if (!validKey(runtime, sessionKey, eventKey) || !sender || sender.runtime !== runtime || !bounded(sender.id, 512)
          || (sender.channel !== null && !bounded(sender.channel, 128))) continue;
        // Whitelist fields. Avatars/known-person enrichment are resolved afresh, never captured.
        const value = { kind: sender.kind, id: sender.id, name: nameOf(sender.name), runtime, channel: sender.channel, avatarHint: null };
        if (!validate(Sender, value).ok) continue;
        const json = JSON.stringify(value);
        if (json.length > 2048) continue;
        const bytes = Buffer.byteLength(runtime) + Buffer.byteLength(sessionKey) + Buffer.byteLength(eventKey) + Buffer.byteLength(json);
        if (bytes > maxBytes || bytes > 16384) continue;
        // First exact-key observation wins. Replayed reads cannot extend retention or replace attribution.
        added += Number(put.run(runtime, sessionKey, eventKey, json, bytes, now()).changes);
      }
      prune(); return added;
    });
  }
  prune();
  return { get: read, putMany, prune, bounds: { retentionDays, maxEntries, maxBytes } };
}
module.exports = { createSenderCapturesRepo, DEFAULTS };
