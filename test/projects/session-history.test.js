'use strict';
// architect-57 (Owner's screenshot: « Session agent:main:subagent:9c51…. Messages : {messages}. Jetons : 0 ») · a project's
// history session rows: who (not a key), a real message count, what the agent did (deterministic, from the transcript),
// and where to open the session.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeSession, messageCountOf, firstLine } = require('../../src/projects/session-summary');
const { isProjectTagEvent } = require('../../src/adapters/openclaw/project-hint');
const { loadScenario, readFixture, gatewayHandlers } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');

const ev = (kind, extra = {}) => Object.assign({ id: kind + Math.random(), kind, at: 1 }, extra);
const tool = (name, input, extra = {}) => ev('tool', Object.assign({ name, input: JSON.stringify(input) }, extra));

describe('session summary · deterministic', () => {
  const t = { messageCount: 9, events: [ev('user', { text: 'Prépare le plan de l’infolettre' }),
    tool('web_search', { query: 'brevo' }), tool('write', { path: '/ws/out/plan-infolettre.md' }), tool('edit', { file_path: '/ws/out/plan-infolettre.md' }),
    tool('exec', { title: 'tag', code: "return await exec({command:'node projet.js tag infolettre en-revue P3'});" }),
    tool('exec', { command: 'false' }, { isError: true }),
    ev('assistant', { text: '## **Plan de l’infolettre** : 3 numéros, outil [Brevo](https://brevo.com), calendrier\n\nDétails…' })] };
  it('the final reply\'s first line, the steps (failures noted), the files written, the tokens; the tag call never counts', () => {
    assert.equal(summarizeSession(t, { tokens: 25734, locale: 'fr', hidden: isProjectTagEvent }).summary,
      'Plan de l’infolettre : 3 numéros, outil Brevo, calendrier · 4 étapes (1 échec) · fichier : plan-infolettre.md · 25 734 jetons');
    assert.equal(summarizeSession(t, { tokens: 25734, locale: 'en', hidden: isProjectTagEvent }).summary,
      'Plan de l’infolettre : 3 numéros, outil Brevo, calendrier · 4 steps (1 failed) · file: plan-infolettre.md · 25,734 tokens');
  });
  it('no transcript → no summary; message count: the session\'s, else the transcript\'s, else its turns', () => {
    assert.equal(summarizeSession(null).summary, null);
    assert.equal(messageCountOf({ messageCount: 4 }, t), 4);
    assert.equal(messageCountOf({}, t), 2);
    assert.equal(messageCountOf({}, { events: t.events }), 2);
    assert.equal(messageCountOf({}, null), null);
    assert.equal(firstLine('\n\n- x\n**Bonjour** à tous'), 'Bonjour à tous');
  });
});

describe('session history rows · end to end (an auto-added project, its sub-agent and conversation sessions)', () => {
  let h, sc;
  const SUB = 'agent:main:subagent:ffffffff-cafe-4000-8000-000000000001';
  before(async () => {
    sc = loadScenario('synthetic-basic');
    const base = readFixture(sc.rpc['sessions.list']).body.value;
    const tpl = base.sessions.find((s) => s.key === 'agent:main:main');
    const body = readFixture('gw/rpc/sessions.get/2026.9.8/projet-tag-6-code-mode.json').body.value;
    const shift = sc.now - 120e3 - body.messages[0].timestamp;
    for (const m of body.messages) m.timestamp += shift;
    const sessions = base.sessions.concat([Object.assign({}, tpl, { key: SUB, sessionId: 's1', isMain: false, kind: 'direct', classification: 'subagent', updatedAt: sc.now - 90e3, totalTokens: 25734 })]);
    const get = gatewayHandlers(sc)['sessions.get'];
    h = await startServer(sc, { env: { AO_TIME_SCALE: '20' }, handlers: {
      'sessions.list': () => Object.assign({}, base, { sessions, count: sessions.length, totalCount: sessions.length }),
      'sessions.get': (p) => (p.key === SUB ? body : get(p)) } });
  });
  after(async () => { if (h) await h.stop(); });
  it('the sub-agent\'s row: « <agent> (sous-agent) », a count, what it did (the tag calls not counted), the route; never {messages} or the raw key', async () => {
    const card = await waitFor(async () => (await h.get('/api/v2/views/projects')).json.data.columns.flatMap((c) => c.cards).find((x) => x.name === 'Café Test Projet'), { timeoutMs: 15000, what: 'the project' });
    const item = await waitFor(async () => {
      const p = (await h.get('/api/v2/views/projects/' + card.id)).json.data;
      return (p.recentHistory || []).find((x) => x.kind === 'session' && x.session && x.session.key === SUB);
    }, { timeoutMs: 15000, what: 'the session row' });
    assert.equal(item.text.key, 'historyKind.session');
    assert.equal(item.text.params.session.key, 'historySession.subagent');
    assert.ok(typeof item.text.params.session.params.agent === 'string' && item.text.params.session.params.agent.length > 0, 'the agent\'s name');
    assert.ok(Number.isInteger(item.text.params.messages) && item.text.params.messages > 0, JSON.stringify(item.text));
    assert.equal(item.session.route, '/journaux/' + encodeURIComponent(SUB));
    assert.match(item.session.summary, /^Demandeur : .* → .* : 1 étape → Résultat : Voici le plan en quatre étapes\.$/, item.session.summary);
    assert.doesNotMatch(JSON.stringify(item), /\{messages\}/);
    for (const v of ['v2', 'v3']) {
      const page = (await h.get(`/api/${v}/views/projects/${card.id}/history`)).json.data;
      assert.ok(page.items.some((x) => x.session && x.session.key === SUB && x.session.summary), v);
    }
  });
});
