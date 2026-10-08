import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, waterfall } from '../../public/v2/trace.js';

const ev = (kind, at, extra = {}) => ({ kind, at, text: kind, truncated: false, ...extra });
const tool = (at, name, extra = {}) => ({ kind: 'tool', at, callId: name + at, name, toolKind: 'search', input: '{}', output: 'ok', isError: false, durationMs: 1000, truncated: false, ...extra });

test('buildTree: thinking goes with the next answer, tools and observations with the answer before them', () => {
  const nodes = buildTree([
    ev('system', 0), ev('user', 1, { sender: 'Guest' }), ev('thinking', 2), ev('assistant', 3),
    tool(4, 'web_search'), ev('observation', 6), tool(7, 'exec'), ev('assistant', 9), ev('user', 10),
  ]);
  assert.deepEqual(nodes.map((n) => n.type), ['system', 'human', 'agent', 'agent', 'human']);
  assert.equal(nodes[2].thinking.length, 1);
  assert.deepEqual(nodes[2].tools.map((x) => x.name), ['web_search', 'exec']);
  assert.equal(nodes[2].notes.length, 1);
  assert.equal(nodes[3].tools.length, 0);
});

test('buildTree: a live turn without an answer yet still shows its thinking and tools', () => {
  const nodes = buildTree([ev('user', 1), ev('thinking', 2), tool(3, 'web_fetch')]);
  assert.deepEqual(nodes.map((n) => n.type), ['human', 'agent']);
  assert.equal(nodes[1].event, null);
  assert.equal(nodes[1].thinking.length, 1);
  assert.equal(nodes[1].tools.length, 1);
  assert.deepEqual(buildTree([ev('thinking', 1)]).map((n) => n.type), ['agent']);
  assert.deepEqual(buildTree([]), []);
  assert.deepEqual(buildTree([null, { kind: 'unknown' }]), [], 'unknown kinds are skipped, not thrown');
});

test('waterfall: tools last durationMs, others until the next event; percentages of the span', () => {
  const w = waterfall([ev('user', 0, { sender: 'Guest' }), ev('assistant', 2000), tool(3000, 'exec', { durationMs: 7000, isError: true })]);
  assert.equal(w.t0, 0);
  assert.equal(w.t1, 10_000);
  assert.deepEqual(w.rows.map((r) => [r.label, r.kind, Math.round(r.start), Math.round(r.len), r.durMs]), [
    ['Guest', 'human', 0, 20, 2000], ['Réponse', 'agent', 20, 10, 1000], ['exec', 'error', 30, 70, 7000],
  ]);
});

test('waterfall: timestamps that step backwards never give negative bars', () => {
  const w = waterfall([ev('assistant', 5000), ev('thinking', 3000), tool(4000, 'x', { durationMs: null })]);
  assert.ok(w.rows.every((r) => r.start >= 0 && r.len >= 0));
  assert.equal(w.rows[2].durMs, null, 'unknown tool duration stays unknown');
  assert.deepEqual(waterfall([]), { t0: null, t1: null, totalMs: 0, rows: [] });
});
