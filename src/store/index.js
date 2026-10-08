'use strict';
/*
 * The store, composed (storage.md §5): the database, its repositories, the engine binding and the
 * daily maintenance. The rest of the server sees only this object.
 *
 *   const store = openStore({ dir, instance, ownerName, log });
 *   store.bindEngine(engine);     // restores the quarantine, then writes it behind every FLUSH_MS
 *   store.startMaintenance();     // 04:00 local: backup, audit/quarantine retention
 *   store.close();                // flushes, then closes (SIGTERM)
 */
const { openDatabase, withTx } = require('./db');
const { createQuarantineRepo } = require('./repos/quarantine');
const { createCachesRepo } = require('./repos/caches');
const { createAuditRepo } = require('./repos/audit');
const { createPersonsRepo } = require('./repos/persons');
const { createSessionsRepo } = require('./repos/sessions');
const { createTokensRepo } = require('./repos/tokens');
const { createOfficeRepo } = require('./repos/office');
const { createCommentsRepo } = require('./repos/comments');
const { every } = require('../ops/timescale');

const FLUSH_MS = 5000;
const DAY = 86400000;
const RETENTION = { auditMs: 365 * DAY, resolvedIssueMs: 30 * DAY };
const MAINTENANCE_HOUR = 4;

function msUntilNextHour(hour, from = new Date()) {
  const next = new Date(from); next.setHours(hour, 0, 0, 0);
  if (next <= from) next.setDate(next.getDate() + 1);
  return next - from;
}

// G8 (operations.md §3): `retention` { auditDays, issueDays } (config; defaults RETENTION)
function openStore({ dir, instance, ownerName, renameOwner = false, now = () => Date.now(), log = (m) => console.log(m), retention = null }) {
  const keep = { auditMs: (retention && retention.auditDays ? retention.auditDays * DAY : RETENTION.auditMs), resolvedIssueMs: (retention && retention.issueDays ? retention.issueDays * DAY : RETENTION.resolvedIssueMs) };
  const handle = openDatabase({ dir, instance, now, log });
  const { db } = handle;
  let engine = null;
  // A row that fails validation on read is skipped and reported (engine.md §5, code store.invalid).
  const onInvalid = (table) => {
    if (engine) engine.quarantine.record({ channel: 'store.' + table, code: 'store.invalid', severity: 'warn', path: null });
    else pendingInvalid.push(table);
  };
  const pendingInvalid = [];
  const quarantine = createQuarantineRepo(db, { onInvalid });
  const caches = createCachesRepo(db, { onInvalid });
  const audit = createAuditRepo(db);
  const persons = createPersonsRepo(db, { now });
  const sessions = createSessionsRepo(db);
  const tokens = createTokensRepo(db, { now });
  const office = createOfficeRepo(db, { now });
  const comments = createCommentsRepo(db, { now });   // architect-57
  const owner = withTx(db, () => persons.ensureOwner(ownerName, { rename: renameOwner }));
  const timers = [];

  function flushQuarantine() {
    if (!engine || !db.isOpen) return 0;
    const batch = engine.quarantine.takeDirty();
    if (!batch.upserts.length && !batch.deletes.length) return 0;
    try {
      withTx(db, () => { quarantine.upsertMany(batch.upserts); quarantine.deleteMany(batch.deletes); });
    } catch (e) {
      engine.quarantine.requeue(batch);    // R8-04: nothing is lost; the next flush retries
      throw e;
    }
    return batch.upserts.length + batch.deletes.length;
  }

  function bindEngine(e) {
    engine = e;
    engine.quarantine.restore(quarantine.loadAll());
    for (const t of pendingInvalid.splice(0)) onInvalid(t);
    // Seed an agent Person for each configured agent as soon as the gateway lists them (storage.md §5.2).
    const seeded = new Set();
    const seedAgents = () => {
      const fresh = (engine.agents() || []).filter((a) => !seeded.has(a.id));
      if (fresh.length) withTx(db, () => { for (const a of fresh) { persons.ensureAgent(a.id, a.name); seeded.add(a.id); } });
    };
    engine.on('change', seedAgents);
    seedAgents();
    const t = setInterval(() => { try { flushQuarantine(); } catch (err) { log('store: quarantine flush failed (' + (err.code || 'error') + ')'); } }, every(FLUSH_MS));
    t.unref(); timers.push(t);
  }

  function maintenance() {
    const t = now();
    // resolved issues after issueDays; muted ones after auditDays (both since their last occurrence); open ones stay
    if (engine) engine.quarantine.prune(t - keep.resolvedIssueMs, t - keep.auditMs);
    flushQuarantine();
    const pruned = withTx(db, () => ({ audit: audit.prune(t - keep.auditMs),
      issues: quarantine.pruneResolved(t - keep.resolvedIssueMs) + quarantine.pruneMuted(t - keep.auditMs),
      revoked: sessions.prune(t), seen: office.pruneSeen(t) }));
    log(`store: maintenance pruned audit=${pruned.audit}, issues=${pruned.issues}, revoked=${pruned.revoked}, seen=${pruned.seen}`);   // counts only
    const file = handle.backup('daily');
    return { backup: file, pruned };
  }

  function startMaintenance() {
    const arm = () => {
      const t = setTimeout(() => { try { maintenance(); } catch (err) { log('store: maintenance failed (' + (err.code || 'error') + ')'); } arm(); }, msUntilNextHour(MAINTENANCE_HOUR));
      t.unref(); timers.push(t);
    };
    arm();
  }

  function close() {
    for (const t of timers.splice(0)) clearTimeout(t);
    try { flushQuarantine(); } finally { handle.close(); }
  }

  return { db, dir: handle.dir, file: handle.file, version: handle.version, applied: handle.applied, owner,
    quarantine, caches, audit, persons, sessions, tokens, office, comments, withTx: (fn) => withTx(db, fn),
    bindEngine, flushQuarantine, maintenance, startMaintenance, backup: handle.backup, close,
    ping: () => !!db.prepare('SELECT 1 AS ok').get(),   // G8: /readyz's store check
  };
}

module.exports = { openStore, msUntilNextHour, FLUSH_MS, RETENTION };
