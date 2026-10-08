'use strict';
/*
 * Canonical session registry (S3, hardened in S3.1).
 *
 * Snapshots (R2-02): sessions.list is paginated (hasMore / nextOffset). Pages are collected into a
 * run that starts at offset 0. Rows are upserted as pages arrive, but sessions are only DELETED when
 * a run completes with every page received in order. A failed, rejected, out-of-order or stalled page
 * invalidates the run: no absence in it counts as deletion evidence.
 *
 * Descriptions (R2-05): validated sessions.describe rows are merged into the canonical Session. The
 * newer of list row and description wins field by field; the other fills the gaps (e.g. a described
 * displayName survives later list refreshes that don't carry one). A description received before the
 * session is listed is kept and applied when it appears.
 *
 * Every normalised Session is validated against the canonical contract (model/session.js, R2-07);
 * a violation is quarantined and that session is not admitted.
 */
const schemaDsl = require('../schema');
// G2: the session normaliser and the key classifier are the runtime adapter's (injected); this registry is core.
const { Session: SessionEntity } = require('../model');

const MAX_PAGES = 20;
// Run evidence is one coherent observation (R5 Residual D): these fields always come together from the
// NEWER source, never mixed field by field with an older one (an older hasActiveRun:true must not survive
// a newer terminal status that simply omits the flag).
const RUN_FIELDS = ['status', 'hasActiveRun', 'hasActiveSubagentRun', 'startedAt', 'endedAt', 'runtimeMs', 'lastRunId', 'lastRunError', 'subagentRunState'];

function createSessionsRegistry({ now, normalise, classify }) {
  if (typeof normalise !== 'function' || typeof classify !== 'function') throw new Error('sessions registry: normalise and classify are required (runtime adapter)');
  const listRows = new Map();      // key → { row, at }   (raw validated list rows)
  const descRows = new Map();      // key → { row, at }   (raw validated descriptions)
  let order = [];                  // display order (last complete snapshot, then new keys appended)
  let sessions = new Map();        // key → canonical Session
  let meta = { totalCount: null, listedAt: null, complete: false };
  let run = null;                  // { expected, keys: [], seen: Set, valid, pages }
  let seq = 0;                     // arrival order (wall-clock time can tie; precedence must not)

  const baseKeyOf = (key) => { const m = String(key).match(/^(.*):heartbeat$/); return m ? m[1] : null; };
  function mergedRow(key) {
    const l = listRows.get(key), d = descRows.get(key);
    if (!l) return null;
    if (!d) return l.row;
    const newer = d.seq > l.seq ? d.row : l.row, older = d.seq > l.seq ? l.row : d.row;
    const merged = Object.assign({}, older, newer);
    if (RUN_FIELDS.some((k) => newer[k] !== undefined)) for (const k of RUN_FIELDS) { if (newer[k] === undefined) delete merged[k]; }
    // timestamps never move backwards: an older description can't rewind what the list already saw
    for (const k of ['updatedAt', 'lastActivityAt', 'lastInteractionAt']) {
      const a = l.row[k], b = d.row[k];
      if (Number.isInteger(a) || Number.isInteger(b)) merged[k] = Math.max(Number.isInteger(a) ? a : 0, Number.isInteger(b) ? b : 0);
    }
    return merged;
  }

  function rebuild(rec) {
    const next = new Map();
    for (const key of order) {
      const row = mergedRow(key);
      if (!row) continue;
      const base = baseKeyOf(key);
      const { session, unmappedStatus } = normalise(row, { baseRow: base ? mergedRow(base) || undefined : undefined });
      if (unmappedStatus !== undefined) rec({ code: 'enum.unmapped', severity: 'warn', path: '$.sessions[].status', detail: 'session status not in the RUN_STATUS table', sample: { length: unmappedStatus.length } });
      if (session.class.kind === 'unrecognized') rec({ code: 'session.unclassified', severity: 'warn', path: '$.sessions[].key' });
      // PM audit (B): the canonical Session is an entity (frozen, explicit nulls, validated)
      const e = SessionEntity.from(session, (i) => rec({ code: 'shape.invalid', severity: 'error', path: '$.canonical' + i.path.slice(1), detail: i.detail }));
      if (!e) continue;
      next.set(key, e);
    }
    sessions = next;
  }

  // One page of sessions.list. `offset` is the request offset (0 = a new snapshot run).
  // `rowsDropped`: the page had rows rejected by validation (R5 Residual C), so its absences prove nothing.
  function acceptPage(value, offset, rec, { rowsDropped = false } = {}) {
    offset = Number.isInteger(offset) ? offset : 0;
    if (offset === 0) run = { expected: 0, keys: [], seen: new Set(), valid: true, pages: 0, totals: new Set() };
    if (!run || offset !== run.expected) { if (run) run.valid = false; else run = { expected: -1, keys: [], seen: new Set(), valid: false, pages: 0, totals: new Set() }; }
    run.pages++;
    // R6-11: every total any page supplies is evidence; they must agree with each other and with the rows.
    if (Number.isInteger(value.totalCount)) run.totals.add(value.totalCount);
    if (rowsDropped) run.valid = false;
    let fresh = 0;
    const at = now();
    for (const row of value.sessions) {
      listRows.set(row.key, { row, at, seq: ++seq });
      if (!run.seen.has(row.key)) { run.seen.add(row.key); run.keys.push(row.key); fresh++; }
      if (!order.includes(row.key)) order.push(row.key);
    }
    const more = value.hasMore === true;
    if (more && (fresh === 0 || run.pages >= MAX_PAGES)) run.valid = false;   // stalled / runaway pagination
    if (more) run.expected = Number.isInteger(value.nextOffset) ? value.nextOffset : offset + value.sessions.length;
    if (!more) {
      // a total that contradicts what was received is not a complete snapshot either (Residual C)
      if (run.totals.size > 1 || (run.totals.size === 1 && !run.totals.has(run.keys.length))) run.valid = false;
      if (run.valid) {
        for (const k of [...listRows.keys()]) if (!run.seen.has(k)) listRows.delete(k);
        order = run.keys.slice();
        meta = { totalCount: run.keys.length, listedAt: at, complete: true };
      } else {
        meta = Object.assign({}, meta, { listedAt: at, complete: false });
      }
      run = null;
    }
    rebuild(rec);
  }

  // A failed or rejected sessions.list page: the current run can no longer justify deletions.
  function invalidateRun() { if (run) run.valid = false; }

  // sessions.changed (event-driven): upsert one session immediately; never deletes (only complete
  // snapshots delete). The event row is as fresh as a list row.
  function acceptChanged(row, rec) {
    const at = now();
    listRows.set(row.key, { row, at, seq: ++seq });
    if (!order.includes(row.key)) order.push(row.key);
    rebuild(rec);
  }

  function acceptDescription(row, rec) {
    descRows.set(row.key, { row, at: now(), seq: ++seq });
    rebuild(rec);
  }

  return {
    acceptPage, invalidateRun, acceptDescription, acceptChanged,
    list: () => [...sessions.values()],
    get: (key) => sessions.get(key) || null,
    meta: () => Object.assign({}, meta),
    // Classification for any key: registry first; a heartbeat of a known base uses the base's row.
    classify(key) {
      if (sessions.has(key)) return sessions.get(key).class;
      const base = baseKeyOf(key);
      return classify(key, undefined, { baseRow: base ? mergedRow(base) || undefined : undefined });
    },
  };
}

module.exports = { createSessionsRegistry, MAX_PAGES };
