'use strict';
// PM after R26-01: never hide real agent activity because of an id length. A session whose occupant id is too long to
// store is admitted, on stage and in the logs; ONLY the seen inventory leaves it out, with a warning (store.unindexed).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadScenario, readFixture } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');
const { OCCUPANT_ID_MAX } = require('../../src/engine/model/kinds');

const JOB = '\u{1D49C}'.repeat(250);   // 250 code points (500 UTF-16 units): 'scheduled:' + it is over OCCUPANT_ID_MAX

describe('an occupant too long to index stays visible; only the inventory leaves it out', () => {
  let h;
  before(async () => {
    const sc = loadScenario('synthetic-basic');
    const base = readFixture(sc.rpc['sessions.list']).body.value;
    const cron = base.sessions.find((s) => s.key.includes(':cron:'));
    const sessions = base.sessions.concat([Object.assign({}, cron, { key: 'agent:main:cron:' + JOB, sessionId: 'long-1', status: 'active', updatedAt: sc.now - 10 })]);
    h = await startServer(sc, { handlers: { 'sessions.list': () => Object.assign({}, base, { sessions, count: sessions.length, totalCount: sessions.length }) } });
  });
  after(async () => { if (h) await h.stop(); });
  it('admitted (no quarantine), on stage and in the logs; the inventory has every other occupant; one store.unindexed warning', async () => {
    assert.ok([...('scheduled:' + JOB)].length > OCCUPANT_ID_MAX);
    const logs = (await h.get('/api/v3/views/logs?limit=200')).json.data.items;
    assert.ok(logs.some((x) => x.id === 'agent:main:cron:' + JOB && x.live), 'in the logs, running');
    const office = (await h.get('/api/v3/views/office')).json.data;
    assert.ok(office.occupants.some((o) => o.id === 'scheduled:' + JOB), 'on stage');
    const stored = h.withStore((db) => db.prepare('SELECT occupant_id FROM office_agents_seen').all().map((r) => r.occupant_id));
    assert.deepEqual(stored.sort(), office.occupants.map((o) => o.id).filter((id) => id !== 'scheduled:' + JOB).sort(), 'everyone else is in the inventory');
    const issues = (await h.get('/api/v3/views/health')).json.data.dataQuality.issues;
    assert.ok(issues.some((i) => i.code === 'store.unindexed' && i.severity === 'warn' && i.channel === 'store.office_agents_seen'));
    assert.ok(!issues.some((i) => i.code === 'shape.invalid'), 'nothing quarantined as invalid');
  });
});
