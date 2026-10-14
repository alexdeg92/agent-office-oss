'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('../../src/schema');
const { VM_SCHEMAS, VM_SCHEMAS_V3 } = require('../../src/api/v2/vm/schemas');
const { teamProjects, appendTeamProjects, buildTeamProjectVM } = require('../../src/projects/orchestrator-teams');
const { createViewProjection } = require('../../src/security/view-projection');

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

const capabilities = { teamTasks: { read: true, write: false } };
const blankBoard = () => ({ filter: 'all', columns: ['idea', 'todo', 'in-progress', 'in-review', 'shipped'].map(id => ({ id, count: 0, cards: [] })) });

test('canonical team tasks project as one read-only project with backend-mapped columns and task metadata', () => {
  const source = snapshot(), [project] = teamProjects(source, capabilities);
  const detail = buildTeamProjectVM(source, project.id, capabilities);
  assert.equal(project.id, teamProjects(source, capabilities)[0].id, 'project identity is stable across refreshes');
  assert.equal(project.status, 'in-progress');
  assert.equal(project.priority, 'P0');
  assert.equal(project.teamProject.readOnly, true, 'read-only is the default unless an adapter declares writes');
  assert.equal(detail.teamProject.taskCount, 6);
  assert.deepEqual(detail.teamProject.summaryLabel, { key: 'project.team.summary', params: { tasks: 6 } });
  assert.equal(detail.teamProject.roster.memberCount, 3);
  const engineer = detail.teamProject.roster.members.find(row => row.id === 'member:engineer');
  assert.deepEqual([engineer.parentId, engineer.parentLabel, engineer.rosterDepth, engineer.roleLabel], ['member:lead', 'Lead', 1, 'engineer']);
  assert.equal(engineer.identity.provider, 'codex');
  assert.deepEqual(engineer.portrait.look, { character: 'fox', variant: 'blue', accessories: [] });
  assert.equal(engineer.source.brand.providerName, 'Codex');
  assert.equal(detail.sourceDescriptors[0].kind, 'orchestrator-team');
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

test('team project cards participate in project status filters and disclose no team rows without teams.read', () => {
  const source = snapshot();
  const cardBoard = require('../../src/projects/vm').buildBoardVM([], { filter: 'all' });
  const board = appendTeamProjects({ ...cardBoard, columns: cardBoard.columns.map(row => ({ ...row, cards: [...row.cards] })) }, source,
    { capabilities, filter: 'all' });
  assert.equal(board.columns.find(row => row.id === 'in-progress').cards.length, 1);
  assert.equal(board.columns.find(row => row.id === 'in-progress').cards[0].origin, 'orchestrator-team');
  const teamCard = board.columns.find(row => row.id === 'in-progress').cards[0];
  assert.equal(teamCard.sourceDescriptors[0].id, `team-source:${source.team.id}`);
  assert.equal(teamCard.counts.agents, 3);
  assert.equal(appendTeamProjects(blankBoard(), source, { capabilities, filter: 'with-agent' }).columns.every(row => row.cards.length === 0), true);
  assert.equal(appendTeamProjects(blankBoard(), source, { capabilities, filter: 'at-risk' }).columns.find(row => row.id === 'in-progress').cards.length, 1);

  const users = new Map();
  const store = { users: { byId: id => users.get(typeof id === 'string' ? id : id?.id) },
    policy: { can: (user, resource) => user.grants.includes(resource) } };
  const projection = createViewProjection({ store });
  const reader = { id: 'project-reader', status: 'active', grants: ['projects'] };
  users.set(reader.id, reader);
  for (const version of [2, 3]) {
    const safeBoard = projection.project(reader, 'projects', version === 3 ? { ...board, agent: null } : board, { version });
    assert.equal(safeBoard.columns.flatMap(row => row.cards).some(row => row.origin === 'orchestrator-team'), false);
    assert.ok(safeBoard.columns.every(column => column.count === column.cards.length), `v${version}: hidden cards do not leak through pre-filter counts`);
  }
  const admin = { id: 'team-reader', status: 'active', grants: ['projects', 'teams'] };
  users.set(admin.id, admin);
  assert.equal(projection.project(admin, 'projects', { ...board, agent: null }, { version: 3 }).columns.flatMap(row => row.cards).length, 1);
  const detail = buildTeamProjectVM(source, teamProjects(source, capabilities)[0].id, capabilities);
  assert.throws(() => projection.project(reader, 'project', detail, { version: 2 }), error => error.code === 'not_found');
  assert.equal(projection.project(admin, 'project', detail, { version: 3 }).teamProject.columns.length, 5);
});
