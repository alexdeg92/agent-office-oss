'use strict';
/*
 * Quarantine persistence (storage.md §4, §7). An issue record is value-free (engine.md §5.3): code,
 * severity, channel, schema path, count, timestamps, state. A row that fails validation on read is
 * skipped and reported (store.invalid), never returned half-parsed.
 */
const s = require('../../schema');

const IssueRow = s.object({
  fingerprint: s.string().refine((f) => /^[0-9a-f]{16}$|^overflow$/.test(f), 'fingerprint'), code: s.string().min(1),
  severity: s.enumOf(['error', 'warn', 'info']), channel: s.string().min(1), path: s.string().refine((p) => p.startsWith('$'), 'path').nullable(),
  count: s.int().min(1), firstSeenAt: s.int().min(0), lastSeenAt: s.int().min(0), state: s.enumOf(['open', 'resolved', 'muted']),
}, { extra: 'reject' });

function createQuarantineRepo(db, { onInvalid = () => {} } = {}) {
  const upsert = db.prepare(`INSERT INTO quarantine (fingerprint, code, severity, channel, path, count, first_seen_at, last_seen_at, state)
    VALUES (:fingerprint, :code, :severity, :channel, :path, :count, :first_seen_at, :last_seen_at, :state)
    ON CONFLICT (fingerprint) DO UPDATE SET count = excluded.count, last_seen_at = excluded.last_seen_at, state = excluded.state`);
  const all = db.prepare('SELECT * FROM quarantine');
  const del = db.prepare('DELETE FROM quarantine WHERE fingerprint = ?');
  const prune = db.prepare("DELETE FROM quarantine WHERE state = 'resolved' AND last_seen_at < ?");
  const pruneMutedQ = db.prepare("DELETE FROM quarantine WHERE state = 'muted' AND last_seen_at < ?");   // G8

  function toRow(i) {
    const rec = { fingerprint: i.fingerprint, code: i.code, severity: i.severity, channel: i.channel, path: i.path,
      count: i.count, firstSeenAt: i.firstSeenAt, lastSeenAt: i.lastSeenAt, state: i.state };
    if (!s.validate(IssueRow, rec).ok) throw new Error('quarantine issue rejected by the store schema');
    return { fingerprint: rec.fingerprint, code: rec.code, severity: rec.severity, channel: rec.channel, path: rec.path,
      count: rec.count, first_seen_at: rec.firstSeenAt, last_seen_at: rec.lastSeenAt, state: rec.state };
  }
  function fromRow(r) {
    const i = { fingerprint: r.fingerprint, code: r.code, severity: r.severity, channel: r.channel, path: r.path,
      count: r.count, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, state: r.state };
    return s.validate(IssueRow, i).ok ? i : null;
  }

  return {
    loadAll() {
      const out = [];
      for (const r of all.all()) { const i = fromRow(r); if (i) out.push(i); else onInvalid('quarantine'); }
      return out;
    },
    upsertMany(issues) { for (const i of issues) upsert.run(toRow(i)); },
    deleteMany(fingerprints) { for (const fp of fingerprints) del.run(fp); },
    pruneResolved(before) { return Number(prune.run(before).changes); },
    pruneMuted(before) { return Number(pruneMutedQ.run(before).changes); },
  };
}

module.exports = { createQuarantineRepo, IssueRow };
