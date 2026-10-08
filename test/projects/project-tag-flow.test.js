'use strict';
// architect-54 · the project tag, end to end on the real server, with the fixtures test/fixtures/gw/rpc/sessions.get/
// 2026.9.8/projet-tag-*.json (OpenClaw-shaped transcripts; the tag is a no-op exec call, never in the reply text):
//   1. a substantial new task → a project on the board at once (PM: auto-add), with the tag's title, status and priority;
//   2. a follow-up in ANOTHER conversation (a Discord DM, the next day) with the same slug → attached to that project;
//   3. a later tag with P0 → the project's priority changes (by the agent);
//   4. a later tag with `livre` → the project's status changes to shipped (by the agent);
//   5. a quick question (no tag) → no project, no candidate.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadScenario, readFixture, gatewayHandlers } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');

const FIX = (n) => `gw/rpc/sessions.get/2026.9.8/projet-tag-${n}.json`;
const CONV = [
  ['agent:main:explicit:menu-1', FIX('1-new-task')],
  ['agent:main:discord:direct:100000000000000091', FIX('2-follow-up')],
  ['agent:main:explicit:menu-2', FIX('3-priority')],
  ['agent:main:explicit:menu-3', FIX('4-status')],
  ['agent:main:discord:direct:100000000000000092', FIX('5-quick-question')],
];

describe('project tag · the flow: new task, follow-up elsewhere, priority, status, and a quick question', () => {
  let h, sc, visible, projectId;
  const shift = (body, by) => { for (const m of body.messages) m.timestamp += by; return body; };   // fixtures' clock → the scenario's
  before(async () => {
    sc = loadScenario('synthetic-basic');
    const base = readFixture(sc.rpc['sessions.list']).body.value;
    const tpl = base.sessions.find((s) => s.key === 'agent:main:main');
    const transcripts = Object.fromEntries(CONV.map(([key, file], i) => {
      const body = readFixture(file).body.value;
      const first = body.messages[0].timestamp;
      return [key, shift(body, sc.now - (5 - i) * 3600e3 - first)];   // one hour apart, the last an hour before "now"
    }));
    const rowOf = (key, i) => Object.assign({}, tpl, { key, sessionId: 'tag' + i, isMain: false, kind: /discord/.test(key) ? 'direct' : 'unknown',
      chatType: /discord/.test(key) ? 'direct' : undefined, channel: /discord/.test(key) ? 'discord' : undefined, displayName: null, groupChannel: undefined,
      updatedAt: transcripts[key].messages[transcripts[key].messages.length - 1].timestamp });
    visible = [];
    const get = gatewayHandlers(sc)['sessions.get'];
    h = await startServer(sc, { env: { AO_TIME_SCALE: '20' }, handlers: {
      'sessions.list': () => { const sessions = base.sessions.concat(visible.map(([k, i]) => rowOf(k, i))); return Object.assign({}, base, { sessions, count: sessions.length, totalCount: sessions.length }); },
      'sessions.get': (p) => transcripts[p.key] || get(p),
    } });
  });
  after(async () => { if (h) await h.stop(); });
  const show = (...idx) => { for (const i of idx) visible.push([CONV[i][0], i]); h.gw.emit('sessions.changed', { reason: 'test' }); };
  const candidates = async () => (await h.get('/api/v2/views/project-candidates')).json.data.candidates;
  const project = async () => (await h.get('/api/v2/views/projects/' + projectId)).json.data;
  const card = async () => {
    const board = (await h.get('/api/v2/views/projects')).json.data;
    return JSON.parse(JSON.stringify(board)).columns ? (board.columns.flatMap((c) => c.cards || c.projects || [])).find((p) => p.id === projectId) : null;
  };

  const boardCards = async () => (await h.get('/api/v2/views/projects')).json.data.columns.flatMap((c) => c.cards);
  it('1 · a new task becomes a project on the board by itself (title, status, priority, by the agent); 5 · a quick question gives nothing', async () => {
    show(0, 4);
    const card = await waitFor(async () => (await boardCards()).find((x) => x.name === 'Générateur de menus'), { timeoutMs: 20000, what: 'the auto-added project' });
    projectId = card.id;
    const p = await project();
    assert.deepEqual([p.name, p.status, p.priority], ['Générateur de menus', 'in-progress', 'P2']);
    const hist = (await h.get('/api/v2/views/projects/' + projectId + '/history')).json.data;
    const created = (hist.events || hist.items || []).find((e) => e.kind === 'project-created');
    assert.equal(created && created.actor.kind, 'agent', 'created by the agent');
    assert.ok(!(await candidates()).some((x) => /menu/i.test(x.name)), 'not also a candidate');
    assert.ok(!JSON.stringify(await boardCards()).includes('100000000000000092') && !(await candidates()).some((x) => JSON.stringify(x).includes('100000000000000092')), 'the quick question (no tag) is nothing');
    assert.equal((await boardCards()).filter((x) => x.name === 'Générateur de menus').length, 1);
  });

  it('2 · a follow-up in another conversation, the next hour, with the same slug: attached to the same project', async () => {
    show(1);
    await waitFor(async () => JSON.stringify(await project()).includes('100000000000000091'), { timeoutMs: 20000, what: 'the follow-up linked' });
    assert.ok(!(await candidates()).some((x) => x.name === 'Générateur de menus' || /menu-builder/.test(x.key)), 'no duplicate candidate');
  });

  it('3 · a later tag with P0: the priority changes, by the agent', async () => {
    show(2);
    const p = await waitFor(async () => { const x = await project(); return x.priority === 'P0' ? x : null; }, { timeoutMs: 20000, what: 'priority P0' });
    assert.equal(p.status, 'in-progress');
    const hist = (await h.get('/api/v2/views/projects/' + projectId + '/history')).json.data;
    const ev = (hist.events || hist.items || []).find((e) => e.kind === 'priority');
    assert.ok(ev, JSON.stringify(hist).slice(0, 400));
    assert.equal(ev.actor.kind, 'agent', 'attributed to the agent'); assert.deepEqual(ev.text.params, { from: 'P2', to: 'P0' });
  });

  it('4 · a later tag with `livre`: the status becomes shipped, by the agent', async () => {
    show(3);
    const p = await waitFor(async () => { const x = await project(); return x.status === 'shipped' ? x : null; }, { timeoutMs: 20000, what: 'status shipped' });
    assert.equal(p.priority, 'P0');
    for (const key of ['menu-1', '100000000000000091', 'menu-2', 'menu-3']) assert.ok(JSON.stringify(p).includes(key), key + ' linked');
    assert.ok(!JSON.stringify(p).includes('100000000000000092'), 'never the quick question');
  });

  it('idempotent: the same slug never creates twice; archived, the project is not re-created by its old tags', async () => {
    assert.equal((await boardCards()).filter((x) => x.name === 'Générateur de menus').length, 1);
    const rev = (await project()).revision;
    assert.equal((await h.request('PUT', `/api/v2/projects/${projectId}/archived`, { expectedRevision: rev, archived: true })).status, 200);
    h.gw.emit('sessions.changed', { reason: 'test' });
    const calls = h.gw.callsTo('sessions.list').length;
    await waitFor(() => h.gw.callsTo('sessions.list').length >= calls + 4, { timeoutMs: 20000, what: 'a few refreshes' });
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(!(await boardCards()).some((x) => x.name === 'Générateur de menus'), 'not re-created');
    assert.ok(!(await candidates()).some((x) => /menu/i.test(x.name)), 'nor proposed again');
    const n = h.withStore((db) => db.prepare("SELECT count(*) AS n FROM projects WHERE name = 'Générateur de menus'").get().n);
    assert.equal(n, 1, 'one project, ever');
  });
});
