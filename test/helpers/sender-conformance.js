'use strict';
// Reusable adapter gate: invoke with hooks and a runtime-specific synthetic raw-message factory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../../src/schema');
const { Sender, participantsOf } = require('../../src/engine/model/sender');
const fixture = require('../fixtures/senders/group.json').body.value;
function senderConformance(name, { resolveSender, stripEnvelope, raw, context }) {
  const ctx = { runtime: name, sessionKey: fixture.sessionKey, agent: fixture.agent, ...context('group') };
  const check = (m, c) => { const sender = resolveSender(m, c); assert.equal(s.validate(Sender, sender).ok, true); return sender; };
  test(`${name}: DM resolves the human, display name beats username`, () => {
    const who = check(raw(fixture.humans[0], 'DM'), { ...ctx, ...context('dm') });
    assert.equal(who.kind, 'human'); assert.equal(who.name, 'Mira'); assert.ok(who.id.includes(fixture.humans[0].id));
  });
  test(`${name}: group has three distinct humans plus its agent`, () => {
    const events = fixture.humans.map((p) => ({ senderInfo: check(raw(p, 'Hello'), ctx) }));
    events.push({ senderInfo: check({ role: 'assistant' }, ctx) });
    const people = participantsOf(events); assert.equal(people.length, 4); assert.deepEqual(people.slice(0, 3).map((p) => p.name), ['Mira', 'Jules', 'Noor']);
  });
  test(`${name}: unknown never exposes opaque IDs as display names`, () => {
    const who = check(raw(null, 'Hello'), ctx); assert.equal(who.name, null); assert.equal(who.kind, 'human');
  });
  test(`${name}: operator, agent, system and tool have neutral kinds`, () => {
    const c = { ...ctx, ...context('operator'), operator: fixture.operator };
    assert.equal(check({ role: 'user' }, c).name, 'Camille');
    assert.equal(check({ role: 'assistant' }, c).name, 'Atlas');
    assert.equal(check({ role: 'system' }, c).kind, 'system');
    assert.equal(check({ role: 'tool', name: 'read' }, c).kind, 'tool');
  });
  test(`${name}: envelope is removed before display`, () => assert.equal(stripEnvelope(raw(fixture.humans[0], 'Hello').content), 'Hello'));
}
module.exports = { senderConformance };
