'use strict';
require('./scratch-home.cjs').refuseEntry(__filename);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)
/*
 * Contract shape checker (api.md §7, contract 2.1; PM decision on review-07; strict since S6.2, review R8-08/09).
 * No dependencies.
 *
 *   const { compareExample } = require('../helpers/contract-shape');
 *   assert.deepEqual(compareExample('project-vm', buildProjectVM(...)), []);      // compares with `.data`
 *
 * The example payload is compiled into a SPEC, then the actual value is checked against it:
 *   - types: string, number, boolean, array, object must match;
 *   - null: allowed only where the spec is nullable: the example shows null there (in at least one occurrence),
 *     or the example's sidecar `<name>.types.json` lists the path in `nullable`. A field that is ONLY ever null
 *     in the example must have its type in the sidecar's `types` (else it's "unmodelled", reported);
 *   - objects: exactly the spec's keys (missing and extra keys both reported). LabelRef `params` (an object with
 *     a string `key`) is optional and, when present, each param must be a string, a number or a nested LabelRef;
 *   - arrays: all example elements are merged into one model per key set. Elements with the same keys are the
 *     same shape whatever their `kind` (a semantic enum, R8-09); different key sets are structural alternatives
 *     (FlagVM), and an actual element must match one of them. An example array that is always empty is
 *     "unmodelled": a non-empty actual array there is reported (R8-08);
 *   - records (`labels`, `enums`, `overrides`, or `records` paths): values are checked against the merged value;
 *   - opaque paths (sidecar `opaque`, e.g. the layout manifest): only the type is checked;
 *   - sidecar `variants` { path: [values] }: extra example values merged at that path (a union member or the
 *     non-null form of a field the example shows as null).
 * Paths: '$' is the compared value, '.field', '[]' for array elements, '.{}' for record values.
 */
const fs = require('fs');
const path = require('path');

const EXAMPLES_DIR = path.resolve(__dirname, '..', '..', 'docs', 'architecture', 'examples');
const RECORD_KEYS = new Set(['labels', 'enums', 'overrides']);
const PRIM = new Set(['string', 'number', 'boolean']);
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// G5: version 3 reads examples/v3/<name> when 3.0 changed that VM, else the 2.x example (api-v3.md)
const dirOf = (name, version) => (version === 3 && fs.existsSync(path.join(EXAMPLES_DIR, 'v3', name + '.json')) ? path.join(EXAMPLES_DIR, 'v3') : EXAMPLES_DIR);
function loadExample(name, version = 2) { return JSON.parse(fs.readFileSync(path.join(dirOf(name, version), name + '.json'), 'utf8')); }
function loadSidecar(name, version = 2) { const f = path.join(dirOf(name, version), name + '.types.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; }

// ---- spec construction --------------------------------------------------------------------------------------
const sig = (s) => (s.k === 'obj' ? 'obj:' + Object.keys(s.fields).sort().join(',') + (s.labelRef ? '+lr' : '') : s.k === 'prim' ? 'prim:' + s.t : s.k);

function fromTypeName(name, nullable) {
  if (PRIM.has(name)) return { k: 'prim', t: name, nullable };
  if (name === 'LabelRef') return { k: 'obj', fields: { key: { k: 'prim', t: 'string', nullable: false } }, labelRef: true, nullable };
  if (name === 'any') return { k: 'opaque', nullable };
  throw new Error('unknown sidecar type ' + name);
}

function build(v, p, o) {
  if (o.opaque.has(p)) return { k: 'opaque', nullable: v === null };
  const t = typeOf(v);
  if (t === 'null') return o.types[p] ? fromTypeName(o.types[p], true) : { k: 'unknown', nullable: true };
  if (PRIM.has(t)) return { k: 'prim', t, nullable: false };
  if (t === 'array') return { k: 'arr', item: v.length ? v.map((x) => build(x, p + '[]', o)).reduce(merge) : null, nullable: false };
  const keyName = p.split('.').pop();
  if (RECORD_KEYS.has(keyName) || o.records.has(p)) {
    const vals = Object.values(v);
    return { k: 'record', value: vals.length ? vals.map((x) => build(x, p + '.{}', o)).reduce(merge) : null, nullable: false };
  }
  const labelRef = typeof v.key === 'string' && Object.keys(v).every((k) => k === 'key' || k === 'params');
  const fields = {};
  for (const [k, x] of Object.entries(v)) if (!(labelRef && k === 'params')) fields[k] = build(x, p + '.' + k, o);
  return { k: 'obj', fields, labelRef, nullable: false };
}

function merge(a, b) {
  if (a.k === 'unknown') return Object.assign({}, b, { nullable: true });
  if (b.k === 'unknown') return Object.assign({}, a, { nullable: true });
  const nullable = a.nullable || b.nullable;
  if (a.k === 'union' || b.k === 'union') {
    const alts = (a.k === 'union' ? a.alts : [a]).slice();
    for (const x of (b.k === 'union' ? b.alts : [b])) {
      const i = alts.findIndex((y) => sig(y) === sig(x));
      if (i >= 0) alts[i] = merge(alts[i], x); else alts.push(x);
    }
    return { k: 'union', alts: alts.map((x) => Object.assign({}, x, { nullable: false })), nullable };
  }
  if (sig(a) !== sig(b)) return merge({ k: 'union', alts: [Object.assign({}, a, { nullable: false })], nullable }, b);
  if (a.k === 'obj') {
    const fields = {};
    for (const k of Object.keys(a.fields)) fields[k] = merge(a.fields[k], b.fields[k]);
    return { k: 'obj', fields, labelRef: a.labelRef, nullable };
  }
  if (a.k === 'arr') return { k: 'arr', item: a.item && b.item ? merge(a.item, b.item) : a.item || b.item, nullable };
  if (a.k === 'record') return { k: 'record', value: a.value && b.value ? merge(a.value, b.value) : a.value || b.value, nullable };
  return Object.assign({}, a, { nullable });
}

// ---- comparison ------------------------------------------------------------------------------------------
function checkParams(params, p, out) {
  if (typeOf(params) !== 'object') { out.push(`${p}: params must be an object`); return; }
  for (const [k, v] of Object.entries(params)) {
    const t = typeOf(v);
    if (t === 'string' || t === 'number') continue;
    if (t === 'object' && typeof v.key === 'string' && Object.keys(v).every((x) => x === 'key' || x === 'params')) { if (v.params !== undefined) checkParams(v.params, `${p}.${k}.params`, out); continue; }
    out.push(`${p}.${k}: a param is a string, a number or a LabelRef`);
  }
}

function check(spec, v, p, out, strict) {
  const t = typeOf(v);
  if (t === 'null') { if (!spec.nullable) out.push(`${p}: null, but the example never allows null here`); return; }
  switch (spec.k) {
    case 'opaque': return;
    case 'unknown': if (strict) out.push(`${p}: unmodelled (the example only shows null; declare its type in the sidecar)`); return;
    case 'prim': if (t !== spec.t) out.push(`${p}: expected ${spec.t}, got ${t}`); return;
    case 'arr':
      if (t !== 'array') { out.push(`${p}: expected array, got ${t}`); return; }
      if (!spec.item) { if (v.length && strict) out.push(`${p}: unmodelled (the example array is always empty)`); return; }
      v.forEach((x) => check(spec.item, x, p + '[]', out, strict));
      return;
    case 'record':
      if (t !== 'object') { out.push(`${p}: expected object, got ${t}`); return; }
      if (spec.value) for (const x of Object.values(v)) check(spec.value, x, p + '.{}', out, strict);
      return;
    case 'union': {
      let best = null;
      for (const alt of spec.alts) { const o = []; check(alt, v, p, o, strict); if (!o.length) return; if (!best || o.length < best.length) best = o; }
      out.push(...best);
      return;
    }
    case 'obj': {
      if (t !== 'object') { out.push(`${p}: expected object, got ${t}`); return; }
      // sidecar `optional`: an example field that may be absent (e.g. LayoutData.presence, O8)
      for (const k of Object.keys(spec.fields)) if (!Object.prototype.hasOwnProperty.call(v, k) && !spec.fields[k].optional) out.push(`${p}.${k}: missing`);
      for (const k of Object.keys(v)) {
        if (Object.prototype.hasOwnProperty.call(spec.fields, k)) { check(spec.fields[k], v[k], `${p}.${k}`, out, strict); continue; }
        if (k === 'params' && spec.labelRef) { checkParams(v.params, `${p}.params`, out); continue; }
        out.push(`${p}.${k}: unexpected`);
      }
      return;
    }
    default: throw new Error('bad spec ' + spec.k);
  }
}

// Applies fn to every spec node at path `p` (through union alternatives); → number of nodes reached.
function atPath(spec, p, fn) {
  const segs = p.replace(/^\$/, '').split(/(?=\.|\[\])/).filter(Boolean);
  let n = 0;
  (function go(s, i, parent, key) {
    if (!s) return;
    if (s.k === 'union' && i < segs.length) { s.alts.forEach((a) => go(a, i)); return; }
    if (i === segs.length) { n++; fn(s, parent, key); return; }
    const seg = segs[i];
    if (seg === '[]') go(s.item, i + 1, s, 'item');
    else if (seg === '.{}') go(s.value, i + 1, s, 'value');
    else if (s.fields) go(s.fields[seg.slice(1)], i + 1, s.fields, seg.slice(1));
  })(spec, 0, null, null);
  if (!n) throw new Error('sidecar path not in the example: ' + p);
  return n;
}

/**
 * compareShape(example, actual, { nullable?, types?, opaque?, records?, strict = true }) → mismatches ([] = same shape)
 * Sidecar-style options use paths relative to the compared value ('$…').
 */
function compareShape(example, actual, opts = {}) {
  const o = { opaque: new Set(opts.opaque || []), records: new Set(opts.records || []), types: opts.types || {} };
  const spec = build(example, '$', o);
  // Consumers may delegate a subtree to its semantic validator. Sidecar details below
  // that opaque root must not be applied to a spec that deliberately omits them.
  const delegated = p => [...o.opaque].some(root => p.startsWith(root + '.') || p.startsWith(root + '[]'));
  // sidecar `variants`: extra example values merged at a path (union members a singleton example can't show)
  for (const [p, values] of Object.entries(opts.variants || {})) {
    if (delegated(p)) continue;
    atPath(spec, p, (node) => { const merged = values.map((v) => build(v, p, o)).reduce(merge, Object.assign({}, node)); for (const k of Object.keys(node)) delete node[k]; Object.assign(node, merged); });
  }
  // sidecar `additional` (architect-55): an OPTIONAL field the example doesn't show, declared by an example value; its
  // parent must be in the example (e.g. OccupantVM.exchanges, present only for conversation occupants)
  for (const [p, value] of Object.entries(opts.additional || {})) {
    if (delegated(p)) continue;
    const at = p.lastIndexOf('.');
    atPath(spec, p.slice(0, at) || '$', (node) => {
      function add(n) {
        if (n.k === 'union') { n.alts.forEach(add); return; }
        if (!n.fields) throw new Error('sidecar additional: no object at ' + p.slice(0, at));
        n.fields[p.slice(at + 1)] = Object.assign(build(value, p, o), { optional: true });
      }
      add(node);
    });
  }
  for (const p of opts.nullable || []) if (!delegated(p)) atPath(spec, p, (node) => { node.nullable = true; });
  for (const p of opts.optional || []) if (!delegated(p)) atPath(spec, p, (node) => { node.optional = true; });
  const out = [];
  check(spec, actual, '$', out, opts.strict !== false);
  return out;
}

// The one success envelope's meta (api.md §2.1), checked in envelope mode.
const META_EXAMPLE = { modelVersion: 1, generatedAt: 1, stale: ['gateway'] };
const META_TOPIC = { id: 'x', rev: 1 };

/**
 * compareExample('project-vm', vm)                       → against the example's `data` (or the whole file for requests/errors)
 * compareExample('project-vm', body, { envelope: true }) → a whole HTTP body: { data } with the sidecar, and `meta` against the
 *                                                          envelope model (modelVersion, generatedAt, stale: SourceId[], topic?)
 */
function compareExample(name, actual, { envelope = false, version = 2 } = {}) {
  const ex = loadExample(name, version);
  const sidecar = loadSidecar(name, version);
  const isEnvelope = Object.prototype.hasOwnProperty.call(ex, 'data') && Object.prototype.hasOwnProperty.call(ex, 'meta');
  if (!envelope) return compareShape(isEnvelope ? ex.data : ex, actual, sidecar);
  if (!isEnvelope) throw new Error(name + ' is not an Ok<T> envelope example');
  const out = [];
  if (typeOf(actual) !== 'object') return ['$: expected the { data, meta } envelope'];
  for (const k of Object.keys(actual)) if (k !== 'data' && k !== 'meta') out.push(`$.${k}: unexpected`);
  out.push(...compareShape(ex.data, actual.data, sidecar).map((m) => '$.data' + m.slice(1)));
  const meta = actual.meta || {};
  const { topic, ...rest } = meta;
  out.push(...compareShape(META_EXAMPLE, rest).map((m) => '$.meta' + m.slice(1)));
  if (topic !== undefined) out.push(...compareShape(META_TOPIC, topic).map((m) => '$.meta.topic' + m.slice(1)));
  return out;
}

// frontend-07: every *url / *Url string field of a payload, as [path, value] (VM URLs must be absolute).
function urlFields(v, p = '$', out = []) {
  if (Array.isArray(v)) v.forEach((x) => urlFields(x, p + '[]', out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    // MetaVM labels are a record of translated copy, not URL fields: a label key may describe a URL input.
    // Only flat string dictionaries qualify; labels arrays/objects containing real URL fields still recurse.
    if (k === 'labels' && x && !Array.isArray(x) && typeof x === 'object' && Object.values(x).every(value => typeof value === 'string')) continue;
    if (/url$/i.test(k) && typeof x === 'string') out.push([p + '.' + k, x]);
    urlFields(x, p + '.' + k, out);
  }
  return out;
}

module.exports = { compareShape, compareExample, loadExample, loadSidecar, urlFields, EXAMPLES_DIR };
