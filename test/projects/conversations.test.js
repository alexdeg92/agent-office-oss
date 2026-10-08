'use strict';
// architect-54 · passive project inference from conversations (rooms, ticket keys, working directories): no agent change.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { conversationGroups, ticketOf, roomTitle } = require('../../src/projects/sources/conversations');
const { proposeCandidates } = require('../../src/projects/discovery');
const { loadScenario, readFixture } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');

const NOW = Date.UTC(2026, 9, 7, 12);
const room = (sf, name, at = NOW - 3600e3, n = 0) => ({ key: `agent:main:discord:channel:${sf}${n ? ':thread:' + n : ''}`, updatedAt: at, channelName: name,
  class: { kind: 'conversation-group', interlocutorId: `discord-channel:${sf}` } });
const session = (key, extra = {}) => Object.assign({ key, updatedAt: NOW - 7200e3, class: { kind: 'explicit' } }, extra);

describe('conversation inference · the pieces', () => {
  it('ticket keys: letters then digits, normalised; not inside words or versions', () => {
    assert.deepEqual(ticketOf('#PIVOT-2735'), { key: 'PIVOT-2735', slug: 'pivot-2735' });
    assert.deepEqual(ticketOf('fix PIVOT-0042 today'), { key: 'PIVOT-42', slug: 'pivot-42' });
    assert.deepEqual(ticketOf('#pivot-2735', { anyCase: true }), { key: 'PIVOT-2735', slug: 'pivot-2735' }, 'room names: any case');
    for (const no of ['#restaurant-banner', 'v2-3', 'node-24', 'fix pivot-42', '2026-10-07', 'abc12-x', 'X-1', 'AB2-12']) assert.equal(ticketOf(no), null, no);
  });
  it('room titles: the # and separators go, a ticket key stays whole', () => {
    assert.equal(roomTitle('#pivot-2735-menu-update'), 'PIVOT-2735 menu update');
    assert.equal(roomTitle('#restaurant-banner'), 'restaurant banner');
    assert.equal(roomTitle('#Perroquet SaaS'), 'Perroquet SaaS');
  });
});

describe('conversation inference · groups', () => {
  const sessions = [
    room('100000000000000001', '#PIVOT-2735'), room('100000000000000001', '#PIVOT-2735', NOW - 60e3, 7),   // a thread of the same room
    room('100000000000000002', '#restaurant-banner', NOW - 86400e3),
    room('100000000000000003', '#Perroquet SaaS', NOW - 2 * 86400e3),
    room('100000000000000004', '#général'), room('100000000000000005', '#bots'), room('100000000000000006', '#00000000a045cb24c8be7ceaea812e'),
    session('agent:main:explicit:a', { label: 'Relance ABC-12 (factures)' }),
    session('agent:main:explicit:b', { goal: { objective: 'Terminer ABC-12 avant vendredi', status: 'active', tokensUsed: 0, tokenBudget: null } }),
    session('agent:main:explicit:c', { label: 'PIVOT-2735 suivi' }),                    // its room already carries the ticket
    session('agent:main:cron:j1', { class: { kind: 'scheduled', cronJobId: 'j1' } }),
    session('agent:main:subagent:s1', { cwd: '/srv/clients/menu-builder', class: { kind: 'subagent' } }),
    session('agent:main:subagent:s2', { cwd: '/srv/ws/projects/agent-office', class: { kind: 'subagent' } }),   // under the root
    session('agent:main:subagent:s3', { cwd: '/srv/home/.openclaw/workspace', class: { kind: 'subagent' } }),       // the runtime's own
    session('agent:main:subagent:s4', { cwd: '/tmp', class: { kind: 'subagent' } }),
  ];
  const flows = [{ id: 'j1', name: 'Rapport hebdo DATA-7' }];
  let groups;
  before(() => { groups = conversationGroups({ sessions, flows, roots: ['/srv/ws/projects'], home: '/srv/home' }); });

  it('one group per project-like room, linked by the room; generic and hash-like rooms give nothing', () => {
    const rooms = groups.filter((g) => g.ref.by === 'interlocutor');
    assert.deepEqual(rooms.map((g) => [g.name, g.slug, g.evidence, g.confidence]), [
      ['PIVOT-2735', 'pivot-2735', 'ticket', 'high'],
      ['restaurant banner', 'restaurant-banner', 'room', 'medium'],
      ['Perroquet SaaS', 'perroquet-saas', 'room', 'medium'],
    ]);
    assert.equal(rooms[0].lastActivityAt, NOW - 60e3, 'the newest activity in the room, threads included');
  });
  it('a ticket in labels, goals or a flow name: one group per ticket, by session keys; never twice for a room ticket', () => {
    const t = groups.filter((g) => g.ref.by === 'keys' && g.evidence === 'ticket');
    assert.deepEqual(t.map((g) => [g.name, g.ref.sessionKeys]).sort(), [
      ['ABC-12', ['agent:main:explicit:a', 'agent:main:explicit:b']],
      ['DATA-7', ['agent:main:cron:j1']],
    ]);
  });
  it('a working directory outside the root becomes a folder group; the root\'s, the runtime\'s and generic ones do not', () => {
    assert.deepEqual(groups.filter((g) => g.evidence === 'workspace').map((g) => [g.name, g.ref.sessionKeys]), [['menu-builder', ['agent:main:subagent:s1']]]);
  });
  it('proposeCandidates: a room folds into the repo of the same name; the others become candidates', () => {
    const c = proposeCandidates({ now: NOW, owners: ['acme'], sessionGroups: groups.concat(conversationGroups({ sessions: [room('100000000000000009', '#menu-builder-web')] })),
      github: [{ owner: 'acme', repo: 'menu-builder', name: 'menu-builder', description: '', archived: false, pushedAt: new Date(NOW - 86400e3).toISOString(), topics: [] }] });
    const names = c.map((x) => x.name).sort();
    assert.ok(names.includes('PIVOT-2735') && names.includes('restaurant banner') && names.includes('ABC-12'), names.join(', '));
    const repo = c.find((x) => x.sources.some((s) => s.kind === 'github'));
    assert.ok(repo.sources.some((s) => s.kind === 'sessionGroup' && s.ref.by === 'interlocutor'), 'the #menu-builder-web room joined the menu-builder repo');
  });
});

describe('conversation inference · end to end (the real server, sessions.list rows as OpenClaw sends them)', () => {
  let h;
  before(async () => {
    const sc = loadScenario('synthetic-basic');
    const base = readFixture(sc.rpc['sessions.list']).body.value;
    const tpl = base.sessions.find((s) => /discord:channel/.test(s.key)) || base.sessions[0];
    const row = (sf, name) => Object.assign({}, tpl, { key: `agent:main:discord:channel:${sf}`, sessionId: 's' + sf, groupChannel: name, displayName: name, updatedAt: sc.now - 3600e3 });
    const sessions = base.sessions.concat([row('100000000000000071', '#PIVOT-2735'), row('100000000000000072', '#restaurant-banner'), row('100000000000000073', '#general')]);
    h = await startServer(sc, { handlers: { 'sessions.list': () => Object.assign({}, base, { sessions, count: sessions.length, totalCount: sessions.length }) } });
  });
  after(async () => { if (h) await h.stop(); });
  it('the candidates view proposes the rooms (not #general), with no data-quality issue for groupChannel', async () => {
    const c = (await h.get('/api/v2/views/project-candidates')).json.data;
    const names = c.candidates.map((x) => x.name);
    assert.ok(names.includes('PIVOT-2735') && names.includes('restaurant banner'), names.join(', '));
    assert.ok(!names.includes('general'));
    const dq = (await h.get('/api/v2/views/health')).json.data.dataQuality.issues;
    assert.ok(!dq.some((i) => /groupChannel/.test(i.path || '')), JSON.stringify(dq));
  });
});
