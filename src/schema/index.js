'use strict';
/*
 * In-house schema DSL (no dependency). Used for raw OpenClaw payloads (engine), and later for store
 * JSON columns and API bodies. See docs/architecture/engine.md §4.
 *
 *   const s = require('./schema');
 *   const Row = s.object({ key: s.string().min(1), updatedAt: s.ms().optional() }, { extra: 'count', known: ['visibility'] });
 *   const r = s.validate(s.object({ sessions: s.array(Row, { perItem: true }) }), payload);
 *   // r = { ok: true, value, issues } | { ok: false, issues }
 *
 * Issues: { code, severity, path, detail }. Paths use [] for array indices ('sessions[].updatedAt'),
 * so issues from different rows deduplicate. Values are never copied into issues.
 *   shape.invalid      error  missing required field / wrong type / failed constraint
 *   shape.extra-field  info   field not declared (object option extra: 'count')
 *   shape.item-dropped warn   perItem array: an invalid element was dropped, the rest kept
 */

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
// Own-property checks only (R1-06): inherited names (constructor, toString, __proto__…) are never
// schema members, tags or input fields. Outputs are built with define() so a '__proto__' key from
// JSON input stays an own data property and can never change an object's prototype.
const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const define = (o, k, value) => { Object.defineProperty(o, k, { value, enumerable: true, writable: true, configurable: true }); };
const MS_MIN = Date.UTC(2020, 0, 1), MS_MAX = Date.UTC(2100, 0, 1);

class Schema {
  constructor(kind, check, opts = {}) { this.kind = kind; this._check = check; this.opts = opts; this.isOptional = false; this.isNullable = false; this.constraints = []; }
  _clone(extra) { const c = Object.assign(Object.create(Object.getPrototypeOf(this)), this, extra); c.constraints = this.constraints.slice(); return c; }
  optional() { return this._clone({ isOptional: true }); }
  nullable() { return this._clone({ isNullable: true }); }
  refine(fn, detail) { const c = this._clone(); c.constraints.push({ fn, detail }); return c; }
  min(n) { return this.refine((v) => (typeof v === 'number' ? v >= n : v.length >= n), `min ${n}`); }
  max(n) { return this.refine((v) => (typeof v === 'number' ? v <= n : v.length <= n), `max ${n}`); }
  describe() { return this.kind + (this.isNullable ? '|null' : '') + (this.isOptional ? '?' : ''); }

  // → { ok, value } ; pushes issues into ctx.issues
  run(v, path, ctx) {
    if (v === null && this.isNullable) return { ok: true, value: null };
    const r = this._check(v, path, ctx);
    if (!r.ok) return r;
    for (const c of this.constraints) {
      if (!c.fn(r.value)) { ctx.issues.push({ code: 'shape.invalid', severity: 'error', path, detail: `${this.kind} failed ${c.detail}` }); return { ok: false }; }
    }
    return r;
  }
}

const bad = (ctx, path, expected, v) => { ctx.issues.push({ code: 'shape.invalid', severity: 'error', path, detail: `expected ${expected}, got ${typeOf(v)}` }); return { ok: false }; };
const prim = (kind, test) => new Schema(kind, (v, p, ctx) => (test(v) ? { ok: true, value: v } : bad(ctx, p, kind, v)));

const s = {
  string: () => prim('string', (v) => typeof v === 'string'),
  number: () => prim('number', (v) => typeof v === 'number' && Number.isFinite(v)),
  int: () => prim('int', (v) => Number.isInteger(v)),
  boolean: () => prim('boolean', (v) => typeof v === 'boolean'),
  // epoch milliseconds, plausibly between 2020 and 2100
  ms: () => prim('ms', (v) => Number.isInteger(v) && v >= MS_MIN && v < MS_MAX),
  snowflake: () => prim('snowflake', (v) => typeof v === 'string' && /^\d{17,20}$/.test(v)),
  literal: (lit) => prim(JSON.stringify(lit), (v) => v === lit),
  // A closed set. Use only for values that are truly fixed by the protocol; open-ended raw enums are
  // validated as strings and mapped by the engine's enum tables (engine.md §6.3).
  enumOf: (values) => prim('enum(' + values.join('|') + ')', (v) => values.includes(v)),
  // Deliberately opaque subtree we pass through without inspecting (documented at each use).
  unknown: () => new Schema('unknown', (v) => ({ ok: true, value: v })),

  array(item, { perItem = false, maxItems = null } = {}) {
    const sch = new Schema('array<' + item.describe() + '>', (v, p, ctx) => {
      if (!Array.isArray(v)) return bad(ctx, p, 'array', v);
      if (Number.isSafeInteger(maxItems) && maxItems >= 0 && v.length > maxItems) return bad(ctx, p, `array with at most ${maxItems} items`, v);
      const out = [];
      for (let i = 0; i < v.length; i++) {
        const before = ctx.issues.length;
        const r = item.run(v[i], p + '[]', ctx);
        if (r.ok) { out.push(r.value); continue; }
        if (!perItem) return { ok: false };
        ctx.issues.push({ code: 'shape.item-dropped', severity: 'warn', path: p + '[]', detail: `invalid element dropped (${ctx.issues.length - before} issue(s))` });
      }
      return { ok: true, value: out };
    });
    sch.item = item; sch.perItem = perItem; sch.maxItems = maxItems;
    return sch;
  },

  record(valueSchema) {
    const sch = new Schema('record<' + valueSchema.describe() + '>', (v, p, ctx) => {
      if (typeOf(v) !== 'object') return bad(ctx, p, 'object', v);
      const out = {};
      for (const [k, x] of Object.entries(v)) { const r = valueSchema.run(x, p + '.*', ctx); if (!r.ok) return { ok: false }; define(out, k, r.value); }
      return { ok: true, value: out };
    });
    sch.item = valueSchema;
    return sch;
  },

  /**
   * @param shape   { field: Schema }
   * @param opts.extra 'count' (default for raw data): undeclared fields kept + reported as info;
   *                   'reject': undeclared fields are errors; 'ignore': kept silently;
   *                   'strip': dropped silently (projections: only declared fields are loaded).
   * @param opts.known names of fields we know exist but don't read: kept, never reported.
   */
  object(shape, { extra = 'count', known = [] } = {}) {
    shape = Object.assign(Object.create(null), shape);
    const knownSet = new Set(known);
    const sch = new Schema('object', (v, p, ctx) => {
      if (typeOf(v) !== 'object') return bad(ctx, p, 'object', v);
      const out = {}; let ok = true;
      for (const [k, fs] of Object.entries(shape)) {
        const fp = p + '.' + k;
        if (!own(v, k) || v[k] === undefined) {
          if (fs.isOptional) continue;
          ctx.issues.push({ code: 'shape.invalid', severity: 'error', path: fp, detail: `missing required ${fs.describe()}` }); ok = false; continue;
        }
        const r = fs.run(v[k], fp, ctx);
        if (r.ok) define(out, k, r.value); else ok = false;
      }
      for (const k of Object.keys(v)) {
        if (own(shape, k)) continue;
        // `parent`: the path built from DECLARED names only, so a diagnostic can omit the key (R22-02: a key may be a secret)
        if (extra === 'reject') { ctx.issues.push({ code: 'shape.invalid', severity: 'error', path: p + '.' + k, parent: p, detail: 'unexpected field' }); ok = false; continue; }
        if (extra === 'strip') continue;
        if (extra === 'count' && !knownSet.has(k)) ctx.issues.push({ code: 'shape.extra-field', severity: 'info', path: p + '.' + k, detail: `undeclared ${typeOf(v[k])}` });
        define(out, k, v[k]);
      }
      return ok ? { ok: true, value: out } : { ok: false };
    });
    sch.shape = shape; sch.extra = extra; sch.known = known.slice();
    return sch;
  },

  union(options) {
    const sch = new Schema('union<' + options.map((o) => o.describe()).join('|') + '>', (v, p, ctx) => {
      for (const o of options) { const scratch = { issues: [] }; const r = o.run(v, p, scratch); if (r.ok) { ctx.issues.push(...scratch.issues.filter((i) => i.severity !== 'error')); return r; } }
      return bad(ctx, p, 'one of ' + options.map((o) => o.describe()).join(' | '), v);
    });
    sch.options = options;
    return sch;
  },

  // Tagged union on a string field; an unknown tag is an error naming the tag field (never the value).
  discriminated(key, map) {
    const sch = new Schema('discriminated<' + key + '>', (v, p, ctx) => {
      if (typeOf(v) !== 'object') return bad(ctx, p, 'object', v);
      const tag = v[key];
      const opt = typeof tag === 'string' && own(map, tag) ? map[tag] : null;
      if (!opt) { ctx.issues.push({ code: 'shape.invalid', severity: 'error', path: p + '.' + key, detail: `unknown ${key} tag` }); return { ok: false }; }
      return opt.run(v, p, ctx);
    });
    sch.tags = map;
    return sch;
  },

  // Every field name a schema declares (typed fields and `known` names, at any depth). Used by the
  // diagnostics privacy rule: only DECLARED names may appear in issue paths, samples and fixtures.
  declaredNames(schemas, out = new Set()) {
    const walk = (sch) => {
      if (!sch || typeof sch !== 'object') return;
      if (sch.shape) { for (const [k, f] of Object.entries(sch.shape)) { out.add(k); walk(f); } for (const k of sch.known || []) out.add(k); }
      if (sch.item) walk(sch.item);
      if (sch.options) sch.options.forEach(walk);
      if (sch.tags) Object.values(sch.tags).forEach(walk);
    };
    (Array.isArray(schemas) ? schemas : [schemas]).forEach(walk);
    return out;
  },

  validate(schema, value, path = '$') {
    const ctx = { issues: [] };
    const r = schema.run(value, path, ctx);
    return r.ok ? { ok: true, value: r.value, issues: ctx.issues } : { ok: false, issues: ctx.issues };
  },
};

module.exports = s;
module.exports.Schema = Schema;
