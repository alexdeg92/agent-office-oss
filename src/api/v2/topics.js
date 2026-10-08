'use strict';
/*
 * SSE topics (api.md §4.1, §4.3, §4.7).
 *   - A topic id is `name`, `name:<param>` or `name?<k>=<v>[&…]` (params URL-encoded, query keys sorted).
 *     Different ids are different topics with different VMs.
 *   - One server-wide revision counter per topic id, starting at 1 when the VM is first built.
 *   - invalidate(name?) marks topics dirty; a rebuild runs at most every COALESCE_MS per topic id. A rebuild
 *     that doesn't change the VM produces nothing; otherwise rev + 1 and one change { id, rev, baseRev,
 *     ops | snapshot } is published to subscribers (ops when expressible and smaller than the VM).
 */
const { EventEmitter } = require('events');
const { diff } = require('./diff');

const COALESCE_MS = 250;

/**
 * @param {object} defs  name → { build(params) → VM, params?: 'none' | 'path' | string[] (allowed query keys) }
 */
// `check(name, vm, id)` (PM audit (B)): every built VM is validated before it is stored or sent (vm/check.js)
function createTopics(defs, { coalesceMs = COALESCE_MS, check = (name, vm) => vm } = {}) {
  const ev = new EventEmitter();
  ev.setMaxListeners(0);
  const state = new Map();     // id → { name, params, rev, vm, timer, dirty, lastAt }

  // → { id, name, params } with a canonical id, or null when the name or a param is unknown
  function parse(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > 300) return null;
    let name = raw, param = null, query = null;
    const q = raw.indexOf('?'), c = raw.indexOf(':');
    if (q >= 0) { name = raw.slice(0, q); query = raw.slice(q + 1); } else if (c >= 0) { name = raw.slice(0, c); param = raw.slice(c + 1); }
    const def = Object.prototype.hasOwnProperty.call(defs, name) ? defs[name] : null;
    if (!def) return null;
    const kind = def.params || 'none';
    if (kind === 'none') return param == null && query == null ? { id: name, name, params: {} } : null;
    if (kind === 'path') {
      if (param == null || query != null) return null;
      let v; try { v = decodeURIComponent(param); } catch (_) { return null; }
      if (!v) return null;
      return { id: name + ':' + encodeURIComponent(v), name, params: { key: v } };
    }
    if (param != null) return null;
    if (query == null) return { id: name, name, params: {} };
    const params = {};
    for (const part of query.split('&')) {
      const i = part.indexOf('='); if (i < 1) return null;
      let k, v; try { k = decodeURIComponent(part.slice(0, i)); v = decodeURIComponent(part.slice(i + 1)); } catch (_) { return null; }
      if (!kind.includes(k) || Object.prototype.hasOwnProperty.call(params, k)) return null;
      params[k] = v;
    }
    const keys = Object.keys(params).sort();
    return { id: keys.length ? name + '?' + keys.map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&') : name, name, params };
  }

  function entry(t) {
    let s = state.get(t.id);
    if (!s) { s = { name: t.name, params: t.params, rev: 0, vm: undefined, timer: null, dirty: false, lastAt: 0 }; state.set(t.id, s); }
    return s;
  }

  // The current { id, rev, vm } (built on first use: rev 1). Throws what the builder throws (e.g. not_found).
  function current(raw) {
    const t = typeof raw === 'string' ? parse(raw) : raw;
    if (!t) return null;
    const s = entry(t);
    if (s.rev === 0 || s.dirty) rebuild(t.id);
    return { id: t.id, rev: s.rev, vm: s.vm };
  }

  function rebuild(id) {
    const s = state.get(id);
    s.dirty = false; s.lastAt = Date.now();
    const vm = check(s.name, defs[s.name].build(s.params), id);
    if (s.rev === 0) { s.vm = vm; s.rev = 1; return null; }
    const ops = diff(s.vm, vm);
    if (ops && ops.length === 0) return null;
    const baseRev = s.rev;
    s.rev += 1; s.vm = vm;
    const useOps = ops && JSON.stringify(ops).length < JSON.stringify(vm).length;
    const change = useOps ? { id, rev: s.rev, baseRev, ops } : { id, rev: s.rev, baseRev, snapshot: vm };
    ev.emit('change', change);
    return change;
  }

  function flush(id) {
    const s = state.get(id); s.timer = null;
    if (!s.dirty) return;
    try { rebuild(id); } catch (_) { /* a builder failure keeps the previous VM; the next invalidation retries */ }
  }

  // Mark topics dirty (all of them, or those of one name). Only topics already built are tracked.
  function invalidate(name) {
    for (const [id, s] of state) {
      if (name && s.name !== name) continue;
      if (s.rev === 0) continue;
      s.dirty = true;
      if (s.timer) continue;
      const wait = Math.max(0, coalesceMs - (Date.now() - s.lastAt));
      s.timer = setTimeout(() => flush(id), wait);
      if (s.timer.unref) s.timer.unref();
    }
  }

  // Mark specific topic ids dirty (raw ids are parsed to their canonical form; unknown or never-built ids are ignored).
  function invalidateIds(ids) {
    for (const raw of ids || []) {
      const t = parse(raw); if (!t) continue;
      const s = state.get(t.id); if (!s || s.rev === 0) continue;
      s.dirty = true;
      if (s.timer) continue;
      s.timer = setTimeout(() => flush(t.id), Math.max(0, coalesceMs - (Date.now() - s.lastAt)));
      if (s.timer.unref) s.timer.unref();
    }
  }

  // Topics can be registered by area modules (projects, office…) after creation.
  function define(name, def) { if (Object.prototype.hasOwnProperty.call(defs, name)) throw new Error('topic already defined: ' + name); defs[name] = def; }

  function close() { for (const s of state.values()) if (s.timer) clearTimeout(s.timer); }

  // Ids of the topics of one name that have been built (subscribed or fetched at least once).
  const ids = (name) => [...state.entries()].filter(([, s]) => s.name === name && s.rev > 0).map(([id]) => id);

  return { parse, current, invalidate, invalidateIds, define, ids, on: ev.on.bind(ev), off: ev.off.bind(ev), names: () => Object.keys(defs), close, _state: state };
}

/**
 * G5 (api-v3.md): one topic registry PER CONTRACT VERSION behind one facade, so the views define each topic once.
 *   define(name, { params, build(params, P) }) registers it in every version; `build` gets that version's projection
 *   (`P.version` 2 → project2x, 3 → project3x). invalidate / invalidateIds reach every version (only built topics
 *   rebuild). current(raw, version = 2) and parse are per version; `of(version)` is that version's own registry (its
 *   stream hub subscribes to it alone: a v3 topic never reaches a v2 stream).
 * @param {object} versions  { [version]: { P, check } }
 */
function createVersionedTopics(versions, { coalesceMs = COALESCE_MS } = {}) {
  const byV = {};
  for (const [v, o] of Object.entries(versions)) byV[v] = Object.assign(createTopics({}, { coalesceMs, check: o.check }), { P: o.P });
  const all = Object.values(byV);
  const of = (v) => { const t = byV[v || 2]; if (!t) throw new Error('unknown contract version ' + v); return t; };
  return {
    of,
    define(name, def) { for (const t of all) t.define(name, { params: def.params, build: (params) => def.build(params, t.P) }); },
    invalidate(name) { for (const t of all) t.invalidate(name); },
    invalidateIds(ids) { for (const t of all) t.invalidateIds(ids); },
    current: (raw, v) => of(v).current(raw),
    parse: (raw, v) => of(v).parse(raw),
    ids: (name) => [...new Set(all.flatMap((t) => t.ids(name)))],
    names: () => of(2).names(),
    close() { for (const t of all) t.close(); },
  };
}

module.exports = { createTopics, createVersionedTopics, COALESCE_MS };
