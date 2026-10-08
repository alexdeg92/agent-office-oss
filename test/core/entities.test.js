'use strict';
// PM audit (B), part 1: canonical entities from schemas (defineEntity). Frozen, constructor-validated, optional =
// explicit null, never undefined, stable toJSON; the engine stores instances.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../../src/schema');
const { defineEntity, EntityError } = require('../../src/model/entity');
const M = require('../../src/model');
const { createEngine } = require('../../src/engine');
const { loadScenario, readFixture } = require('../helpers/scenario');

describe('entities · defineEntity', () => {
  const Thing = defineEntity('Thing', s.object({ id: s.string().min(1), note: s.string().optional(), tags: s.array(s.object({ k: s.string(), v: s.int().optional() }, { extra: 'reject' })) }, { extra: 'reject' }));

  it('optional = explicit null, at every depth; instances are frozen; toJSON follows the schema order', () => {
    const t = new Thing({ tags: [{ k: 'a' }], id: 'x' });
    assert.deepEqual(JSON.parse(JSON.stringify(t)), { id: 'x', note: null, tags: [{ k: 'a', v: null }] });
    assert.deepEqual(Object.keys(t.toJSON()), ['id', 'note', 'tags']);
    assert.ok(Object.isFrozen(t) && Object.isFrozen(t.tags) && Object.isFrozen(t.tags[0]));
    assert.throws(() => { 'use strict'; t.id = 'y'; }, TypeError);
    assert.equal(new Thing(t), t, 'an instance passes through');
  });

  it('undefined anywhere is refused (with its path), unknown fields and wrong types too; from() reports instead of throwing', () => {
    for (const [bad, path] of [[{ id: 'x', note: undefined, tags: [] }, '$.note'], [{ id: 'x', tags: [{ k: 'a', v: undefined }] }, '$.tags[].v'], [{ id: undefined, tags: [] }, '$.id']]) {
      assert.throws(() => new Thing(bad), (e) => e instanceof EntityError && e.issues[0].path === path, path);
    }
    assert.throws(() => new Thing({ id: 'x', tags: [], extra: 1 }), EntityError);
    assert.throws(() => new Thing({ id: 3, tags: [] }), EntityError);
    const issues = []; assert.equal(Thing.from({ id: '' , tags: [] }, (i) => issues.push(i)), null); assert.ok(issues.length > 0);
    assert.ok(!JSON.stringify(issues).includes('""'), 'issues are value-free');
  });
});

describe('entities · the engine stores instances', () => {
  it('agents, flows, sessions, live events and the config are entity instances, all fields defined', () => {
    const sc = loadScenario('synthetic-basic');
    const engine = createEngine({ now: () => sc.now });
    const feed = (channel, rel, context) => engine.ingest({ source: 'gateway', channel, receivedAt: sc.now, context, body: { kind: 'json', value: readFixture(rel).body.value } });
    feed('gw.rpc.agents.list', sc.rpc['agents.list']);
    feed('gw.rpc.cron.list', sc.rpc['cron.list']);
    feed('gw.rpc.sessions.list', sc.rpc['sessions.list'], { offset: 0 });
    engine.setGatewayConnected(true);
    assert.ok(engine.agents().length && engine.agents().every((a) => a instanceof M.Agent));
    assert.ok(engine.cronJobs().length && engine.cronJobs().every((j) => j instanceof M.Flow));
    assert.ok(engine.sessions().length && engine.sessions().every((x) => x instanceof M.Session));
    assert.ok(engine.liveEvents().every((e) => e instanceof M.LiveEvent));
    const hasUndefined = (v) => v === undefined || (v && typeof v === 'object' && Object.values(v).some(hasUndefined));
    for (const x of [...engine.agents(), ...engine.cronJobs(), ...engine.sessions(), ...engine.liveEvents()]) assert.equal(hasUndefined(x), false);
    assert.ok(engine.sessions().every((x) => 'subagentId' in x.class && 'interlocutorId' in x.class), 'optional fields are explicit');
  });
});
