'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildBoardVM, buildProjectVM, presentHistory, compareCards, buildCandidatesVM } = require('../../src/projects');
const { initials } = require('../../src/projects/vm');
const { commands } = require('../../src/projects');
const { hashEmail } = require('../../src/projects/email');
const { AT, repository, Owner, timmy } = require('./helpers');

function board(repo, filter) {
  return buildBoardVM(repo.listProjects({ archived: 'include' }), {
    filter,
    persons: repo.listPersons(),
    timmyPersonId: 'per_timmymain000000',
    liveStates: { per_timmymain000000: 'working' },
  });
}

describe('project view models', () => {
  it('supplies canonical labelled initial import stages even with no discoveries', () => {
    const vm = buildCandidatesVM([], { scannedAt: AT });
    assert.deepEqual(vm.statusOptions, ['idea','todo','in-progress','in-review','shipped'].map(id => ({ id, label: { key: 'projectStatus.' + id } })));
  });

  it('supplies labelled status destinations and no choices for read-only sources', () => {
    const repo = repository(), project = commands.createProject(repo, { name: 'Transitions', actor: 'owner', at: AT });
    for (const status of ['idea', 'todo', 'in-progress', 'in-review', 'shipped']) {
      const vm = buildProjectVM({ ...project, status }, []);
      assert.deepEqual(vm.statusLabel, { key: 'projectStatus.' + status });
      assert.deepEqual(vm.statusTransitions, ['idea', 'todo', 'in-progress', 'in-review', 'shipped']
        .filter(id => id !== status).map(id => ({ id, label: { key: 'projectStatus.' + id } })));
      assert.deepEqual(buildProjectVM({ ...project, status, readOnly: true }, []).statusTransitions, []);
    }
  });

  it('orders cards by priority, then last activity, then id', () => {
    const repo = repository();
    const low = commands.createProject(repo, { name: 'Zed', priority: 'P2', actor: 'owner', at: AT });
    const hot = commands.createProject(repo, { name: 'Alpha', priority: 'P0', actor: 'owner', at: AT + 1 });
    const newer = commands.createProject(repo, { name: 'Mid', priority: 'P2', actor: 'owner', at: AT + 5 });
    commands.setStatus(repo, { id: low.id, expectedRevision: 1, status: 'todo', actor: 'owner', at: AT + 10 });
    commands.setStatus(repo, { id: hot.id, expectedRevision: 1, status: 'todo', actor: 'owner', at: AT + 2 });
    commands.setStatus(repo, { id: newer.id, expectedRevision: 1, status: 'todo', actor: 'owner', at: AT + 8 });
    const column = board(repo).columns.find((c) => c.id === 'todo');
    assert.deepEqual(column.cards.map((c) => c.name), ['Alpha', 'Zed', 'Mid']);
    assert.equal(column.count, 3);
    assert.deepEqual(board(repo).columns.map((c) => c.id), ['idea', 'todo', 'in-progress', 'in-review', 'shipped']);
    const again = [hot, newer, low].sort(compareCards);
    assert.equal(again[0].priority, 'P0');
  });

  it('caps card flags and people, and hides an acked risk from the card only', () => {
    const repo = repository();
    const project = commands.createProject(repo, { name: 'Agent Office', actor: 'owner', at: AT });
    let rev = project.revision;
    for (const label of ['un', 'deux', 'trois', 'quatre']) {
      const next = commands.addLabel(repo, { id: project.id, expectedRevision: rev, label, actor: 'owner', at: AT + rev });
      rev = next.revision;
    }
    const blocked = commands.setBlocked(repo, { id: project.id, expectedRevision: rev, actor: 'owner', at: AT + 20 });
    const card = board(repo).columns[0].cards[0];
    assert.equal(card.thumb.initials, 'AO');
    assert.equal(card.thumb.kind, 'monogram');
    assert.equal(card.thumb.url, null);
    assert.match(card.thumb.accent, /^(slate|indigo|teal|amber|rose|green)$/);
    const risk = card.flags.visible.filter((f) => f.kind === 'risk');
    assert.equal(risk.length, 1);
    assert.equal(risk[0].removable, true);
    assert.ok(card.flags.visible.filter((f) => f.kind !== 'risk').length <= 3);
    assert.ok(card.flags.hiddenCount >= 1);
    const acked = commands.ackRisk(repo, {
      id: project.id, expectedRevision: blocked.revision, key: 'blocked', ack: true, actor: 'owner', at: AT + 30,
    });
    const hidden = board(repo).columns[0].cards[0];
    assert.equal(hidden.flags.visible.some((f) => f.kind === 'risk'), false);
    const detail = buildProjectVM(acked, repo.getHistory(project.id).events, { persons: repo.listPersons() });
    const detailRisk = detail.flags.find((f) => f.key === 'blocked');
    assert.equal(detailRisk.acked, true);
    assert.equal(detailRisk.removable, true);
    assert.equal(detailRisk.label, 'Bloqué');
    const ackedItem = detail.recentHistory.find((e) => e.kind === 'risk-acked');
    assert.equal(ackedItem.text.key, 'historyKind.risk-acked');
    assert.deepEqual(ackedItem.text.params.risk, { key: 'risk.blocked' });
    assert.equal(ackedItem.actor.kind, 'human');
    assert.equal(ackedItem.actor.name, 'owner');
  });

  it('filters the board by risk and by Timmy', () => {
    const repo = repository();
    const calm = commands.createProject(repo, { name: 'Calme', actor: 'owner', at: AT });
    const risky = commands.createProject(repo, { name: 'Risqué', actor: 'owner', at: AT + 1 });
    commands.setBlocked(repo, { id: risky.id, expectedRevision: 1, actor: 'owner', at: AT + 2 });
    commands.linkSource(repo, {
      id: calm.id, expectedRevision: 1, actor: 'owner', at: AT + 3,
      source: { kind: 'sessionGroup', ref: { by: 'keys', sessionKeys: ['agent:main:main'] } },
    });
    const sourceId = repo.getProject(calm.id).sources[0].id;
    repo.putSessionSnapshot({
      sourceId,
      sessions: [{ key: 'agent:main:main', class: { kind: 'main', agentId: 'main' } }],
    });
    assert.deepEqual(board(repo, 'at-risk').columns.flatMap((c) => c.cards).map((c) => c.name), ['Risqué']);
    assert.deepEqual(board(repo, 'with-timmy').columns.flatMap((c) => c.cards).map((c) => c.name), ['Calme']);
    const withState = board(repo, 'with-timmy').columns.flatMap((c) => c.cards)[0];
    assert.equal(withState.people.visible[0].state, 'working');
  });

  it('renders history as LabelRefs and groups consecutive commits', () => {
    const repo = repository();
    const project = commands.createProject(repo, { name: 'Portail', actor: 'owner', at: AT });
    commands.setStatus(repo, { id: project.id, expectedRevision: 1, status: 'todo', actor: 'owner', at: AT + 1 });
    commands.ingestActivity(repo, {
      id: project.id, actor: 'owner', at: AT + 2,
      commits: [
        { sha: 'aaaaaaa', branch: 'main', at: AT + 3 },
        { sha: 'bbbbbbb', branch: 'main', at: AT + 4 },
      ],
      sessions: [{ sessionKey: 'agent:main:main', messages: null, tokens: 12, at: AT + 5 }],
    });
    const page = repo.getHistory(project.id);
    const vm = presentHistory(page.events, { persons: repo.listPersons() });
    const status = vm.find((e) => e.kind === 'status');
    assert.equal(status.text.key, 'historyKind.status');
    assert.deepEqual(status.text.params.from, { key: 'projectStatus.idea' });
    assert.deepEqual(status.text.params.to, { key: 'projectStatus.todo' });
    assert.equal(status.actor.name, 'owner');
    assert.equal(status.group, 1);
    const commit = vm.find((e) => e.kind === 'commit');
    assert.equal(commit.text.key, 'historyKind.commit.other');
    assert.equal(commit.text.params.n, 2);
    assert.equal(commit.text.params.branch, 'main');
    assert.equal(commit.group, 2);
    const sessionEv = vm.find((e) => e.kind === 'session');
    // architect-57 (Owner): an unknown count has its own label (never an unfilled {messages}); never the raw key
    assert.equal(sessionEv.text.key, 'historyKind.session.noCount');
    assert.equal(sessionEv.text.params.session, 'main');
    assert.equal(sessionEv.text.params.tokens, 12);
    assert.equal(Object.hasOwn(sessionEv.text.params, 'messages'), false);
    assert.deepEqual([sessionEv.session.key, sessionEv.session.route, sessionEv.session.messages], ['agent:main:main', '/journaux/agent%3Amain%3Amain', null]);
    const detail = buildProjectVM(repo.getProject(project.id), page.events, {
      persons: repo.listPersons(), nextCursor: page.nextCursor,
    });
    assert.equal(detail.historyNextCursor, null);
    assert.equal(Object.hasOwn(detail, 'repoNotice'), false);
    assert.equal(Object.hasOwn(detail, 'archivedAt'), false);
    assert.equal(detail.repo, null);
    assert.equal(detail.status, 'todo');
  });

  it('shows a feature flag and a github thumb from the cache', () => {
    const repo = repository({ persons: [Owner({ gitEmailHash: hashEmail('ada@example.com') }), timmy()] });
    const project = commands.createProject(repo, { name: 'Portail', summary: '', actor: 'owner', at: AT });
    const linked = commands.linkSource(repo, {
      id: project.id, expectedRevision: 1, actor: 'owner', at: AT,
      source: { kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } },
    });
    repo.putRepoCache({
      owner: 'alexdeg92', name: 'demo',
      authors: [{ name: 'owner', emailHash: hashEmail('ada@example.com') }],
      repo: {
        url: 'https://github.com/alexdeg92/demo',
        owner: 'alexdeg92', name: 'demo', defaultBranch: 'main',
        image: { kind: 'opengraph', url: 'https://opengraph.githubassets.com/1/alexdeg92/demo' },
        ci: { state: 'none', at: null, url: null },
        commits: [{ sha: 'abcdef0', at: AT, author: { name: 'owner', personId: null }, message: 'Hi' }],
        fetchedAt: AT,
      },
    });
    const flagged = commands.replaceFeatureFlags(repo, {
      id: project.id, expectedRevision: linked.revision, actor: 'system', component: 'engine', at: AT + 1,
      features: [{ key: 'projets.board', state: 'on', foundIn: { path: 'src/flags.js', line: 4 } }],
    });
    const card = buildBoardVM([repo.getProject(project.id)], { persons: repo.listPersons() }).columns[0].cards[0];
    assert.equal(card.thumb.kind, 'opengraph');
    assert.equal(card.thumb.repoLabel, 'alexdeg92/demo');
    const detail = buildProjectVM(flagged, [], { persons: repo.listPersons() });
    assert.equal(detail.repo.branch, 'main');
    const feature = detail.flags.find((f) => f.kind === 'feature' && f.key === 'projets.board');
    assert.equal(feature.state, 'on');
    assert.equal(detail.people.some((p) => p.id === 'per_alexowner000000' && p.commitCount === 1), true);
  });

  it('builds monogram initials from accented names, one word, and emoji', () => {
    assert.equal(initials('Élodie Martin'), 'ÉM');
    assert.equal(initials('école'), 'ÉC');
    assert.equal(initials('Portail'), 'PO');
    assert.equal(initials('A'), 'A');
    assert.equal(initials('🌮 Portail'), 'PO');
    assert.equal(initials(''), '?');
    assert.equal(initials('🌮'), '🌮');
    const family = '👨‍👩‍👧‍👦';
    const only = initials(family);
    assert.ok(only === family || only === '?');
  });
});
