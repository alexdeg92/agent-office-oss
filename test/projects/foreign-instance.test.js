'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createMemoryRepository, createProjectService, discovery, linkProjectActivity, providerFor,
} = require('../../src/projects');
const { initials } = require('../../src/projects/vm');

const AT = Date.UTC(2026, 9, 6, 8, 0, 0);
const ZONE = 'Europe/Paris';
const LOCALE = 'en';
const CAMILLE = 'per_camilleowner0000';
const ATLAS = 'per_atlasprimary0000';
const SCRIBE = 'per_scribeagent00000';
const REVIEWER = 'per_revieweragent000';
const TELEGRAM = 'agent:atlas:dm:camille';
const SLACK = 'agent:scribe:room:acme';
const REVIEWER_KEY = 'agent:reviewer:room:llm';
const BANNED = /Timmy|Owner|alexdeg92|discord/;

function person(id, name, links) {
  return { id, kind: links.agentId ? 'agent' : 'human', name, avatarUrl: null, links };
}

function session(key, agentId, channel, provider, model) {
  return {
    key,
    class: { kind: 'chat-direct', agentId, channel, heartbeatOf: null },
    provider,
    model,
    usage: { total: 3, input: 1, output: 2 },
    updatedAt: AT,
    cwd: '/srv/acme/notes',
    goal: null,
    messageCount: 2,
  };
}

function assertForeign(value, label) {
  const text = JSON.stringify(value);
  assert.equal(BANNED.test(text), false, label);
  assert.equal(/"agentId"\s*:\s*"main"/.test(text), false, label);
}

// Projects module only: discovery, the linker, people, risks, and the board, project, history,
// and candidates views. This does not validate the OpenClaw adapter, the engine, SQL route
// wiring, SSE, or a rendered foreign instance.
describe('foreign instance', () => {
  it('runs discovery, the linker, people, risks and every VM without a home install', async () => {
    const persons = [
      person(CAMILLE, 'Camille', { isOwner: true }),
      person(ATLAS, 'Atlas', { agentId: 'atlas' }),
      person(SCRIBE, 'Scribe', { agentId: 'scribe' }),
      person(REVIEWER, 'Aaron', { agentId: 'reviewer' }),
    ];
    const camille = { kind: 'human', personId: CAMILLE };
    const atlas = { kind: 'agent', agentId: 'atlas' };

    const github = [
      { owner: 'acme-labs', repo: 'ledger', name: 'Ledger', description: '', pushedAt: new Date(AT).toISOString(), archived: false, topics: [] },
      { owner: 'alexdeg92', repo: 'secret', name: 'Secret', description: '', pushedAt: new Date(AT).toISOString(), archived: false, topics: [] },
    ];
    const workspaces = [{ path: 'acme/notes', remote: 'git@gitlab.com:acme-labs/notes.git', lastCommitAt: AT - 1000 }];
    const found = discovery.proposeCandidates({
      now: AT, github, workspaces, sessionGroups: [], owners: ['acme-labs'], locale: LOCALE,
    });
    assert.deepEqual(found.map((row) => row.name).sort(), ['Ledger', 'notes']);
    const notes = found.find((row) => row.name === 'notes');
    assert.equal(notes.sources.some((source) => source.kind === 'github'), false);
    assert.equal(notes.sources.some((source) => source.kind === 'workspace'), true);
    assert.deepEqual(found.notices, [{
      host: 'gitlab',
      remote: 'git@gitlab.com:acme-labs/notes.git',
      issue: 'not-supported',
      key: 'candidateNotice.host-not-supported',
    }]);
    assert.match(discovery.formatTable(found), /candidateNotice\.host-not-supported gitlab/);
    assert.equal(found.some((row) => JSON.stringify(row).includes('alexdeg92')), false);
    assert.throws(() => providerFor('gitlab').parseRef('acme-labs/notes'), (err) => {
      assert.equal(err.details[0].issue, 'not-supported');
      return true;
    });

    let groupCalls = 0;
    const repo = createMemoryRepository({
      persons,
      ownerPersonId: CAMILLE,
      primaryAgentId: 'atlas',
      githubOwners: ['acme-labs'],
      locale: LOCALE,
      timeZone: ZONE,
      portability: true,
      now: () => AT,
    });
    const sessions = new Map([
      [TELEGRAM, session(TELEGRAM, 'atlas', 'telegram', 'anthropic', 'claude-sonnet-5')],
      [SLACK, session(SLACK, 'scribe', 'slack', 'mistral', 'mistral-large-3')],
    ]);
    sessions.set(REVIEWER_KEY, session(REVIEWER_KEY, 'reviewer', 'slack', 'acme-llm', 'acme-1'));
    const service = createProjectService({
      repository: repo,
      clock: () => AT,
      primaryAgentId: 'atlas',
      sources: {
        owners: ['acme-labs'],
        capabilities: { sessionGroups: false },
        sessionGroups: async () => { groupCalls += 1; return [{ name: 'ignored' }]; },
        githubRepos: async () => github,
        workspaceFolders: async () => workspaces,
      },
      engineRegistry: {
        sessions,
        agents: new Map([
          ['atlas', { id: 'atlas', name: 'Atlas' }],
          ['scribe', { id: 'scribe', name: 'Scribe' }],
          ['reviewer', { id: 'reviewer', name: 'Aaron' }],
        ]),
        cronJobs: new Map([['nightly', { id: 'nightly', sessionKey: TELEGRAM }]]),
        cronRuns: new Map([['nightly', [{ id: 'nightly@1', jobId: 'nightly', sessionKey: TELEGRAM, at: AT, status: 'failed' }]]]),
      },
    });

    const created = service.commands.create({ name: 'Notes', actor: camille, at: AT });
    const linked = service.commands.linkSource({
      id: created.vm.id, expectedRevision: created.revision, actor: camille, at: AT,
      source: { kind: 'workspace', ref: { path: 'acme/notes' } },
    });
    let revision = linked.revision;
    for (const personId of [CAMILLE, ATLAS, REVIEWER, SCRIBE]) {
      const added = service.commands.setPersonOverride({
        id: created.vm.id, expectedRevision: revision, personId, actor: camille, at: AT,
      });
      revision = added.revision;
    }
    const edited = service.commands.edit({
      id: created.vm.id, expectedRevision: revision, actor: atlas, summary: 'Close the ledger', at: AT,
    });
    const side = service.commands.create({ name: 'Side', actor: camille, at: AT });
    service.commands.setPersonOverride({
      id: side.vm.id, expectedRevision: side.revision, personId: REVIEWER, actor: camille, at: AT,
    });

    const activity = linkProjectActivity({
      projects: [repo.getProject(created.vm.id)],
      sessions: [...sessions.values()],
      agents: [{ id: 'atlas', name: 'Atlas' }, { id: 'scribe', name: 'Scribe' }, { id: 'reviewer', name: 'Aaron' }],
      cronRuns: [{ id: 'nightly@1', jobId: 'nightly', sessionKey: TELEGRAM, at: AT, status: 'failed' }],
      cronJobs: [{ id: 'nightly', sessionKey: TELEGRAM }],
      now: AT,
    });
    const suggested = activity.byProject[created.vm.id].people.map((row) => row.links.agentId).sort();
    assert.deepEqual(suggested, ['atlas', 'reviewer', 'scribe']);
    assert.equal(activity.byProject[created.vm.id].riskPlan.raise.some((row) => row.key === 'cron-failing'), true);
    assert.equal([TELEGRAM, SLACK, REVIEWER_KEY].join(' ').includes('telegram'), false);
    assert.equal([TELEGRAM, SLACK, REVIEWER_KEY].join(' ').includes('slack'), false);
    assert.deepEqual(activity.byProject[created.vm.id].channels, ['slack', 'telegram']);

    await service.refresh({ changes: [{ type: 'Session', op: 'upsert', id: TELEGRAM }] });
    const project = repo.getProject(created.vm.id);
    assert.equal(project.flags.some((flag) => flag.kind === 'risk' && flag.key === 'cron-failing'), true);
    assert.deepEqual(
      project.people.map((row) => persons.find((item) => item.id === row.personId).name),
      ['Camille', 'Atlas', 'Aaron', 'Scribe'],
    );

    const candidates = await service.views.candidates();
    assert.equal(groupCalls, 0);
    const board = service.views.board({ filter: 'with-timmy' });
    const agentBoard = service.views.board({ filter: 'with-agent' });
    // 2026-10-06T08:00:00.000Z is 10:00 in Europe/Paris. English month text and that hour
    // both come from the service (repository locale and zone). French is "6 octobre à 10 h";
    // UTC is "October 6 at 08".
    assert.equal(service.views.localStamp(AT), 'October 6 at 10');
    const detail = service.views.project({ id: created.vm.id });
    const history = service.views.history({ id: created.vm.id });
    const names = (vm) => vm.columns.flatMap((column) => column.cards.map((card) => card.name));
    assert.deepEqual(names(board), ['Notes']);
    assert.deepEqual(names(agentBoard), ['Notes']);
    assert.equal(detail.thumb.initials, initials('Notes', LOCALE));
    assert.equal(detail.people.some((row) => row.name === 'Atlas'), true);
    assert.equal(history.items.some((item) => item.actor && item.actor.name === 'Atlas'), true);
    assert.equal(candidates.candidates.some((row) => row.sources.some((source) => source.kind === 'github' && source.ref && source.ref.owner === 'acme-labs')), true);
    assert.equal(candidates.candidates.some((row) => JSON.stringify(row).includes('gitlab.com') && row.sources.some((source) => source.kind === 'github')), false);

    for (const [label, value] of [['board', board], ['agent', agentBoard], ['project', detail], ['history', history], ['candidates', candidates], ['edited', edited.vm]]) {
      assertForeign(value, label);
    }
  });

  // en and fr collate these names the same way in this runtime, so the English scenario above
  // cannot see a hardcoded French locale. Turkish (and the initials it produces) can.
  it('membership, candidate order, and monograms follow the configured locale', async () => {
    const locale = 'tr';
    const names = ['Cote', 'ça'];
    const order = (tag) => names.slice().sort((a, b) => a.localeCompare(b, tag));
    assert.notDeepEqual(order(locale), order('fr'));
    assert.notEqual(initials('idea board', locale), initials('idea board', 'fr'));

    const cote = 'per_coteagent000000';
    const cedilla = 'per_caagent00000000';
    const persons = [
      person(cote, 'Cote', { agentId: 'cote' }),
      person(cedilla, 'ça', { agentId: 'ca' }),
    ];
    const repo = createMemoryRepository({
      persons,
      primaryAgentId: 'atlas',
      locale,
      timeZone: ZONE,
      portability: true,
      now: () => AT,
    });
    const service = createProjectService({
      repository: repo,
      clock: () => AT,
      primaryAgentId: 'atlas',
      sources: {
        owners: ['acme-labs'],
        capabilities: { sessionGroups: false },
        githubRepos: async () => [
          { owner: 'acme-labs', repo: 'cote', name: 'Cote', description: '', pushedAt: new Date(AT).toISOString(), archived: false, topics: [] },
          { owner: 'acme-labs', repo: 'ca-mark', name: 'ça', description: '', pushedAt: new Date(AT).toISOString(), archived: false, topics: [] },
        ],
        workspaceFolders: async () => [],
      },
    });
    const actor = { kind: 'agent', agentId: 'cote' };
    const created = service.commands.create({ name: 'idea board', actor, at: AT });
    service.commands.setPersonOverride({
      id: created.vm.id, expectedRevision: created.revision, personId: cote, actor, at: AT,
    });
    const added = repo.getProject(created.vm.id);
    service.commands.setPersonOverride({
      id: created.vm.id, expectedRevision: added.revision, personId: cedilla, actor, at: AT,
    });

    const project = repo.getProject(created.vm.id);
    const memberNames = project.people.map((row) => persons.find((item) => item.id === row.personId).name);
    assert.deepEqual(memberNames, order(locale));

    const detail = service.views.project({ id: created.vm.id });
    assert.deepEqual(detail.people.map((row) => row.name), order(locale));
    assert.equal(detail.thumb.initials, initials('idea board', locale));
    const board = service.views.board({ filter: 'all' });
    const card = board.columns.flatMap((column) => column.cards).find((item) => item.id === created.vm.id);
    assert.equal(card.thumb.initials, initials('idea board', locale));

    const candidates = await service.views.candidates();
    assert.deepEqual(candidates.candidates.map((row) => row.name), order(locale));
  });
});
