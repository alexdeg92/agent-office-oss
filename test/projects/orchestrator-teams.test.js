'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('../../src/schema');
const { VM_SCHEMAS, VM_SCHEMAS_V3 } = require('../../src/api/v2/vm/schemas');
const { teamProjects, appendTeamProjects, buildTeamProjectVM, officePortraitForMember } = require('../../src/projects/orchestrator-teams');
const { createViewProjection } = require('../../src/security/view-projection');
const { tagTeamMember } = require('../../src/engine/office/placement-identity');

function snapshot() {
  const teamId = 'team_opaque_fixture';
  return {
    team: { id: teamId, label: 'Paperclip Delivery', status: 'active', observedAt: 1791900000000 },
    members: [
      { id: 'member:lead', teamId, name: 'Lead', roleKind: 'lead', roleLabel: 'lead', status: 'active' },
      { id: 'member:engineer', teamId, name: 'Engineer', roleKind: 'member', roleLabel: 'engineer', parentMemberId: 'member:lead',
        runtimeKind: 'codex', sourceAgentName: 'Engineer agent', status: 'active', portrait: { look: { character: 'fox', variant: 'blue', accessories: [] }, avatarUrl: null },
        brand: { mark: 'CX', providerName: 'Codex', logo: 'assets/connectors/codex.svg', color: '#187b67', foreground: '#ffffff' } },
      { id: 'member:reviewer', teamId, name: 'Reviewer', roleKind: 'member' },
    ],
    tasks: [
      { id: 'task:open', teamId, title: 'Open issue', state: 'open', priority: 2, ownerMemberId: null, reviewerMemberIds: [], createdAt: 10, updatedAt: 10 },
      { id: 'task:claimed', teamId, title: 'Claimed work', state: 'claimed', priority: 1, ownerMemberId: 'member:engineer', reviewerMemberIds: ['member:reviewer'], createdAt: 20, updatedAt: 30 },
      { id: 'task:working', teamId, title: 'Current work', state: 'working', priority: 0, ownerMemberId: 'member:engineer', reviewerMemberIds: [], createdAt: 30, updatedAt: 50 },
      { id: 'task:review', teamId, title: 'Review work', state: 'review', priority: 1, ownerMemberId: 'member:engineer', reviewerMemberIds: ['member:reviewer'], createdAt: 40, updatedAt: 60 },
      { id: 'task:done', teamId, title: 'Delivered work', state: 'done', priority: 3, ownerMemberId: 'member:lead', reviewerMemberIds: [], createdAt: 50, updatedAt: 70 },
      { id: 'task:blocked', teamId, title: 'Blocked work', state: 'blocked', priority: 0, ownerMemberId: null, reviewerMemberIds: [], createdAt: 60, updatedAt: 80,
        briefPresent: true, privateBrief: '/private/home/user/plan.md' },
    ],
    reviews: [
      { id: 'review:old', taskId: 'task:review', reviewerMemberId: 'member:reviewer', verdict: 'pending', createdAt: 40 },
      { id: 'review:new', taskId: 'task:review', reviewerMemberId: 'member:reviewer', verdict: 'go', createdAt: 60 },
    ],
    revision: 7,
  };
}

const capabilities = { projectSource: { id: 'paperclip', label: 'Paperclip' }, teamTasks: { read: true, write: false } };
const blankBoard = () => ({ filter: 'all', columns: ['idea', 'todo', 'in-progress', 'in-review', 'shipped'].map(id => ({ id, count: 0, cards: [] })) });

test('canonical team tasks project as one read-only project with backend-mapped columns and task metadata', () => {
  const source = snapshot(), [project] = teamProjects(source, capabilities);
  source.privateMemberSessionKeys = { 'member:engineer': 'session:engineer' };
  source.members[1].hostAgentId = 'host:engineer';
  const office = { occupants: [
    tagTeamMember({ sessionKey: 'session:engineer', hostAgentId: 'host:engineer', look: { character: 'otter', variant: 'red', accessories: ['glasses'] } }, 'member:engineer'),
    { hostAgentId: 'host:other', look: { character: 'fox', variant: 'blue', accessories: [] } },
  ] };
  const detail = buildTeamProjectVM(source, project.id, capabilities, {
    portraitForMember: (member, snapshot) => officePortraitForMember(member, snapshot, office),
    runtimeOf: () => ({ providerName: 'Codex CLI', brand: { mark: 'CX', providerName: 'Codex CLI', logo: 'assets/connectors/codex.svg' } }),
  });
  assert.equal(project.id, teamProjects(source, capabilities)[0].id, 'project identity is stable across refreshes');
  assert.equal(project.status, 'in-progress');
  assert.equal(project.name, 'Paperclip Delivery · Lead', 'the team identity remains the project title');
  assert.equal(project.priority, 'P0');
  assert.equal(project.teamProject.readOnly, true, 'read-only is the default unless an adapter declares writes');
  assert.equal(detail.teamProject.taskCount, 6);
  assert.deepEqual(detail.teamProject.summaryLabel, { key: 'project.team.summary', params: { tasks: 6 } });
  assert.equal(detail.teamProject.roster.memberCount, 3);
  const engineer = detail.teamProject.roster.members.find(row => row.id === 'member:engineer');
  assert.deepEqual([engineer.parentId, engineer.parentLabel, engineer.rosterDepth, engineer.roleLabel], ['member:lead', 'Lead', 1, null]);
  assert.deepEqual(engineer.portrait.look, { character: 'otter', variant: 'red', accessories: ['glasses'] },
    'stable member identity joins the canonical OfficeVM appearance and ignores optional snapshot portraits');
  assert.equal(engineer.identity.provider, 'Codex CLI');
  assert.equal(engineer.source.label.params.label, 'Codex CLI');
  assert.equal(engineer.source.brand.providerName, 'Codex CLI');
  assert.equal(detail.sourceDescriptors[0].kind, 'orchestrator-team');
  assert.equal(detail.sourceDescriptors[0].id, 'team-source:paperclip');
  assert.deepEqual(detail.sourceDescriptors[0].label, { key: 'project.source.team', params: { label: 'Paperclip' } });
  assert.deepEqual(detail.teamProject.columns[0].label, { key: 'projectStatus.idea' });
  assert.deepEqual(detail.teamProject.columns.map(row => [row.id, row.count]), [
    ['idea', 0], ['todo', 1], ['in-progress', 3], ['in-review', 1], ['shipped', 1],
  ]);
  const working = detail.teamProject.columns.find(row => row.id === 'in-progress').tasks.find(row => row.id === 'task:claimed');
  assert.deepEqual([working.state, working.column, working.columnLabel], ['claimed', 'in-progress', { key: 'projectStatus.in-progress' }]);
  assert.deepEqual(working.owner, { id: 'member:engineer', name: 'Engineer' });
  assert.deepEqual(working.reviewers, [{ id: 'member:reviewer', name: 'Reviewer', verdict: 'pending', verdictLabel: { key: 'project.taskReview.pending' } }]);
  const reviewed = detail.teamProject.columns.find(row => row.id === 'in-review').tasks[0];
  assert.equal(reviewed.reviewers[0].verdict, 'go', 'latest reviewer verdict wins');
  const serialized = JSON.stringify(detail);
  assert.equal(serialized.includes('/private/home/user/plan.md'), false);
  assert.equal(serialized.includes('privateBrief'), false);
  assert.equal(serialized.includes('briefPresent'), false);
  assert.equal(validate(VM_SCHEMAS.project, detail).ok, true);
  assert.equal(validate(VM_SCHEMAS_V3.project, detail).ok, true);
});

test('canonical Office portrait resolution joins by member ID and ignores source-provided portraits', () => {
  const member = { id: 'member:one', hostAgentId: 'host:shared', portrait: { look: { character: 'fox', variant: 'blue', accessories: [] } } };
  const snapshot = { privateMemberSessionKeys: { 'member:one': 'session:one' } };
  const sessionLook = { character: 'otter', variant: 'red', accessories: [] };
  assert.deepEqual(officePortraitForMember(member, snapshot, { occupants: [
    { id: 'agent:revived', memberId: member.id, sessionKey: 'session:new', look: sessionLook },
    { sessionKey: 'session:one', look: { character: 'fen', variant: 'clay', accessories: [] } },
    { hostAgentId: 'host:shared', look: { character: 'cat', variant: 'green', accessories: [] } },
  ] }), { look: sessionLook, avatarUrl: null }, 'stable member identity wins over stale session and host matches');
  const primaryLook = { character: 'fox', variant: 'gold', accessories: [] };
  const index = { manifest: { characters: [{ id: 'timmy', role: 'main' }, { id: 'cosmo', role: 'subagent' }] },
    characters: new Map([['cosmo', { id: 'cosmo', role: 'subagent', variants: [{ id: 'sage' }] }]]) };
  const fallbackMember = { id: 'member:host-only', hostAgentId: 'host:only' };
  const fallback = officePortraitForMember(fallbackMember, { agents: [{ id: 'host:only' }] },
    { occupants: [{ id: 'primary', role: 'primary', look: primaryLook }] }, { index,
      assignLook: id => ({ character: id === `team-member:${fallbackMember.id}` ? 'cosmo' : 'timmy', variant: 'sage', accessories: [] }) });
  assert.deepEqual(fallback, { look: { character: 'cosmo', variant: 'sage', accessories: [] }, avatarUrl: null },
    'an unmatched host-only member gets a stable member look, never the primary template');
  const derived = officePortraitForMember(fallbackMember, {}, { occupants: [] }, { index });
  assert.deepEqual(officePortraitForMember(fallbackMember, {}, { occupants: [] }, { index }), derived,
    'a missing Office join derives the same appearance from the stable member ID on every projection');
  assert.notEqual(derived.look.character, 'timmy', 'the deterministic fallback excludes the main character');
});

test('stable portrait join prefers the canonical primary when one member ID labels duplicate Office rows', () => {
  const member = { id: 'member:lead' };
  const primaryLook = { character: 'timmy', variant: null, accessories: [] };
  const duplicateLook = { character: 'family-b', variant: 'slate', accessories: [] };
  assert.deepEqual(officePortraitForMember(member, {}, { occupants: [
    { id: 'agent:main', memberId: member.id, role: 'agent', look: duplicateLook },
    { id: 'primary', memberId: member.id, role: 'primary', look: primaryLook },
  ] }), { look: primaryLook, avatarUrl: null }, 'an exact member join uses its canonical primary row instead of a derived fallback');
});

test('team portraits join the Office character by stable member id and never fall back to the primary', () => {
  const member = { id: 'member:revived', name: 'Revived builder', hostAgentId: 'host:revived' };
  const memberLook = { character: 'cosmo', variant: 'sage', accessories: ['scarf'] };
  const primaryLook = { character: 'timmy', variant: null, accessories: ['headphones'] };
  const staleSessionLook = { character: 'fen', variant: 'clay', accessories: [] };
  const occupant = tagTeamMember({ id: 'agent:revived', role: 'subagent', sessionKey: 'new-session',
    look: memberLook }, member.id);
  const office = { occupants: [
    { id: 'primary', role: 'primary', look: primaryLook },
    occupant,
    { id: 'conversation:old-session', sessionKey: 'old-session', look: staleSessionLook },
  ] };
  const snapshot = { privateMemberSessionKeys: { [member.id]: 'old-session' } };
  assert.deepEqual(officePortraitForMember(member, snapshot, office), { look: memberLook, avatarUrl: null },
    'stable member identity takes precedence over a stale session join');
  const fallback = officePortraitForMember(member, snapshot, { occupants: [office.occupants[0]] }, {
    index: { manifest: { characters: [{ id: 'timmy', role: 'main' }, { id: 'cosmo', role: 'subagent' }] },
      characters: new Map([['cosmo', { id: 'cosmo', variants: [{ id: 'sage' }] }]]) },
    assignLook: id => ({ character: id === `team-member:${fallbackMember.id}` ? 'cosmo' : 'timmy', variant: 'sage', accessories: [] }),
  });
  assert.equal(fallback.look.character, 'cosmo', 'unmatched members get a stable member-derived non-primary look');
  assert.notDeepEqual(fallback.look, primaryLook, 'an unmatched team member never inherits the primary look');
});

test('team project omits a role label that duplicates the member name', () => {
  const source = snapshot();
  source.members[0] = { ...source.members[0], name: 'pm', roleLabel: 'pm' };
  const [project] = teamProjects(source, capabilities);
  const lead = project.teamProject.roster.members.find(row => row.id === 'member:lead');
  assert.equal(lead.roleLabel, null);
});

test('team project cards participate in project status filters and disclose no team rows without teams.read', () => {
  const source = snapshot();
  const { buildBoardVM } = require('../../src/projects/vm');
  const boardFor = apiVersion => appendTeamProjects(buildBoardVM([], { filter: 'all', apiVersion }), source,
    { capabilities, filter: 'all' });
  const board = boardFor(3);
  assert.equal(board.columns.find(row => row.id === 'in-progress').cards.length, 1);
  assert.equal(board.columns.find(row => row.id === 'in-progress').cards[0].origin, 'orchestrator-team');
  const teamCard = board.columns.find(row => row.id === 'in-progress').cards[0];
  assert.equal(teamCard.sourceDescriptors[0].id, 'team-source:paperclip');
  assert.deepEqual(teamCard.sourceDescriptors[0].label, { key: 'project.source.team', params: { label: 'Paperclip' } });
  assert.equal(teamCard.name, 'Paperclip Delivery · Lead');
  const sourceFilter = buildBoardVM(teamProjects(source, capabilities), { filter: 'all', apiVersion: 3 }).sourceFilters
    .find(row => row.id === teamCard.sourceDescriptors[0].id);
  assert.deepEqual(sourceFilter.label,
    teamCard.sourceDescriptors[0].label, 'the filter uses the same adapter-declared source label as cards');
  assert.equal(teamCard.counts.agents, 3);
  assert.equal(appendTeamProjects(blankBoard(), source, { capabilities, filter: 'with-agent' }).columns.every(row => row.cards.length === 0), true);
  assert.equal(appendTeamProjects(blankBoard(), source, { capabilities, filter: 'at-risk' }).columns.find(row => row.id === 'in-progress').cards.length, 1);

  const users = new Map();
  const store = { users: { byId: id => users.get(typeof id === 'string' ? id : id?.id) },
    policy: { can: (user, resource) => user.grants.includes(resource) },
    rbac: { fingerprint: id => {
      const user = users.get(id);
      return user ? `${user.id}:${[...user.grants].sort().join(',')}` : null;
    } } };
  const projection = createViewProjection({ store });
  const reader = { id: 'project-reader', status: 'active', grants: ['projects'] };
  users.set(reader.id, reader);
  for (const version of [2, 3]) {
    const rawBoard = boardFor(version);
    const safeBoard = projection.project(reader, 'projects', version === 3 ? { ...rawBoard, agent: null } : rawBoard, { version });
    assert.equal(safeBoard.columns.flatMap(row => row.cards).some(row => row.origin === 'orchestrator-team'), false);
    assert.ok(safeBoard.columns.every(column => column.count === column.cards.length), `v${version}: hidden cards do not leak through pre-filter counts`);
  }
  const admin = { id: 'team-reader', status: 'active', grants: ['projects', 'teams'] };
  users.set(admin.id, admin);
  assert.equal(projection.project(admin, 'projects', { ...boardFor(3), agent: null }, { version: 3 }).columns.flatMap(row => row.cards).length, 1);
  const detail = buildTeamProjectVM(source, teamProjects(source, capabilities)[0].id, capabilities);
  assert.throws(() => projection.project(reader, 'project', detail, { version: 2 }), error => error.code === 'not_found');
  assert.equal(projection.project(admin, 'project', detail, { version: 3 }).teamProject.columns.length, 5);
});

test('team phone navigation default and short people label are backend-authored',()=>{
 const source=snapshot(),project=teamProjects(source)[0],team=buildTeamProjectVM(source,project.id).teamProject;
 const fragment=require('../../docs/architecture/examples/fragments/team-project-navigation.json');
 assert.deepEqual({defaultColumnId:team.defaultColumnId,mobilePeopleLabel:team.mobilePeopleLabel},fragment);
 const review=buildTeamProjectVM({...source,tasks:source.tasks.filter(row=>row.state==='review')},project.id).teamProject;
 assert.equal(review.defaultColumnId,'in-review');
 const empty=buildTeamProjectVM({...source,tasks:[]},project.id).teamProject;assert.equal(empty.defaultColumnId,'idea');
 for(const locale of ['fr','en'])assert.ok(require('../../src/i18n').labelsFor(locale,3)[team.mobilePeopleLabel.key]);
});
