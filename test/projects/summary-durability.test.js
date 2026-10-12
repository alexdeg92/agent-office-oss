'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { openStore } = require('../../src/store');
const { createProjectsRepository } = require('../../src/store/repos/projects');
const { createProjectService } = require('../../src/projects');
const { createProjectThread } = require('../../src/api/v2/comments');
const AT = 1791400000000;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-summary-durable-'));
  let store, repository, service;
  const open = () => {
    store = openStore({ dir, instance: 'test', ownerName: 'Fixture Owner', now: () => AT, log() {} });
    store.persons.ensureAgent('main', 'Fixture Agent');
    repository = createProjectsRepository(store.db, { ownerPersonId: store.owner.id, primaryAgentId: 'main' });
    service = createProjectService({ repository, clock: () => AT });
  };
  open();
  const p = service.commands.create({ name: 'Fixture Project', summary: 'Original' }).vm;
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { p, get store() { return store; }, get repository() { return repository; }, get service() { return service; }, restart() { store.close(); open(); } };
}
const agent = { kind: 'agent', agentId: 'main' };
const pending = e => e.code === 'conflict' && e.details?.[0]?.issue === 'turn-pending';
const claim = h => h.service.commands.regenerateSummary({ id: h.p.id, expectedRevision: h.service.views.project({ id: h.p.id }).revision });
const complete = (h, turn, extra = {}) => h.service.commands.completeSummary({ id: h.p.id, turnId: turn.result.turnId, expectedRevision: turn.revision, summary: 'Generated', actor: agent, ...extra });
test('critic-02/04: reopen retains pending lock and applies the original completion once', t => {
  const h = fixture(t), turn = claim(h), before = h.repository.getHistory(h.p.id).events.length;
  h.restart(); assert.throws(() => claim(h), pending);
  assert.equal(complete(h, turn).vm.summary, 'Generated');
  assert.equal(complete(h, turn).result.applied, false);
  assert.equal(h.repository.getHistory(h.p.id).events.length, before + 1);
  assert.ok(claim(h).result.turnId);
});
test('critic-02: reopen without trying a new turn still accepts the durable exact id', t => {
  const h = fixture(t), turn = claim(h); h.restart();
  assert.equal(complete(h, turn).vm.summary, 'Generated');
  assert.equal(h.service.views.project({ id: h.p.id }).revision, turn.revision + 1);
});
test('manual repository edits invalidate the turn even when the original text is restored', t => {
  const h = fixture(t), turn = claim(h);
  const changed = h.repository.edit({ id: h.p.id, expectedRevision: turn.revision, summary: 'Manual', actor: 'owner' });
  const restored = h.repository.edit({ id: h.p.id, expectedRevision: changed.revision, summary: 'Original', actor: 'owner' });
  assert.equal(complete(h, turn, { expectedRevision: restored.revision }).result.applied, false);
  assert.ok(claim(h).result.turnId);
});
test('a stale service cannot clear or overwrite a newer durable turn', t => {
  const h = fixture(t), turnA = claim(h);
  const newer = createProjectService({ repository: h.repository, clock: () => AT });
  newer.commands.abandonSummary({ id: h.p.id, turnId: turnA.result.turnId });
  const turnB = newer.commands.regenerateSummary({ id: h.p.id, expectedRevision: turnA.revision });
  assert.equal(complete(h, turnA, { summary: 'Old' }).result.applied, false);
  h.service.commands.abandonSummary({ id: h.p.id, turnId: turnA.result.turnId });
  assert.throws(() => claim(h), pending);
  assert.equal(complete(h, turnB).vm.summary, 'Generated');
});
test('unrelated revisions keep the lock; abandon after reopen changes no public revision/history', t => {
  const h = fixture(t), turn = claim(h);
  h.service.commands.edit({ id: h.p.id, expectedRevision: turn.revision, name: 'Renamed' });
  h.restart(); assert.equal(complete(h, turn).result.applied, false); assert.throws(() => claim(h), pending);
  const before = h.repository.getProject(h.p.id), history = h.repository.getHistory(h.p.id);
  h.service.commands.abandonSummary({ id: h.p.id, turnId: turn.result.turnId });
  assert.deepEqual(h.repository.getProject(h.p.id), before); assert.deepEqual(h.repository.getHistory(h.p.id), history);
  assert.ok(claim(h).result.turnId); assert.equal('summaryTurn' in before, false); assert.equal('summary_turn' in before, false);
});
test('missing turn identity never authorizes a summary completion', t => {
  const h = fixture(t);
  assert.equal(h.service.commands.completeSummary({ id: h.p.id, expectedRevision: h.p.revision, summary: 'Unauthorized', actor: agent }).result.applied, false);
  assert.equal(h.service.views.project({ id: h.p.id }).summary, 'Original');
});
function threadFor(h) {
  return createProjectThread({ store: h.store, engine: { agents: () => [{ id: 'main', name: 'Fixture Agent' }], primaryAgent: () => ({ id: 'main' }) },
    runtime: { commands: { agentTurn() { throw Error('fixture must not dispatch'); } } }, topics: { invalidateIds() {} }, cfg: {}, now: () => AT });
}
test('summary lock and queued delivery roll back together when insertion fails', t => {
  const h = fixture(t), thread = threadFor(h); thread.attach({ service: h.service, repository: h.repository });
  const create = h.store.comments.create;
  h.store.comments.create = () => { throw Error('fixture insert failure'); };
  assert.throws(() => thread.startSummary({ id: h.p.id, expectedRevision: h.p.revision }, 'main', { kind: 'human' }), /fixture insert failure/);
  h.store.comments.create = create; thread.close();
  h.restart(); assert.equal(h.store.comments.active().length, 0); assert.ok(claim(h).result.turnId);
});
test('successful acceptance atomically stores the same id on project and queued delivery before dispatch', t => {
  const h = fixture(t), thread = threadFor(h); thread.attach({ service: h.service, repository: h.repository }); thread.close();
  const turn = thread.startSummary({ id: h.p.id, expectedRevision: h.p.revision }, 'main', { kind: 'human' });
  h.restart(); assert.throws(() => claim(h), pending);
  assert.equal(h.store.comments.active()[0].delivery[0].follow.summary.turnId, turn.result.turnId);
  assert.equal(h.repository.getSummaryTurn(h.p.id), turn.result.turnId);
});

test('pre-016 active retry with a null id is adopted durably without dispatch', t => {
  const h = fixture(t);
  const c = h.store.comments.create({ projectId: h.p.id, kind: 'event', author: { kind: 'person', id: h.store.owner.id, name: 'Fixture Owner' }, body: 'summary-requested',
    delivery: [{ agentId: 'main', status: 'working', follow: { phase: 'tracking', summary: { turnId: null, originalSummary: 'Original', lastSummary: null } } }], at: AT });
  const thread = threadFor(h); thread.close(); thread.attach({ service: h.service, repository: h.repository });
  h.restart(); assert.throws(() => claim(h), pending);
  assert.equal(h.repository.getSummaryTurn(h.p.id), h.store.comments.get(c.id).delivery[0].follow.summary.turnId);
});
test('completion and release participate in an outer transaction rollback', t => {
  const h = fixture(t), turn = claim(h), { withTx } = require('../../src/store/db');
  const before = h.repository.getProject(h.p.id), history = h.repository.getHistory(h.p.id);
  assert.throws(() => withTx(h.store.db, () => { complete(h, turn); throw Error('fixture delivery update failure'); }), /fixture delivery update failure/);
  h.restart(); assert.deepEqual(h.repository.getProject(h.p.id), before); assert.deepEqual(h.repository.getHistory(h.p.id), history);
  assert.throws(() => claim(h), pending); assert.equal(complete(h, turn).vm.summary, 'Generated');
});
test('memory repository shares the same turn identity and cancellation contract between services', () => {
  const { repository } = require('./helpers');
  const repo = repository(), a = createProjectService({ repository: repo, clock: () => AT }), b = createProjectService({ repository: repo, clock: () => AT });
  const p = a.commands.create({ name: 'Memory Fixture', summary: 'Original' }).vm;
  const turn = a.commands.regenerateSummary({ id: p.id, expectedRevision: p.revision });
  assert.throws(() => b.commands.regenerateSummary({ id: p.id, expectedRevision: p.revision }), pending);
  const done = b.commands.completeSummary({ id: p.id, turnId: turn.result.turnId, expectedRevision: p.revision, summary: 'Generated', actor: agent });
  assert.equal(done.vm.summary, 'Generated'); assert.equal(repo.getSummaryTurn(p.id), null);
  assert.equal(a.commands.completeSummary({ id: p.id, turnId: turn.result.turnId, expectedRevision: done.revision, summary: 'Repeated', actor: agent }).result.applied, false);
});
