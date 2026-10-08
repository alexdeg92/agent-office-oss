'use strict';
// review-24 R24-01 (P2): one occupant-id limit end to end (validated at the edge), migrations that never reject an id
// the previous schema accepted, per-row inventory writes, and no silent empty inventory (R22-04 finished).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { openDatabase, MIGRATIONS_DIR } = require('../../src/store/db');
const { createOfficeRepo } = require('../../src/store/repos/office');
const kinds = require('../../src/engine/model/kinds');
const { createEngine } = require('../../src/engine');
const { loadScenario, readFixture } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r24-'));
const SUBJECT_MAX = kinds.OCCUPANT_SUBJECT_MAX, ID_MAX = kinds.OCCUPANT_ID_MAX;
const subject = (n) => 'j' + 'x'.repeat(n - 1);

describe('R24-01 · one limit: the constant, the canonical model and every schema agree', () => {
  it('OCCUPANT_ID_MAX = the longest role prefix of either vocabulary + ":" + OCCUPANT_SUBJECT_MAX; the latest seen-table CHECK uses it', () => {
    assert.equal(SUBJECT_MAX, 200);
    assert.equal(ID_MAX, 'conversation:'.length + SUBJECT_MAX);
    const latest = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /office_agents_seen/.test(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))).sort().pop();
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, latest), 'utf8');
    assert.match(sql, new RegExp(`length\\(occupant_id\\) BETWEEN 1 AND ${ID_MAX}\\b`), latest);
  });
  // PM after R26-01: real activity is never hidden because of an id length; only the inventory leaves it out (store.unindexed)
  it('every session is admitted, whatever its id length (no quarantine for a long id)', () => {
    const sc = loadScenario('synthetic-basic');
    const base = readFixture(sc.rpc['sessions.list']).body.value;
    const row = (key) => Object.assign({}, base.sessions.find((s) => s.key.includes(':cron:')), { key, sessionId: 'x' + key.length });
    const e = createEngine({ now: () => sc.now });
    e.ingest({ source: 'gateway', channel: 'gw.rpc.sessions.list', receivedAt: sc.now, context: { offset: 0 },
      body: { kind: 'json', value: Object.assign({}, base, { sessions: [row('agent:main:cron:' + subject(SUBJECT_MAX)), row('agent:main:cron:' + subject(SUBJECT_MAX + 1))] }) } });
    assert.deepEqual(e.sessions().map((s) => s.class.cronJobId.length).sort(), [SUBJECT_MAX, SUBJECT_MAX + 1]);
    assert.ok(!e.dataQuality().issues.some((i) => i.code === 'shape.invalid'));
  });
});

describe('R24-01 · migrations never reject an id the previous schema accepted', () => {
  it('a 007 store with 200-char cron/dm/channel ids upgrades; the canonical ids keep every character', () => {
    const d = tmp(), mig = path.join(d, 'm');
    try {
      fs.mkdirSync(mig);
      for (const f of fs.readdirSync(MIGRATIONS_DIR)) if (Number(f.slice(0, 3)) <= 7) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(mig, f));
      const pre = openDatabase({ dir: path.join(d, 'data'), instance: 'test', migrationsDir: mig });
      const ins = pre.db.prepare('INSERT INTO office_agents_seen VALUES (?, ?, ?, ?)');
      const rows = [['cron:' + 'c'.repeat(195), 'cron'], ['dm:' + 'd'.repeat(197), 'dm'], ['channel:' + 'g'.repeat(192), 'channel'], ['main', 'main']];
      for (const [id, role] of rows) { assert.equal(id.length <= 200, true); ins.run(id, role, 'n', 1); }
      pre.close();
      for (const f of fs.readdirSync(MIGRATIONS_DIR)) if (Number(f.slice(0, 3)) > 7) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(mig, f));
      const h = openDatabase({ dir: path.join(d, 'data'), instance: 'test', migrationsDir: mig });
      try {
        const got = h.db.prepare('SELECT occupant_id FROM office_agents_seen ORDER BY occupant_id').all().map((r) => r.occupant_id);
        assert.deepEqual(got.sort(), ['direct:' + 'd'.repeat(197), 'group:' + 'g'.repeat(192), 'primary', 'scheduled:' + 'c'.repeat(195)].sort());
      } finally { h.close(); }
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

describe('R24-01 · inventory writes are per row', () => {
  it('a bad row is reported and skipped; the others are stored', () => {
    const d = tmp();
    try {
      const h = openDatabase({ dir: path.join(d, 'data'), instance: 'test' });
      try {
        const office = createOfficeRepo(h.db, { now: () => 1000 });
        const out = office.seen([{ id: 'primary', role: 'primary', name: 'A' }, { id: 'scheduled:' + 'x'.repeat(ID_MAX), role: 'scheduled', name: 'B' }, { id: 'subagent:s1', role: 'subagent', name: 'C' }], 1000);
        assert.deepEqual(out, { stored: 2, rejected: 1 });
        assert.deepEqual(office.seenRecent(1000).map((x) => x.id).sort(), ['primary', 'subagent:s1']);
      } finally { h.close(); }
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

describe('R24-01 · the real server: a long scheduled job id with ordinary occupants', () => {
  let h;
  const JOB = subject(195);
  before(async () => {
    const sc = loadScenario('synthetic-basic');
    const base = readFixture(sc.rpc['sessions.list']).body.value;
    const cron = base.sessions.find((s) => s.key.includes(':cron:'));
    const sessions = base.sessions.concat([Object.assign({}, cron, { key: 'agent:main:cron:' + JOB, sessionId: 'long-1', status: 'active', updatedAt: sc.now - 10 })]);
    h = await startServer(sc, { handlers: { 'sessions.list': () => Object.assign({}, base, { sessions, count: sessions.length, totalCount: sessions.length }) } });
  });
  after(async () => { if (h) await h.stop(); });
  it('every occupant is in the inventory, the long one included (v3 and v2), and no inventory issue', async () => {
    const office = (await h.get('/api/v3/views/office')).json.data;
    assert.ok(office.occupants.some((o) => o.id === 'scheduled:' + JOB), 'the long occupant is on stage');
    const stored = h.withStore((db) => db.prepare('SELECT occupant_id FROM office_agents_seen').all().map((r) => r.occupant_id));
    assert.deepEqual(stored.sort(), office.occupants.map((o) => o.id).sort());
    assert.ok((await h.get('/api/v3/office/layout')).json.data.agentsSeen.some((x) => x.id === 'scheduled:' + JOB));
    assert.ok((await h.get('/api/v2/office/layout')).json.data.agentsSeen.some((x) => x.id === 'cron:' + JOB));
    assert.ok(!(await h.get('/api/v2/views/health')).json.data.dataQuality.issues.some((i) => i.channel === 'store.office_agents_seen'));
  });
});
