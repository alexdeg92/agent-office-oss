import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, applyOps, reduceFrame, DeltaError } from '../../public/v2/delta.js';

const vm = () => ({
  level: 'ok',
  connection: { gateway: 'up', since: 1 },
  cards: [{ id: 'cpu', v: 1 }, { id: 'mem', v: 2 }, { id: 'disk', v: 3 }],
  columns: [
    { id: 'todo', count: 2, cards: [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }] },
    { id: 'in-progress', count: 0, cards: [] },
  ],
  dataQuality: { open: { error: 0 }, issues: [{ id: 'a' }] },
});

test('set replaces a field path and shares untouched branches', () => {
  const before = vm();
  const after = applyOp(before, { op: 'set', path: ['connection', 'gateway'], value: 'down' });
  assert.equal(after.connection.gateway, 'down');
  assert.equal(before.connection.gateway, 'up', 'input is not mutated');
  assert.equal(after.cards, before.cards, 'untouched collections keep their identity');
  assert.deepEqual(applyOp(before, { op: 'set', path: ['new', 'deep'], value: 1 }).new, { deep: 1 });
});

test('{id} selectors address collection elements (api.md 2.0 §4.5)', () => {
  const v = applyOp(vm(), { op: 'set', path: ['cards', { id: 'mem' }, 'v'], value: 9 });
  assert.equal(v.cards[1].v, 9);
  const w = applyOp(vm(), { op: 'set', path: ['cards', { id: 'disk' }], value: { id: 'disk', v: 0 } });
  assert.deepEqual(w.cards[2], { id: 'disk', v: 0 });
  assert.throws(() => applyOp(vm(), { op: 'set', path: ['cards', { id: 'disk' }], value: { id: 'other' } }), DeltaError, 'set on {id} keeps the id');
  assert.throws(() => applyOp(vm(), { op: 'set', path: ['cards', { id: 'nope' }, 'v'], value: 1 }), DeltaError);
});

test('the §4.6 board move applies exactly', () => {
  const v = applyOps(vm(), [
    { op: 'remove', path: ['columns', { id: 'todo' }, 'cards'], id: 'p1' },
    { op: 'set', path: ['columns', { id: 'todo' }, 'count'], value: 1 },
    { op: 'upsert', path: ['columns', { id: 'in-progress' }, 'cards'], index: 0, item: { id: 'p1', name: 'A', status: 'in-progress' } },
    { op: 'set', path: ['columns', { id: 'in-progress' }, 'count'], value: 1 },
  ]);
  assert.deepEqual(v.columns.map((c) => [c.id, c.count, c.cards.map((x) => x.id)]), [['todo', 1, ['p2']], ['in-progress', 1, ['p1']]]);
});

test('upsert inserts at index or replaces and moves by id; remove is idempotent; move reorders', () => {
  let v = applyOp(vm(), { op: 'upsert', path: ['cards'], item: { id: 'net', v: 9 }, index: 1 });
  assert.deepEqual(v.cards.map((c) => c.id), ['cpu', 'net', 'mem', 'disk']);
  v = applyOp(v, { op: 'upsert', path: ['cards'], item: { id: 'cpu', v: 7 }, index: 3 });
  assert.deepEqual(v.cards.map((c) => c.id), ['net', 'mem', 'disk', 'cpu']);
  const r = applyOp(vm(), { op: 'remove', path: ['cards'], id: 'mem' });
  assert.deepEqual(r.cards.map((c) => c.id), ['cpu', 'disk']);
  assert.equal(applyOp(r, { op: 'remove', path: ['cards'], id: 'mem' }), r);
  assert.deepEqual(applyOp(vm(), { op: 'move', path: ['cards'], id: 'disk', index: 0 }).cards.map((c) => c.id), ['disk', 'cpu', 'mem']);
});

test('bad paths and ops throw DeltaError', () => {
  assert.throws(() => applyOp(vm(), { op: 'set', path: 'connection.gateway', value: 1 }), DeltaError, 'dotted strings are not paths');
  assert.throws(() => applyOp(vm(), { op: 'set', path: ['cards', 0, 'v'], value: 1 }), DeltaError, 'number segments are banned');
  assert.throws(() => applyOp(vm(), { op: 'upsert', path: ['level'], item: { id: 'x' }, index: 0 }), DeltaError);
  assert.throws(() => applyOp(vm(), { op: 'upsert', path: ['cards'], item: {}, index: 0 }), DeltaError);
  assert.throws(() => applyOp(vm(), { op: 'move', path: ['cards'], id: 'nope', index: 0 }), DeltaError);
  assert.throws(() => applyOp(vm(), { op: 'patch', path: [] }), DeltaError);
  assert.throws(() => applyOp(vm(), null), DeltaError);
});

test('reduceFrame: snapshot sets the current rev; deltas need baseRev === rev', () => {
  let { state } = reduceFrame({ rev: null, data: undefined }, { type: 'snapshot', topic: 't', rev: 31, data: vm() });
  assert.equal(state.rev, 31);
  let r = reduceFrame(state, { type: 'delta', rev: 32, baseRev: 31, ops: [{ op: 'set', path: ['level'], value: 'warn' }] });
  assert.equal(r.needResync, false);
  assert.equal(r.state.rev, 32);
  assert.equal(r.state.data.level, 'warn');
  state = r.state;
  r = reduceFrame(state, { type: 'delta', rev: 32, baseRev: 31, ops: [] });
  assert.equal(r.state, state, 'replayed frame (Last-Event-ID resume) is ignored');
  r = reduceFrame(state, { type: 'delta', rev: 34, baseRev: 33, ops: [] });
  assert.equal(r.needResync, true, 'gap → resync');
  assert.equal(r.state.rev, null);
  assert.equal(r.state.data, state.data, 'keeps showing the last data while resyncing');
  const waiting = reduceFrame(r.state, { type: 'delta', rev: 35, baseRev: 34, ops: [] });
  assert.equal(waiting.needResync, false, 'while waiting for a snapshot, deltas are ignored');
});

test('R4-17: every malformed frame goes to resync instead of applying or throwing', () => {
  const state = { rev: 1, data: vm() };
  const bad = [
    { type: 'delta', rev: 9, baseRev: 1, ops: [] },                       // rev must be baseRev + 1
    { type: 'delta', rev: 2, baseRev: 1 },                                // no ops
    { type: 'delta', rev: 2, baseRev: 1, ops: 'nope' },                   // ops not an array
    { type: 'delta', rev: '2', baseRev: 1, ops: [] },                     // non-integer rev
    { type: 'delta', rev: 2, baseRev: 1, ops: [null] },                   // op not an object
    { type: 'delta', rev: 2, baseRev: 1, ops: [{ op: 'set', path: ['cards', { id: 'x' }, 'v'], value: 1 }] },
    { type: 'snapshot', rev: 0, data: {} },                               // invalid snapshot rev
    { type: 'snapshot', rev: 3 },                                          // snapshot without data
    null,
  ];
  for (const f of bad) {
    const r = reduceFrame(state, f);
    assert.equal(r.needResync, true, JSON.stringify(f));
    assert.equal(r.state.rev, null);
    assert.equal(r.state.data, state.data);
  }
});
