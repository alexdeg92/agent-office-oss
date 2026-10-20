'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadScenario } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');
const { openSse } = require('../helpers/sse-client');

function seedTeam(tmp, { env }) {
  const root = path.join(tmp, 'team-source-fixture');
  fs.mkdirSync(path.join(root, 'members'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
  const pm = 'member:12345678-1111-4111-8111-123456789abc';
  const engineer = 'member:12345678-2222-4222-8222-123456789abc';
  const reviewer = 'member:12345678-3333-4333-8333-123456789abc';
  fs.writeFileSync(path.join(root, 'members', 'lead.json'), JSON.stringify({ id: pm, name: 'Project Manager', role: 'lead' }));
  fs.writeFileSync(path.join(root, 'members', 'engineer.json'), JSON.stringify({ id: engineer, name: 'Engineer', role: 'engineer', runtime: 'codex', spawnedBy: pm }));
  fs.writeFileSync(path.join(root, 'members', 'reviewer.json'), JSON.stringify({ id: reviewer, name: 'Reviewer', role: 'reviewer', runtime: 'claude', spawnedBy: pm }));
  fs.writeFileSync(path.join(root, 'tasks', 'T-0001.json'), JSON.stringify({
    id: 'T-0001', title: 'Build the project dashboard', state: 'claimed', owner: 'Engineer', prio: 1,
    reviewers: { Reviewer: null }, created_by: 'Project Manager', created: '2026-10-10T10:00:00Z',
    updated: '2026-10-10T10:05:00Z', after: [], history: [], reviews: [],
  }));
  fs.writeFileSync(path.join(root, 'tasks', 'T-0002.json'), JSON.stringify({
    id: 'T-0002', title: 'Review the release', state: 'review', owner: 'Engineer', prio: 2,
    reviewers: ['Reviewer'], created_by: 'Project Manager', created: '2026-10-10T10:00:00Z',
    updated: '2026-10-10T10:06:00Z', after: [], history: [],
    reviews: [{ ts: '2026-10-10T10:06:00Z', by: 'Reviewer', verdict: 'go', note: 'PRIVATE_NOTE_CANARY', report: '/private/home/report.md' }],
    brief: 'PRIVATE_BRIEF_CANARY /private/home/brief.md',
  }));
  env.AO_TEAM_STORE_ROOT = root;
}

test('orchestrator team work appears as a read-only project with mapped task cards in v2 and v3', async t => {
  const h = await startServer(loadScenario('synthetic-basic'), { prepare: seedTeam });
  t.after(() => h.stop());
  await waitFor(async () => {
    const response = await h.get('/api/v2/views/projects');
    return response.json?.data?.columns?.some(column => column.cards.some(row => row.origin === 'orchestrator-team'));
  }, { what: 'the canonical team project after its read-only source scan' });
  for (const [name, status] of [['Control probe todo', 'todo'], ['Control probe active', 'in-progress']]) {
    const created = await h.post('/api/v3/projects', { name, status, priority: 'P2', summary: null, sources: [] });
    assert.equal(created.status, 200, created.text);
  }
  for (const version of [2, 3]) {
    const board = await h.get(`/api/v${version}/views/projects`);
    assert.equal(board.status, 200, board.text);
    const cards = board.json.data.columns.flatMap(column => column.cards);
    const card = cards.find(row => row.origin === 'orchestrator-team');
    assert.ok(card, `v${version} includes a backend-projected team project`);
    assert.equal(card.teamProject.readOnly, true, 'the source has no declared task-write capability');
    assert.equal(card.teamProject.taskCount, 2);
    assert.equal(card.statusLabel.key, `projectStatus.${card.status}`);
    assert.equal(card.counts.agents, 3);
    assert.equal(card.sourceDescriptors[0].kind, 'orchestrator-team');
    assert.equal(card.sourceDescriptors[0].id, 'team-source:agent-team-pm');
    assert.deepEqual(card.sourceDescriptors[0].label,
      { key: 'project.source.team', params: { label: 'Agent Team PM' } });
    assert.equal(card.name, 'Team · Project Manager', 'the project title keeps the team label and lead identity');
    assert.deepEqual(card.capabilities, { read: true, write: false, comments: 'read-only', history: 'unsupported', repository: 'unsupported' });
    const sourceFilter = board.json.data.sourceFilters.find(row => row.id === card.sourceDescriptors[0].id);
    assert.ok(sourceFilter && !sourceFilter.selected);
    assert.deepEqual(sourceFilter.label, card.sourceDescriptors[0].label);
    if (version === 3) {
      assert.deepEqual(board.json.data.columns[0].label, { key: 'projectStatus.idea' });
      assert.equal(board.json.data.columns[0].taskCount, board.json.data.columns[0].count);
      assert.deepEqual(board.json.data.columns[0].summaryLabel,
        { key: 'project.board.column.summary', params: { n: board.json.data.columns[0].count } });
      assert.deepEqual(board.json.data.controls.stage.selected, 'all');
      assert.equal(board.json.data.controls.search.counts[0].count, cards.length,
        'the empty search describes every card on the unfiltered board');
      const queried = await h.get(`/api/v3/views/projects?search=${encodeURIComponent(card.name)}&stage=in-progress`);
      assert.equal(queried.status, 200, queried.text);
      assert.equal(queried.json.data.controls.search.selected, card.name);
      assert.equal(queried.json.data.controls.stage.selected, 'in-progress');
      assert.deepEqual(queried.json.data.columns.find(row => row.id === 'in-progress').cards.map(row => row.id), [card.id]);
      assert.equal(queried.json.data.columns.find(row => row.id === 'todo').cards.length, 0);
      const controlled = await h.get('/api/v3/views/projects?search=Control%20probe&stage=todo');
      assert.equal(controlled.status, 200, controlled.text);
      assert.equal(controlled.json.data.controls.search.counts[0].count, 2,
        'search match count is from the pre-stage population even after the mounted v3 topic builder shapes the VM');
      assert.deepEqual(controlled.json.data.controls.stage.counts.filter(row => ['todo', 'in-progress'].includes(row.id)),
        [{ id: 'todo', count: 1 }, { id: 'in-progress', count: 1 }]);
      const controlsTopic = 'projects?search=Control%20probe&stage=todo';
      const controlsStream = openSse(h.base, `/api/v3/stream?topics=${encodeURIComponent(controlsTopic)}`, { cookie: h.cookie });
      t.after(() => controlsStream.close());
      const controlsFrame = await controlsStream.next(frame => frame.event === 'snapshot' && frame.data.topic === controlsTopic);
      assert.equal(controlsFrame.data.data.controls.search.counts[0].count, 2,
        'mounted SSE preserves the same non-enumerable pre-stage metadata as HTTP');
      const accented = 'é'.repeat(60);
      const accentedQuery = await h.get(`/api/v3/views/projects?search=${encodeURIComponent(accented)}`);
      assert.equal(accentedQuery.status, 200, accentedQuery.text, 'legal Unicode search fits the HTTP route and canonical topic bounds');
      assert.deepEqual(accentedQuery.json.data.controls.search, {
        options: [{ id: 'project-name', label: { key: 'project.control.search.name' } }],
        counts: [{ id: 'matches', count: 0 }], selected: accented,
      });
      const searchTopic = `projects?search=${encodeURIComponent(accented)}`;
      const searchStream = openSse(h.base, `/api/v3/stream?topics=${encodeURIComponent(searchTopic)}`, { cookie: h.cookie });
      t.after(() => searchStream.close());
      const searchFrame = await searchStream.next(frame => frame.event === 'snapshot' && frame.data.topic === searchTopic);
      assert.deepEqual(searchFrame.data.data.controls.search.selected, accented, 'the same legal Unicode search is accepted by SSE topic parsing');
      const invalidV2 = await h.get('/api/v2/views/projects?stage=in-progress');
      assert.equal(invalidV2.status, 400, invalidV2.text, 'v2 refuses v3-only query controls');
    }
    const filtered = await h.get(`/api/v${version}/views/projects?source=${encodeURIComponent(card.sourceDescriptors[0].id)}`);
    assert.equal(filtered.status, 200, filtered.text);
    assert.equal(filtered.json.data.sourceFilterId, card.sourceDescriptors[0].id);
    assert.equal(filtered.json.data.sourceFilters.find(row => row.id === card.sourceDescriptors[0].id).selected, true);
    assert.ok(filtered.json.data.columns.flatMap(column => column.cards).some(row => row.id === card.id));

    const detail = await h.get(`/api/v${version}/views/projects/${encodeURIComponent(card.id)}`);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.json.data.name, 'Team · Project Manager', 'the adapter source label must not replace the team project title');
    assert.deepEqual(detail.json.data.sourceDescriptors[0].label, card.sourceDescriptors[0].label,
      'detail and board agree on the adapter-declared source identity');
    const teamProject = detail.json.data.teamProject;
    assert.equal(teamProject.readOnly, true);
    assert.equal(teamProject.taskCount, 2);
    assert.equal(teamProject.roster.memberCount, 3);
    assert.deepEqual(teamProject.roster.members.map(row => [row.identity.name, row.order]), [
      ['Project Manager', 0], ['Engineer', 1], ['Reviewer', 2],
    ]);
    assert.equal(teamProject.roster.members[1].parentLabel, 'Project Manager');
    assert.equal(teamProject.roster.members[1].rosterDepth, 1);
    assert.equal(teamProject.columns[0].label.key, 'projectStatus.idea');
    assert.deepEqual(teamProject.capabilities, { comments: 'read-only', history: 'unsupported', repository: 'unsupported' });
    assert.deepEqual(card.capabilities, { read: true, write: false, comments: 'read-only', history: 'unsupported', repository: 'unsupported' },
      'read-only action capabilities agree between board card and detail');
    assert.deepEqual(detail.json.data.capabilities, card.capabilities, 'shared project capability projection stays consistent on board and detail');
    assert.deepEqual(teamProject.columns.map(row => [row.id, row.count]), [
      ['idea', 0], ['todo', 0], ['in-progress', 1], ['in-review', 1], ['shipped', 0],
    ]);
    const claimed = teamProject.columns.find(row => row.id === 'in-progress').tasks[0];
    assert.deepEqual([claimed.state, claimed.column, claimed.priority, claimed.owner.name], ['claimed', 'in-progress', 'P1', 'Engineer']);
    const reviewed = teamProject.columns.find(row => row.id === 'in-review').tasks[0];
    assert.equal(reviewed.reviewers[0].verdict, 'go');
    const serialized = JSON.stringify([board.json.data, detail.json.data]);
    assert.equal(serialized.includes('PRIVATE_NOTE_CANARY'), false);
    assert.equal(serialized.includes('PRIVATE_BRIEF_CANARY'), false);
    assert.equal(serialized.includes('/private/home/report.md'), false);
    assert.equal(serialized.includes('/private/home/brief.md'), false);

    const comments = await h.get(`/api/v${version}/views/projects/${encodeURIComponent(card.id)}/comments`);
    assert.equal(comments.status, 200, comments.text);
    assert.deepEqual(comments.json.data, { projectId: card.id, items: [], nextCursor: null,
      mentionable: [], canComment: false, canMention: false, session: null });
    const stream = openSse(h.base, `/api/v${version}/stream?topics=${encodeURIComponent('comments:' + card.id)}`, { cookie: h.cookie });
    t.after(() => stream.close());
    const hello = await stream.next(frame => frame.event === 'hello');
    assert.ok(hello.data.topics.includes('comments:' + card.id), 'verified RBAC-off owner keeps team comments access');
    const snapshot = await stream.next(frame => frame.event === 'snapshot' && frame.data.topic === 'comments:' + card.id);
    assert.deepEqual(snapshot.data.data, comments.json.data);
    const write = await h.post(`/api/v${version}/projects/${encodeURIComponent(card.id)}/comments`, { body: 'Should remain read-only' });
    assert.equal(write.status, 403, write.text);
  }
});
