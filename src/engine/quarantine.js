'use strict';
/*
 * Quarantine: every input the engine could not fully accept becomes an Issue — deduplicated by
 * fingerprint, counted and timestamped. Nothing is dropped silently. Persisted by the store (S5).
 *
 * Privacy (PM decision on review-06, S4.1): **no values, ever; paths come from schemas.** An issue
 * record carries only:
 *   fingerprint · code · severity · channel · path · count · firstSeenAt · lastSeenAt · state
 * No sample, no detail, no source error text, no version, no payload key. Whatever a caller passes in
 * other fields is dropped here, centrally:
 *   - code, severity: closed lists;
 *   - channel: one of our channel ids; an unknown gateway event keeps its name only if the gateway
 *     advertised it (hello features.events), else 'gw.event.<unadvertised>';
 *   - path: a DSL path whose segments are declared schema names; record/map entries are '{}', array
 *     elements '[]'; any other segment (an extra or unexpected payload key) is '<undeclared>'. A path
 *     that is not a DSL path is dropped (null).
 *   - fingerprint: a hash of the sanitised (channel, code, path) only, so it encodes nothing else.
 */
const crypto = require('crypto');

const CODES = new Set(['rpc.failed', 'cli.failed', 'cli.not-ok', 'parse.failed', 'shape.invalid', 'shape.extra-field', 'shape.item-dropped', 'enum.unmapped',
  'session.unclassified', 'activity.unmapped', 'event.unknown', 'version.untested', 'store.invalid', 'schema.missing', 'quarantine.overflow',
  'vm.invalid',                                          // PM audit (B): a VM that failed its runtime check (last good one sent)
  'config.primary-invalid', 'config.primary-guessed',   // G3a: the primary-agent resolver (ADR §12.2)
  'store.unindexed']);                                   // PM after R26-01: real activity not indexed (an id too long to store), never hidden
const SEVERITIES = new Set(['error', 'warn', 'info']);
const EVENT_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

// `vocab` = { declared: Set<fieldName>, channels: Set<ourChannelId>, events: () => Set<advertisedEvent> }
function makeSanitizer(vocab = {}) {
  const declared = vocab.declared || new Set();
  const channels = vocab.channels || new Set();
  const events = vocab.events || (() => new Set());
  const prefix = vocab.eventPrefix || 'gw.event.';    // the runtime adapter's event-channel prefix (G2)

  function channel(c) {
    if (typeof c !== 'string') return '<redacted>';
    if (channels.has(c) || c === '*') return c;
    if (c.startsWith(prefix) && c.length > prefix.length) {
      const name = c.slice(prefix.length);
      return events().has(name) && EVENT_NAME.test(name) ? c : prefix + '<unadvertised>';
    }
    return '<redacted>';
  }
  function path(p) {
    if (typeof p !== 'string' || !p.startsWith('$')) return null;
    const segs = p.split('.');
    if (segs[0] !== '$') return null;
    return segs.map((seg, i) => {
      if (i === 0) return '$';
      const m = seg.match(/^([^[\]]*)((?:\[\d*\])*)$/);
      if (!m) return '<undeclared>';
      const name = m[1], arr = m[2].replace(/\[\d*\]/g, '[]');
      // '*' (DSL record entry) → '{}'; the normalised tokens themselves are kept, so sanitising is idempotent (R8-14)
      if (name === '*' || name === '{}') return '{}' + arr;
      if (name === '<undeclared>') return name + arr;
      if (name === '' && arr) return arr;
      return (declared.has(name) ? name : '<undeclared>') + arr;
    }).join('.');
  }
  return function sanitize(i) {
    return {
      code: CODES.has(i.code) ? i.code : 'schema.missing',
      severity: SEVERITIES.has(i.severity) ? i.severity : 'error',
      channel: channel(i.channel),
      path: path(i.path),
    };
  };
}

const RESOLVE_AFTER_CLEAN = 10;   // consecutive clean envelopes on a channel resolve its open issues
const MAX_FINGERPRINTS = 500;
const STATES = new Set(['open', 'resolved', 'muted']);

const fingerprintOf = (i) => crypto.createHash('sha1').update([i.channel, i.code, i.path || ''].join('|')).digest('hex').slice(0, 16);

function createQuarantine({ now = () => Date.now(), vocab = {} } = {}) {
  const sanitize = makeSanitizer(vocab);
  const issues = new Map();       // fingerprint → Issue
  const clean = new Map();        // channel → consecutive clean envelopes
  const dirty = new Set();        // fingerprints changed since the last takeDirty() (store write-behind, S5)
  const removed = new Set();      // fingerprints pruned since the last takeDirty()
  let version = 0;                // bumps on every state-visible change (open set, severities, states): R6-08 notifications

  // → true if the set of open issues or their states changed (not on a count/timestamp-only bump)
  function record(raw, { increment = true } = {}) {
    let i = sanitize(raw);
    let fp = fingerprintOf(i);
    const at = now();
    if (!issues.has(fp) && issues.size >= MAX_FINGERPRINTS) {
      fp = 'overflow';
      i = { code: 'quarantine.overflow', severity: 'warn', channel: '*', path: null };
    }
    const cur = issues.get(fp);
    let material = false;
    if (cur) {
      if (increment) cur.count++; cur.lastSeenAt = at;
      if (cur.state === 'resolved') { cur.state = 'open'; material = true; }   // a mute survives recurrence
    } else {
      issues.set(fp, { fingerprint: fp, code: i.code, severity: i.severity, channel: i.channel, path: i.path,
        count: 1, firstSeenAt: at, lastSeenAt: at, state: 'open' });
      material = true;
    }
    dirty.add(fp);
    clean.set(i.channel, 0);
    if (material) version++;
    return material;
  }

  function markClean(channel) {
    const n = (clean.get(channel) || 0) + 1;
    clean.set(channel, n);
    let material = false;
    if (n >= RESOLVE_AFTER_CLEAN) for (const i of issues.values()) if (i.channel === channel && i.state === 'open') { i.state = 'resolved'; dirty.add(i.fingerprint); material = true; }
    if (material) version++;
    return material;
  }

  function list({ state } = {}) {
    const sev = { error: 0, warn: 1, info: 2 };
    return [...issues.values()].filter((i) => !state || i.state === state).map((i) => Object.assign({}, i))
      .sort((a, b) => sev[a.severity] - sev[b.severity] || b.lastSeenAt - a.lastSeenAt || a.fingerprint.localeCompare(b.fingerprint));
  }

  function counts() {
    const open = { error: 0, warn: 0, info: 0 };
    let lastIssueAt = null;
    for (const i of issues.values()) { if (i.state === 'open') open[i.severity]++; lastIssueAt = Math.max(lastIssueAt || 0, i.lastSeenAt); }
    return { open, total: issues.size, lastIssueAt };
  }

  // S5 persistence. restore(): issues loaded from the store at boot. Only the record's own fields are
  // kept, each re-checked against the closed lists (they carry no values, so sanitising is idempotent).
  function restore(saved) {
    for (const r of saved || []) {
      if (issues.size >= MAX_FINGERPRINTS && !issues.has(r.fingerprint)) break;
      const i = sanitize(r);
      if (typeof r.fingerprint !== 'string' || !/^[0-9a-f]{16}$|^overflow$/.test(r.fingerprint)) continue;
      const count = i.code === 'session.unclassified' ? 1 : Math.max(1, Number(r.count) || 1);
      issues.set(r.fingerprint, { fingerprint: r.fingerprint, code: i.code, severity: i.severity, channel: i.channel, path: i.path,
        count, firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt, state: STATES.has(r.state) ? r.state : 'open' });
      if (count !== Math.max(1, Number(r.count) || 1)) dirty.add(r.fingerprint);
    }
    version++;
  }
  // → { upserts: Issue[], deletes: fingerprint[] } since the last call
  function takeDirty() {
    const out = { upserts: [...dirty].filter((fp) => issues.has(fp)).map((fp) => Object.assign({}, issues.get(fp))), deletes: [...removed] };
    dirty.clear(); removed.clear();
    return out;
  }
  // R8-04: a batch the store could not commit goes back to the dirty sets. The retry writes the CURRENT state of
  // each fingerprint (so a newer update is never overwritten by the failed one); a delete is retried only if the
  // issue wasn't re-created meanwhile.
  function requeue(batch) {
    for (const i of (batch && batch.upserts) || []) if (issues.has(i.fingerprint)) dirty.add(i.fingerprint);
    for (const fp of (batch && batch.deletes) || []) if (!issues.has(fp)) removed.add(fp);
  }
  // Retention (operations.md §3): resolved issues not seen since `before` are dropped; muted ones since `mutedBefore`
  function prune(before, mutedBefore = null) {
    for (const [fp, i] of issues) {
      if ((i.state === 'resolved' && i.lastSeenAt < before) || (mutedBefore != null && i.state === 'muted' && i.lastSeenAt < mutedBefore)) { issues.delete(fp); dirty.delete(fp); removed.add(fp); }
    }
  }

  // Mute / unmute (api.md §5.3). → the new state, or null for an unknown fingerprint. An error is never
  // mutable (the caller answers 400). Unmuting reopens the issue (it resolves again after clean envelopes).
  function setMuted(fp, muted) {
    const i = issues.get(fp);
    if (!i) return null;
    if (i.severity === 'error') throw Object.assign(new Error('error-not-mutable'), { code: 'error-not-mutable' });
    const next = muted ? 'muted' : (i.state === 'muted' ? 'open' : i.state);
    if (next !== i.state) { i.state = next; dirty.add(fp); version++; }
    return i.state;
  }

  return { record, markClean, list, counts, restore, takeDirty, requeue, prune, setMuted, version: () => version };
}

module.exports = { createQuarantine, makeSanitizer, RESOLVE_AFTER_CLEAN, MAX_FINGERPRINTS, CODES };
