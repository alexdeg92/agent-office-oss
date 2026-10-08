'use strict';
/*
 * Typed classes from schemas (PM audit (B), BRIEF 2026-10-06: "each section has its proper class; no value is
 * undefined; everything properly typed").
 *
 *   const Agent = defineEntity('Agent', AgentSchema);
 *   const a = new Agent(data);        // validates (throws EntityError with value-free issues), deep-frozen
 *   Agent.from(data, onIssue)         // → instance | null (issues reported, never thrown)
 *   a.toJSON()                        // plain data, keys in the schema's declaration order (stable)
 *
 * Rules enforced by every entity:
 *   - optional = explicit null: an optional field the input omits is set to null (the entity's own schema makes every
 *     optional field `nullable` and REQUIRED), at every depth;
 *   - never undefined: an `undefined` value anywhere in the input is an error (not "absent");
 *   - unknown fields are errors for objects declared `extra: 'reject'` (canonical types all are);
 *   - instances and their contents are frozen.
 */
const s = require('../schema');

class EntityError extends Error {
  constructor(name, issues) { super(name + ': invalid (' + issues.length + ' issue(s))'); this.name = 'EntityError'; this.entity = name; this.issues = issues; }
}

// The entity view of a schema: optional → nullable + required, recursively. Memoised per schema object.
const strictCache = new WeakMap();
function strict(sch) {
  if (!sch || typeof sch !== 'object') return sch;
  if (strictCache.has(sch)) return strictCache.get(sch);
  let out = sch;
  if (sch.shape) {
    const shape = {};
    for (const [k, f] of Object.entries(sch.shape)) {
      let fs = strict(f);
      if (f.isOptional) fs = fs._clone({ isOptional: false, isNullable: true });
      shape[k] = fs;
    }
    out = Object.assign(s.object(shape, { extra: sch.extra, known: sch.known }), { constraints: sch.constraints.slice(), isNullable: sch.isNullable });
  } else if (sch.tags) {
    const tags = {}; for (const [t, x] of Object.entries(sch.tags)) tags[t] = strict(x);
    const key = Object.keys(sch.tags).length ? discriminatorOf(sch) : null;
    out = Object.assign(s.discriminated(key, tags), { constraints: sch.constraints.slice(), isNullable: sch.isNullable });
  } else if (sch.item && sch.kind.startsWith('array')) {
    out = Object.assign(s.array(strict(sch.item), { perItem: sch.perItem }), { constraints: sch.constraints.slice(), isNullable: sch.isNullable });
  } else if (sch.item && sch.kind.startsWith('record')) {
    out = Object.assign(s.record(strict(sch.item)), { constraints: sch.constraints.slice(), isNullable: sch.isNullable });
  } else if (sch.options) {
    out = Object.assign(s.union(sch.options.map(strict)), { constraints: sch.constraints.slice(), isNullable: sch.isNullable });
  }
  strictCache.set(sch, out);
  return out;
}
const discriminatorOf = (sch) => /^discriminated<(.+)>$/.exec(sch.kind)[1];

// Fill absent optional fields with null (following the ORIGINAL schema), so the strict schema sees every key.
function fill(sch, v) {
  if (v === null || typeof v !== 'object' || !sch) return v;
  if (Array.isArray(v)) return sch.item ? v.map((x) => fill(sch.item, x)) : v;
  if (sch.tags) { const t = sch.tags[v[discriminatorOf(sch)]]; return t ? fill(t, v) : v; }
  if (sch.options) return v;   // a union is filled by whichever option validates (left as is)
  if (sch.item && sch.kind.startsWith('record')) { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = fill(sch.item, x); return o; }
  if (!sch.shape) return v;
  const o = Object.assign({}, v);
  for (const [k, f] of Object.entries(sch.shape)) {
    if (!Object.prototype.hasOwnProperty.call(o, k) && f.isOptional) o[k] = null;
    else if (Object.prototype.hasOwnProperty.call(o, k)) o[k] = fill(f, o[k]);
  }
  return o;
}

// The first path holding `undefined` (never allowed), or null.
function undefinedPath(v, p = '$', seen = new Set()) {
  if (v === undefined) return p;
  if (v === null || typeof v !== 'object' || seen.has(v)) return null;
  seen.add(v);
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const r = undefinedPath(v[i], p + '[]', seen); if (r) return r; } return null; }
  for (const k of Object.keys(v)) { const r = undefinedPath(v[k], p + '.' + k, seen); if (r) return r; }
  return null;
}

// Plain, ordered copy (schema order for declared keys), then deep-frozen.
function ordered(sch, v) {
  if (v === null || typeof v !== 'object') return v;
  if (typeof v.toJSON === 'function' && v.constructor && v.constructor.isEntity) return v;   // a nested entity stays itself
  const proto = Object.getPrototypeOf(v);
  if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return v;   // a typed value (e.g. a Secret) keeps its class
  if (Array.isArray(v)) return Object.freeze(v.map((x) => ordered(sch && sch.item, x)));
  const shape = sch && (sch.shape || (sch.tags && sch.tags[v[discriminatorOf(sch)]] && sch.tags[v[discriminatorOf(sch)]].shape));
  const out = {};
  if (shape) for (const k of Object.keys(shape)) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = ordered(shape[k], v[k]);
  for (const k of Object.keys(v)) if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = ordered(sch && sch.item, v[k]);
  return Object.freeze(out);
}

// opts.fillOptional (default true): canonical entities fill absent optional fields with null. View models (VM
// classes) keep their documented optional fields absent (e.g. LabelRef `params`), but never undefined.
function defineEntity(name, schema, { fillOptional = true } = {}) {
  const entitySchema = fillOptional ? strict(schema) : schema;
  const Entity = {
    [name]: class {
      constructor(data) {
        if (data instanceof Entity) return data;
        const at = undefinedPath(data);
        if (at) throw new EntityError(name, [{ code: 'shape.invalid', severity: 'error', path: at, detail: 'undefined value (use null)' }]);
        const r = s.validate(entitySchema, fillOptional ? fill(schema, data) : data);
        if (!r.ok) throw new EntityError(name, r.issues.filter((i) => i.severity === 'error'));
        const v = ordered(entitySchema, r.value);
        for (const k of Object.keys(v)) Object.defineProperty(this, k, { value: v[k], enumerable: true });
        Object.freeze(this);
      }
      toJSON() { const o = {}; for (const k of Object.keys(this)) o[k] = this[k]; return o; }
      // → instance | null; each issue is passed to onIssue (value-free), never thrown
      static from(data, onIssue = () => {}) {
        try { return new Entity(data); } catch (e) { if (e instanceof EntityError) { e.issues.forEach(onIssue); return null; } throw e; }
      }
      static check(data) { try { new Entity(data); return { ok: true, issues: [] }; } catch (e) { if (e instanceof EntityError) return { ok: false, issues: e.issues }; throw e; } }
    },
  }[name];
  Entity.schema = entitySchema;
  Entity.sourceSchema = schema;
  Entity.isEntity = true;
  return Entity;
}

module.exports = { defineEntity, EntityError, strict, undefinedPath };
