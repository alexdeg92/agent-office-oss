'use strict';
// architect-57 (B, C) · a project's comment thread through the real server (fake gateway, fake openclaw CLI):
// comments, @agent mentions delivered as a turn in the project's own session (never a channel), the reply posted back,
// the agent's status change as a system line, « Demander un résumé » in the thread, edit/delete, read-only, audit.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { loadScenario, gatewayHandlers, readFixture } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');
const { VM_SCHEMAS } = require('../../src/api/v2/vm/schemas');
const sch = require('../../src/schema');
const { compareExample, loadExample } = require('../helpers/contract-shape');

const sc = loadScenario('synthetic-basic');
const neutralAgents = readFixture(sc.rpc['agents.list'], sc.fixturesDir).body.value;
neutralAgents.agents.find((a) => a.id === 'main').name = 'Orion';
const valid = (vm) => { const r = sch.validate(VM_SCHEMAS.comments, vm); assert.ok(r.ok, JSON.stringify(r.issues || r).slice(0, 400)); };
const audit = (h) => { const db = new DatabaseSync(path.join(h.tmp, 'data', 'agent-office.sqlite'), { readOnly: true, timeout: 5000 }); try { return db.prepare('SELECT command, target, outcome FROM audit_log WHERE command LIKE \'projects.%omment\' ORDER BY id').all().map((r) => ({ ...r })); } finally { db.close(); } };
const turns = (h) => h.cliCalls().filter((a) => a[0] === 'agent');
const { main: tokenCli } = require('../../scripts/agent-token');
const quiet = (fn) => { const w = process.stdout.write; process.stdout.write = () => true; try { return fn(); } finally { process.stdout.write = w; } };
const mint = (h, agent) => { const f = path.join(h.tmp, 'tok-' + agent); quiet(() => tokenCli(['create', '--agent', agent, '--out', f], { AO_ENV: 'test', AO_DATA_DIR: path.join(h.tmp, 'data'), HOME: h.tmp })); return fs.readFileSync(f, 'utf8').trim(); };

describe('project comments · thread, mentions, delivery, summary', () => {
  let h, p;
  const thread = async () => (await h.get(`/api/v2/views/projects/${p.id}/comments`)).json;
  before(async () => {
    h = await startServer(sc, { handlers: { 'agents.list': neutralAgents, 'sessions.get': (p) => /:ao-projet-/.test(p.key) ? { messages: [] } : gatewayHandlers(sc)['sessions.get'](p) } });
    p = (await h.request('POST', '/api/v2/projects', { name: 'Infolettre Été', status: 'in-progress' })).json.data.vm;
  });
  after(async () => { if (h) await h.stop(); });

  it('an empty thread: the agents to mention, the rights, the project session (agent:<primary>:ao-projet-<slug>)', async () => {
    const t = await thread();
    valid(t.data);
    assert.equal(t.meta.topic.id, 'comments:' + p.id);
    assert.deepEqual(t.data.items, []);
    assert.deepEqual(t.data.mentionable.map((a) => [a.id, a.primary]), [['main', true], ['scout', false]]);
    assert.equal(t.data.canComment, true); assert.equal(t.data.canMention, true);
    assert.deepEqual(t.data.session, { key: 'agent:main:ao-projet-infolettre-ete', route: '/journaux/' + encodeURIComponent('agent:main:ao-projet-infolettre-ete') });
  });

  it('a comment without a mention: stored, no turn; a mention of @scout is delivered in scout\'s project session and the reply comes back', async () => {
    const plain = await h.request('POST', `/api/v2/projects/${p.id}/comments`, { body: 'Premier jet prêt.' });
    assert.equal(plain.status, 201, plain.text);
    assert.deepEqual(plain.json.data.result.comment.mentions, []);
    assert.equal(turns(h).length, 0);
    const r = await h.request('POST', `/api/v2/projects/${p.id}/comments`, { body: '@scout peux-tu relire le calendrier ?' });
    assert.equal(r.status, 201);
    const c = r.json.data.result.comment;
    assert.deepEqual(c.mentions, [{ id: 'scout', name: 'Scout' }]);
    assert.deepEqual(c.delivery, [{ agentId: 'scout', status: 'pending', reason: null }]);
    assert.equal(c.author.kind, 'human'); assert.equal(c.editable, true);
    const t = await waitFor(async () => { const x = (await thread()).data; return x.items.some((i) => i.replyTo === c.id) && x.items.find((i) => i.id === c.id)?.delivery[0]?.status === 'replied' && x; }, { what: 'the agent reply' });
    valid(t);
    const reply = t.items.find((i) => i.replyTo === c.id);
    assert.equal(reply.kind, 'comment'); assert.equal(reply.author.kind, 'agent'); assert.equal(reply.author.name, 'Scout');
    assert.equal(reply.body, 'Réponse factice.'); assert.equal(reply.editable, false);
    assert.deepEqual(t.items.find((i) => i.id === c.id).delivery, [{ agentId: 'scout', status: 'replied', reason: null }]);
    assert.deepEqual(t.items.map((i) => i.body), ['Premier jet prêt.', '@scout peux-tu relire le calendrier ?', 'Réponse factice.']);
    // the turn: scout, its project session, never a channel; the prompt carries the project context and the comment
    const argv = turns(h)[0];
    assert.deepEqual(argv.filter((a) => !a.startsWith('--message=')), ['agent', '--agent=scout', '--json', '--timeout=150', '--channel=webchat', '--reply-channel=webchat', '--session-key=agent:scout:ao-projet-infolettre-ete']);
    assert.ok(argv.includes('--channel=webchat')); assert.ok(argv.includes('--reply-channel=webchat'));
    assert.ok(!argv.some((a) => /^--(deliver|reply-to|to)\b/.test(a)));
    const msg = argv.find((a) => a.startsWith('--message=')).slice(10);
    assert.match(msg, /projet « Infolettre Été » \(tag : infolettre-ete\)/);
    assert.match(msg, /Statut : En cours/);
    assert.match(msg, /- .+ : Premier jet prêt\./, 'the recent comments');
    assert.match(msg, /Nouveau commentaire de .+ qui te mentionne :\n@scout peux-tu relire le calendrier \?/);
    assert.match(msg, /jamais sur un canal/);
  });

  it('@Orion resolves by display name to main and its answer replies to the mentioning comment', async () => {
    const r = await h.request('POST', `/api/v2/projects/${p.id}/comments`, { body: '@Orion peux-tu confirmer ?' });
    assert.equal(r.status, 201, r.text);
    const c = r.json.data.result.comment;
    assert.deepEqual(c.mentions, [{ id: 'main', name: 'Orion' }]);
    const t = await waitFor(async () => { const vm = (await thread()).data; return vm.items.find((i) => i.id === c.id)?.delivery[0]?.status === 'replied' && vm; });
    assert.deepEqual(t.items.filter((i) => i.replyTo === c.id).map((i) => [i.author.id, i.body]), [['main', 'Réponse factice.']]);
  });

  it('a case-insensitive @ inside a reply keeps the chain; missing/cross-project/deleted parents are refused', async () => {
    const root = (await h.request('POST', `/api/v2/projects/${p.id}/comments`, { body: 'La première proposition.' })).json.data.result.comment;
    const r = await h.request('POST', `/api/v3/projects/${p.id}/comments`, { body: '@oRiOn peux-tu adapter cette proposition ?', replyTo: root.id });
    assert.equal(r.status, 201, r.text);
    const c = r.json.data.result.comment;
    assert.equal(c.replyTo, root.id);
    assert.deepEqual(c.mentions, [{ id: 'main', name: 'Orion' }]);
    const vm = await waitFor(async () => { const x = (await thread()).data; return x.items.find((i) => i.id === c.id)?.delivery[0]?.status === 'replied' && x; });
    const reply = vm.items.find((i) => i.replyTo === c.id);
    assert.equal(reply.author.id, 'main');
    assert.equal(vm.items.find((i) => i.id === reply.replyTo).replyTo, root.id);
    assert.equal(vm.items.filter((i) => i.replyTo === root.id).length, 1, 'agent replies to the mention, not its ancestor');
    const post = (replyTo) => h.request('POST', `/api/v2/projects/${p.id}/comments`, { body: '@main suite', replyTo });
    assert.equal((await post(42)).status, 400);
    assert.equal((await post('cmt_missing')).status, 404);
    const other = (await h.request('POST', '/api/v2/projects', { name: 'Autre fil' })).json.data.vm;
    assert.equal((await h.request('POST', `/api/v2/projects/${other.id}/comments`, { body: '@main suite', replyTo: root.id })).status, 404);
    await h.request('DELETE', `/api/v2/projects/${p.id}/comments/${root.id}`);
    assert.equal((await post(root.id)).status, 400);
  });

  it('edit (own only, no re-delivery) and soft delete; a deleted comment keeps its place without its body', async () => {
    const before = turns(h).length;
    const t = (await thread()).data;
    const mine = t.items.find((i) => i.body === 'Premier jet prêt.');
    const e = await h.request('PATCH', `/api/v2/projects/${p.id}/comments/${mine.id}`, { body: 'Premier jet prêt (v2). @main' });
    assert.equal(e.status, 200, e.text);
    assert.equal(e.json.data.result.comment.body, 'Premier jet prêt (v2). @main');
    assert.ok(e.json.data.result.comment.editedAt != null);
    assert.deepEqual(e.json.data.result.comment.mentions, [], 'an edit never adds a delivery');
    const agentReply = t.items.find((i) => i.author.kind === 'agent');
    assert.equal((await h.request('PATCH', `/api/v2/projects/${p.id}/comments/${agentReply.id}`, { body: 'x' })).status, 403);
    assert.equal((await h.request('PATCH', `/api/v2/projects/${p.id}/comments/${mine.id}`, { body: '' })).status, 400);
    assert.equal((await h.request('PATCH', `/api/v2/projects/${p.id}/comments/${mine.id}`, { body: 'x', mentions: [] })).status, 400);
    assert.equal((await h.request('POST', `/api/v2/projects/${p.id}/comments`, { body: 'x'.repeat(4001) })).status, 400);
    assert.equal((await h.request('PATCH', `/api/v2/projects/prj_nope/comments/${mine.id}`, { body: 'x' })).status, 404);
    const d = await h.request('DELETE', `/api/v2/projects/${p.id}/comments/${mine.id}`);
    assert.equal(d.status, 200);
    const after = (await thread()).data.items.find((i) => i.id === mine.id);
    assert.deepEqual([after.deleted, after.body, after.editable, after.deletable], [true, null, false, false]);
    assert.equal((await h.request('DELETE', `/api/v2/projects/${p.id}/comments/${mine.id}`)).status, 400);
    assert.equal(turns(h).length, before);
  });

  it('the agent\'s status change shows as a system line; a person\'s does not', async () => {
    const cur = (await h.get(`/api/v2/views/projects/${p.id}`)).json.data;
    await h.request('PUT', `/api/v2/projects/${p.id}/status`, { expectedRevision: cur.revision, status: 'todo' });
    assert.ok(!(await thread()).data.items.some((i) => i.kind === 'system'), 'a person\'s move is no system line');
    // the agent moves it (as the tag does: the agent is the actor), here through its token
    const token = mint(h, 'main');
    const x = (await h.get(`/api/v2/views/projects/${p.id}`)).json.data;
    const m = await fetch(h.base + `/api/v2/projects/${p.id}/status`, { method: 'PUT', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: x.revision, status: 'in-review' }) });
    assert.equal(m.status, 200);
    const t = await waitFor(async () => { const v = (await thread()).data; return v.items.some((i) => i.kind === 'system') && v; }, { what: 'the system line' });
    valid(t);
    const sys = t.items.filter((i) => i.kind === 'system');
    assert.equal(sys.length, 1);
    assert.equal(sys[0].author.kind, 'agent');
    assert.equal(sys[0].text.key, 'historyKind.status');
    assert.equal(sys[0].text.params.to.key, 'projectStatus.in-review');
    assert.ok(sys[0].at >= t.items.find((i) => i.kind === 'comment').at, 'in time order');
  });

  it('« Demander un résumé »: an event line, the turn in the project session (after the comment turns), the reply as the summary and in the thread', async () => {
    const cur = (await h.get(`/api/v2/views/projects/${p.id}`)).json.data;
    const r = await h.request('POST', `/api/v2/projects/${p.id}/summary/regenerate`, { expectedRevision: cur.revision });
    assert.equal(r.status, 202, r.text);
    await waitFor(async () => (await h.get(`/api/v2/views/projects/${p.id}`)).json.data.summary === 'Réponse factice.', { what: 'the summary' });
    const t = (await thread()).data;
    valid(t);
    const ev = t.items.find((i) => i.kind === 'event');
    assert.equal(ev.text.key, 'projectThread.event.summary-requested');
    assert.equal(typeof ev.text.params.actor, 'string');
    const reply = t.items.find((i) => i.replyTo === ev.id);
    assert.deepEqual([reply.kind, reply.author.kind, reply.author.id], ['comment', 'agent', 'main']);
    assert.equal(reply.body, 'Réponse factice.');
    const argv = turns(h).pop();
    assert.ok(argv.includes('--session-key=agent:main:ao-projet-infolettre-ete'), argv.join(' '));
    assert.match(argv.find((a) => a.startsWith('--message=')), /Derniers commentaires du fil :[\s\S]*Rédige en français un résumé/);
  });

  it('the thread matches comment-thread-vm.json (every item kind present), and the example passes the server schema', async () => {
    const t = await thread();
    assert.deepEqual([...new Set(t.data.items.map((i) => i.kind))].sort(), ['comment', 'event', 'system']);
    assert.deepEqual(compareExample('comment-thread-vm', t, { envelope: true }), []);
    valid(loadExample('comment-thread-vm').data);
  });

  it('every thread write is audited with the project id; another project\'s comment id is 404', async () => {
    const other = (await h.request('POST', '/api/v2/projects', { name: 'Autre' })).json.data.vm;
    const t = (await thread()).data;
    assert.equal((await h.request('DELETE', `/api/v2/projects/${other.id}/comments/${t.items[1].id}`)).status, 404);
    const rows = audit(h);
    assert.deepEqual([...new Set(rows.map((r) => r.command))].sort(), ['projects.comment', 'projects.deleteComment', 'projects.editComment']);
    assert.ok(rows.filter((r) => r.outcome === 'ok').every((r) => r.target === p.id));
  });
  it('legacy empty delivery retries on v3, is audited, and exposes only the public delivery state', async () => {
    const db = new DatabaseSync(path.join(h.tmp, 'data', 'agent-office.sqlite'), { timeout: 5000 });
    let id;
    try {
      const { createCommentsRepo } = require('../../src/store/repos/comments');
      const owner = db.prepare('SELECT id, name FROM persons WHERE is_owner = 1').get();
      id = createCommentsRepo(db).create({ projectId: p.id, author: { kind: 'person', id: owner.id, name: owner.name }, body: '@main ancienne demande',
        mentions: ['main'], delivery: [{ agentId: 'main', status: 'failed', reason: 'empty' }] }).id;
    } finally { db.close(); }
    const r = await h.request('POST', `/api/v3/projects/${p.id}/comments/${id}/retry`, { agentId: 'main' });
    assert.equal(r.status, 202, r.text);
    assert.deepEqual(r.json.data.result.comment.delivery, [{ agentId: 'main', status: 'pending', reason: null }]);
    await waitFor(async () => (await thread()).data.items.find((i) => i.id === id)?.delivery[0]?.status === 'replied');
    assert.equal((await h.request('POST', `/api/v2/projects/${p.id}/comments/${id}/retry`, { agentId: 'main' })).status, 400);
    assert.ok(audit(h).some((r) => r.command === 'projects.retryComment' && r.target === p.id && r.outcome === 'ok'));
  });

});

describe('project comments · read-only OpenClaw: a mention is stored but never delivered', () => {
  let h;
  before(async () => { h = await startServer(sc, { readonly: true }); });
  after(async () => { if (h) await h.stop(); });
  it('canMention false; the delivery says unavailable/readonly; no agent turn', async () => {
    const c = await h.request('POST', '/api/v2/projects', { name: 'Lecture' });
    if (c.status !== 200) { assert.equal(c.status, 403); return; }   // a read-only store refuses the project itself
    const id = c.json.data.vm.id;
    assert.equal((await h.get(`/api/v2/views/projects/${id}/comments`)).json.data.canMention, false);
    const r = await h.request('POST', `/api/v2/projects/${id}/comments`, { body: '@main bonjour' });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.data.result.comment.delivery, [{ agentId: 'main', status: 'unavailable', reason: 'readonly' }]);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(turns(h).length, 0);
  });
});
