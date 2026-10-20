'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../../src/schema');
const { collectRuntimeProjects, projectId } = require('../../src/projects/runtime-sources');
const { buildBoardVM, buildProjectVM } = require('../../src/projects/vm');
const { VM_SCHEMAS } = require('../../src/api/v2/vm/schemas');

test('runtime adapters contribute private, read-only workspace projects with backend source filters', () => {
  const sessions = [
    { key: 'codex:one', projectRef: 'project:opaque-a', projectLabel: 'compiler', displayName: 'Synthetic compile task', class: { agentId: 'agent:codex-a' }, run: { status: 'running' }, updatedAt: 2000, messageCount: 3 },
    { key: 'codex:two', projectRef: 'project:opaque-a', projectLabel: 'compiler', class: { agentId: 'agent:codex-a' }, run: { status: 'idle' }, updatedAt: 1000, messageCount: 2 },
    { key: 'claude:one', projectRef: 'project:opaque-b', projectLabel: 'documentation', class: { agentId: 'agent:claude-b' }, run: { status: 'idle' }, updatedAt: 3000, messageCount: null },
    { key: 'unregistered:one', projectRef: 'project:opaque-c', projectLabel: 'not contributed', class: { agentId: 'agent:other' }, run: { status: 'idle' }, updatedAt: 4000 },
    { key: 'private:no-project', projectLabel: '/private/user/path', class: { agentId: 'agent:codex-a' }, run: { status: 'running' } },
  ];
  const projectSource = { kind: 'runtime', projectRefField: 'projectRef', projectLabelField: 'projectLabel',
    capabilities: { read: true, write: false, comments: 'unsupported', history: 'unsupported', repository: 'unsupported' } };
  const connectors = {
    'codex:one': { id: 'runtime-codex', adapter: 'codex', name: 'Codex', projectSource, mark: { monogram: 'CX', providerName: 'Codex', logo: 'assets/connectors/codex.svg', color: '#187b67' } },
    'codex:two': { id: 'runtime-codex', adapter: 'codex', name: 'Codex', projectSource, mark: { monogram: 'CX', providerName: 'Codex', logo: 'assets/connectors/codex.svg', color: '#187b67' } },
    'claude:one': { id: 'runtime-claude', adapter: 'claude-code', name: 'Claude Code', projectSource, mark: { monogram: 'CC', providerName: 'Claude Code', color: '#a34a2c' } },
  };
  const result = collectRuntimeProjects({ sessions, agents: [
    { id: 'agent:codex-a', name: 'Builder' }, { id: 'agent:claude-b', name: 'Reviewer' },
  ], connectorOf: key => connectors[key] || null, idKey: 'synthetic-instance-secret-for-test' });
  assert.equal(result.projects.length, 2);
  assert.deepEqual(result.projects.map(row => row.name), ['compiler', 'documentation']);
  const codexProject = result.projects.find(row => row.name === 'compiler');
  assert.ok(result.persons.every(person => /^per_runtime_[a-f0-9]{24}$/.test(person.id)),
    'runtime-derived people use the canonical project-person ID format');
  assert.equal(codexProject.sessionCount, 2);
  assert.equal(codexProject.agentCount, 1);
  assert.equal(codexProject.activityCount, 5);
  assert.equal(codexProject.summary, 'Synthetic compile task', 'detail context comes from the newest session title');
  assert.equal(codexProject.status, 'in-progress');
  assert.equal(codexProject.readOnly, true);
  assert.match(codexProject.sourceDescriptors[0].id, /^runtime:/);
  assert.equal(codexProject.id, projectId('runtime-codex', 'project:opaque-a', 'synthetic-instance-secret-for-test'));
  assert.notEqual(codexProject.id, projectId('runtime-codex', 'project:opaque-a', 'different-instance-secret-for-test'));
  assert.notEqual(codexProject.id, 'runtimeprj_' + require('node:crypto').createHash('sha256').update('runtime-codex\0project:opaque-a').digest('hex').slice(0, 24));
  assert.throws(() => projectId('runtime-codex', 'project:opaque-a'), /key required/);
  assert.equal(codexProject.runtimeProject.projectRef, 'project:opaque-a');

  const board = buildBoardVM(result.projects, { filter: 'all', persons: result.persons });
  assert.equal(board.sourceFilters.length, 2);
  const source = codexProject.sourceDescriptors[0].id;
  const card=board.columns.flatMap(row=>row.cards).find(row=>row.id===codexProject.id);
  const filtered = buildBoardVM(result.projects, { filter: 'all', sourceFilterId: source, persons: result.persons });
  assert.equal(filtered.sourceFilters.find(row => row.id === source).selected, true);
  assert.equal(filtered.columns.reduce((n, row) => n + row.count, 0), 1);
  assert.equal(schema.validate(VM_SCHEMAS.projects, board).ok, true);
  assert.equal(schema.validate(VM_SCHEMAS.projects, filtered).ok, true);

  const detail = buildProjectVM(codexProject, [], { persons: result.persons,
    sessionCounts: { runtime: { sessionCount: codexProject.sessionCount } } });
  assert.deepEqual(detail.sourceDescriptors, codexProject.sourceDescriptors, 'detail preserves adapter-declared runtime and brand metadata');
  assert.deepEqual(detail.sourceDescriptors,card.sourceDescriptors,'list and detail expose the same generic connector descriptor');
  assert.equal(detail.capabilities.write, false);
  assert.equal(detail.capabilities.history, 'unsupported');
  assert.deepEqual(detail.counts, { sessions: 2, agents: 1, activity: 5 });
  assert.equal(schema.validate(VM_SCHEMAS.project, detail).ok, true);
  assert.equal(JSON.stringify({ board, detail }).includes('/private/user/path'), false);
  assert.equal(JSON.stringify({ board, detail }).includes('project:opaque-a'), false);
});
