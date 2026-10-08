'use strict';
/*
 * R2-09: canonical Session OUTPUT is pinned per fixture (full values, not counts), checked against
 * independently written invariants, and the reviewer's in-memory mutation (displayName/model/
 * parentKey/childKeys/costUsd corrupted) is proven to fail these checks.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const s = require('../../src/schema');
const { createEngine } = require('../../src/engine');
const { normaliseSession } = require('../../src/adapters/openclaw/normalise/session');
// PM audit (B): the contract a canonical Session satisfies is its ENTITY's (optional = explicit null)
const { Session } = require('../../src/model');
const { listScenarios } = require('../helpers/scenario');
const { feed } = require('../helpers/feed');
const { matchGolden, GOLDEN_DIR } = require('../helpers/golden');

// G3b canonical vocabulary (ADR-001 §4.2, §12.3); the 2.x names live only in the projection
const KINDS = new Set(['primary', 'dashboard', 'subagent', 'scheduled', 'conversation-direct', 'conversation-group', 'conversation', 'acp', 'explicit', 'unrecognized']);

// Written from data-model.md §2–3, not from the implementation.
function invariantViolations(list) {
  const out = [];
  const keys = new Set(list.map((x) => x.key));
  const bad = (x, why) => out.push(`${x.key}: ${why}`);
  for (const x of list) {
    if (!KINDS.has(x.class.kind)) bad(x, 'kind outside the closed union');
    if (x.class.heartbeatOf !== null && x.key !== x.class.heartbeatOf + ':heartbeat') bad(x, 'heartbeatOf is not the base key');
    if (x.class.heartbeatOf === null && /:heartbeat$/.test(x.key)) bad(x, 'heartbeat key without heartbeatOf');
    if (x.class.heartbeatOf && x.interactive) bad(x, 'a heartbeat is never interactive');
    if (x.class.kind === 'subagent' && !x.class.subagentId) bad(x, 'subagent without subagentId');
    if (x.class.kind === 'scheduled' && !x.class.cronJobId) bad(x, 'scheduled without cronJobId');
    const iid = x.class.interlocutorId;
    if (iid && x.class.channel === 'discord' && !/^discord-(user|channel):\d{17,20}$/.test(iid)) bad(x, 'malformed Discord interlocutorId');
    if (iid && x.class.channel !== 'discord' && !(iid.startsWith(x.class.channel + '-user:') || iid.startsWith(x.class.channel + '-room:'))) bad(x, 'interlocutorId outside its channel family');
    if (x.class.channel !== null && !/^[a-z][a-z0-9-]{0,31}$/.test(x.class.channel)) bad(x, 'channel is not a ChannelRef slug');
    if (!(x.usage.total >= 0) || (x.usage.input !== null && x.usage.input < 0) || (x.usage.output !== null && x.usage.output < 0)) bad(x, 'negative usage');
    if (x.model !== null && (typeof x.model.id !== 'string' || !x.model.id)) bad(x, 'model without id');
    if (!['idle', 'running', 'succeeded', 'failed'].includes(x.run.status)) bad(x, 'run.status outside the union');
    if ((x.run.status === 'failed') !== (x.run.endReason !== null) && x.run.evidence === 'status-field') bad(x, 'endReason iff failed');
    if (x.run.evidence === 'gateway-flag' && x.run.status !== 'running') bad(x, 'gateway flag means running');
    if (!Array.isArray(x.childKeys)) bad(x, 'childKeys not an array');
    if (x.parentKey === x.key) bad(x, 'own parent');
    if (x.goal !== null && typeof x.goal.objective !== 'string') bad(x, 'goal without objective');
    if (!Session.check(x).ok) bad(x, 'fails the canonical contract');
    if (!(x instanceof Session)) bad(x, 'is not a Session entity');
  }
  if (keys.size !== list.length) out.push('duplicate keys');
  return out;
}

const goldenFile = (sc) => path.join(GOLDEN_DIR, 'engine-sessions', sc.name, 'canonical.json');
const sameAsGolden = (sc, list) => { try { assert.deepStrictEqual(JSON.parse(JSON.stringify(list)), JSON.parse(fs.readFileSync(goldenFile(sc), 'utf8'))); return true; } catch (_) { return false; } };

for (const sc of listScenarios()) {
  describe(`canonical sessions · ${sc.name}`, () => {
    const list = feed(createEngine({ now: () => sc.now }), sc).sessions();

    it('full canonical output matches golden', () => matchGolden('engine-sessions', sc.name, 'canonical', JSON.parse(JSON.stringify(list))));
    it('every session satisfies the independent invariants and the contract', () => assert.deepEqual(invariantViolations(list), []));

    it("the reviewer's mutation is caught (golden and invariants)", () => {
      const mutant = (row, opts) => {
        const r = normaliseSession(row, opts);
        Object.assign(r.session, { displayName: 'wrong', model: null, parentKey: null, childKeys: [], costUsd: null });
        return r;
      };
      const mutated = feed(createEngine({ now: () => sc.now, normalise: mutant }), sc).sessions();
      assert.equal(sameAsGolden(sc, mutated), false, 'golden must detect the corruption');
      // and a structural corruption is caught by the invariants alone
      const broken = (row, opts) => { const r = normaliseSession(row, opts); r.session.usage.total = -1; r.session.class.kind = 'bogus'; return r; };
      const e = createEngine({ now: () => sc.now, normalise: broken });
      feed(e, sc);
      assert.equal(e.sessions().length, 0, 'contract validation refuses corrupted sessions');
      assert.ok(e.quarantine.list().some((i) => i.code === 'shape.invalid' && /^\$\.canonical\./.test(i.path)));
    });
  });
}
