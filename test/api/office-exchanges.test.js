'use strict';
// architect-55 (office-dev-22 §3) · OccupantVM.exchanges { recent, windowMs, lastAt } for conversation occupants:
// a message from the person answered by the agent, timed at the reply; optional (no transcript → no field).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { exchangesOf, EXCHANGE_WINDOW_MS } = require('../../src/api/v2/vm/office');
const { loadScenario, readFixture } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');

const M = 60e3;
const ev = (kind, at) => ({ id: kind + at, kind, at, text: 'x' });

describe('exchanges · the count', () => {
  const NOW = 1791223200000;
  it('a message answered is one exchange; several messages before one reply are one; an unanswered one is none', () => {
    const t = { events: [ev('user', NOW - 30 * M), ev('assistant', NOW - 29 * M),
      ev('user', NOW - 8 * M), ev('user', NOW - 7 * M), ev('tool', NOW - 6 * M), ev('assistant', NOW - 6 * M), ev('assistant', NOW - 5 * M),
      ev('user', NOW - 2 * M), ev('assistant', NOW - 1 * M), ev('user', NOW - 30e3)] };
    assert.deepEqual(exchangesOf(t, NOW), { recent: 2, windowMs: EXCHANGE_WINDOW_MS, lastAt: NOW - 1 * M });
    assert.equal(EXCHANGE_WINDOW_MS, 10 * M, 'the office visit window');
  });
  it('no transcript, or no exchange: null (the field is left out)', () => {
    assert.equal(exchangesOf(null, NOW), null);
    assert.equal(exchangesOf({ events: [ev('user', NOW)] }, NOW), null);
    assert.equal(exchangesOf({ events: [ev('assistant', NOW)] }, NOW), null, 'the agent speaking first is no exchange');
  });
});

describe('exchanges · the office view (v2 and v3, validated)', () => {
  let h, sc;
  const DM = 'agent:main:discord:direct:100000000000000001';
  before(async () => {
    sc = loadScenario('synthetic-basic');
    const base = readFixture(sc.rpc['sessions.list']).body.value;
    const sessions = base.sessions.map((s) => (s.key === DM ? Object.assign({}, s, { updatedAt: sc.now - M, status: 'active' }) : s));
    h = await startServer(sc, { env: { AO_TIME_SCALE: '20' }, handlers: {
      'sessions.list': () => Object.assign({}, base, { sessions }),
    } });
  });
  after(async () => { if (h) await h.stop(); });
  it('human DMs annotate the agent and remain in Logs without a physical exchange visitor', async () => {
    for (const v of ['v2', 'v3']) {
      const occ = (await h.get(`/api/${v}/views/office`)).json.data.occupants;
      assert.equal(occ.some(row => row.sessionKey === DM), false, 'no human DM occupant');
      const owner = occ.find(row => ['main', 'primary'].includes(row.role));
      assert.deepEqual(owner.visitLabel.params.channel, { key: 'channel.discord' });
      assert.ok(occ.every(row => !('exchanges' in row)), 'no visitor animation metadata for the human');
      const logs = (await h.get(`/api/${v}/views/logs?limit=200`)).json.data.items;
      assert.ok(logs.some(row => row.id === DM), 'human conversation remains accessible in Logs');
    }
  });
});
