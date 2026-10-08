'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createProjectService, providerFor, entities } = require('../../src/projects');
const { AT, repository } = require('./helpers');

describe('portability flag (default off until G3)', () => {
  it('has no personal owner default, and an empty allow-list links nothing', () => {
    const src = path.join(__dirname, '..', '..', 'src');
    const files = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.js')) files.push(full);
      }
    };
    walk(src);
    const hits = files.filter((file) => fs.readFileSync(file, 'utf8').includes('alexdeg92'));
    assert.deepEqual(hits, []);

    const repo = repository({ githubOwners: [] });
    const created = repo.createProject({ name: 'Portail', actor: 'owner', at: AT });
    assert.throws(() => repo.linkSource({
      id: created.id, expectedRevision: created.revision, actor: 'owner', at: AT,
      source: { kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } },
    }), (err) => err.details[0].issue === 'owner-not-allowed');
  });

  it('resolves {kind:agent, agentId} and refuses the timmy shorthand when the flag is on', () => {
    const atlas = {
      id: 'per_atlas0000000001', kind: 'agent', name: 'Atlas', avatarUrl: null, links: { agentId: 'atlas' },
    };
    const repo = repository({
      portability: true,
      githubOwners: [],
      persons: [{
        id: 'per_camille00000001', kind: 'human', name: 'Camille', avatarUrl: null, links: { isOwner: true },
      }, atlas],
      ownerPersonId: 'per_camille00000001',
      timmyPersonId: atlas.id,
    });
    const { service } = (() => {
      const published = [];
      return {
        service: createProjectService({
          repository: repo, clock: () => AT, primaryAgentId: 'atlas', publish: (change) => published.push(change),
        }),
      };
    })();
    const created = service.commands.create({
      name: 'Portail', actor: { kind: 'agent', agentId: 'atlas' }, at: AT,
    });
    assert.equal(created.vm.summaryMeta, null);
    const history = repo.getHistory(created.vm.id);
    assert.equal(history.events[0].actor.personId, atlas.id);
    assert.equal(history.events[0].actor.agentId, undefined);
    assert.throws(() => service.commands.create({ name: 'Autre', actor: 'timmy', at: AT }), (err) => err.details[0].issue === 'actor-invalid');

    const board = service.views.board({ filter: 'with-agent' });
    assert.equal(board.filter, 'with-agent');
    assert.throws(() => service.views.board({ filter: 'nope' }), (err) => err.details[0].issue === 'Filtre invalide.' || err.message.includes('Filtre'));
  });

  it('serves label keys instead of French sentences when the flag is on', () => {
    const repo = repository({ portability: true });
    const { service } = {
      service: createProjectService({ repository: repo, clock: () => AT, publish: () => {} }),
    };
    const created = service.commands.create({ name: 'Portail', actor: 'owner', at: AT });
    repo.setBlocked({ id: created.vm.id, expectedRevision: created.revision, actor: 'owner', at: AT });
    const project = service.views.project({ id: created.vm.id });
    const risk = project.flags.find((flag) => flag.kind === 'risk' && flag.key === 'blocked');
    assert.deepEqual(risk.label, { key: 'risk.blocked' });
    const { buildHistoryPage } = require('../../src/projects');
    const page = buildHistoryPage([{
      id: 'evt_sys0000000001', projectId: created.vm.id, at: AT, kind: 'project-created',
      actor: { kind: 'system', component: 'engine' }, dedupeKey: null,
    }], { portability: true, persons: [] });
    assert.deepEqual(page.items[0].actor.name, { key: 'actor.system' });
    const discovery = require('../../src/projects/discovery');
    const [candidate] = discovery.proposeCandidates({
      now: AT,
      portability: true,
      owners: ['acme'],
      github: [{ owner: 'acme', repo: 'demo', name: 'demo', archived: true, description: 'client website', pushedAt: new Date(AT).toISOString() }],
    });
    assert.deepEqual(candidate.reason, { key: 'candidateReason.github-archived' });
    assert.deepEqual(candidate.labels.map((label) => label.key).sort(), ['client', 'website']);
    assert.deepEqual(candidate.labels.find((label) => label.key === 'website').label, { key: 'candidateLabel.website' });
  });

  it('GitHub is a code host; GitLab and Gitea report not-supported', async () => {
    const github = providerFor('github', {
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      owners: ['acme'],
    });
    assert.equal(github.id, 'github');
    assert.equal(github.webUrl({ owner: 'acme', repo: 'demo' }), 'https://github.com/acme/demo');
    assert.throws(() => github.parseRef({ ref: { owner: 'other', repo: 'demo' } }), (err) => err.details[0].issue === 'owner-not-allowed');
    await assert.rejects(() => github.fetch({ owner: 'other', repo: 'demo' }), (err) => err.details[0].issue === 'not-supported' || err.details[0].issue === 'owner-not-allowed');
    for (const id of ['gitlab', 'gitea']) {
      const host = providerFor(id);
      assert.equal(host.id, id);
      assert.throws(() => host.parseRef({ owner: 'acme', repo: 'demo' }), (err) => err.details[0].issue === 'not-supported');
      await assert.rejects(() => host.fetch({ owner: 'acme', repo: 'demo' }), (err) => err.details[0].issue === 'not-supported');
    }
  });

  it('admits Project, Flag, Person, HistoryEvent and ProjectSource through defineEntity', () => {
    const repo = repository();
    const created = repo.createProject({ name: 'Portail', actor: 'owner', at: AT });
    const project = repo.getProject(created.id);
    const entity = new entities.Project(project);
    assert.equal(Object.isFrozen(entity), true);
    assert.equal(entity.name, 'Portail');
    assert.equal(new entities.Person(repo.listPersons()[0]).links.agentId, null);
    assert.equal(entities.HistoryEvent.from({ id: 'evt_nope' }), null);
    const source = project.sources[0];
    if (source) assert.equal(new entities.ProjectSource(source).kind, source.kind);
    const flag = project.flags.find((item) => item.kind === 'priority');
    assert.equal(new entities.Flag(flag).key, 'P2');
  });
});
