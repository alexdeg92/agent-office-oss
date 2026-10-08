'use strict';
// architect-55 (office-dev-22 §3) · OccupantVM.exchanges { recent, windowMs, lastAt } for conversation occupants:
// a message from the person answered by the agent, timed at the reply; optional (no transcript → no field).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { exchangesOf, EXCHANGE_WINDOW_MS } = require('../../src/api/v2/vm/office');
const { loadScenario, readFixture, gatewayHandlers } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');

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
    const turn = (u, a) => [{ role: 'user', timestamp: u, content: 'Salut' }, { role: 'assistant', timestamp: a, content: [{ type: 'text', text: 'Bonjour' }] }];
    const get = gatewayHandlers(sc)['sessions.get'];
    h = await startServer(sc, { env: { AO_TIME_SCALE: '20' }, handlers: {
      'sessions.list': () => Object.assign({}, base, { sessions }),
      'sessions.get': (p) => (p.key === DM ? { messages: turn(sc.now - 20 * M, sc.now - 19 * M).concat(turn(sc.now - 5 * M, sc.now - 4 * M), turn(sc.now - 2 * M, sc.now - M)) } : get(p)),
    } });
  });
  after(async () => { if (h) await h.stop(); });
  it('the DM occupant carries its exchanges; occupants without a conversation transcript carry none', async () => {
    for (const v of ['v2', 'v3']) {
      const occ = await waitFor(async () => { const o = (await h.get(`/api/${v}/views/office`)).json.data.occupants; return o.find((x) => x.exchanges) ? o : null; },
        { timeoutMs: 20000, what: v + ' exchanges' });
      const dm = occ.find((x) => x.sessionKey === DM);
      assert.deepEqual(dm.exchanges, { recent: 2, windowMs: 600000, lastAt: sc.now - M }, v);
      assert.ok(occ.filter((x) => x.sessionKey !== DM).every((x) => !('exchanges' in x)), v + ': only conversation occupants with a transcript');
    }
  });
});
