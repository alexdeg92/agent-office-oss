'use strict';
// architect-54 · the project tag: a no-op `projet` tool call the agent makes, read from the session transcript. It is
// metadata only: it never appears in the text the UI shows as the conversation (Owner's rule: never to people).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { projectHintsOf } = require('../../src/adapters/openclaw/project-hint');
const { createEngine } = require('../../src/engine');
const { loadScenario, readFixture, gatewayHandlers } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');

const SKILL = path.join(__dirname, '..', '..', 'integrations', 'openclaw', 'projet', 'projet.js');
const tool = (id, name, input, at = 1000) => ({ id, kind: 'tool', at, name, input: typeof input === 'string' ? input : JSON.stringify(input, null, 2) });

describe('project tag · the parser (transcript tool events only)', () => {
  it('the skill through exec, quoted statuses, accents, a ticket key, a note; other commands on the line are ignored', () => {
    const hints = projectHintsOf({ events: [
      tool('e1', 'exec', { command: 'node /home/x/.openclaw/skills/projet/projet.js tag PIVOT-2735 "en cours" P1 "Ticket menu" carte à jour' }),
      tool('e2', 'exec', { command: 'cd /tmp && node projet.js tag restaurant-banner livré p3' }),
      tool('e3', 'projet', { action: 'tag', slug: 'perroquet-saas', statut: 'idée', priorite: 'P6', titre: 'Perroquet SaaS' }),
      tool('e4', 'exec', { command: 'git status; node projet.js tag menu-builder en-revue P2' }),
      tool('e5', 'exec', { command: 'node projet.js tag sans-priorite en-cours' }),   // an older call without a priority
    ] });
    assert.deepEqual(hints.map((h) => [h.id, h.slug, h.status, h.priority, h.title, h.note]), [
      ['e1', 'pivot-2735', 'in-progress', 'P1', 'Ticket menu', 'carte à jour'], ['e2', 'restaurant-banner', 'shipped', 'P3', null, null],
      ['e3', 'perroquet-saas', 'idea', 'P6', 'Perroquet SaaS', null], ['e4', 'menu-builder', 'in-review', 'P2', null, null], ['e5', 'sans-priorite', 'in-progress', null, null, null],
    ]);
  });
  it('the trace predicate: every project-tag call (valid or not), nothing else', () => {
    const { isProjectTagEvent } = require('../../src/adapters/openclaw/project-hint');
    for (const yes of [tool('y1', 'exec', { command: 'node /s/projet/projet.js tag a-b en-cours P1' }), tool('y2', 'exec', { command: 'node projet.js tag x' }),
      tool('y3', 'projet', { slug: 'a-b' }), tool('y4', 'exec', '{"command": "cd /x && node projet.js tag clip')]) assert.equal(isProjectTagEvent(yes), true, yes.input);
    for (const no of [tool('n1', 'exec', { command: 'git status' }), tool('n2', 'exec', { command: 'echo "mon projet"' }), tool('n3', 'web_search', { query: 'projet.js tag' }),
      { id: 'n4', kind: 'assistant', text: 'node projet.js tag a-b en-cours' }]) assert.equal(isProjectTagEvent(no), false, JSON.stringify(no));
  });
  it('not a tag: message text, other tools, a one-letter slug, an unrelated mention; an unknown status links without one', () => {
    const hints = projectHintsOf({ events: [
      { id: 'a1', kind: 'assistant', at: 1, text: 'node projet.js tag pivot-2735 en-cours' },   // written to people: never parsed
      { id: 'u1', kind: 'user', at: 1, text: 'projet.js tag pivot-2735 en-cours' },
      tool('t1', 'web_search', { query: 'projet.js tag pivot-2735 en-cours' }),
      tool('t2', 'exec', { command: 'node projet.js tag x en-cours' }),
      tool('t3', 'exec', { command: 'echo "mon projet"' }),
      tool('t4', 'exec', { command: 'node projet.js tag ok-slug presque-fini' }),
    ] });
    assert.deepEqual(hints.map((h) => [h.id, h.slug, h.status, h.statusIssue]), [['t4', 'ok-slug', null, 'unknown']]);
  });
  it('a clipped tool input (the transcript keeps 4 kB) still yields the tag', () => {
    const clipped = '{\n  "command": "node /s/projet/projet.js tag clip-test en-revue ' + 'x'.repeat(50);
    assert.deepEqual(projectHintsOf({ events: [tool('c1', 'exec', clipped)] }).map((h) => [h.slug, h.status]), [['clip-test', 'in-review']]);
  });
  it('the skill itself is a no-op that only acknowledges (exit 0), and refuses a bad call (exit 2)', () => {
    const ok = spawnSync(process.execPath, [SKILL, 'tag', 'PIVOT-2735', 'en cours', 'P1', 'Ticket menu'], { encoding: 'utf8', env: {} });
    assert.equal(ok.status, 0); assert.match(ok.stdout, /^ok · projet pivot-2735 · en-cours · P1/);
    for (const bad of [['tag', 'x', 'en-cours', 'P1'], ['tag', 'ok-slug', 'en-cours'], ['tag', 'ok-slug', 'en-cours', 'P10'], ['tag', 'ok-slug', 'peut-etre', 'P1']]) {
      assert.equal(spawnSync(process.execPath, [SKILL, ...bad], { encoding: 'utf8', env: {} }).status, 2, bad.join(' '));
    }
    const src = require('fs').readFileSync(SKILL, 'utf8');
    assert.doesNotMatch(src, /require\((?!['"]?\))|fetch\(|https?:|writeFile|process\.env/, 'no module, network, file write or environment');
  });
});

describe('project tag · the engine keeps hints from every transcript it reads', () => {
  it('merged across reads (an older window still counts); the transcript cache is bounded', () => {
    const { definition } = require('../../src/adapters/openclaw');
    const e = createEngine({ adapter: definition, now: () => 1791223005000 });
    const msg = (cmd, at) => ({ role: 'assistant', timestamp: 1791223000000 + at, content: [{ type: 'toolCall', id: 'c' + at, name: 'exec', arguments: { command: cmd } }] });
    const ingest = (key, messages) => e.ingest({ source: 'gateway', channel: 'gw.rpc.sessions.get', receivedAt: 1791223005000, context: { key }, body: { kind: 'json', value: { messages } } });
    ingest('agent:main:main', [msg('node projet.js tag alpha en-cours', 100)]);
    ingest('agent:main:main', [msg('node projet.js tag alpha en-cours', 100), msg('node projet.js tag beta idee', 200)]);
    assert.deepEqual(e.projectHints().map((h) => [h.sessionKey, h.slug, h.status]), [['agent:main:main', 'alpha', 'in-progress'], ['agent:main:main', 'beta', 'idea']]);
    for (let i = 0; i < 230; i++) ingest('agent:main:explicit:k' + i, [{ role: 'user', timestamp: 1791223000001, content: 'x' }]);
    assert.equal(e.transcript('agent:main:explicit:k0'), null, 'the least recently read left the cache');
    assert.ok(e.transcript('agent:main:explicit:k229'));
    assert.ok(e.projectHints().some((h) => h.slug === 'beta'), 'hints outlive the transcript cache');
  });
  it('architect-56: a transcript that brings new hints emits a ProjectHint change (the projects refresh at once); the same again does not', async () => {
    const { definition } = require('../../src/adapters/openclaw');
    const e = createEngine({ adapter: definition, now: () => 1791223005000 });
    const seen = []; e.on('change', (c) => { if (c && c.type === 'ProjectHint') seen.push(c.key); });
    const msg = (cmd, at) => ({ role: 'assistant', timestamp: 1791223000000 + at, content: [{ type: 'toolCall', id: 'c' + at, name: 'exec', arguments: { title: 't', code: `return await exec({command:'${cmd}'});` } }] });
    const ingest = (messages) => e.ingest({ source: 'gateway', channel: 'gw.rpc.sessions.get', receivedAt: 1791223005000, context: { key: 'agent:main:x' }, body: { kind: 'json', value: { messages } } });
    ingest([msg('node projet.js tag alpha en-cours P1', 100)]);
    await new Promise((r) => setImmediate(r));
    ingest([msg('node projet.js tag alpha en-cours P1', 100)]);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, ['agent:main:x']);
  });
});

describe('project tag · end to end (the real server: scan, candidates, an existing project, and the UI never shows it)', () => {
  let h, sc, ROOM, CHAT;
  const SECRET_TAG = 'node /home/agent/.openclaw/skills/projet/projet.js tag';
  before(async () => {
    sc = loadScenario('synthetic-basic');
    const base = readFixture(sc.rpc['sessions.list']).body.value;
    const tpl = base.sessions.find((s) => /discord:channel/.test(s.key)) || base.sessions[0];
    ROOM = 'agent:main:discord:channel:100000000000000081'; CHAT = 'agent:main:explicit:projet-test';
    const rows = [Object.assign({}, tpl, { key: ROOM, sessionId: 'r81', groupChannel: '#restaurant-banner', displayName: '#restaurant-banner', updatedAt: sc.now - 60e3 }),
      Object.assign({}, tpl, { key: CHAT, sessionId: 'c1', groupChannel: undefined, displayName: 'Projet', updatedAt: sc.now - 30e3 })];
    const sessions = base.sessions.concat(rows);
    const turn = (text, cmd, at) => [
      { role: 'user', timestamp: at - 10, content: 'Peux-tu avancer ?' },
      { role: 'assistant', timestamp: at, content: [{ type: 'text', text }, { type: 'toolCall', id: 'call_' + at, name: 'exec', arguments: { command: cmd } }] },
      { role: 'toolResult', toolCallId: 'call_' + at, toolName: 'exec', timestamp: at + 5, content: [{ type: 'text', text: 'ok · projet' }] },
    ];
    const transcripts = {
      [ROOM]: { messages: turn('La bannière est en ligne.', `${SECRET_TAG} restaurant-banner livre`, sc.now - 60e3) },
      [CHAT]: { messages: turn('J’ai avancé sur le menu et le SaaS.', `${SECRET_TAG} menu-builder en-revue && ${SECRET_TAG} perroquet-saas idee`, sc.now - 30e3)
        .concat(turn('Et le SaaS.', `${SECRET_TAG} perroquet-saas idee`, sc.now - 20e3)) },
    };
    const getFixture = require('../helpers/scenario').gatewayHandlers(sc)['sessions.get'];
    h = await startServer(sc, { env: { AO_TIME_SCALE: '20' }, handlers: {
      'sessions.list': () => Object.assign({}, base, { sessions, count: sessions.length, totalCount: sessions.length }),
      'sessions.get': (p) => transcripts[p.key] || getFixture(p),
    } });
    // an existing project the agent will tag
    const r = await h.post('/api/v2/projects', { name: 'Menu Builder', status: 'in-progress', priority: 'P2', summary: '', sources: [] });
    assert.equal(r.status, 200, r.text);
  });
  after(async () => { if (h) await h.stop(); });

  it('the scan reads the active sessions\' transcripts; tags for new slugs become projects on the board (PM: auto-add)', async () => {
    const cards = async () => (await h.get('/api/v2/views/projects')).json.data.columns.flatMap((c) => c.cards);
    const got = await waitFor(async () => {
      const c = await cards();
      return c.some((x) => x.name === 'restaurant banner') && c.some((x) => /perroquet/.test(x.name)) ? c : null;
    }, { timeoutMs: 20000, what: 'auto-added projects' });
    const room = got.find((x) => x.name === 'restaurant banner'), saas = got.find((x) => /perroquet/.test(x.name));
    const detail = async (id) => (await h.get('/api/v2/views/projects/' + id)).json.data;
    assert.deepEqual([(await detail(room.id)).status, (await detail(saas.id)).status], ['shipped', 'idea']);
    await waitFor(async () => JSON.stringify(await detail(room.id)).includes('100000000000000081'), { timeoutMs: 20000, what: 'the room linked' });
    const cands = (await h.get('/api/v2/views/project-candidates')).json.data.candidates;
    assert.ok(!cands.some((x) => /restaurant|perroquet|menu/i.test(x.name)), 'nothing proposed twice: ' + cands.map((x) => x.name).join(', '));
    assert.equal(got.filter((x) => /menu/i.test(x.name)).length, 1, 'a tag for an existing project creates nothing');
  });

  it('an existing project the agent tags: the conversation is linked and the status updated, by the agent', async () => {
    const p = await waitFor(async () => {
      const board = (await h.get('/api/v2/views/projects')).json.data;
      const all = (board.columns || []).flatMap((c) => c.cards || c.projects || []).concat(board.projects || []);
      const m = all.find((x) => x.name === 'Menu Builder');
      return m && m.status === 'in-review' ? m : null;
    }, { timeoutMs: 20000, what: 'the tagged status' });
    const detail = (await h.get('/api/v2/views/projects/' + p.id)).json.data;
    assert.ok(JSON.stringify(detail).includes(CHAT) || JSON.stringify(detail).includes('projet-test'), 'the tagged conversation is linked');
  });

  it('the scan is quiet: a session whose transcript can\'t be read (gone since the list) raises no issue and no stale source', async () => {
    await waitFor(() => h.gw.callsTo('sessions.get').length >= 3, { timeoutMs: 20000, what: 'the scan ran' });
    const hv = (await h.get('/api/v2/views/health')).json.data;
    assert.ok(!hv.dataQuality.issues.some((i) => i.channel === 'gw.rpc.sessions.get' && i.code === 'rpc.failed'), JSON.stringify(hv.dataQuality.issues));
    assert.deepEqual((await h.get('/api/v2/views/office')).json.meta.stale || [], []);
  });

  it('the UI never shows the tag: not in the conversation text, not in the trace, not in the logs (v2 and v3)', async () => {
    for (const v of ['v2', 'v3']) {
      for (const key of [ROOM, CHAT]) {
        const vm = (await h.get(`/api/${v}/views/sessions/${encodeURIComponent(key)}`)).json.data;
        const items = vm.items || vm.trace || vm.events || [];
        const said = items.filter((x) => x.kind === 'assistant' || x.kind === 'user' || x.kind === 'message' || x.kind === 'reply');
        assert.ok(said.length > 0, `${v} ${key}: the conversation is shown`);
        for (const x of said) assert.doesNotMatch(JSON.stringify(x), /projet\.js|restaurant-banner livre|perroquet-saas|menu-builder en-revue/, `${v} ${key}: ${JSON.stringify(x).slice(0, 160)}`);
        // architect-55 (PM): nor the trace: the whole session view, every item kind, never shows the call
        assert.doesNotMatch(JSON.stringify(vm), /projet\.js|projet tag/, `${v} ${key}: the trace`);
        assert.equal(items.filter((x) => x.kind === 'tool').length, 0, `${v} ${key}: the tag call was the only tool call`);
      }
      const logs = JSON.stringify((await h.get(`/api/${v}/views/logs?limit=200`)).json.data);
      assert.doesNotMatch(logs, /projet\.js/, v + ' logs');
    }
  });
});

// architect-56 (prod finding, 2026-10-07): OpenClaw 2026.9.8's `exec` is a code-mode tool: arguments { title, code }, the
// shell command a string literal inside `code`; and the tag was run by a sub-agent the conversation spawned.
describe('project tag · code-mode exec (the prod shape) and an immediate refresh', () => {
  const FIX = 'gw/rpc/sessions.get/2026.9.8/projet-tag-6-code-mode.json';
  it('the parser reads the command inside `code`; reading the skill is no tag; the trace hides the tag calls only', () => {
    const { normaliseTranscript } = require('../../src/adapters/openclaw/normalise/transcript');
    const { isProjectTagEvent } = require('../../src/adapters/openclaw/project-hint');
    const t = normaliseTranscript('agent:main:subagent:ffffffff-cafe-4000-8000-000000000001', readFixture(FIX).body.value, 1791223300000);
    assert.deepEqual(projectHintsOf(t).map((h) => [h.slug, h.status, h.priority, h.title]),
      [['cafe-test-projet', 'in-progress', 'P8', 'Café Test Projet'], ['cafe-test-projet', 'shipped', 'P8', 'Café Test Projet']]);
    const tools = t.events.filter((e) => e.kind === 'tool');
    assert.deepEqual(tools.map(isProjectTagEvent), [false, true, true], 'skills.read(\'projet\') stays visible');
    const code = 'await exec({command:"node projet.js tag a-b en-cours P1"}); await exec({command:"node projet.js tag a-b livre P1"});';
    assert.deepEqual(projectHintsOf({ events: [tool('m1', 'exec', { title: 'deux', code })] }).map((h) => [h.id, h.status]), [['m1', 'in-progress'], ['m1#1', 'shipped']]);
  });

  let h, sc;
  const PARENT = 'agent:main:ao-projet-test-1', SUB = 'agent:main:subagent:ffffffff-cafe-4000-8000-000000000001';
  before(async () => {
    sc = loadScenario('synthetic-basic');
    const base = readFixture(sc.rpc['sessions.list']).body.value;
    const tpl = base.sessions.find((s) => s.key === 'agent:main:main');
    // the prod rows: a custom session key from `openclaw agent --session-key`, and the sub-agent it spawned
    const rows = [Object.assign({}, tpl, { key: PARENT, sessionId: 'p1', isMain: false, kind: 'direct', classification: 'custom', updatedAt: sc.now - 60e3 }),
      Object.assign({}, tpl, { key: SUB, sessionId: 's1', isMain: false, kind: 'direct', classification: 'subagent', spawnedBy: PARENT, parentSessionKey: PARENT, updatedAt: sc.now - 90e3 })];
    const sessions = base.sessions.concat(rows);
    const body = readFixture(FIX).body.value;
    const shift = sc.now - 120e3 - body.messages[0].timestamp;
    for (const m of body.messages) m.timestamp += shift;
    const get = gatewayHandlers(sc)['sessions.get'];
    h = await startServer(sc, { env: { AO_TIME_SCALE: '20' }, handlers: {
      'sessions.list': () => Object.assign({}, base, { sessions, count: sessions.length, totalCount: sessions.length }),
      'sessions.get': (p) => (p.key === SUB ? body : p.key === PARENT ? { messages: [] } : get(p)),
    } });
  });
  after(async () => { if (h) await h.stop(); });
  it('the project is on the board within seconds of the scan, with no further session change (the tag triggers the refresh)', async () => {
    const t0 = Date.now();
    const card = await waitFor(async () => (await h.get('/api/v2/views/projects')).json.data.columns.flatMap((c) => c.cards).find((x) => x.name === 'Café Test Projet'),
      { timeoutMs: 15000, what: 'the auto-added project' });
    const p = (await h.get('/api/v2/views/projects/' + card.id)).json.data;
    assert.deepEqual([p.status, p.priority], ['shipped', 'P8']);
    assert.ok(Date.now() - t0 < 15000);
    assert.ok(JSON.stringify(p).includes(SUB), 'the sub-agent\'s session is linked');
  });
});
