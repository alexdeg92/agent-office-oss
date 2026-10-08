'use strict';
// office-dev-22 · visits (pure): a person's single message → they visit the agent's desk; a real conversation (2 exchanges
// within 10 min) or a group / two people → the meeting table, the agent too; quiet for 3 min → nobody visits.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { trackTurns, planVisits, VISIT, isVisitor, exchangeCount, phaseOf, lingering } = require(path.join(__dirname, '..', '..', 'public/v2/office/visits.js'));

const T0 = 1_800_000_000_000, MIN = 60_000, SEC = 1000;
const where = (p) => ({ hostId: p.hostId, desk: p.desk, meeting: p.meeting });
const agent = (state = 'working') => ({ id: 'primary', role: 'primary', state });
const person = (id, state = 'working', role = 'direct') => ({ id, role, state, stateSince: T0 });

describe('visits (office-dev-22)', () => {
  it('a single message: the person visits the agent’s desk (the agent works at his desk)', () => {
    const occ = [agent(), person('direct:camille')];
    const tr = trackTurns({}, occ, T0);
    assert.deepEqual(where(planVisits(occ, tr, T0)), { hostId: 'primary', desk: ['direct:camille'], meeting: [] });
    assert.equal(tr['direct:camille'].turns.length, 1);
    assert.ok(isVisitor({ role: 'dm' }) && isVisitor({ role: 'channel' }) && !isVisitor({ role: 'subagent' }) && !isVisitor({ role: 'cron' }));
  });

  it('a conversation (≥ 2 exchanges within 10 min) → the meeting table, agent first; 2.x ids too', () => {
    let tr = trackTurns({}, [agent(), person('dm:camille')], T0);
    tr = trackTurns(tr, [agent('idle')], T0 + 2 * MIN);                                   // between exchanges: off stage
    assert.equal(tr['dm:camille'].turns.length, 1, 'history kept while away');
    tr = trackTurns(tr, [agent(), { ...person('dm:camille'), stateSince: T0 + 4 * MIN }], T0 + 4 * MIN);
    assert.equal(tr['dm:camille'].turns.length, 2);
    assert.deepEqual(where(planVisits([agent(), { ...person('dm:camille'), stateSince: T0 + 4 * MIN }], tr, T0 + 4 * MIN)), { hostId: 'primary', desk: [], meeting: ['primary', 'dm:camille'] });
    // two exchanges 12 minutes apart are not a conversation
    let far = trackTurns({}, [agent(), person('dm:x')], T0);
    far = trackTurns(far, [agent('idle')], T0 + MIN);
    far = trackTurns(far, [agent(), person('dm:x')], T0 + 12 * MIN);
    assert.deepEqual(planVisits([agent(), person('dm:x')], far, T0 + 12 * MIN).desk, ['dm:x']);
  });

  it('a group channel, or two people at once, is a meeting', () => {
    const g = [agent(), person('group:projet', 'working', 'group')];
    assert.deepEqual(planVisits(g, trackTurns({}, g, T0), T0).meeting, ['primary', 'group:projet']);
    const two = [agent(), person('direct:a'), person('direct:b')];
    assert.deepEqual(planVisits(two, trackTurns({}, two, T0), T0).meeting, ['primary', 'direct:a', 'direct:b']);
  });

  it('office-dev-24: only an exchange in flight talks; once the run is over the person lingers LINGER_MS, then leaves', () => {
    // the person's message is the latest: their turn (bubble on them), both in talking poses
    const occ = [agent(), person('direct:c')];
    let tr = trackTurns({}, occ, T0);
    let p = planVisits(occ, tr, T0 + 2 * SEC);
    assert.deepEqual([p.talking, p.speaker, p.until], [true, 'direct:c', T0 + VISIT.PERSON_TURN_MS]);
    // the agent's reply run: his bubble; the person waits for the reply (the run may last minutes: a sub-agent)
    p = planVisits(occ, tr, T0 + VISIT.PERSON_TURN_MS);
    assert.deepEqual([p.talking, p.speaker, p.until, p.desk], [true, 'primary', null, ['direct:c']]);
    assert.equal(phaseOf(occ[1], tr['direct:c'], T0 + 3 * MIN), 'agent', 'still the agent’s turn while the run lasts');
    // a known reply since the message (OccupantVM.exchanges.lastAt) ends the person's turn at once
    assert.equal(phaseOf({ ...occ[1], exchanges: { recent: 1, windowMs: VISIT.WINDOW_MS, lastAt: T0 + SEC } }, undefined, T0 + 2 * SEC), 'agent');
    // the run ends (2.x: the person is no longer in the list): no bubble, no talking; they linger, then leave
    const END = T0 + 3 * MIN;
    tr = trackTurns(tr, occ, END - SEC);
    tr = trackTurns(tr, [agent('idle')], END);
    const back = [agent('idle'), ...lingering(tr, [agent('idle')], END + 10 * SEC)];
    assert.deepEqual(back.map((o) => [o.id, o.state]), [['primary', 'idle'], ['direct:c', 'idle']], 'the last occupant, idle');
    p = planVisits(back, tr, END + 10 * SEC);
    assert.deepEqual([p.talking, p.speaker, p.desk, p.until], [false, null, ['direct:c'], END - SEC + VISIT.LINGER_MS]);
    assert.deepEqual(lingering(tr, [agent('idle')], END - SEC + VISIT.LINGER_MS), [], 'then walks out');
    assert.deepEqual(where(planVisits([agent('idle')], tr, END + VISIT.LINGER_MS)), { hostId: 'primary', desk: [], meeting: [] });
    // a « seen » person (3.0 presence) lingers the same way; a seen agent is never a host
    const seenP = { ...person('direct:c', 'offline'), presence: 'seen' };
    assert.deepEqual(planVisits([agent('idle'), seenP], tr, END + 10 * SEC).desk, ['direct:c']);
    assert.deepEqual(planVisits([agent('idle'), seenP], tr, END + 2 * MIN).desk, []);
    assert.deepEqual(planVisits([{ ...agent('offline'), presence: 'seen' }, person('direct:c')], tr, T0).desk, []);
  });

  it('office-dev-23: OccupantVM.exchanges (architect-55) is preferred when present; the client count stays the fallback', () => {
    const x = (recent, lastAt) => ({ recent, windowMs: VISIT.WINDOW_MS, lastAt });
    // a new tab: the client has seen nothing yet, the server knows 2 exchanges → the meeting table at once
    const conv = [agent(), { ...person('dm:camille', 'idle'), exchanges: x(2, T0 - 20 * SEC) }];
    let tr = trackTurns({}, conv, T0);
    assert.equal(tr['dm:camille'].turns.length, 0, 'the client saw no exchange');
    assert.deepEqual(where(planVisits(conv, tr, T0)), { hostId: 'primary', desk: [], meeting: ['primary', 'dm:camille'] });
    // the server count wins over the client's: 1 answered + nothing in progress → the desk, though the client counted 2
    let cl = trackTurns({}, [agent(), person('dm:a')], T0);
    cl = trackTurns(cl, [agent('idle')], T0 + MIN);
    cl = trackTurns(cl, [agent(), { ...person('dm:a'), stateSince: T0 + 2 * MIN }], T0 + 2 * MIN);
    assert.equal(cl['dm:a'].turns.length, 2);
    const one = { ...person('dm:a'), stateSince: T0 + 2 * MIN, exchanges: x(1, T0 + 3 * MIN) };
    assert.equal(exchangeCount(one, cl['dm:a'], T0 + 3 * MIN), 1);
    // an exchange in progress (active since after the last answered one) adds one: the second message → the table
    const second = { ...person('dm:b'), stateSince: T0 + 4 * MIN, exchanges: x(1, T0 + MIN) };
    assert.equal(exchangeCount(second, undefined, T0 + 4 * MIN), 2);
    assert.deepEqual(planVisits([agent(), second], trackTurns({}, [agent(), second], T0 + 4 * MIN), T0 + 4 * MIN).meeting, ['primary', 'dm:b']);
    // the server's last exchange keeps a « seen » person visiting while they linger, also off stage (kept in the track)
    tr = trackTurns(tr, [agent('idle')], T0 + 10 * SEC);
    assert.deepEqual(tr['dm:camille'].server, x(2, T0 - 20 * SEC), 'kept while off stage');
    const seenP = { ...person('dm:camille', 'offline'), presence: 'seen' };
    assert.deepEqual(planVisits([agent('idle'), seenP], tr, T0 + 10 * SEC).meeting, ['primary', 'dm:camille']);
    // the window passes: the server count expires; the linger too → nobody visits
    assert.equal(exchangeCount(seenP, tr['dm:camille'], T0 + VISIT.WINDOW_MS), 0);
    assert.deepEqual(where(planVisits([agent('idle'), seenP], tr, T0 + VISIT.LINGER_MS)), { hostId: 'primary', desk: [], meeting: [] });
    // without the field (or a malformed one): the client's own count
    assert.equal(exchangeCount({ ...person('dm:a'), exchanges: { recent: 'x' } }, cl['dm:a'], T0 + 2 * MIN), 2);
  });
});
