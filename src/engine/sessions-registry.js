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
const { sameRun, resolveRunIdentity } = require('./run-identity');
const { MAX_SESSION_PAGE_SIZE, MAX_SESSION_PAGES, MAX_RUNTIME_SESSIONS } = require('./session-limits');

const MAX_PAGES = MAX_SESSION_PAGES;
// Run evidence is one coherent observation (R5 Residual D): these fields always come together from the
// NEWER source, never mixed field by field with an older one (an older hasActiveRun:true must not survive
// a newer terminal status that simply omits the flag).
const RUN_FIELDS = ['status', 'hasActiveRun', 'hasActiveSubagentRun', 'startedAt', 'endedAt', 'runtimeMs', 'lastRunId', 'lastRunError', 'subagentRunState'];
const TERMINAL_RUN_STATES = new Set(['succeeded', 'failed', 'cancelled']);

function createSessionsRegistry({ now, normalise, classify, validate = () => true }) {
  if (typeof normalise !== 'function' || typeof classify !== 'function') throw new Error('sessions registry: normalise and classify are required (runtime adapter)');
  const listRows = new Map();      // key → { row, at, canonical } (input provenance, never inferred from row shape)
  const descRows = new Map();      // key → { row, at }   (raw validated descriptions)
  let order = [];                  // display order (last complete snapshot, then new keys appended)
  let sessions = new Map();        // key → canonical Session
  let meta = { totalCount: null, listedAt: null, complete: false };
  let run = null;                  // { expected, generation, keys: [], seen: Set, rows: Map, valid, pages }
  let seq = 0;                     // fallback source order and row arrival order
  const sessionSourceOrder = new Map(); // latest request-start order, scoped to one session key
  let changedHighWater = 0; // events after a snapshot began make all snapshot absences unsafe
  let latestSnapshotGeneration = 0; // only snapshot generations supersede other snapshots
  let unclassifiedReported = false;

  function retainedKeyCount(rows = listRows, descriptions = descRows) {
    const keys = new Set(rows.keys());
    for (const key of descriptions.keys()) keys.add(key);
    return keys.size;
  }

  function retainPartialRows(snapshot, rec) {
    const priorRows = new Map(listRows), priorOrder = order, priorSessions = sessions;
    const priorSourceOrder = new Map(sessionSourceOrder);
    const next = new Map(listRows);
    for (const [key, row] of snapshot.rows) {
      const current = next.get(key);
      if (!current && retainedKeyCount(next, descRows) >= MAX_RUNTIME_SESSIONS) {
        rec({ code: 'shape.invalid', severity: 'error', path: '$.sessions', detail: 'retained session inventory exceeds the supported limit' });
        continue;
      }
      if (!current || row.sourceOrder >= (sessionSourceOrder.get(key) || 0)) next.set(key, row);
    }
    listRows.clear(); for (const [key, row] of next) listRows.set(key, row);
    for (const [key, row] of snapshot.rows) if (listRows.has(key)) {
      sessionSourceOrder.set(key, Math.max(sessionSourceOrder.get(key) || 0, row.sourceOrder || snapshot.generation));
    }
    order = [...snapshot.keys, ...[...listRows.keys()].filter(key => !snapshot.seen.has(key))];
    if (!rebuild(rec)) {
      snapshot.valid = false;
      listRows.clear(); for (const [key, row] of priorRows) listRows.set(key, row);
      order = priorOrder;
      sessions = priorSessions;
      sessionSourceOrder.clear(); for (const [key, source] of priorSourceOrder) sessionSourceOrder.set(key, source);
    }
  }

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
    const next = new Map(); let valid = true;
    for (const key of order) {
      const input = listRows.get(key);
      // A canonical transfer is already normalized. Native descriptions remain
      // pending until a native list observation arrives; never merge both formats.
      const row = input?.canonical ? input.row : mergedRow(key);
      if (!row) continue;
      const base = baseKeyOf(key);
      const { session, unmappedStatus } = input.canonical ? {session:row} : normalise(row, { baseRow: base ? mergedRow(base) || undefined : undefined, observedAt: input.at });
      if (unmappedStatus !== undefined) rec({ code: 'enum.unmapped', severity: 'warn', path: '$.sessions[].status', detail: 'session status not in the RUN_STATUS table', sample: { length: unmappedStatus.length } });
      // Keep the canonical generic kind on every row, while representing unknown classifiers once
      // per registry lifetime. Large inventories and later change events must not fan out warnings.
      if (session.class.kind === 'unrecognized' && !unclassifiedReported) {
        unclassifiedReported = true;
        rec({ code: 'session.unclassified', severity: 'warn', path: '$.sessions[].key', incrementCount: false });
      }
      const prior = sessions.get(key);
      const resolvedRun = prior && resolveRunIdentity(prior, session);
      const canonicalInput = resolvedRun?.same ? {
        ...session,
        run: { ...session.run, lastRunId: resolvedRun.identity.lastRunId, startedAt: resolvedRun.identity.startedAt },
      } : session;
      // PM audit (B): the canonical Session is an entity (frozen, explicit nulls, validated)
      const e = SessionEntity.from(canonicalInput, (i) => rec({ code: 'shape.invalid', severity: 'error', path: '$.canonical' + i.path.slice(1), detail: i.detail }));
      if (!e || !validate(e, rec)) { valid = false; if (sessions.has(key)) next.set(key, sessions.get(key)); continue; }
      if (prior && TERMINAL_RUN_STATES.has(prior.run.status)) {
        // A terminal run is monotonic. Without a distinct stable run identity, a later row
        // cannot prove that `running` means a genuinely new run rather than stale state.
        if (sameRun(prior, e)) {
          const retained = SessionEntity.from({ ...e.toJSON(), run: prior.run }, (i) => rec({ code: 'shape.invalid', severity: 'error', path: '$.canonical' + i.path.slice(1), detail: i.detail }));
          next.set(key, retained || prior); continue;
        }
      }
      next.set(key, e);
    }
    if (valid) sessions = next;
    return valid;
  }

  // One page of sessions.list. `offset` is the request offset (0 = a new snapshot run).
  // `rowsDropped`: the page had rows rejected by validation (R5 Residual C), so its absences prove nothing.
  function acceptPage(value, offset, rec, { rowsDropped = false, canonical = false, acquisitionGeneration = null, sourceOrder = null } = {}) {
    offset = Number.isInteger(offset) ? offset : 0;
    const externalGeneration = Number.isSafeInteger(acquisitionGeneration) && acquisitionGeneration > 0 ? acquisitionGeneration
      : Number.isSafeInteger(sourceOrder) && sourceOrder > 0 ? sourceOrder : null;
    if (offset === 0) {
      const generation = externalGeneration || seq + 1;
      if (generation < latestSnapshotGeneration) return;
      latestSnapshotGeneration = generation;
      seq = Math.max(seq, generation);
      run = { expected: 0, generation, keys: [], seen: new Set(), rows: new Map(), valid: true, pages: 0, totals: new Set() };
    }
    const wrongGeneration = !!run && externalGeneration != null && externalGeneration !== run.generation;
    // A late continuation from a superseded snapshot is inert. It cannot poison the
    // active run, while malformed pages in the active generation still invalidate it.
    if (!run || wrongGeneration) return;
    if (offset !== run.expected) { run.valid = false; return; }
    if (!Array.isArray(value?.sessions) || value.sessions.length > (canonical ? MAX_RUNTIME_SESSIONS : MAX_SESSION_PAGE_SIZE)
      || run.seen.size + value.sessions.filter(row => row && !run.seen.has(row.key)).length > MAX_RUNTIME_SESSIONS) {
      run.valid = false;
      rec({ code: 'shape.invalid', severity: 'error', path: '$.sessions', detail: 'session inventory exceeds the supported limit' });
      meta = Object.assign({}, meta, { listedAt: now(), complete: false });
      run = null;
      return;
    }
    run.pages++;
    // R6-11: every total any page supplies is evidence; they must agree with each other and with the rows.
    if (Number.isInteger(value.totalCount)) run.totals.add(value.totalCount);
    if (rowsDropped) run.valid = false;
    let fresh = 0;
    const at = now();
    for (const row of value.sessions) {
      const rowOrder = Number.isSafeInteger(sourceOrder) && sourceOrder > 0 ? sourceOrder : run.generation;
      const previousOrder = sessionSourceOrder.get(row.key) || 0;
      if (rowOrder >= previousOrder) run.rows.set(row.key, { row, at, seq: ++seq, sourceOrder: rowOrder, canonical });
      if (!run.seen.has(row.key)) { run.seen.add(row.key); run.keys.push(row.key); fresh++; }
    }
    const more = value.hasMore === true;
    if (more && fresh === 0) run.valid = false;   // stalled pagination
    if (more && run.pages >= MAX_PAGES) {
      run.valid = false;
      rec({ code: 'shape.invalid', severity: 'error', path: '$.sessions', detail: 'session pagination exceeds the supported limit' });
      meta = Object.assign({}, meta, { listedAt: at, complete: false });
      retainPartialRows(run, rec);
      run = null;
      return;
    }
    if (more) {
      run.expected = Number.isInteger(value.nextOffset) ? value.nextOffset : offset + value.sessions.length;
      meta = Object.assign({}, meta, { listedAt: at, complete: false });
      retainPartialRows(run, rec);
    }
    if (!more) {
      // a total that contradicts what was received is not a complete snapshot either (Residual C)
      if (run.totals.size > 1 || (run.totals.size === 1 && !run.totals.has(run.keys.length))) run.valid = false;
      if (run.valid) {
        // A complete snapshot only has deletion authority after every canonical
        // entity in the proposed replacement has passed validation. Keep the
        // last accepted state so a rejected row cannot turn an invalid page's
        // absences into deletions.
        const priorListRows = new Map(listRows);
        const priorDescRows = new Map(descRows);
        const priorOrder = order;
        const priorSessions = sessions;
        const priorSourceOrder = new Map(sessionSourceOrder);
        const priorMeta = meta;
        const nextRows = new Map(run.rows);
        const mayReconcileAbsence = run.generation >= changedHighWater;
        for (const [key, prior] of listRows) {
          if ((sessionSourceOrder.get(key) || 0) > run.generation || !mayReconcileAbsence && !run.seen.has(key)) nextRows.set(key, prior);
        }
        const nextDescriptions = new Map(descRows);
        for (const [key, description] of nextDescriptions) {
          if (!nextRows.has(key) && (description.sourceOrder || 0) <= run.generation) nextDescriptions.delete(key);
        }
        if (retainedKeyCount(nextRows, nextDescriptions) <= MAX_RUNTIME_SESSIONS) {
          listRows.clear();
          for (const [key, row] of nextRows) listRows.set(key, row);
          descRows.clear();
          for (const [key, row] of nextDescriptions) descRows.set(key, row);
          for (const key of [...sessionSourceOrder.keys()]) if (!listRows.has(key) && !descRows.has(key)) sessionSourceOrder.delete(key);
          for (const [key, row] of run.rows) sessionSourceOrder.set(key, Math.max(sessionSourceOrder.get(key) || 0, row.sourceOrder || run.generation));
          order = [...run.keys, ...[...listRows.keys()].filter(k => !run.seen.has(k))];
          if (!rebuild(rec)) {
            run.valid = false;
            listRows.clear(); for (const [key, row] of priorListRows) listRows.set(key, row);
            descRows.clear(); for (const [key, row] of priorDescRows) descRows.set(key, row);
            order = priorOrder;
            sessions = priorSessions;
            sessionSourceOrder.clear(); for (const [key, source] of priorSourceOrder) sessionSourceOrder.set(key, source);
            meta = Object.assign({}, priorMeta, { listedAt: at, complete: false });
          } else meta = { totalCount: order.length, listedAt: at, complete: true };
        } else {
          run.valid = false;
          rec({ code: 'shape.invalid', severity: 'error', path: '$.sessions', detail: 'retained session inventory exceeds the supported limit' });
          meta = Object.assign({}, meta, { listedAt: at, complete: false });
        }
      } else {
        retainPartialRows(run, rec);
        meta = Object.assign({}, meta, { listedAt: at, complete: false });
      }
      run = null;
    }
  }

  // A failed or rejected sessions.list page: the current run can no longer justify deletions.
  function invalidateRun() { if (run) run.valid = false; }

  // sessions.changed (event-driven): upsert one session immediately; never deletes (only complete
  // snapshots delete). The event row is as fresh as a list row.
  function acceptChanged(row, rec, { canonical = false, sourceOrder = null } = {}) {
    if (!listRows.has(row.key) && !descRows.has(row.key) && retainedKeyCount() >= MAX_RUNTIME_SESSIONS) {
      rec({ code: 'shape.invalid', severity: 'error', path: '$.session', detail: 'session inventory exceeds the supported limit' });
      return;
    }
    const sourceOrderValue = Number.isSafeInteger(sourceOrder) && sourceOrder > 0 ? sourceOrder : seq + 1;
    if (sourceOrderValue < (sessionSourceOrder.get(row.key) || 0)) return;
    const before = { row: listRows.get(row.key), sourceOrder: sessionSourceOrder.get(row.key), order: [...order], seq,
      changedHighWater, unclassifiedReported, sessions };
    const restore = () => {
      if (before.row === undefined) listRows.delete(row.key); else listRows.set(row.key, before.row);
      if (before.sourceOrder === undefined) sessionSourceOrder.delete(row.key); else sessionSourceOrder.set(row.key, before.sourceOrder);
      order = before.order; seq = before.seq; changedHighWater = before.changedHighWater;
      unclassifiedReported = before.unclassifiedReported; sessions = before.sessions;
    };
    seq = Math.max(seq, sourceOrderValue);
    const at = now();
    listRows.set(row.key, { row, at, seq: ++seq, sourceOrder: sourceOrderValue, canonical });
    sessionSourceOrder.set(row.key, sourceOrderValue);
    changedHighWater = Math.max(changedHighWater, sourceOrderValue);
    if (!order.includes(row.key)) order.push(row.key);
    try { if (rebuild(rec)) return; } catch (error) { restore(); throw error; }
    restore();
  }

  function acceptDescription(row, rec, { sourceOrder = null } = {}) {
    if (!descRows.has(row.key) && !listRows.has(row.key) && retainedKeyCount() >= MAX_RUNTIME_SESSIONS) {
      rec({ code: 'shape.invalid', severity: 'error', path: '$.session', detail: 'session inventory exceeds the supported limit' });
      return;
    }
    const sourceOrderValue = Number.isSafeInteger(sourceOrder) && sourceOrder > 0 ? sourceOrder : seq + 1;
    if (sourceOrderValue < (sessionSourceOrder.get(row.key) || 0)) return;
    const before = { row: descRows.get(row.key), sourceOrder: sessionSourceOrder.get(row.key), seq, unclassifiedReported, sessions };
    const restore = () => {
      if (before.row === undefined) descRows.delete(row.key); else descRows.set(row.key, before.row);
      if (before.sourceOrder === undefined) sessionSourceOrder.delete(row.key); else sessionSourceOrder.set(row.key, before.sourceOrder);
      seq = before.seq; unclassifiedReported = before.unclassifiedReported; sessions = before.sessions;
    };
    seq = Math.max(seq, sourceOrderValue);
    descRows.set(row.key, { row, at: now(), seq: ++seq, sourceOrder: sourceOrderValue });
    sessionSourceOrder.set(row.key, sourceOrderValue);
    try { if (rebuild(rec)) return; } catch (error) { restore(); throw error; }
    restore();
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
