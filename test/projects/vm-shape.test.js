'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildBoardVM, buildProjectVM, buildCandidatesVM, buildHistoryPage, projectConflictBody, commands } = require('../../src/projects');
const { compareExample, loadExample } = require('../helpers/contract-shape');
const { AT, repository } = require('./helpers');
const { validate } = require('../../src/schema');
const { VM_SCHEMAS_V3 } = require('../../src/api/v2/vm/schemas');

const ownerId = 'per_alex00000000000';
const timmyId = 'per_0a1b2c3d4e5f6g7h';
const gitId = 'per_9g8f7e6d5c4b3a21';

const persons = [
  { id: ownerId, kind: 'human', name: 'owner', avatarUrl: null, links: {} },
  { id: timmyId, kind: 'agent', name: 'Timmy', avatarUrl: null, links: { agentId: 'main' } },
  { id: gitId, kind: 'git', name: 'inconnu', avatarUrl: null, links: {} },
];

function shapeProject() {
  return {
    id: 'prj_k3v9q2m8x1c4d7fz',
    revision: 8,
    name: 'Agent Office',
    status: 'in-progress',
    priority: 'P1',
    archivedAt: null,
    summary: 'Refonte',
    summaryMeta: { author: { kind: 'agent', personId: timmyId }, at: AT },
    lastActivityAt: AT,
    createdAt: AT - 1000,
    flags: [
      { kind: 'priority', key: 'P1', label: 'P1' },
      { kind: 'risk', key: 'ci-red', label: 'CI rouge', severity: 'medium', origin: 'auto', ack: null, clearedAt: null },
      { kind: 'feature', key: 'office-v2', state: 'on' },
      { kind: 'label', key: 'interne', label: 'interne' },
    ],
    sources: [
      { id: 'src_gh', kind: 'github', ref: { owner: 'example-org', repo: 'agent-office-oss' }, addedAt: AT - 4 },
      { id: 'src_ws', kind: 'workspace', ref: { path: 'dev/project/agent-office-redesign' }, addedAt: AT - 3 },
      { id: 'src_sg', kind: 'sessionGroup', ref: loadExample('project-vm').data.sources.find((s) => s.kind === 'sessionGroup').ref, addedAt: AT - 2 },
      { id: 'src_man', kind: 'manual', ref: null, addedAt: AT - 1 },
    ],
    repoStatus: { state: 'ok', lastError: null },
    repo: {
      url: 'https://github.com/example-org/agent-office-oss',
      owner: 'example-org',
      name: 'agent-office-oss',
      defaultBranch: 'main',
      image: { kind: 'opengraph', url: 'https://opengraph.githubassets.com/1/example-org/agent-office-oss' },
      ci: { state: 'failing', at: AT, url: 'https://github.com/example-org/agent-office-oss/actions/runs/1' },
      commits: [{ sha: '3782a7b', at: AT, author: { name: 'owner', personId: null }, message: 'Service unit' }],
      fetchedAt: AT,
    },
    people: [
      { personId: ownerId, role: 'responsable', origin: 'manual', commitCount: 12 },
      { personId: timmyId, role: null, origin: 'derived', liveState: 'working', commitCount: null },
      { personId: gitId, role: null, origin: 'derived', commitCount: 2 },
    ],
  };
}

function historyEvents() {
  const Owner = { kind: 'human', personId: ownerId };
  const timmy = { kind: 'agent', personId: timmyId };
  return [
    { id: 'evt_status', at: AT, kind: 'status', actor: Owner, from: 'todo', to: 'in-progress' },
    { id: 'evt_c1', at: AT - 1, kind: 'commit', actor: Owner, branch: 'main', sha: 'aaa' },
    { id: 'evt_c2', at: AT - 2, kind: 'commit', actor: Owner, branch: 'main', sha: 'bbb' },
    { id: 'evt_c3', at: AT - 3, kind: 'commit', actor: Owner, branch: 'main', sha: 'ccc' },
    { id: 'evt_risk', at: AT - 4, kind: 'risk-raised', actor: { kind: 'system', component: 'monitor' }, key: 'ci-red' },
    {
      id: 'evt_flow', at: AT - 5, kind: 'flow-run', actor: timmy,
      jobId: 'veille', status: 'succeeded', durationMs: 128000,
    },
  ];
}

describe('view models match the 2.4 examples', () => {
  it('projects search/stage controls and labelled board columns in v3 only', () => {
    const projects = [shapeProject(), { ...shapeProject(), id: 'prj_other', name: 'Other', status: 'todo' }];
    const v3 = buildBoardVM(projects, { apiVersion: 3, search: 'Office', stage: 'in-progress' });
    assert.equal(v3.controls.search.selected, 'Office');
    assert.deepEqual(v3.controls.search.counts, [{ id: 'matches', count: 1 }]);
    assert.equal(v3.controls.stage.selected, 'in-progress');
    assert.deepEqual(v3.controls.stage.options.map(option => option.id), ['all', 'idea', 'todo', 'in-progress', 'in-review', 'shipped']);
    assert.deepEqual(v3.columns.map(column => [column.id, column.label.key, column.taskCount, column.summaryLabel]), [
      ['idea', 'projectStatus.idea', 0, { key: 'project.board.column.summary', params: { n: 0 } }],
      ['todo', 'projectStatus.todo', 0, { key: 'project.board.column.summary', params: { n: 0 } }],
      ['in-progress', 'projectStatus.in-progress', 1, { key: 'project.board.column.summary', params: { n: 1 } }],
      ['in-review', 'projectStatus.in-review', 0, { key: 'project.board.column.summary', params: { n: 0 } }],
      ['shipped', 'projectStatus.shipped', 0, { key: 'project.board.column.summary', params: { n: 0 } }],
    ]);
    assert.equal(validate(VM_SCHEMAS_V3.projects, { ...v3, filter: 'all', agent: null }).ok, true);
    const v2 = buildBoardVM(projects);
    assert.equal(Object.hasOwn(v2, 'controls'), false);
    assert.equal(Object.hasOwn(v2.columns[0], 'label'), false);
    assert.equal(v2.columns.find(column => column.id === 'in-progress').cards.length, 1,
      'v2 keeps the established all-stage projection');
  });

  it('buildProjectVM matches project-vm.json', () => {
    const vm = buildProjectVM(shapeProject(), historyEvents(), {
      persons,
      liveStates: { [timmyId]: 'working' },
      nextCursor: 'eyJhdCI6MTc5MTIxODAwMDAwMCwiaWQiOiJldnRfZjEifQ',
      jobNames: { veille: 'Veille hebdomadaire' },
      sessionCounts: { src_ws: { sessionCount: 14 }, src_sg: { sessionCount: 3 } },
    });
    assert.deepEqual(compareExample('project-vm', vm), []);
    const exampleGroup = loadExample('project-vm').data.sources.find((s) => s.kind === 'sessionGroup');
    assert.equal(exampleGroup.ref.by, 'group');
    assert.deepEqual(vm.sources.find((s) => s.kind === 'sessionGroup').ref, exampleGroup.ref);
    assert.equal(vm.sources.find((s) => s.kind === 'sessionGroup').label, exampleGroup.ref.name);
    assert.equal(vm.recentHistory.find((e) => e.kind === 'commit').group, 3);
    assert.equal(vm.recentHistory.find((e) => e.kind === 'flow-run').text.params.duration, 'PT2M8S');
    assert.equal(vm.recentHistory.find((e) => e.kind === 'risk-raised').actor.name, 'Système');
  });

  it('buildBoardVM matches board-vm.json', () => {
    const project = shapeProject();
    project.flags = project.flags.filter((f) => f.kind !== 'label');
    project.people = project.people.filter((p) => p.personId === timmyId);
    const board = buildBoardVM([project], { filter: 'all', persons, liveStates: { [timmyId]: 'working' } });
    assert.deepEqual(compareExample('board-vm', board), []);
    const card = board.columns.find((c) => c.id === 'in-progress').cards[0];
    assert.equal(card.status, 'in-progress');
    assert.equal(card.statusLabel.key, 'projectStatus.in-progress');
    assert.deepEqual(card.counts, { sessions: null, agents: 1, activity: null });
    assert.equal(board.sourceFilters.length, 4);
    assert.equal(board.sourceFilters.some(row => row.selected), false);
    const other = { ...project, id: 'prj_other_opaque', name: 'Other', sources: [{ id: 'src_other', kind: 'manual', ref: null, addedAt: AT }] };
    const filtered = buildBoardVM([project, other], { filter: 'all', persons, sourceFilterId: 'source:github:example-org' });
    assert.equal(filtered.columns.flatMap(row => row.cards).length, 1, 'source selection determines server membership');
    assert.equal(filtered.sourceFilters.find(row => row.id === 'source:github:example-org').selected, true);
    assert.equal(filtered.sourceFilters.find(row => row.id === 'source:manual').count, 2);
    assert.throws(() => buildBoardVM([project], { filter: 'all', sourceFilterId: 'missing' }), /Filtre de source invalide/);
    const unresolved = buildBoardVM([project], { filter: 'all', sourceFilterId: 'missing', allowUnknownSourceFilter: true });
    assert.equal(unresolved.sourceFilterId, 'missing');
    assert.equal(unresolved.columns.every(column => column.cards.length === 0 && column.count === 0), true);
  });

  it('buildCandidatesVM matches candidates-vm.json', () => {
    const vm = buildCandidatesVM([{
      key: 'gh:example-org/agent-office-oss',
      name: 'Agent Office',
      summary: 'Tableau de bord de Timmy.',
      status: 'in-progress',
      confidence: 'high',
      reason: 'Activité dans les 14 derniers jours.',
      labels: [{ key: 'perso', label: 'perso' }],
      sources: [
        { kind: 'github', ref: { owner: 'example-org', repo: 'agent-office-oss' } },
        { kind: 'workspace', ref: { path: 'dev/project/agent-office-redesign' } },
        { kind: 'sessionGroup', ref: loadExample('candidates-vm').data.candidates[0].sources.find((s) => s.kind === 'sessionGroup').ref },
      ],
      lastActivityAt: AT,
    }], { scannedAt: AT });
    assert.deepEqual(compareExample('candidates-vm', vm), []);
    const exampleGroup = loadExample('candidates-vm').data.candidates[0].sources.find((s) => s.kind === 'sessionGroup');
    assert.equal(exampleGroup.ref.by, 'group');
    assert.deepEqual(vm.candidates[0].sources.find((s) => s.kind === 'sessionGroup').ref, exampleGroup.ref);
    assert.equal(vm.candidates[0].id, vm.candidates[0].key);
    assert.equal(vm.candidates[0].suggestedStatus, 'in-progress');
  });

  it('importCandidates matches import-result.json', () => {
    const repo = repository();
    const result = commands.importCandidates(repo, {
      at: AT,
      candidates: [{
        key: 'gh:example-org/agent-office-oss',
        name: 'Agent Office',
        summary: '',
        status: 'todo',
        labels: [],
        sources: [{ kind: 'github', ref: { owner: 'example-org', repo: 'agent-office-oss' } }],
        lastActivityAt: AT,
      }],
      keys: ['gh:example-org/agent-office-oss', 'sg:discord-user:100000000000000001'],
    });
    assert.deepEqual(compareExample('import-result', result), []);
    assert.deepEqual(Object.keys(result.result.created[0]).sort(), ['id', 'key']);
    assert.deepEqual(Object.keys(result.result.skipped[0]).sort(), ['key', 'reason']);
  });

  it('buildHistoryPage matches history-page.json', () => {
    const Owner = { kind: 'human', personId: ownerId };
    const page = buildHistoryPage([
      { id: 'evt_archived', at: AT, kind: 'archived', actor: Owner },
      { id: 'evt_people', at: AT - 1, kind: 'people-override', actor: Owner, personId: timmyId, role: 'développeur', hidden: false },
      { id: 'evt_created', at: AT - 2, kind: 'project-created', actor: Owner },
    ], { persons, nextCursor: null });
    assert.deepEqual(compareExample('history-page', page), []);
    assert.equal(page.items.find((e) => e.kind === 'people-override').text.params.person, 'Timmy');
  });

  it('a stale write matches error-409-project.json', () => {
    const vm = buildProjectVM(shapeProject(), historyEvents(), {
      persons,
      liveStates: { [timmyId]: 'working' },
      nextCursor: 'eyJhdCI6MTc5MTIxODAwMDAwMCwiaWQiOiJldnRfZjEifQ',
      jobNames: { veille: 'Veille hebdomadaire' },
      sessionCounts: { src_ws: { sessionCount: 14 }, src_sg: { sessionCount: 3 } },
    });
    const body = projectConflictBody({ requestId: 'req_8f2c1a', vm });
    assert.deepEqual(compareExample('error-409-project', body), []);
    assert.equal(body.error.current.revision, vm.revision);
    assert.equal(body.error.current.vm, vm);
  });
});
