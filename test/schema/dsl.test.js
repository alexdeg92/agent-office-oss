'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../../src/schema');

const codes = (r) => r.issues.map((i) => `${i.severity} ${i.code} ${i.path}`);

describe('schema DSL', () => {
  it('primitives and modifiers', () => {
    assert.ok(s.validate(s.string().min(2), 'ab').ok);
    assert.deepEqual(codes(s.validate(s.string().min(2), 'a')), ['error shape.invalid $']);
    assert.ok(s.validate(s.int(), 3).ok); assert.ok(!s.validate(s.int(), 3.5).ok);
    assert.ok(!s.validate(s.number(), NaN).ok);
    assert.ok(s.validate(s.ms(), Date.UTC(2026, 0, 1)).ok); assert.ok(!s.validate(s.ms(), 12).ok);
    assert.ok(s.validate(s.snowflake(), '100000000000000001').ok); assert.ok(!s.validate(s.snowflake(), '123').ok);
    assert.ok(s.validate(s.string().nullable(), null).ok); assert.ok(!s.validate(s.string(), null).ok);
    assert.ok(s.validate(s.enumOf(['a', 'b']), 'b').ok); assert.ok(!s.validate(s.enumOf(['a']), 'z').ok);
    assert.ok(s.validate(s.literal(4), 4).ok);
  });

  it('objects: required, optional, extra count / known / reject / ignore', () => {
    const O = (extra) => s.object({ a: s.string(), b: s.int().optional() }, { extra, known: ['k'] });
    assert.deepEqual(codes(s.validate(O('count'), { b: 1 })), ['error shape.invalid $.a']);
    const r = s.validate(O('count'), { a: 'x', k: 1, z: 2 });
    assert.ok(r.ok); assert.deepEqual(r.value, { a: 'x', k: 1, z: 2 });
    assert.deepEqual(codes(r), ['info shape.extra-field $.z']);
    assert.ok(!s.validate(O('reject'), { a: 'x', z: 1 }).ok);
    assert.deepEqual(codes(s.validate(O('ignore'), { a: 'x', z: 1 })), []);
  });

  it('arrays: strict vs perItem (bad rows dropped, rest kept, paths deduplicate)', () => {
    const Row = s.object({ id: s.int() });
    assert.ok(!s.validate(s.array(Row), [{ id: 1 }, { id: 'x' }]).ok);
    const r = s.validate(s.array(Row, { perItem: true }), [{ id: 1 }, { id: 'x' }, { id: 'y' }, { id: 4 }]);
    assert.ok(r.ok); assert.deepEqual(r.value, [{ id: 1 }, { id: 4 }]);
    assert.deepEqual([...new Set(codes(r))], ['error shape.invalid $[].id', 'warn shape.item-dropped $[]']);
  });

  it('record, union, discriminated', () => {
    assert.ok(s.validate(s.record(s.int()), { a: 1, b: 2 }).ok);
    assert.ok(!s.validate(s.record(s.int()), { a: 'x' }).ok);
    const U = s.union([s.string(), s.object({ primary: s.string() })]);
    assert.ok(s.validate(U, 'm').ok); assert.ok(s.validate(U, { primary: 'm' }).ok); assert.ok(!s.validate(U, 3).ok);
    const D = s.discriminated('kind', { cron: s.object({ kind: s.literal('cron'), expr: s.string() }), every: s.object({ kind: s.literal('every'), everyMs: s.int() }) });
    assert.ok(s.validate(D, { kind: 'every', everyMs: 5 }).ok);
    assert.deepEqual(codes(s.validate(D, { kind: 'at' })), ['error shape.invalid $.kind']);
  });

  it('issues never contain values', () => {
    const r = s.validate(s.object({ token: s.int() }), { token: 'SECRET-VALUE-123' });
    assert.ok(!JSON.stringify(r.issues).includes('SECRET'));
  });
});

describe('generated schema docs', () => {
  it('docs/architecture/generated/raw-schemas.md is up to date (run node scripts/schemas-doc.js)', () => {
    const { render, FILE } = require('../../scripts/schemas-doc');
    assert.equal(require('fs').readFileSync(FILE, 'utf8'), render());
  });
});

describe('schema DSL · prototype names (R1-06)', () => {
  const PROTO = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'propertyIsEnumerable', '__defineGetter__'];

  it('strict objects reject inherited names present in the input', () => {
    for (const name of PROTO) {
      const input = JSON.parse(`{"a":"x",${JSON.stringify(name)}:{"admin":true}}`);
      const r = s.validate(s.object({ a: s.string() }, { extra: 'reject' }), input);
      assert.equal(r.ok, false, name);
      assert.deepEqual(r.issues.map((i) => i.code), ['shape.invalid'], name);
    }
  });

  it('inherited names never satisfy a required field', () => {
    for (const name of PROTO) {
      const r = s.validate(s.object({ [name]: s.string() }), {});
      assert.equal(r.ok, false, name);
    }
  });

  it('a __proto__ key in JSON input stays an own property (no prototype change), in objects and records', () => {
    const input = JSON.parse('{"a":"x","__proto__":{"admin":true}}');
    const r = s.validate(s.object({ a: s.string() }, { extra: 'ignore' }), input);
    assert.ok(r.ok); assert.equal(Object.getPrototypeOf(r.value), Object.prototype); assert.equal(r.value.admin, undefined);
    assert.ok(Object.prototype.hasOwnProperty.call(r.value, '__proto__'));
    const rr = s.validate(s.record(s.object({}, { extra: 'ignore' })), JSON.parse('{"__proto__":{"x":1}}'));
    assert.ok(rr.ok); assert.equal(Object.getPrototypeOf(rr.value), Object.prototype); assert.equal(rr.value.x, undefined);
    assert.equal({}.admin, undefined, 'no global pollution');
  });

  it('discriminated unions never select inherited members and never throw', () => {
    const D = s.discriminated('kind', { a: s.object({ kind: s.literal('a') }) });
    for (const name of PROTO) {
      let r; assert.doesNotThrow(() => { r = s.validate(D, JSON.parse(`{"kind":${JSON.stringify(name)}}`)); }, name);
      assert.equal(r.ok, false, name); assert.equal(r.issues[0].code, 'shape.invalid', name);
    }
  });
});
