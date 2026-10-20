'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { settingsFixture } = require('../helpers/settings-fixture');
const { openSse } = require('../helpers/sse-client');
const { waitFor } = require('../helpers/harness');
const { createHerdrReader } = require('../../src/adapters/herdr/reader');
const { createTeamStoreReader } = require('../../src/adapters/agent-team-pm/store-reader');
const { createOrchestratorTeamSnapshots } = require('../../src/sources/orchestrator-team-snapshots');
const { validate } = require('../../src/schema');
const { hashPassword } = require('../../src/security/password');

const people = ['pm', 'chars-b', 'chars-c', 'access-codex', 'office-codex', 'backend-codex', 'decor', 'critic', 'security', 'designer'];
const statuses = ['working', 'idle', 'done', 'blocked'];
const herdrOutput = () => Buffer.from(JSON.stringify({ id: 'fixture', result: { type: 'ok', agents: people.map((name, index) => ({
  pane_id: 'pane-' + index, agent: ['claude-code', 'codex', 'cursor'][index % 3], name, agent_status: statuses[index % statuses.length],
  agent_session: { value: `session-ref-${index}` },
})).concat([{ pane_id: 'pane-unregistered', agent: 'codex', name: 'Unregistered source-only worker', agent_status: 'idle' }]) } }));

describe('T-0045 · wired orchestrator/team projections', () => {
  let h;
  let activePrincipal = { id: 'owner-fixture', role: 'admin', permissionRevision: 1 };
  let sessionsGrant = true;
  before(async () => {
    h = await settingsFixture({ sourcePrincipalFor: () => activePrincipal, sessionsReadable: () => sessionsGrant, orchestratorTeams: ({ tmp }) => {
      const root = path.join(tmp, 'synthetic-team');
      fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
      fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
      fs.mkdirSync(path.join(root, 'members'), { recursive: true });
      const memberIds = people.map((_person, index) => `member:${String(index + 1).padStart(8, '0')}-1111-4111-8111-${String(index + 1).padStart(12, '0')}`);
      people.forEach((person, index) => fs.writeFileSync(path.join(root, 'members', `${person}.json`), JSON.stringify({
        id: memberIds[index], name: person, role: index === 0 ? 'pm' : index >= 7 ? 'reviewer' : 'builder',
        runtime: index === 0 ? 'claude' : ['claude-code', 'codex', 'cursor'][index % 3], herdrPane: `pane-${index}`,
        session: { source: `herdr:${['claude-code', 'codex', 'cursor'][index % 3]}`, kind: 'agent_session', value: `session-ref-${index}` },
        spawnedBy: index === 0 ? null : memberIds[0],
      })));
      people.forEach((person, index) => fs.writeFileSync(path.join(root, 'tasks', `T-${String(index + 1).padStart(4, '0')}.json`), JSON.stringify({
        id: `T-${String(index + 1).padStart(4, '0')}`, title: `Synthetic task for ${person}`, state: 'working', owner: person,
        prio: 1, brief: 'PRIVATE_BRIEF_CANARY', after: [], reviewers: ['critic', 'security', 'designer'], created_by: 'pm',
        created: '2026-10-10T20:00:00Z', updated: '2026-10-10T20:01:00Z', commit: null, report: '/synthetic/private/report.md',
        history: [], reviews: [{ ts: '2026-10-10T20:01:00Z', by: 'critic', verdict: 'go', note: 'PRIVATE_REVIEW_CANARY', report: '/synthetic/private/report.md' }],
      })));
      fs.writeFileSync(path.join(root, 'tasks', 'T-9999.json'), JSON.stringify({ id: 'T-9999', title: '', state: 'working' }));
      const herdr = createHerdrReader({ binaryPath: '/synthetic/herdr', hostId: 'host_fixture', orchestratorId: 'orchestrator_fixture',
        platform: 'container', label: 'Synthetic host', env: {}, supportsStableSessionRef: true,
        run: async (_binary, argv) => { assert.deepEqual(argv, ['agent', 'list']); return { stdout: herdrOutput() }; } });
      const teamStore = createTeamStoreReader({ root, label: 'Agent Office team', now: () => Date.parse('2026-10-10T20:02:00Z') });
      return createOrchestratorTeamSnapshots({ herdr, teamStore, now: () => Date.parse('2026-10-10T20:02:00Z') });
    } });
  });
  after(async () => { await h?.close(); });

  it('critic602 host-only team roster reuses the actual scoped Bureau look', async () => {
    const office=await h.get('/api/v3/views/office');assert.equal(office.status,200,office.text);
    const lead=office.json.data.occupants.find(row=>row.name==='pm');assert.ok(lead?.look,'real Herdr-only registered lead is visible with a canonical look');
    const board=await h.get('/api/v3/views/projects');assert.equal(board.status,200,board.text);
    const card=board.json.data.columns.flatMap(c=>c.cards).find(c=>c.origin==='orchestrator-team');assert.ok(card);
    const detail=await h.get('/api/v3/views/projects/'+card.id);assert.equal(detail.status,200,detail.text);
    const member=detail.json.data.teamProject.roster.members.find(row=>row.identity.name==='pm');assert.ok(member);
    console.log('scoped Bureau vs project portrait',JSON.stringify({office:lead.look,project:member.portrait.look}));
    assert.deepEqual(member.portrait.look,lead.look,'same registered member must keep the Bureau appearance in Projects');
  });
  it('critic602 accepted native Claude alias resolves to its adapter display label', async () => {
    const board=await h.get('/api/v3/views/projects');assert.equal(board.status,200,board.text);
    const card=board.json.data.columns.flatMap(c=>c.cards).find(c=>c.origin==='orchestrator-team');assert.ok(card);
    const detail=await h.get('/api/v3/views/projects/'+card.id);assert.equal(detail.status,200,detail.text);
    const member=detail.json.data.teamProject.roster.members.find(row=>row.identity.name==='pm');assert.ok(member);
    console.log('native runtime label',JSON.stringify({provider:member.identity.provider,source:member.source}));
    assert.equal(member.identity.provider,'Claude Code');assert.equal(member.source.label.params.label,'Claude Code');
  });
  it('critic607 saved canonical appearance invalidates the cached Project roster portrait', async (t) => {
    const board=await h.get('/api/v3/views/projects');assert.equal(board.status,200,board.text);
    const card=board.json.data.columns.flatMap(c=>c.cards).find(c=>c.origin==='orchestrator-team');assert.ok(card);
    const path='/api/v3/views/projects/'+card.id;
    const before=await h.get(path);assert.equal(before.status,200,before.text);
    const prior=before.json.data.teamProject.roster.members.find(row=>row.identity.name==='pm').portrait.look;assert.ok(prior);
    const topic='project:'+card.id;
    const stream=openSse(h.base,'/api/v3/stream?topics='+encodeURIComponent(topic),{cookie:h.cookie});t.after(()=>stream.close());
    const initial=await stream.next(frame=>frame.event==='snapshot'&&frame.data.topic===topic);
    const layout=await h.get('/api/v3/office/layout');assert.equal(layout.status,200,layout.text);
    const data=structuredClone(layout.json.data.layout.data),rule=data.agents.find(row=>row.agentId==='primary');assert.ok(rule);
    rule.appearance='manual';rule.character='timmy';rule.variant=null;rule.accessories=[];
    const saved=await h.put('/api/v3/office/layout',{expectedRevision:layout.json.data.layout.revision,data});assert.equal(saved.status,200,saved.text);
    const update=await stream.next(frame=>['snapshot','delta'].includes(frame.event)&&frame.data.topic===topic&&frame.data.rev>initial.data.rev);
    assert.ok(update,'appearance changes invalidate subscribed project detail topics, not only the board');
    const office=await h.get('/api/v3/views/office');assert.equal(office.status,200,office.text);
    const primary=office.json.data.occupants.find(row=>row.role==='primary');assert.ok(primary?.look);
    assert.deepEqual(primary.look,{character:'timmy',variant:null,accessories:[]},'the committed layout save changed the primary appearance');
    const after=await h.get(path);assert.equal(after.status,200,after.text);
    const current=after.json.data.teamProject.roster.members.find(row=>row.identity.name==='pm').portrait.look;
    console.log('saved primary vs stable team portrait',JSON.stringify({prior,primary:primary.look,current}));
    assert.deepEqual(current,prior,'a distinct team member keeps its stable appearance when the unrelated primary look changes');
    assert.notDeepEqual(current,primary.look,'the team portrait never inherits the primary appearance');
  });
});
