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
    assert.deepEqual(card.capabilities, { read: true, write: false, comments: 'read-only', history: 'unsupported', repository: 'unsupported' });
    assert.ok(board.json.data.sourceFilters.some(row => row.id === card.sourceDescriptors[0].id && row.selected === false));
    const filtered = await h.get(`/api/v${version}/views/projects?source=${encodeURIComponent(card.sourceDescriptors[0].id)}`);
    assert.equal(filtered.status, 200, filtered.text);
    assert.equal(filtered.json.data.sourceFilterId, card.sourceDescriptors[0].id);
    assert.equal(filtered.json.data.sourceFilters.find(row => row.id === card.sourceDescriptors[0].id).selected, true);
    assert.ok(filtered.json.data.columns.flatMap(column => column.cards).some(row => row.id === card.id));

    const detail = await h.get(`/api/v${version}/views/projects/${encodeURIComponent(card.id)}`);
    assert.equal(detail.status, 200, detail.text);
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
