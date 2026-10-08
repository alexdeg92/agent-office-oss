'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { messageCountOf, conversationSummary } = require('../../src/projects/session-summary');
const { loadScenario, readFixture, gatewayHandlers } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');
const { buildProjectVM } = require('../../src/projects/vm');

it('frontend-28: zero/missing session counters fall back to user + assistant turns, excluding tools', () => {
  const transcript = { messageCount: 4, events: [{ kind: 'user', text: 'Prépare le plan.', sender: 'Camille' },
    { kind: 'tool', name: 'write', input: '{"path":"plan.md"}' }, { kind: 'assistant', text: 'Plan livré.' }] };
  for (const session of [{ messageCount: 0 }, {}, { messageCount: null }]) assert.equal(messageCountOf(session, transcript), 2);
  assert.equal(messageCountOf({ messageCount: 0 }, transcript, 132), 132, 'the complete raw count wins over a tail window');
  assert.equal(messageCountOf({ messageCount: 0 }, { events: [] }), 0);
  assert.equal(messageCountOf({}, null), null);
  assert.equal(conversationSummary(transcript, { agent: 'Atlas' }), 'Camille : Prépare le plan. → Atlas : 1 étape · plan.md → Résultat : Plan livré.');
});

it('frontend-28: linked-conversation membership preserves manual roles/hidden people and distinct sub-agent identities', () => {
  const agent = { id:'per_primary', kind:'agent', name:'Atlas', avatarUrl:null, links:{agentId:'main'} };
  const human = { id:'per_camille', kind:'human', name:'Camille', avatarUrl:null, links:{discordUserId:'100000000000000028'} };
  const project = { id:'prj_demo', name:'Projet', summary:'', status:'todo', priority:'P1', sources:[], flags:[],
    people:[{personId:agent.id,role:'Responsable',origin:'manual'}], lastActivityAt:1, createdAt:1 };
  const options = { persons:[agent,human], hiddenPeople:[human.id], linkedSessionKeys:['dm','sub'], sessionInfo:(key)=>({channel:key==='dm'?'Discord':null,people:key==='dm'
    ? [{id:'agent:main',kind:'agent',name:'Atlas',avatarUrl:null,state:null},{id:'discord-user:100000000000000028',kind:'human',name:'Camille',avatarUrl:null,state:null}]
    : [{id:'agent:main:subagent:abcd',kind:'agent',name:'Atlas',avatarUrl:null,state:null}]}) };
  const vm=buildProjectVM(project,[],options);
  assert.equal(vm.people.length,2);
  assert.equal(vm.people.find((p)=>p.id===agent.id).role,'Responsable');
  assert.equal(vm.people.find((p)=>p.id.includes(':subagent:')).role,'Sous-agent');
  assert.ok(!vm.people.some((p)=>p.name==='Camille'));
});

describe('frontend-28: real API transcripts and project rows for sub-agent and Discord DM keys', () => {
  const SUB = 'agent:main:subagent:ffffffff-cafe-4000-8000-000000000028';
  const DM = 'agent:main:discord:direct:100000000000000028';
  let h, body, count, projectId;
  before(async () => {
    const sc = loadScenario('synthetic-basic');
    const base = readFixture(sc.rpc['sessions.list']).body.value;
    const tpl = base.sessions.find((s) => s.key === 'agent:main:main');
    body = readFixture('gw/rpc/sessions.get/2026.9.8/projet-tag-6-code-mode.json').body.value;
    const shift = sc.now - 120e3 - body.messages[0].timestamp;
    for (const m of body.messages) m.timestamp += shift;
    body.messages[0].senderName = 'Camille Test';
    const earlier = Array.from({ length: 130 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user',
      timestamp: sc.now - 500e3 + i * 1000, senderName: i % 2 ? undefined : 'Camille Test', content: `Échange initial ${i}` }));
    body.messages.unshift(...earlier);
    count = body.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length;
    const sessions = base.sessions.concat([
      { ...tpl, key: SUB, sessionId: 's28', isMain: false, classification: 'subagent', updatedAt: sc.now - 90e3, messageCount: 0 },
      { ...tpl, key: DM, sessionId: 'd28', isMain: false, classification: 'chat-direct', channel: 'discord', updatedAt: sc.now - 90e3, messageCount: 0 },
    ]);
    const get = gatewayHandlers(sc)['sessions.get'];
    h = await startServer(sc, { env: { AO_TIME_SCALE: '20' }, handlers: {
      'sessions.list': () => ({ ...base, sessions, count: sessions.length, totalCount: sessions.length }),
      'sessions.get': (p) => [SUB, DM].includes(p.key) ? body : get(p),
    } });
    const card = await waitFor(async () => (await h.get('/api/v2/views/projects')).json.data.columns.flatMap((c) => c.cards).find((c) => c.name === 'Café Test Projet'), { timeoutMs: 15000 });
    projectId = card.id;
  });
  after(async () => { if (h) await h.stop(); });
  it('both history counters use the whole transcript before it is opened; conversations populate people', async () => {
    const p = await waitFor(async () => {
      const vm = (await h.get('/api/v2/views/projects/' + projectId)).json.data;
      return [SUB, DM].every((key) => vm.recentHistory.some((e) => e.session?.key === key && e.session.messages === count)) && vm;
    }, { timeoutMs: 15000 });
    assert.ok(p.people.some((person) => person.name === 'Camille Test' && person.kind === 'human'));
    assert.ok(p.people.some((person) => person.kind === 'agent'));
    const dm = p.recentHistory.find((e) => e.session?.key === DM).session;
    assert.equal(dm.channel, 'Discord');
    assert.ok(dm.people.some((person) => person.name === 'Camille Test'));
    assert.match(dm.summary, /Camille Test : .* → .* → Résultat :/);
  });
  it('v2 and v3 session routes return initial messages, agent replies and collapsed-tool data beyond the old 120-message tail', async () => {
    for (const v of ['v2', 'v3']) for (const key of [SUB, DM]) {
      const r = await h.get(`/api/${v}/views/sessions/${encodeURIComponent(key)}`);
      assert.equal(r.status, 200);
      const vm = r.json.data;
      assert.equal(vm.key, key);
      assert.equal(vm.messageCount, count);
      assert.equal(vm.window.from, 0);
      assert.ok(vm.events.some((e) => e.kind === 'user' && e.text === 'Échange initial 0'));
      assert.ok(vm.events.some((e) => e.kind === 'assistant' && /Voici le plan/.test(e.text)));
      assert.ok(vm.events.some((e) => e.kind === 'tool' && e.name === 'exec'));
      assert.ok(!vm.events.some((e) => e.kind === 'tool' && /projet\.js tag/.test(e.input)), 'project-tag calls stay hidden');
    }
  });
});
