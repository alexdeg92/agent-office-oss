'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { normalizeTranscriptEvents } = require('../../src/engine/model/transcript');
const { projectEvents } = require('../../src/engine/model/sender');

const adapters = [
  ['OpenClaw', require('../../src/adapters/openclaw').definition],
  ['Claude Code', require('../../src/adapters/claude-code').definition],
  ['Codex', require('../../src/adapters/codex').definition],
  ['Demo', require('../../src/adapters/demo').definition],
];

for (const [name, adapter] of adapters) test(`${name} transcript normalization repairs repeated and colliding synthetic event ids`, t => {
  const engine = createEngine({ adapter, now: () => 1_800_000_000_000 });
  t.after(() => engine.close());
  const key = 'synthetic-session';
  const first = { id: 'ev:0:0', kind: 'system', at: 1, text: 'first event', truncated: false };
  const collision = { ...first, text: 'distinct event with a colliding source id' };
  const input = { sessionKey: key, fetchedAt: 2, messageCount: 1, window: { from: 0, to: 1 },
    events: [first, structuredClone(first), collision] };
  const result = engine.ingestCanonical('transcript', input, { key });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const trace = engine.transcript(key);
  assert.equal(trace.events.length, 2, 'exact delivery duplicate is removed while distinct content is retained');
  assert.equal(trace.events[0].text, 'first event', 'the first copy remains canonical');
  assert.equal(new Set(trace.events.map(event => event.id)).size, 2);
  assert.match(trace.events[1].id, /^msg:[a-f0-9]{64}:0$/);
  const again = engine.ingestCanonical('transcript', input, { key });
  assert.equal(again.ok, true);
  assert.equal(engine.transcript(key).events[1].id, trace.events[1].id, 'repair IDs are stable across reads');
});

test('transcript repairs reserve later source ids and never collapse a distinct following event', () => {
  const sessionKey = 'session-reserved-id';
  const first = { id: 'ev:0:0', kind: 'system', at: 1, text: 'first', truncated: false };
  const collision = { ...first, at: 2, text: 'second' };
  const replacementFromPair = normalizeTranscriptEvents({ sessionKey, events: [first, collision] }, sessionKey).transcript.events[1].id;
  const laterOriginal = { ...first, id: replacementFromPair, at: 3, text: 'later original' };
  const normalized = normalizeTranscriptEvents({ sessionKey, events: [first, collision, laterOriginal] }, sessionKey);
  assert.equal(normalized.transcript.events.length, 3);
  assert.equal(new Set(normalized.transcript.events.map(event => event.id)).size, 3);
  assert.equal(normalized.transcript.events[2].text, 'later original');
  assert.equal(projectEvents(normalized.transcript.events).length, 3,
    'read projection retains every distinct event after ID normalization');
});

test('inserting another runtime with the same source id does not renumber a repaired event', () => {
  const sessionKey = 'session-cross-runtime-stability';
  const row = (runtime, at, text) => ({ id: 'ev:0:0', kind: 'user', at, text, truncated: false,
    senderInfo: { kind: 'agent', id: 'agent:shared', runtime, channel: null } });
  const a = row('codex', 1, 'A');
  const c = row('claude-code', 2, 'C');
  const b = row('cursor', 3, 'B');
  const repaired = events => normalizeTranscriptEvents({ sessionKey, events }, sessionKey).transcript.events;
  const before = repaired([a, c]).find(event => event.text === 'C').id;
  const after = repaired([a, b, c]).find(event => event.text === 'C').id;
  assert.equal(after, before, 'a different runtime identity has an independent occurrence sequence');
});
