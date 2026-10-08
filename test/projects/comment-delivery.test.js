'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const express = require('express');
const { openStore } = require('../../src/store');
const { createProjectsRepository } = require('../../src/store/repos/projects');
const { createProjectService } = require('../../src/projects');
const { engineRegistry } = require('../../src/api/v2/projects');
const { createProjectThread } = require('../../src/api/v2/comments');
const { normaliseTranscript } = require('../../src/adapters/openclaw/normalise/transcript');
const { projectHintsOf } = require('../../src/adapters/openclaw/project-hint');
const { errorMiddleware, ApiError } = require('../../src/api/v2/errors');
const { waitFor } = require('../helpers/harness');
const { validate } = require('../../src/schema');
const { VM_SCHEMAS } = require('../../src/api/v2/vm/schemas');
const fixture = require('./fixtures/comments/deferred.json');
const KEY = 'agent:main:ao-projet-bulletin', CHILD = 'agent:main:subagent:child-1';
const BASE = 1791400000000;
const messages = (name) => structuredClone(fixture[name]).map((m) => ({ ...m, timestamp: BASE + m.timestamp }));

async function setup(t, { grace = 10000, readonly = false } = {}) {
  let clock = BASE, offline = false, turns = [], raw = new Map(), transcripts = new Map(), hints = new Map();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-delivery-'));
  let store = openStore({ dir: tmp, instance: 'test', ownerName: 'Camille', now: () => clock, log: () => {} });
  store.persons.ensureAgent('main', 'Orion');
  const repository = createProjectsRepository(store.db, { ownerPersonId: store.owner.id, primaryAgentId: () => 'main', githubOwners: [] });
  const sessions = [KEY, CHILD, 'linked-old', 'linked-new'].map((key, i) => ({ key, group: key === KEY ? null : 'projet:bulletin',
    updatedAt: BASE + i, class: { kind: key === CHILD ? 'subagent' : 'conversation-direct', agentId: 'main', channel: null, interlocutorId: null }, usage: { total: 0 } }));
  const engine = {
    agents: () => [{ id: 'main', name: 'Orion' }], primaryAgent: () => ({ id: 'main', name: 'Orion' }),
    sessions: () => sessions, session: (key) => sessions.find((s) => s.key === key), transcript: (key) => transcripts.get(key),
    cronJobs: () => [], cronRuns: () => null, projectHints: () => [...hints.values()].flat(),
    async request(op, key) {
      assert.equal(op, 'transcript');
      if (offline) return { ok: false, category: 'offline' };
      const tr = normaliseTranscript(key, { messages: raw.get(key) || [] }, clock, Infinity);
      transcripts.set(key, tr); hints.set(key, projectHintsOf(tr).map((h) => ({ ...h, sessionKey: key })));
      return { ok: true, value: tr };
    },
  };
  let service = createProjectService({ repository, engineRegistry: engineRegistry(engine), primaryAgentId: () => 'main', clock: () => clock });
  const p = service.commands.create({ name: 'Bulletin', summary: 'Résumé initial', status: 'in-progress', priority: 'P5', actor: { kind: 'human', personId: store.owner.id },
    sources: [{ kind: 'sessionGroup', ref: { by: 'group', groupId: 'projet:bulletin', name: 'bulletin' } }] }).vm;
  const cfg = { instanceLocale: 'fr', readonly };
  const topics = { define() {}, invalidateIds() {} };
  let onTurn = () => { raw.set(KEY, messages('initial')); return { text: '' }; };
  const runtime = { commands: { agentTurn: async (args) => { turns.push(args); return onTurn(args); } } };
  const makeThread = () => {
    const thread = createProjectThread({ store, engine, runtime, topics, cfg, now: () => clock, pollMs: 5, relayGraceMs: grace });
    thread.attach({ service, repository }); return thread;
  };
  let thread = makeThread(), server;
  function mount() {
    const app = express(); app.use(express.json());
    thread.mount(app, { authed: (req, res, next) => next(), guard: () => (req, res, next) => readonly ? next(new ApiError('readonly')) : next(), ok: (res, data) => res.json(data) });
    app.use(errorMiddleware()); server = app.listen(0, '127.0.0.1');
    return new Promise((r) => server.once('listening', r));
  }
  await mount();
  const request = async (method, tail, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/projects/${p.id}/comments${tail}`, {
      method, headers: { 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  t.after(async () => { thread.close(); await thread.idle(); await new Promise((r) => server.close(r)); store.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  return { p, raw, turns, engine, repository,
    get store() { return store; }, get thread() { return thread; }, get service() { return service; },
    setClock: (v) => { clock = v; }, setOffline: (v) => { offline = v; }, setTurn: (fn) => { onTurn = fn; }, request,
    async restart() {
      thread.close(); await thread.idle(); await new Promise((r) => server.close(r)); store.close();
      store = openStore({ dir: tmp, instance: 'test', ownerName: 'Camille', now: () => clock, log: () => {} });
      // Repository statements belong to the reopened SQLite connection.
      const reopened = createProjectsRepository(store.db, { ownerPersonId: store.owner.id, primaryAgentId: () => 'main', githubOwners: [] });
      service = createProjectService({ repository: reopened, engineRegistry: engineRegistry(engine), primaryAgentId: () => 'main', clock: () => clock });
      thread = createProjectThread({ store, engine, runtime, topics, cfg, now: () => clock, pollMs: 5, relayGraceMs: grace });
      thread.attach({ service, repository: reopened }); await mount();
    },
  };
}
const state = (h, id) => h.store.comments.get(id).delivery[0];
const replies = (h, id) => h.store.comments.page(h.p.id).filter((c) => c.replyTo === id).reverse().map((c) => c.body);
const create = async (h) => { const r = await h.request('POST', '', { body: '@main prépare la V2.' }); assert.equal(r.status, 201); return r.body.result.comment.id; };

it('spawn + yield: working; posts every later assistant, consumes child tags, no duplicate child relay', async (t) => {
  const h = await setup(t), id = await create(h);
  await waitFor(() => state(h, id).status === 'working' && replies(h, id).length === 1);
  assert.equal(state(h, id).reason, null);
  h.raw.set(CHILD, messages('child')); h.raw.set(KEY, [...messages('initial'), ...messages('completion'), ...messages('relay')]);
  h.setClock(BASE + 100);
  await waitFor(() => state(h, id).follow.phase === 'settled');
  assert.equal(state(h, id).status, 'replied');
  assert.deepEqual(replies(h, id), ['Je prépare la nouvelle version.', 'Je vérifie le calendrier proposé.', 'Voici la V2 à relire : marges, équipes et préparation des Fêtes. Le document est prêt.']);
  const vm = h.thread.threadVM(h.p.id);
  assert.ok(validate(VM_SCHEMAS.comments, vm).ok);
  assert.deepEqual(vm.items.filter((x) => x.kind === 'system').map((x) => x.text.key).sort(), ['historyKind.priority', 'historyKind.status']);
  assert.equal(h.repository.getProject(h.p.id).status, 'in-review');
  assert.equal(h.repository.getProject(h.p.id).priority, 'P2');
});

it('pending session follows across a real store reopen; cursor survives without rerunning the CLI or duplicating replies', async (t) => {
  const h = await setup(t), id = await create(h);
  await waitFor(() => replies(h, id).length === 1);
  await h.restart();
  h.setClock(BASE + 100); h.raw.set(CHILD, messages('child'));
  h.raw.set(KEY, [...messages('initial'), ...messages('completion'), ...messages('relay')]);
  await waitFor(() => state(h, id).follow.phase === 'settled');
  assert.equal(h.turns.length, 1);
  assert.equal(replies(h, id).length, 3);
  await h.restart();
  assert.equal(replies(h, id).length, 3);
});

it('child final is posted when the parent never relays; late parent messages are still followed', async (t) => {
  const h = await setup(t, { grace: 20 }), id = await create(h);
  await waitFor(() => replies(h, id).length === 1);
  h.raw.set(CHILD, messages('child')); h.raw.set(KEY, [...messages('initial'), ...messages('completion')]); h.setClock(BASE + 100);
  await waitFor(() => Object.values(state(h, id).follow.children).some((c) => c.done));
  h.setClock(BASE + 150);
  await waitFor(() => replies(h, id).length === 2);
  assert.match(replies(h, id)[1], /^Plan final du sous-agent/);
  await h.restart();
  h.raw.set(KEY, [...messages('initial'), ...messages('completion'), ...messages('relay')]);
  await waitFor(() => state(h, id).follow.phase === 'settled');
  assert.equal(replies(h, id).filter((x) => x.startsWith('Plan final du sous-agent')).length, 1);
  assert.equal(replies(h, id).length, 4);
});

it('summary request also survives yield and restart, updates from the final answer despite tag revision changes', async (t) => {
  const h = await setup(t);
  const accepted = h.service.commands.regenerateSummary({ id: h.p.id, expectedRevision: h.p.revision });
  const c = h.thread.requestSummary(h.p.id, 'main', { kind: 'human' }, { turnId: accepted.result.turnId });
  await waitFor(() => state(h, c.id).status === 'working' && replies(h, c.id).length === 1);
  assert.equal(h.repository.getProject(h.p.id).summary, 'Résumé initial');
  await h.restart();
  assert.equal(h.thread.hasPendingSummary(h.p.id), true);
  h.setClock(BASE + 100); h.raw.set(CHILD, messages('child'));
  h.raw.set(KEY, [...messages('initial'), ...messages('completion'), ...messages('relay')]);
  await waitFor(() => state(h, c.id).follow.phase === 'settled');
  assert.equal(h.service.views.project({ id: h.p.id }).summary, replies(h, c.id).at(-1));
  assert.equal(h.thread.hasPendingSummary(h.p.id), false);
});

it('two-hour deadline, gateway failures, retry no-reply and legacy empty, duplicate/foreign/deleted retry refusals', async (t) => {
  const h = await setup(t), id = await create(h);
  await waitFor(() => replies(h, id).length === 1);
  h.setOffline(true); h.setClock(BASE + 7200001);
  await waitFor(() => state(h, id).status === 'no-reply');
  assert.equal(state(h, id).reason, 'timeout');
  await waitFor(() => h.thread.idle());
  h.setOffline(false); h.setTurn(() => ({ text: 'Réponse après nouvelle tentative.' }));
  const retry = await h.request('POST', '/' + id + '/retry', { agentId: 'main' });
  assert.equal(retry.status, 202);
  await waitFor(() => state(h, id).follow.phase === 'settled');
  assert.equal((await h.request('POST', '/' + id + '/retry', { agentId: 'main' })).status, 400);
  const legacy = h.store.comments.create({ projectId: h.p.id, author: { kind: 'person', id: h.store.owner.id, name: 'Camille' }, body: '@main ancienne demande',
    mentions: ['main'], delivery: [{ agentId: 'main', status: 'failed', reason: 'empty' }], at: BASE });
  assert.equal((await h.request('POST', '/' + legacy.id + '/retry', { agentId: 'main', extra: 1 })).status, 400);
  assert.equal((await h.request('POST', '/' + legacy.id + '/retry', { agentId: 'scout' })).status, 400);
  assert.equal((await h.request('POST', '/' + legacy.id + '/retry', { agentId: 'main' })).status, 202);
  await waitFor(() => state(h, legacy.id).follow.phase === 'settled');
  h.store.comments.remove(legacy.id);
  assert.equal((await h.request('POST', '/' + legacy.id + '/retry', { agentId: 'main' })).status, 400);
  assert.equal((await h.request('POST', '/cmt_unknown/retry', { agentId: 'main' })).status, 404);
});

it('prompt contains actual linked requests, people, dates and child final texts, newest first, bounded context', async (t) => {
  const h = await setup(t);
  h.raw.set('linked-new', [{ role: 'user', timestamp: BASE - 1, senderName: 'Nadia', content: 'Prépare le calendrier récent.' },
    { role: 'assistant', timestamp: BASE, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'spawn', name: 'sessions_spawn', arguments: {} }] },
    { role: 'toolResult', timestamp: BASE, toolCallId: 'spawn', content: JSON.stringify({ childSessionKey: CHILD }) }]);
  h.raw.set('linked-old', [{ role: 'user', timestamp: BASE - 1000, senderName: 'Luc', content: 'Prépare le premier plan.' },
    { role: 'assistant', timestamp: BASE - 500, stopReason: 'stop', content: 'Ancien plan : outil et trois sujets.' }]);
  h.raw.set(CHILD, [...messages('child').slice(0, -1), { role: 'assistant', timestamp: BASE, stopReason: 'stop', content: 'Plan concret du sous-agent : Brevo, 3 numéros. ' + 'x'.repeat(2500) }]);
  for (let i = 0; i < 12; i++) {
    const key = 'linked-extra-' + i;
    h.engine.sessions().push({ key, group: 'projet:bulletin', updatedAt: BASE - 100 - i, class: { kind: 'conversation-direct', agentId: 'main' } });
    h.raw.set(key, [{ role: 'user', timestamp: BASE - 100, content: 'Demande complémentaire' },
      { role: 'assistant', timestamp: BASE - 50, stopReason: 'stop', content: 'Résultat complémentaire : ' + 'z'.repeat(2000) }]);
  }
  h.setTurn(() => ({ text: 'Bien reçu.' }));
  const id = await create(h); await waitFor(() => state(h, id).follow.phase === 'settled');
  const prompt = h.turns[0].text;
  assert.match(prompt, /Bulletin.*\nStatut : En cours · priorité : P5\nRésumé : Résumé initial/);
  assert.match(prompt, /Nadia/); assert.match(prompt, /2026-/); assert.match(prompt, /Prépare le calendrier récent/);
  assert.match(prompt, /Plan concret du sous-agent : Brevo, 3 numéros/); assert.match(prompt, /agent:main:subagent:child-1/);
  assert.match(prompt, /Ancien plan : outil et trois sujets/);
  assert.ok(prompt.indexOf('Session : linked-new') < prompt.indexOf('Session : linked-old'));
  const context = prompt.split('Conversations liées : ')[1].split('\nDerniers commentaires')[0];
  assert.ok(context.length <= 8000 && context.length >= 7500);
  assert.ok(!prompt.includes('x'.repeat(1501)));
});

it('completion event provides the final result even when the child transcript is unavailable', async (t) => {
  const h = await setup(t, { grace: 0 }), id = await create(h);
  await waitFor(() => replies(h, id).length === 1);
  h.setClock(BASE + 100); h.raw.set(KEY, [...messages('initial'), ...messages('completion')]);
  await waitFor(() => replies(h, id).length === 2);
  assert.match(replies(h, id)[1], /^Plan final du sous-agent/);
  await h.restart();
  h.raw.set(CHILD, messages('child'));
  await waitFor(() => Object.values(state(h, id).follow.children).every((c) => c.done && c.posted));
  assert.equal(replies(h, id).length, 2, 'late child availability does not duplicate the event fallback');
});

it('manual summary edits win over the delayed summary, while its final message is still posted', async (t) => {
  const h = await setup(t);
  const accepted = h.service.commands.regenerateSummary({ id: h.p.id, expectedRevision: h.p.revision });
  const c = h.thread.requestSummary(h.p.id, 'main', { kind: 'human' }, { turnId: accepted.result.turnId });
  await waitFor(() => replies(h, c.id).length === 1);
  const p = h.repository.getProject(h.p.id);
  h.service.commands.edit({ id: p.id, expectedRevision: p.revision, summary: 'Résumé corrigé par Camille', actor: { kind: 'human', personId: h.store.owner.id } });
  h.setClock(BASE + 100); h.raw.set(CHILD, messages('child'));
  h.raw.set(KEY, [...messages('initial'), ...messages('completion'), ...messages('relay')]);
  await waitFor(() => state(h, c.id).follow.phase === 'settled');
  assert.equal(h.repository.getProject(h.p.id).summary, 'Résumé corrigé par Camille');
  assert.equal(replies(h, c.id).length, 3);
});

it('a late tool output is still inspected after its tool-call index has already been consumed', async (t) => {
  const h = await setup(t), id = await create(h);
  await waitFor(() => replies(h, id).length === 1);
  // First poll sees a call whose output was not recorded yet. Next poll updates that same canonical event.
  const initial = messages('initial'); initial[2].content = '';
  h.raw.set(KEY, initial);
  await waitFor(() => state(h, id).follow.cursor === 5);
  // Simulate restart with no child keys retained, as if the result was initially absent.
  const d = state(h, id); d.follow.children = {};
  h.store.comments.setDelivery(id, [d]);
  await h.restart();
  h.raw.set(KEY, messages('initial'));
  await waitFor(() => Object.keys(state(h, id).follow.children).includes(CHILD));
  assert.equal(h.turns.length, 1);
});

it('retry respects read-only mode and original authorship', async (t) => {
  const h = await setup(t, { readonly: true });
  const c = h.store.comments.create({ projectId: h.p.id, author: { kind: 'person', id: h.store.owner.id, name: 'Camille' }, body: 'Ancienne demande',
    delivery: [{ agentId: 'main', status: 'failed', reason: 'empty' }] });
  assert.equal((await h.request('POST', '/' + c.id + '/retry', { agentId: 'main' })).status, 403);
  assert.equal(h.turns.length, 0);
  const writable = await setup(t);
  const other = writable.store.comments.create({ projectId: writable.p.id, author: { kind: 'agent', id: 'main', name: 'Orion' }, body: 'Demande agent',
    delivery: [{ agentId: 'main', status: 'failed', reason: 'empty' }] });
  assert.equal((await writable.request('POST', '/' + other.id + '/retry', { agentId: 'main' })).status, 403);
});

it('an ordinary empty answer without spawn/yield remains a retryable failed delivery', async (t) => {
  const h = await setup(t);
  h.setTurn(() => { h.raw.set(KEY, [{ role: 'user', timestamp: BASE, content: 'Demande sans réponse' }]); return { text: '' }; });
  const id = await create(h);
  await waitFor(() => state(h, id).status === 'failed');
  assert.equal(state(h, id).reason, 'empty');
});

it('two queued requests stay in order and exclude the previous delivery’s messages and spawns', async (t) => {
  const h = await setup(t), first = await create(h);
  await waitFor(() => replies(h, first).length === 1);
  const second = await create(h);
  assert.equal(h.turns.length, 1);
  h.setTurn(() => {
    h.raw.set(KEY, [...h.raw.get(KEY), { role: 'user', timestamp: BASE + 101, content: 'Deuxième demande' },
      { role: 'assistant', timestamp: BASE + 102, stopReason: 'stop', content: 'Réponse à la deuxième demande.' }]);
    return { text: 'Réponse à la deuxième demande.' };
  });
  h.setClock(BASE + 100); h.raw.set(CHILD, messages('child'));
  h.raw.set(KEY, [...messages('initial'), ...messages('completion'), ...messages('relay')]);
  await waitFor(() => state(h, second).follow.phase === 'settled');
  assert.equal(h.turns.length, 2);
  assert.deepEqual(replies(h, second), ['Réponse à la deuxième demande.']);
  assert.deepEqual(state(h, second).follow.children, {});
});

it('display-name mention inside a reply keeps every spawn/yield follow-up under that exact reply', async (t) => {
  const h = await setup(t);
  const root = (await h.request('POST', '', { body: 'Plan original à revoir.' })).body.result.comment;
  const nested = await h.request('POST', '', { body: '@Orion @MAIN prépare la V2.', replyTo: root.id });
  assert.equal(nested.status, 201);
  const c = nested.body.result.comment;
  assert.equal(c.replyTo, root.id);
  assert.deepEqual(c.mentions, [{ id: 'main', name: 'Orion' }]);
  await waitFor(() => replies(h, c.id).length === 1);
  h.raw.set(CHILD, messages('child')); h.setClock(BASE + 100);
  h.raw.set(KEY, [...messages('initial'), ...messages('completion'), ...messages('relay')]);
  await waitFor(() => state(h, c.id).follow.phase === 'settled');
  assert.equal(h.turns.length, 1, 'id and display-name aliases deduplicate');
  assert.equal(replies(h, c.id).length, 3);
  assert.deepEqual(h.store.comments.page(h.p.id).filter((x) => x.replyTo === root.id).map((x) => x.id), [c.id]);
  assert.equal(h.store.comments.get(c.id).replyTo, root.id);
});

it('mention ids and display names ignore case and accents, including decomposed Unicode', async (t) => {
  const h = await setup(t);
  h.engine.agents = () => [{ id: 'main', name: 'Orion' }, { id: 'éclaireur', name: 'Éloïse' }];
  for (const token of ['@main', '@Orion', '@orion', '@ORION']) assert.deepEqual(h.thread.mentionsOf(token), ['main']);
  for (const token of ['@ÉLOÏSE', '@eloise', '@E\u0301loi\u0308se', '@ÉCLAIREUR', '@eclaireur']) assert.deepEqual(h.thread.mentionsOf(token), ['éclaireur']);
  assert.deepEqual(h.thread.mentionsOf('@main @Orion @oRiOn'), ['main']);
});
