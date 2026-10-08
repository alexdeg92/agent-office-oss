'use strict';
// S7a: Projets on API v2 through createProjectService over the SQL repository (api.md §3.9, §3.14, §5.4).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { loadScenario, gatewayHandlers } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');
const { openSse } = require('../helpers/sse-client');
const { compareExample } = require('../helpers/contract-shape');

const sc = loadScenario('synthetic-basic');
// pending on projects' builders (they copy RepoVM.image once the 2.3 example has it, projects.md)
const PENDING = new Set(['$.repo.image: missing', '$.error.current.vm.repo.image: missing']);
const shape = (name, v, opts) => compareExample(name, v, opts).filter((m) => !PENDING.has(m) && !PENDING.has(m.replace('$.data', '$')));
const audit = (h) => { const db = new DatabaseSync(path.join(h.tmp, 'data', 'agent-office.sqlite'), { readOnly: true, timeout: 5000 }); try { return db.prepare('SELECT command, target, outcome, detail, actor_json FROM audit_log WHERE command != \'auth.login\' ORDER BY id').all().map((r) => ({ ...r })); } finally { db.close(); } };

describe('Projets v2 · commands, views, 409, audit', () => {
  let h, vm;
  before(async () => { h = await startServer(sc, { handlers: { 'sessions.get': (p) => /:ao-projet-/.test(p.key) ? { messages: [] } : gatewayHandlers(sc)['sessions.get'](p) } }); });
  after(async () => { if (h) await h.stop(); });

  it('create → CommandResult with a ProjectVM matching project-vm.json; board and history match their examples', async () => {
    const r = await h.request('POST', '/api/v2/projects', { name: 'Agent Office', status: 'todo', sources: [{ kind: 'github', ref: { owner: 'alexdeg92', repo: 'agent-office' } }] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json.data).sort(), ['ok', 'result', 'revision', 'vm']);
    vm = r.json.data.vm;
    assert.deepEqual(shape('project-vm', vm), []);
    assert.equal(vm.repo.state, 'pending');
    const board = await h.get('/api/v2/views/projects');
    assert.deepEqual(shape('board-vm', board.json, { envelope: true }), []);
    assert.equal(board.json.meta.topic.id, 'projects');
    assert.deepEqual(shape('history-page', (await h.get(`/api/v2/views/projects/${vm.id}/history`)).json, { envelope: true }), []);
    assert.deepEqual(shape('candidates-vm', (await h.get('/api/v2/views/project-candidates')).json, { envelope: true }), []);
  });

  it('a stale write is 409 with error.current {revision, vm} (error-409-project.json); a body actor is refused', async () => {
    const r = await h.request('PUT', `/api/v2/projects/${vm.id}/status`, { expectedRevision: vm.revision + 5, status: 'in-progress' });
    assert.equal(r.status, 409); assert.equal(r.json.error.current.revision, vm.revision);
    assert.deepEqual(shape('error-409-project', r.json), []);
    const a = await h.request('PUT', `/api/v2/projects/${vm.id}/status`, { expectedRevision: vm.revision, status: 'in-progress', actor: 'timmy' });
    assert.equal(a.status, 400); assert.deepEqual(a.json.error.details, [{ field: 'actor', issue: 'unexpected-field' }]);
    const x = await h.request('PUT', `/api/v2/projects/${vm.id}/status`, { expectedRevision: vm.revision, status: 'in-progress', index: 0 });
    assert.equal(x.status, 400);
    assert.equal((await h.get('/api/v2/views/projects/prj_nope')).status, 404);
  });

  it('a move publishes exactly its topics: `projects` and `project:<id>` get deltas on the stream', async () => {
    const S = openSse(h.base, `/api/v2/stream?topics=projects,project:${vm.id}`, { cookie: h.cookie });
    try {
      const snaps = [await S.next((f) => f.event === 'snapshot' && f.data.topic === 'projects'), await S.next((f) => f.event === 'snapshot' && f.data.topic === 'project:' + vm.id)];
      const r = await h.request('PUT', `/api/v2/projects/${vm.id}/status`, { expectedRevision: vm.revision, status: 'in-progress' });
      assert.equal(r.status, 200); assert.equal(r.json.data.revision, vm.revision + 1); vm = r.json.data.vm;
      for (const s of snaps) {
        const d = await S.next((f) => (f.event === 'delta' || f.event === 'snapshot') && f.data.topic === s.data.topic && f.data.rev === s.data.rev + 1);
        assert.ok(d, s.data.topic);
      }
    } finally { S.close(); }
  });

  it('every write is audited as Owner with the project id', async () => {
    const rows = audit(h);
    assert.deepEqual(rows.map((r) => [r.command, r.outcome]).slice(0, 4),
      [['projects.create', 'ok'], ['projects.setStatus', 'rejected'], ['projects.setStatus', 'rejected'], ['projects.setStatus', 'rejected']]);
    assert.ok(rows.filter((r) => r.command === 'projects.setStatus').every((r) => r.target === vm.id));
    assert.ok(rows.every((r) => JSON.parse(r.actor_json).kind === 'human'));
  });

  it('« Régénérer le résumé »: 202 with a turnId; the reply lands as Timmy\'s summary-edited; a second call while pending is 409', async () => {
    const r = await h.request('POST', `/api/v2/projects/${vm.id}/summary/regenerate`, { expectedRevision: vm.revision });
    assert.equal(r.status, 202); assert.match(r.json.data.result.turnId, /^trn_/);
    await waitFor(async () => (await h.get(`/api/v2/views/projects/${vm.id}`)).json.data.summary === 'Réponse factice.', { what: 'summary from the agent turn' });
    const p = (await h.get(`/api/v2/views/projects/${vm.id}`)).json.data;
    assert.equal(p.summaryMeta.author.name, 'Timmy');
    // the server's clock is frozen in tests: every event has the same `at`, so look for the event, not its position
    const ev = p.recentHistory.find((x) => x.kind === 'summary-edited');
    assert.ok(ev, 'summary-edited in the history'); assert.equal(ev.actor.name, 'Timmy');
    // R13-05: exact argv, every flag with its own value (the primary agent of the synthetic scenario is main)
    const turn = h.cliCalls().find((a) => a[0] === 'agent');
    assert.deepEqual(turn.filter((a) => !a.startsWith('--message=')),
      ['agent', '--agent=main', '--json', '--timeout=150', '--session-key=agent:main:ao-projet-agent-office']);
  });
});

describe('Projets v2 · a failed summary turn can be retried (R13-05)', () => {
  let h;
  before(async () => { h = await startServer(sc, { failCli: 'agent' }); await h.login(); });
  after(async () => { if (h) await h.stop(); });
  const ready = () => typeof require('../../src/projects').createProjectService === 'function'
    && /abandonSummary/.test(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'projects', 'service.js'), 'utf8'));
  it('the turn fails (the CLI exits 1): the summary is unchanged and a new regeneration is accepted', { todo: ready() ? false : 'projects: service.commands.abandonSummary (release a pending regeneration)' }, async () => {
    const c = await h.request('POST', '/api/v2/projects', { name: 'Essai' });
    const id = c.json.data.vm.id;
    const first = await h.request('POST', `/api/v2/projects/${id}/summary/regenerate`, { expectedRevision: c.json.data.revision });
    assert.equal(first.status, 202);
    await waitFor(async () => (await h.request('POST', `/api/v2/projects/${id}/summary/regenerate`, { expectedRevision: c.json.data.revision })).status === 202,
      { what: 'a retry accepted after the failed turn', timeoutMs: 5000 });
    assert.equal((await h.get(`/api/v2/views/projects/${id}`)).json.data.summary, '');
  });
});

describe('Projets v2 · write classes on a read-only instance (§5.0)', () => {
  let h;
  before(async () => { h = await startServer(sc, { readonly: true }); });
  after(async () => { if (h) await h.stop(); });
  it('store writes are allowed (PORTAL_READONLY_STORE unset); the summary agent turn is refused (OpenClaw class)', async () => {
    const c = await h.request('POST', '/api/v2/projects', { name: 'Essai' });
    assert.equal(c.status, 200, c.text);
    const g = await h.request('POST', `/api/v2/projects/${c.json.data.vm.id}/summary/regenerate`, { expectedRevision: c.json.data.revision });
    assert.equal(g.status, 403); assert.equal(g.json.error.code, 'readonly');
    assert.ok(!h.cliCalls().some((a) => a[0] === 'agent'));
  });
});

describe('Projets v2 · PORTAL_READONLY_STORE=1', () => {
  let h;
  before(async () => { h = await startServer(sc, { readonly: true, env: { PORTAL_READONLY_STORE: '1' } }); });
  after(async () => { if (h) await h.stop(); });
  it('project writes are refused with the v2 readonly error; reads still work', async () => {
    const c = await h.request('POST', '/api/v2/projects', { name: 'Essai' });
    assert.equal(c.status, 403); assert.equal(c.json.error.code, 'readonly');
    assert.equal((await h.get('/api/v2/views/projects')).status, 200);
  });
});
