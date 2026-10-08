'use strict';
// review-26 R26-01 (P2): every id bound counts CODE POINTS (SQLite length() on TEXT), at the edge, in the store's CHECKs
// and in the tests; opaque Unicode ids (astral, combining) accepted before stay accepted; an upgrade never strands a row.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase, MIGRATIONS_DIR } = require('../../src/store/db');
const { createOfficeRepo } = require('../../src/store/repos/office');
const kinds = require('../../src/engine/model/kinds');
const { createEngine } = require('../../src/engine');
const { loadScenario, readFixture } = require('../helpers/scenario');

const ASTRAL = '\u{1D49C}';            // 𝒜: one code point, two UTF-16 units
const COMBINING = 'é';           // é decomposed: two code points (e + combining acute)
const cp = (s) => [...s].length;
const astral = (n) => ASTRAL.repeat(n);
const combining = (n) => (COMBINING.repeat(Math.ceil(n / 2))).slice(0, n);   // n code points (all BMP)
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r26-'));

describe('R26-01 · one unit: code points, as SQLite counts them', () => {
  it('the constant\'s unit is the SQLite CHECK\'s: length() of astral and combining text is in code points', () => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const s of [astral(3), combining(4), 'abc']) assert.equal(db.prepare('SELECT length(?) AS n').get(s).n, cp(s), JSON.stringify(s));
    } finally { db.close(); }
    assert.equal(kinds.cpLength(astral(5)), 5); assert.equal(kinds.cpLength(combining(6)), 6);
  });

  it('the edge admits Unicode subjects of any length (200 and 201 code points, astral and combining)', () => {
    const sc = loadScenario('synthetic-basic');
    const base = readFixture(sc.rpc['sessions.list']).body.value;
    const cron = base.sessions.find((s) => s.key.includes(':cron:'));
    const row = (job, n) => Object.assign({}, cron, { key: 'agent:main:cron:' + job, sessionId: 's' + n });
    const e = createEngine({ now: () => sc.now });
    e.ingest({ source: 'gateway', channel: 'gw.rpc.sessions.list', receivedAt: sc.now, context: { offset: 0 }, body: { kind: 'json', value: Object.assign({}, base,
      { sessions: [row(astral(200), 1), row(combining(200), 2), row(astral(201), 3), row(combining(201), 4)] }) } });
    assert.deepEqual(e.sessions().map((s) => cp(s.class.cronJobId)).sort(), [200, 200, 201, 201]);
  });

  it('the inventory stores an id of OCCUPANT_ID_MAX code points (more UTF-16 units), refuses one more', () => {
    const d = tmp();
    try {
      const h = openDatabase({ dir: path.join(d, 'data'), instance: 'test' });
      try {
        const office = createOfficeRepo(h.db, { now: () => 1 });
        const atMax = 'scheduled:' + astral(kinds.OCCUPANT_ID_MAX - 'scheduled:'.length);
        assert.equal(cp(atMax), kinds.OCCUPANT_ID_MAX); assert.ok(atMax.length > kinds.OCCUPANT_ID_MAX, 'more UTF-16 units than the limit');
        assert.deepEqual(office.seen([{ id: atMax, role: 'scheduled', name: 'x' }, { id: atMax + ASTRAL, role: 'scheduled', name: 'y' }], 1), { stored: 1, rejected: 1 });
      } finally { h.close(); }
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  it('an upgrade never strands a stored row: 007 rows of 200 astral / combining code points survive 008 and 009', () => {
    const d = tmp(), mig = path.join(d, 'm');
    try {
      fs.mkdirSync(mig);
      for (const f of fs.readdirSync(MIGRATIONS_DIR)) if (Number(f.slice(0, 3)) <= 7) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(mig, f));
      const pre = openDatabase({ dir: path.join(d, 'data'), instance: 'test', migrationsDir: mig });
      const ins = pre.db.prepare('INSERT INTO office_agents_seen VALUES (?, ?, ?, ?)');
      const rows = [['cron:' + astral(195), 'cron'], ['dm:' + combining(197), 'dm'], ['channel:' + astral(192), 'channel']];
      for (const [id, role] of rows) { assert.equal(cp(id), 200); ins.run(id, role, 'n', 1); }   // the previous release accepted these
      pre.close();
      for (const f of fs.readdirSync(MIGRATIONS_DIR)) if (Number(f.slice(0, 3)) > 7) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(mig, f));
      const h = openDatabase({ dir: path.join(d, 'data'), instance: 'test', migrationsDir: mig });
      try {
        const got = h.db.prepare('SELECT occupant_id FROM office_agents_seen').all().map((r) => r.occupant_id).sort();
        assert.deepEqual(got, ['direct:' + combining(197), 'group:' + astral(192), 'scheduled:' + astral(195)].sort());
      } finally { h.close(); }
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  it('interlocutor ids count code points too: a 128-code-point astral peer is a valid opaque id', () => {
    assert.equal(kinds.isInterlocutorId('telegram-user:' + astral(128)), true);
    assert.equal(kinds.isInterlocutorId('telegram-user:' + astral(129)), false);
    const { interlocutorIdOf } = require('../../src/channels');
    assert.equal(interlocutorIdOf('telegram', { kind: 'conversation-direct', scope: 'dm', peer: astral(128) }), 'telegram-user:' + astral(128));
  });
});
