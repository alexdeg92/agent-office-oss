'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createProjectService } = require('../../src/projects');
const { repoFromPayloads } = require('../../src/projects/sources/github');
const { compareShape, loadExample, loadSidecar } = require('../helpers/contract-shape');
const { AT, repository } = require('./helpers');

const repoJson = require('./fixtures/github/repo.json');
const commitsJson = require('./fixtures/github/commits.json');
const runsSuccess = require('./fixtures/github/runs-success.json');

const THUMB = {
  kind: 'monogram', url: null, repoLabel: null, initials: 'PO', accent: 'slate',
};
const DAY = 24 * 60 * 60 * 1000;

function matches(name, actual, variants) {
  const sidecar = loadSidecar(name);
  const example = loadExample(name);
  const value = example.data !== undefined && example.meta !== undefined ? example.data : example;
  return compareShape(value, actual, {
    nullable: sidecar.nullable,
    types: sidecar.types,
    records: sidecar.records,
    opaque: sidecar.opaque,
    additional: sidecar.additional, optional: sidecar.optional,   // architect-57: optional fields (HistoryItemVM.session)
    variants: { ...(sidecar.variants || {}), ...(variants || {}) },
  });
}

function serviceFor(repo, extra = {}) {
  const published = [];
  const service = createProjectService({
    repository: repo,
    clock: extra.clock || (() => AT),
    publish: (change) => published.push(change),
    sources: extra.sources,
    capturer: extra.capturer,
    engineRegistry: extra.engineRegistry,
    ids: extra.ids,
  });
  return { service, published };
}

describe('project service facade', () => {
  it('matches the 2.1 board, project, history, 409, candidates and import examples', async () => {
    const repo = repository();
    const { service, published } = serviceFor(repo, {
      sources: {
        githubRepos: async () => [{
          owner: 'alexdeg92',
          repo: 'agent-office',
          name: 'Agent Office',
          description: 'Tableau de bord de Timmy.',
          topics: ['perso'],
          archived: false,
          pushedAt: new Date(AT).toISOString(),
        }],
      },
    });
    const created = service.commands.create({ name: 'Portail', actor: 'owner', at: AT, requestId: 'req_8f2c1a' });
    assert.equal(created.ok, true);
    assert.equal(created.result, null);
    assert.equal(created.revision, created.vm.revision);
    assert.deepEqual(matches('project-vm', created.vm, { '$.thumb': [THUMB] }), []);
    assert.deepEqual(matches('project-vm', service.views.project({ id: created.vm.id }), { '$.thumb': [THUMB] }), []);
    assert.deepEqual(matches('board-vm', service.views.board({ filter: 'all' }), {
      '$.columns[].cards[].thumb': [THUMB],
    }), []);
    assert.deepEqual(matches('history-page', service.views.history({ id: created.vm.id })), []);
    assert.equal(published.length, 1);
    assert.deepEqual(published[0].topics, ['projects', `project:${created.vm.id}`]);

    assert.throws(() => service.commands.setStatus({
      id: created.vm.id, expectedRevision: created.revision + 3, status: 'todo', actor: 'owner', requestId: 'req_8f2c1a',
    }), (err) => {
      assert.equal(err.status, 409);
      assert.deepEqual(matches('error-409-project', err.body, { '$.error.current.vm.thumb': [THUMB] }), []);
      return true;
    });
    assert.equal(published.length, 1);

    const candidates = await service.views.candidates();
    assert.deepEqual(matches('candidates-vm', candidates), []);
    const imported = service.commands.importCandidates({
      keys: ['gh:alexdeg92/agent-office', 'sg:discord-user:100000000000000001'],
      actor: 'owner',
      at: AT,
    });
    assert.deepEqual(matches('import-result', imported), []);
    assert.equal(published.length, 2);
    assert.equal(published[1].projectIds.length, 1);
  });

  it('runs one repository write per command and publishes only when the project changed', () => {
    const repo = repository();
    let statusCalls = 0;
    const orig = repo.setStatus.bind(repo);
    repo.setStatus = (input) => {
      statusCalls += 1;
      return orig(input);
    };
    const { service, published } = serviceFor(repo);
    const created = service.commands.create({ name: 'Portail', actor: 'owner', at: AT });
    const id = created.vm.id;
    service.commands.setStatus({ id, expectedRevision: created.revision, status: 'idea', actor: 'owner', at: AT });
    assert.equal(statusCalls, 1);
    assert.equal(published.length, 1);
    const moved = service.commands.setStatus({ id, expectedRevision: created.revision, status: 'todo', actor: 'owner', at: AT + 1 });
    assert.equal(statusCalls, 2);
    assert.deepEqual(published[1].topics, ['projects', `project:${id}`]);
    assert.equal(moved.vm.status, 'todo');
    const blocked = service.commands.addFlag({
      id, expectedRevision: moved.revision, kind: 'risk', key: 'blocked', actor: 'owner', at: AT + 2,
    });
    assert.deepEqual(published[2].topics, ['projects', 'projects?filter=at-risk', `project:${id}`]);
    assert.equal(blocked.vm.lastActivityAt, moved.vm.lastActivityAt);
    const archived = service.commands.setArchived({
      id, expectedRevision: blocked.revision, archived: true, actor: 'owner', at: AT + 3,
    });
    assert.ok(published[3].topics.includes('projects?filter=archived'));
    assert.equal(service.views.board({ filter: 'all' }).columns.every((column) => column.cards.length === 0), true);
    assert.equal(service.views.board({ filter: 'archived' }).columns.some((column) => column.cards.some((card) => card.id === id)), true);
    assert.equal(archived.vm.archived, true);
  });

  it('checks the summary revision once and refuses a second turn', () => {
    const repo = repository();
    const { service, published } = serviceFor(repo, { ids: { mint: (prefix) => `${prefix}_fixedturn00001` } });
    const created = service.commands.create({ name: 'Portail', actor: 'owner', at: AT });
    const id = created.vm.id;
    const turn = service.commands.regenerateSummary({ id, expectedRevision: created.revision, actor: 'owner' });
    assert.equal(turn.result.turnId, 'trn_fixedturn00001');
    assert.equal(turn.revision, created.revision);
    assert.equal(published.length, 1);
    assert.throws(() => service.commands.regenerateSummary({ id, expectedRevision: created.revision }), (err) => {
      assert.equal(err.details[0].issue, 'turn-pending');
      assert.equal(err.body, undefined);
      return true;
    });
    service.commands.edit({
      id, expectedRevision: created.revision, summary: 'Résumé', actor: { kind: 'agent', agentId: 'main' }, at: AT + 1,
    });
    const again = service.commands.regenerateSummary({ id, expectedRevision: created.revision + 1, actor: 'owner' });
    assert.equal(again.result.turnId, 'trn_fixedturn00001');
  });

  it('abandons a failed summary turn without a write, and a second abandon does nothing', () => {
    const repo = repository();
    const { service, published } = serviceFor(repo, { ids: { mint: (prefix) => `${prefix}_fixedturn00001` } });
    const created = service.commands.create({ name: 'Portail', actor: 'owner', at: AT });
    const id = created.vm.id;
    const history = () => repo.getHistory(id, { limit: 20 }).events.length;
    const beforeHistory = history();
    const turn = service.commands.regenerateSummary({ id, expectedRevision: created.revision, actor: 'owner' });
    const released = service.commands.abandonSummary({ id, turnId: turn.result.turnId });
    assert.equal(released.revision, created.revision);
    assert.equal(released.vm.summary, created.vm.summary);
    assert.equal(history(), beforeHistory);
    assert.equal(published.length, 1);
    const again = service.commands.abandonSummary({ id, turnId: turn.result.turnId });
    assert.equal(again.revision, created.revision);
    service.commands.regenerateSummary({ id, expectedRevision: created.revision, actor: 'owner' });
    service.commands.abandonSummary({ id, turnId: 'trn_other' });
    assert.throws(() => service.commands.regenerateSummary({ id, expectedRevision: created.revision }), (err) => err.details[0].issue === 'turn-pending');
  });

  it('a late failed turn does not release the newer regeneration', () => {
    const repo = repository();
    let n = 0;
    const { service } = serviceFor(repo, { ids: { mint: (prefix) => `${prefix}_${String(++n).padStart(12, '0')}` } });
    const created = service.commands.create({ name: 'Portail', actor: 'owner', at: AT });
    const id = created.vm.id;
    const turnA = service.commands.regenerateSummary({ id, expectedRevision: created.revision, actor: 'owner' });
    const edited = service.commands.edit({
      id, expectedRevision: created.revision, summary: 'Résumé manuel', actor: 'owner', at: AT + 1,
    });
    service.commands.regenerateSummary({ id, expectedRevision: edited.revision, actor: 'owner' });
    service.commands.abandonSummary({ id, turnId: turnA.result.turnId });
    assert.equal(service.views.project({ id }).summary, 'Résumé manuel');
    assert.throws(() => service.commands.regenerateSummary({ id, expectedRevision: edited.revision }), (err) => err.details[0].issue === 'turn-pending');
  });

  it('drops a late summary completion that would overwrite a manual edit or a newer turn', () => {
    const repo = repository();
    let n = 0;
    const { service } = serviceFor(repo, { ids: { mint: (prefix) => `${prefix}_${String(++n).padStart(12, '0')}` } });
    const created = service.commands.create({ name: 'Portail', actor: 'owner', at: AT });
    const id = created.vm.id;
    const turnA = service.commands.regenerateSummary({ id, expectedRevision: created.revision, actor: 'owner' });
    const edited = service.commands.edit({
      id, expectedRevision: created.revision, summary: 'Résumé manuel', actor: 'owner', at: AT + 1,
    });
    const turnB = service.commands.regenerateSummary({ id, expectedRevision: edited.revision, actor: 'owner' });
    const stale = service.commands.completeSummary({
      id, turnId: turnA.result.turnId, expectedRevision: turnA.revision, summary: 'Old turn A result', actor: { kind: 'agent', agentId: 'main' }, at: AT + 2,
    });
    assert.equal(stale.result.applied, false);
    assert.equal(service.views.project({ id }).summary, 'Résumé manuel');
    assert.throws(() => service.commands.regenerateSummary({ id, expectedRevision: edited.revision }), (err) => err.details[0].issue === 'turn-pending');
    const landed = service.commands.completeSummary({
      id, turnId: turnB.result.turnId, expectedRevision: turnB.revision, summary: 'Résumé de B', actor: { kind: 'agent', agentId: 'main' }, at: AT + 3,
    });
    assert.equal(landed.vm.summary, 'Résumé de B');
    const next = service.commands.regenerateSummary({ id, expectedRevision: landed.revision, actor: 'owner' });
    assert.equal(next.result.turnId, 'trn_000000000003');
  });

  it('rejects an empty import before touching the repository', async () => {
    const repo = repository();
    let imports = 0;
    const orig = repo.importCandidates.bind(repo);
    repo.importCandidates = (input) => {
      imports += 1;
      return orig(input);
    };
    const { service, published } = serviceFor(repo);
    assert.throws(() => service.commands.importCandidates({ keys: [] }), (err) => err.details[0].issue === 'empty-selection');
    assert.throws(() => service.commands.importCandidates({
      keys: ['gh:alexdeg92/demo'],
      overrides: { 'gh:other/repo': { name: 'Autre' } },
    }), (err) => err.details[0].issue === 'override-not-selected');
    assert.equal(imports, 0);
    assert.equal(published.length, 0);
    await service.views.candidates();
    const imported = service.commands.importCandidates({ keys: ['missing'], at: AT });
    assert.equal(imports, 1);
    assert.equal(imported.result.skipped[0].reason, 'unknown');
    assert.equal(published.length, 0);
  });

  it('refreshes risks and linked activity from an engine change, and ignores other types', async () => {
    let now = AT;
    const repo = repository({ now: () => now });
    let riskCalls = 0;
    const orig = repo.applyProjectRisks.bind(repo);
    repo.applyProjectRisks = (input) => {
      riskCalls += 1;
      return orig(input);
    };
    const { service, published } = serviceFor(repo, { clock: () => now });
    const created = service.commands.create({ name: 'Portail', actor: 'owner', at: AT });
    const id = created.vm.id;
    await service.refresh({ changes: [{ type: 'Skill', op: 'upsert', id: 'weather' }] });
    assert.equal(riskCalls, 0);
    assert.equal(published.length, 1);

    now = AT + 20 * DAY;
    const stale = await service.refresh({ changes: [{ type: 'Session', op: 'upsert', id: 'sess' }] });
    assert.equal(riskCalls, 1);
    assert.deepEqual(stale.topics, ['projects', 'projects?filter=at-risk', `project:${id}`]);
    assert.equal(repo.getProject(id).flags.some((flag) => flag.kind === 'risk' && flag.key === 'stale'), true);
    assert.equal(repo.getProject(id).lastActivityAt, AT);
  });

  it('ingests a workspace session and refreshes a linked repo through the injected source', async () => {
    const repo = repository();
    let fetches = 0;
    const { service, published } = serviceFor(repo, {
      sources: {
        github: {
          async fetch() {
            fetches += 1;
            return repoFromPayloads({ meta: repoJson, commits: commitsJson, runs: runsSuccess, fetchedAt: AT });
          },
        },
      },
      engineRegistry: {
        sessions: new Map([[
          'agent:main:sites',
          {
            key: 'agent:main:sites',
            class: { kind: 'main', agentId: 'main', heartbeatOf: null },
            usage: { total: 4 },
            updatedAt: AT,
            goal: { objective: 'Travailler dans sites/demo', status: 'active', tokensUsed: null, tokenBudget: null },
            cwd: null,
            messageCount: 2,
          },
        ]]),
        cronJobs: new Map(),
        cronRuns: new Map(),
        agents: new Map(),
      },
    });
    const created = service.commands.create({ name: 'Portail', actor: 'owner', at: AT });
    const id = created.vm.id;
    const linked = service.commands.linkSource({
      id, expectedRevision: created.revision, actor: 'owner', at: AT,
      source: { kind: 'workspace', ref: { path: 'sites/demo' } },
    });
    service.commands.linkSource({
      id, expectedRevision: linked.revision, actor: 'owner', at: AT,
      source: { kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } },
    });
    const change = await service.refresh({ changes: [{ type: 'Session', op: 'upsert', id: 'agent:main:sites' }] });
    assert.equal(fetches, 1);
    assert.equal(repo.getHistory(id, { limit: 20 }).events.some((event) => event.kind === 'session'), true);
    assert.equal(repo.getProject(id).repo.ci.state, 'passing');
    assert.ok(change.projectIds.includes(id));
    assert.ok(change.topics.includes('projects'));
    assert.ok(change.topics.includes(`project:${id}`));
    const before = published.length;
    await service.refresh({ changes: [{ type: 'Session', op: 'upsert', id: 'agent:main:sites' }] });
    assert.equal(fetches, 1);
    assert.equal(published.length, before);
  });
});
