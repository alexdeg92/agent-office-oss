// The mock's diff must produce deltas that delta.js applies back to the exact next VM (api.md §4.2 round trip).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff } from '../../public/v2/mock/diff.js';
import { applyOps } from '../../public/v2/delta.js';
import { seed, buildBoardVM, buildProjectVM, command } from '../../public/v2/mock/projects.js';

const roundTrip = (prev, next) => assert.deepEqual(applyOps(prev, diff(prev, next)), JSON.parse(JSON.stringify(next)));

test('diff → applyOps reproduces the next VM (board move, reorder, add, remove)', () => {
  const db = seed(Date.UTC(2026, 9, 5, 18));
  const before = buildBoardVM(db);
  const r = command(db, 'PUT', '/api/v2/projects/prj_lucie/status', { expectedRevision: 3, status: 'in-progress' });
  assert.equal(r.revision, 4);
  roundTrip(before, buildBoardVM(db));
  const ops = diff(before, buildBoardVM(db));
  // The §4.6 shape: remove from the old column's cards, set counts, upsert into the new column's cards.
  assert.deepEqual(ops.map((o) => [o.op, JSON.stringify(o.path)]).sort(), [
    ['remove', '["columns",{"id":"todo"},"cards"]'],
    ['set', '["columns",{"id":"in-progress"},"count"]'],
    ['set', '["columns",{"id":"todo"},"count"]'],
    ['upsert', '["columns",{"id":"in-progress"},"cards"]'],
  ].sort());
  assert.ok(ops.every((o) => Array.isArray(o.path)), 'paths are arrays');
});

test('diff → applyOps on a project VM (flags, history prepend, nested objects)', () => {
  const db = seed(Date.UTC(2026, 9, 5, 18));
  const before = buildProjectVM(db, 'prj_portail');
  command(db, 'POST', '/api/v2/projects/prj_portail/flags', { expectedRevision: 3, kind: 'label', label: 'Urgent' });
  command(db, 'PUT', '/api/v2/projects/prj_portail/flags/risk/ci-red/ack', { expectedRevision: 4, ack: true });
  roundTrip(before, buildProjectVM(db, 'prj_portail'));
});

test('generic shapes: removals, moves, scalars, nested objects', () => {
  roundTrip({ a: 1, list: [{ id: 'x' }, { id: 'y' }, { id: 'z' }], o: { k: [1, 2] } }, { a: 2, list: [{ id: 'z' }, { id: 'x', v: 1 }], o: { k: [3] } });
  roundTrip({ cols: [{ id: 'a', cards: [{ id: '1', n: 1 }] }, { id: 'b', cards: [] }] }, { cols: [{ id: 'b', cards: [{ id: '1', n: 2 }] }, { id: 'a', cards: [] }] });
  roundTrip({ list: [] }, { list: [{ id: 'n' }] });
});

test('mock commands: revision checks and validation', () => {
  const db = seed();
  const stale = command(db, 'PUT', '/api/v2/projects/prj_lucie/status', { expectedRevision: 1, status: 'idea' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.current.revision, 3, '409 carries the authoritative revision and ProjectVM');
  assert.equal(stale.body.error.current.vm.id, 'prj_lucie');
  assert.equal(command(db, 'POST', '/api/v2/projects/prj_ventes/sources', { expectedRevision: 3, kind: 'github', ref: { owner: 'a', repo: 'b' } }).status, 400, 'link body is {source}');
  assert.equal(command(db, 'POST', '/api/v2/projects/prj_ventes/sources', { expectedRevision: 3, source: { kind: 'github', ref: { owner: 'a', repo: 'b' } } }).revision, 4);
  assert.equal(buildProjectVM(db, 'prj_ventes').repo.state, 'pending', 'a newly linked repo is pending');
  assert.equal(buildProjectVM(db, 'prj_lucie').repo.state, 'ok', 'chez-lucie was already fetched');
  assert.equal(command(db, 'PUT', '/api/v2/projects/prj_lucie/status', { status: 'idea' }).status, 400);
  assert.equal(command(db, 'PUT', '/api/v2/projects/prj_lucie/status', { expectedRevision: 3, status: 'nope' }).status, 400);
  assert.equal(command(db, 'PUT', '/api/v2/projects/prj_lucie/status', { expectedRevision: 3, status: 'idea', extra: 1 }).status, 400);
  assert.equal(command(db, 'DELETE', '/api/v2/projects/prj_factures/flags/risk/flow-failing', { expectedRevision: 3 }).status, 400, 'auto risks are acked, not removed');
  assert.equal(command(db, 'PUT', '/api/v2/projects/prj_nope/status', { expectedRevision: 1, status: 'idea' }).status, 404);
  const created = command(db, 'POST', '/api/v2/projects', { name: 'Essai', status: 'todo' });
  assert.match(created.result.id, /^prj_essai-/);
  assert.equal(buildBoardVM(db).columns.find((c) => c.id === 'todo').cards.some((c) => c.id === created.result.id), true);
});

test('mock VMs follow contract 2.0 shapes', () => {
  const db = seed();
  const card = buildBoardVM(db).columns.find((c) => c.id === 'in-progress').cards[0];
  assert.equal(card.status, 'in-progress');
  assert.ok(card.flags.visible.some((f) => f.kind === 'priority'), 'priority is a FlagVM');
  const p = buildProjectVM(db, 'prj_portail');
  for (const k of ['archived', 'recentHistory', 'historyNextCursor', 'repo', 'sources', 'flags', 'people']) assert.ok(k in p, k);
  assert.equal(typeof p.recentHistory[0].text.key, 'string', 'history text is a LabelRef');
  assert.ok(p.sources.every((s) => typeof s.label === 'string'));
  assert.equal(typeof p.repo.commits[0].author, 'string');
  const label = p.flags.find((f) => f.kind === 'label');
  assert.equal(label.removable, true);
  const risk = p.flags.find((f) => f.kind === 'risk');
  assert.equal(risk.removable, false, 'auto risks are not removable');
  command(db, 'POST', '/api/v2/projects/prj_lucie/sources', { expectedRevision: 3, source: { kind: 'github', ref: { owner: 'atelier-demo', repo: 'neuf' } } });
});
