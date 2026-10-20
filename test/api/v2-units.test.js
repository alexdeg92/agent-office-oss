'use strict';
// S6 units: delta diff (api.md §4.5), topic ids and revisions (§4.1, §4.3), stream hub expiry (R1-09).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { diff, apply } = require('../../src/api/v2/diff');
const { createTopics } = require('../../src/api/v2/topics');
const { createStreamHub } = require('../../src/api/v2/stream');
const { loadExample } = require('../helpers/contract-shape');

const rnd = (n) => Math.floor(Math.random() * n);
const mk = () => ({ a: rnd(3), list: [...new Map(Array.from({ length: rnd(7) }, () => { const id = 'x' + rnd(9); return [id, { id, v: rnd(3), sub: { w: rnd(2) } }]; })).values()], tags: [rnd(2)] });

describe('delta diff (§4.5)', () => {
  it('apply(a, diff(a, b)) = b, and the ops are idempotent on b (a VM shown before its delta), 3000 random cases', () => {
    for (let i = 0; i < 3000; i++) {
      const a = mk(), b = mk(), ops = diff(a, b);
      assert.notEqual(ops, null);
      assert.deepEqual(apply(a, ops), b);
      assert.deepEqual(apply(b, ops), b, 'idempotent on the target state');
      for (const o of ops) assert.ok(o.path.every((s) => typeof s === 'string' || (s && typeof s.id === 'string')), 'no number segments');
    }
  });

  it('the board move of §4.6: remove + count + upsert in the target column, granular for unchanged cards', () => {
    const vm = loadExample('board-vm').data;
    const source = vm.columns.find(column => column.cards.length > 0);
    const target = vm.columns.find(column => column.id !== source?.id);
    assert.ok(source && target, 'the example supplies a card and a distinct target stage');
    const card = source.cards[0];
    const next = JSON.parse(JSON.stringify(vm));
    const nextSource = next.columns.find(column => column.id === source.id);
    const nextTarget = next.columns.find(column => column.id === target.id);
    nextSource.cards = []; nextSource.count = 0;
    nextTarget.cards.unshift(Object.assign({}, card, { status: target.id, revision: card.revision + 1 })); nextTarget.count++;
    const ops = diff(vm, next);
    assert.deepEqual(ops.map((o) => o.op + ' ' + JSON.stringify(o.path)).sort(), [
      `remove ["columns",{"id":"${source.id}"},"cards"]`, `set ["columns",{"id":"${source.id}"},"count"]`,
      `upsert ["columns",{"id":"${target.id}"},"cards"]`, `set ["columns",{"id":"${target.id}"},"count"]`].sort());   // field order follows the VM
    assert.deepEqual(apply(vm, ops), next);
  });

  it('a removed field is not expressible: the caller sends a snapshot', () => {
    assert.equal(diff({ a: 1, b: 2 }, { a: 1 }), null);
  });
});

describe('topics (§4.1, §4.3)', () => {
  it('canonical ids: params URL-encoded, query keys sorted; unknown names and params are refused', () => {
    const t = createTopics({ health: { build: () => ({}) }, logs: { build: () => ({}), params: ['kind', 'heartbeat'] }, session: { build: () => ({}), params: 'path' } });
    assert.equal(t.parse('health').id, 'health');
    assert.equal(t.parse('logs?kind=cron&heartbeat=include').id, 'logs?heartbeat=include&kind=cron');
    assert.equal(t.parse('session:agent:main:main').id, 'session:agent%3Amain%3Amain');
    for (const bad of ['nope', 'health:x', 'health?a=1', 'logs?zzz=1', 'logs?kind=a&kind=b', 'session', '']) assert.equal(t.parse(bad), null, bad);
  });

  it('server-wide revision from 1; an unchanged rebuild is silent; a change is rev + 1 with baseRev and ops', async () => {
    let n = 1;
    const t = createTopics({ x: { build: () => ({ items: [{ id: 'a', n }], pad: 'x'.repeat(200) }) } }, { coalesceMs: 10 });   // big enough that ops beat a snapshot
    const changes = []; t.on('change', (c) => changes.push(c));
    assert.equal(t.current('x').rev, 1);
    t.invalidate(); await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(changes, []);
    n = 2; t.invalidate(); t.invalidate(); t.invalidate(); await new Promise((r) => setTimeout(r, 30));
    assert.equal(changes.length, 1, 'coalesced');
    assert.deepEqual(changes[0], { id: 'x', rev: 2, baseRev: 1, ops: [{ op: 'set', path: ['items', { id: 'a' }, 'n'], value: 2 }] });
    assert.equal(t.current('x').rev, 2);
    t.close();
  });

  it('logs topic build/check failures with only the declared topic and fixed failure class', () => {
    const run = issue => {
      const diagnostics = [];
      const failure = Object.assign(new Error('PRIVATE_PAYLOAD_CANARY'), { code: 'vm.invalid', issues: [issue] });
      const t = createTopics({ 'office-scope': { params: 'path', build: () => ({ known: 'ok', sk_live_T0095_SENTINEL: 'SECRET_VALUE_CANARY' }) } }, {
        check: () => { throw failure; }, onError: event => diagnostics.push(event),
      });
      try { assert.throws(() => t.current('office-scope:opaque'), error => error === failure); }
      finally { t.close(); }
      return diagnostics;
    };
    const declaredPath = run({ path: '$.occupants[0].role', parent: '$', detail: 'PRIVATE_PAYLOAD_CANARY' });
    assert.deepEqual(declaredPath, [{ topic: 'office-scope', code: 'build_or_check_failed' }], 'even declared paths are omitted');
    const dynamicKey = run({ path: '$.sk_live_T0095_SENTINEL', parent: '$', detail: 'SECRET_VALUE_CANARY' });
    assert.deepEqual(dynamicKey, [{ topic: 'office-scope', code: 'build_or_check_failed' }], 'caller-controlled issue paths are omitted');
    const serialized = JSON.stringify([declaredPath, dynamicKey]);
    for (const secret of ['PRIVATE_PAYLOAD_CANARY', 'sk_live_T0095_SENTINEL', 'SECRET_VALUE_CANARY', '$.occupants']) {
      assert.equal(serialized.includes(secret), false, secret);
    }
  });
});

describe('stream hub · R1-09 session expiry', () => {
  it('a stream closes at its session expiry with a final system frame', async () => {
    const topics = createTopics({ health: { build: () => ({ ok: 1 }) } });
    const engine = Object.assign(new EventEmitter(), { sources: () => [] });
    const hub = createStreamHub({ topics, engine, systemState: () => ({ gateway: 'up', capabilities: { openclawWrites: true, storeWrites: true } }), contractVersion: '2.1', modelVersion: 1 });
    const req = Object.assign(new EventEmitter(), { headers: {}, query: { topics: 'health' }, session: { email: 'a@b.c', exp: Date.now() + 150, sid: '0123456789abcdef0123' } });
    const out = []; let ended = false;
    const res = { writeHead() {}, write: (s) => out.push(s), end: () => { ended = true; } };
    hub.open(req, res);
    assert.match(out.join(''), /event: hello[\s\S]*event: snapshot/);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(ended, 'closed at expiry');
    assert.match(out[out.length - 1], /event: system\ndata: .*"closing":"session-expired"/);
    topics.close();
  });
});

describe('stream hub · reauthorize queued source snapshots', () => {
  it('drops a source snapshot when grants are revoked before backpressure drains', () => {
    const topics = createTopics({ teams: { build: () => ({ secret: 'PRIVATE_QUEUED_SOURCE_CANARY' }) } });
    const engine = Object.assign(new EventEmitter(), { sources: () => [] });
    let allowed = true;
    const hub = createStreamHub({ topics, engine, authorizeTopic: () => allowed,
      systemState: () => ({}), contractVersion: '3', modelVersion: 1 });
    const req = Object.assign(new EventEmitter(), { headers: {}, query: { topics: 'teams' },
      session: { email: 'reader@example.test', exp: Date.now() + 10_000, sid: '0123456789abcdef0123' } });
    const res = Object.assign(new EventEmitter(), { frames: [], first: true, writeHead() {},
      write(line) { this.frames.push(line); if (this.first) { this.first = false; return false; } return true; },
      end() { this.ended = true; }, destroy() { this.destroyed = true; } });
    try {
      hub.open(req, res);
      assert.ok(res.frames.some(line => line.startsWith('retry:')));
      assert.equal(res.frames.some(line => line.includes('PRIVATE_QUEUED_SOURCE_CANARY')), false,
        'the snapshot remains deferred while the transport is blocked');

      allowed = false;
      res.emit('drain');

      assert.equal(res.frames.some(line => line.includes('PRIVATE_QUEUED_SOURCE_CANARY')), false,
        'a queued protected snapshot is never flushed after grant revocation');
      assert.ok(res.destroyed || res.ended, 'the unauthorized stream is terminated');
    } finally { hub.closeAll(); topics.close(); }
  });
});


it('frontend-28: SSE hello and heartbeat expose the current deployed build, including a replacement', async () => {
  const topics = createTopics({ health: { build: () => ({ok:1}) } });
  const engine = Object.assign(new EventEmitter(), {sources:()=>[]});
  let build = 'A';
  const hub = createStreamHub({topics,engine,systemState:()=>({gateway:'up',capabilities:{}}),contractVersion:'2.1',modelVersion:1,buildId:()=>build,heartbeatMs:10});
  const req = Object.assign(new EventEmitter(), {headers:{},query:{topics:'health'},session:{email:'a@b.c',exp:Date.now()+1000,sid:'0123456789abcdef0123'}});
  const frames = [];
  hub.open(req,{writeHead(){},write:(s)=>frames.push(s),end(){}});
  try {
    assert.match(frames.find(s=>s.includes('event: hello')), /"buildId":"A"/);
    build = 'B'; await new Promise(r=>setTimeout(r,35));
    assert.ok(frames.some(s=>s.includes('event: heartbeat') && s.includes('"buildId":"B"')));
  } finally { req.emit('close'); topics.close(); }
});
