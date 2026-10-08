'use strict';

/**
 * Store contract for every projects repository.
 *
 * The memory repository runs when this file is loaded. The SQL repository
 * (architect, S5) must call the same function with its own factory:
 *
 *   const { defineRepositoryContract } = require('../../test/projects/repository-contract.test.js');
 *   defineRepositoryContract((options) => createProjectsRepository(db, options), 'sql');
 *
 * `options` is `{ persons, ownerPersonId, timmyPersonId, now, githubOwners }`.
 * `createRepository` may return a promise. `close()` is called when present.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRepository, REPOSITORY_METHODS } = require('../../src/projects');
const { hashEmail } = require('../../src/projects/email');
const { AT, Owner, timmy } = require('./helpers');

const SHA = 'a'.repeat(40);

function repoPayload(extra = {}) {
  return {
    url: 'https://github.com/alexdeg92/demo',
    owner: 'alexdeg92',
    name: 'demo',
    defaultBranch: 'main',
    image: { kind: 'opengraph', url: 'https://github.com/alexdeg92/demo.png' },
    ci: { state: 'none', at: null, url: null },
    commits: [{
      sha: SHA,
      at: AT,
      author: { name: 'owner', personId: null },
      message: 'Bonjour',
    }],
    fetchedAt: AT,
    ...extra,
  };
}

function defineRepositoryContract(createRepository, label = 'memory') {
  async function using(fn, options = {}) {
    const persons = options.persons || [Owner(), timmy()];
    const repo = await createRepository({
      persons,
      ownerPersonId: options.ownerPersonId || persons.find((p) => p.links && p.links.isOwner).id,
      timmyPersonId: options.timmyPersonId || persons.find((p) => p.links && p.links.agentId === 'main').id,
      now: options.now || (() => AT),
      githubOwners: options.githubOwners || ['alexdeg92'],
    });
    try {
      await fn(repo);
    } finally {
      if (repo && typeof repo.close === 'function') await repo.close();
    }
  }

  async function create(repo, extra = {}) {
    return repo.createProject({ name: 'Portail', actor: 'owner', at: AT, ...extra });
  }

  function rejects(fn, check) {
    return assert.rejects(async () => { await fn(); }, check);
  }

  describe(`projects repository contract (${label})`, () => {
    it('exposes every repository method', async () => {
      await using((repo) => {
        for (const name of REPOSITORY_METHODS) assert.equal(typeof repo[name], 'function', name);
      });
    });

    it('creates a frozen project and writes nothing when the name is invalid', async () => {
      await using(async (repo) => {
        const project = await create(repo, { summary: 'Un résumé.', status: 'todo', priority: 'P1' });
        assert.match(project.id, /^prj_[a-z2-7]{16}$/);
        assert.equal(project.revision, 1);
        assert.equal(project.status, 'todo');
        assert.equal(project.priority, 'P1');
        assert.equal(project.repo, null);
        assert.equal(project.summaryMeta.author.kind, 'human');
        assert.equal(project.summaryMeta.author.personId, 'per_alexowner000000');
        assert.equal(project.flags.filter((f) => f.kind === 'priority').length, 1);
        assert.equal(Object.isFrozen(project), true);
        const created = (await repo.getHistory(project.id)).events.find((e) => e.kind === 'project-created');
        assert.equal(created.actor.kind, 'human');
        assert.equal(created.actor.personId, 'per_alexowner000000');
        await rejects(() => create(repo, { name: '' }), (e) => e.status === 400 && e.code === 'validation_failed');
        assert.equal((await repo.listProjects()).length, 1);
        assert.equal(await repo.getProject('prj_bbbbbbbbbbbbbbbb'), null);
        await rejects(() => repo.getHistory('prj_bbbbbbbbbbbbbbbb'), (e) => e.status === 404 && e.code === 'not_found');
      });
    });

    it('edits in one revision and refuses a user write without expectedRevision', async () => {
      await using(async (repo) => {
        const project = await create(repo);
        const next = await repo.edit({
          id: project.id, expectedRevision: 1, name: 'Bureau', summary: 'Nouveau.', priority: 'P0', actor: 'owner', at: AT + 10,
        });
        assert.equal(next.revision, 2);
        assert.equal(next.name, 'Bureau');
        assert.equal(next.lastActivityAt, AT + 10);
        const kinds = (await repo.getHistory(project.id)).events.map((e) => e.kind);
        assert.deepEqual(kinds.filter((k) => k !== 'project-created').sort(), ['priority', 'renamed', 'summary-edited']);
        await rejects(() => repo.rename({ id: project.id, name: 'Autre', actor: 'owner', at: AT + 11 }), (e) => e.status === 400);
        assert.equal((await repo.getProject(project.id)).revision, 2);
        assert.equal((await repo.getProject(project.id)).name, 'Bureau');
      });
    });

    it('moves status with a revision check and treats reorder as that move', async () => {
      await using(async (repo) => {
        const project = await create(repo);
        const moved = await repo.setStatus({
          id: project.id, expectedRevision: 1, status: 'in-progress', actor: { kind: 'agent', agentId: 'main' }, at: AT + 5,
        });
        assert.equal(moved.revision, 2);
        assert.equal(moved.lastActivityAt, AT + 5);
        const statusEvent = (await repo.getHistory(project.id)).events.find((e) => e.kind === 'status');
        assert.equal(statusEvent.actor.kind, 'agent');
        assert.deepEqual({ from: statusEvent.from, to: statusEvent.to }, { from: 'idea', to: 'in-progress' });
        const before = (await repo.getHistory(project.id)).events.length;
        await rejects(() => repo.setStatus({
          id: project.id, expectedRevision: 1, status: 'shipped', actor: 'owner', at: AT + 6,
        }), (e) => e.status === 409 && e.code === 'conflict' && e.revision === 2);
        assert.equal((await repo.getProject(project.id)).status, 'in-progress');
        assert.equal((await repo.getHistory(project.id)).events.length, before);
        const same = await repo.reorder({
          id: project.id, expectedRevision: 2, status: 'in-progress', actor: 'owner', at: AT + 7,
        });
        assert.equal(same.revision, 2);
        await rejects(() => repo.reorder({
          id: project.id, expectedRevision: 2, status: 'todo', index: 0, actor: 'owner', at: AT + 8,
        }), (e) => e.status === 400 && e.code === 'validation_failed' && e.details[0].field === 'index');
        assert.equal((await repo.getProject(project.id)).status, 'in-progress');
        assert.equal((await repo.getHistory(project.id)).events.length, before);
      });
    });

    it('pages history newest first', async () => {
      await using(async (repo) => {
        const project = await create(repo);
        await repo.setStatus({ id: project.id, expectedRevision: 1, status: 'todo', actor: 'owner', at: AT + 1 });
        await repo.setStatus({ id: project.id, expectedRevision: 2, status: 'in-progress', actor: 'owner', at: AT + 2 });
        const page = await repo.getHistory(project.id, { limit: 2 });
        assert.equal(page.events.length, 2);
        assert.ok(page.events[0].at >= page.events[1].at);
        assert.equal(page.events[0].kind, 'status');
        assert.ok(page.nextCursor);
        const rest = await repo.getHistory(project.id, { cursor: page.nextCursor, limit: 2 });
        assert.equal(rest.events.length, 1);
        assert.equal(rest.events[0].kind, 'project-created');
        assert.equal(rest.nextCursor, null);
        await rejects(() => repo.getHistory(project.id, { cursor: 'nope' }), (e) => e.status === 400);
      });
    });

    it('keeps labels and Bloqué on the activity rules', async () => {
      await using(async (repo) => {
        const project = await create(repo);
        const labeled = await repo.addLabel({
          id: project.id, expectedRevision: 1, label: 'Site Web', actor: 'owner', at: AT + 1,
        });
        assert.equal(labeled.lastActivityAt, AT + 1);
        assert.equal(labeled.flags.find((f) => f.kind === 'label').key, 'site-web');
        const again = await repo.addLabel({
          id: project.id, expectedRevision: labeled.revision, label: 'site-web', actor: 'owner', at: AT + 2,
        });
        assert.equal(again.revision, labeled.revision);
        const blocked = await repo.setBlocked({
          id: project.id, expectedRevision: again.revision, actor: 'owner', at: AT + 3,
        });
        assert.equal(blocked.lastActivityAt, labeled.lastActivityAt);
        assert.equal(blocked.flags.find((f) => f.key === 'blocked').origin, 'manual');
        const cleared = await repo.removeFlag({
          id: project.id, expectedRevision: blocked.revision, kind: 'risk', key: 'blocked', actor: 'owner', at: AT + 4,
        });
        assert.equal(cleared.lastActivityAt, labeled.lastActivityAt);
        assert.equal(cleared.flags.some((f) => f.key === 'blocked' && f.clearedAt == null), false);
      });
    });

    it('acks a manual block without moving the clock and leaves it when CI is green', async () => {
      await using(async (repo) => {
        const project = await create(repo);
        const blocked = await repo.setBlocked({ id: project.id, expectedRevision: 1, actor: 'owner', at: AT + 10 });
        const acked = await repo.ackRisk({
          id: project.id, expectedRevision: blocked.revision, key: 'blocked', ack: true, actor: 'owner', at: AT + 20,
        });
        assert.equal(acked.lastActivityAt, project.lastActivityAt);
        assert.equal(acked.flags.find((f) => f.key === 'blocked').ack.by.kind, 'human');
        const passed = await repo.applyProjectRisks({
          id: project.id, at: AT + 30, ci: { state: 'passing', at: AT + 30, url: null },
        });
        const flag = passed.flags.find((f) => f.key === 'blocked');
        assert.equal(flag.clearedAt, null);
        assert.ok(flag.ack);
        assert.equal(passed.lastActivityAt, project.lastActivityAt);
      });
    });

    it('gives a GitHub repo to one active project', async () => {
      await using(async (repo) => {
        const project = await create(repo);
        const linked = await repo.linkSource({
          id: project.id, expectedRevision: 1, actor: 'owner', at: AT + 1,
          source: { kind: 'github', ref: { owner: 'AlexDeg92', repo: 'Demo' } },
        });
        assert.equal(linked.repo, null);
        assert.equal(linked.repoStatus.state, 'pending');
        assert.equal(linked.lastActivityAt, AT + 1);
        const other = await create(repo, { name: 'Autre' });
        await rejects(() => repo.linkSource({
          id: other.id, expectedRevision: 1, actor: 'owner', at: AT + 2,
          source: { kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } },
        }), (e) => e.status === 409 && e.details[0].issue === 'source-in-use');
        assert.equal((await repo.findActiveByGithub('ALEXDEG92', 'DEMO')).id, project.id);
        const archived = await repo.setArchived({
          id: project.id, expectedRevision: linked.revision, archived: true, actor: 'owner', at: AT + 3,
        });
        assert.equal(archived.archivedAt, AT + 3);
        assert.equal(archived.lastActivityAt, linked.lastActivityAt);
        assert.equal(await repo.findActiveByGithub('alexdeg92', 'demo'), null);
        assert.equal((await repo.listProjects()).some((p) => p.id === project.id), false);
        assert.equal((await repo.listProjects({ archived: 'only' })).some((p) => p.id === project.id), true);
        const taken = await repo.linkSource({
          id: other.id, expectedRevision: 1, actor: 'owner', at: AT + 4,
          source: { kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } },
        });
        await rejects(() => repo.setArchived({
          id: project.id, expectedRevision: archived.revision, archived: false, actor: 'owner', at: AT + 5,
        }), (e) => e.status === 409 && e.details[0].issue === 'source-in-use');
        const unlinked = await repo.unlinkSource({
          id: other.id, expectedRevision: taken.revision, sourceId: taken.sources[0].id, actor: 'owner', at: AT + 6,
        });
        assert.equal(unlinked.sources.length, 0);
        assert.equal(unlinked.repoStatus, null);
      });
    });

    it('ingests activity once and does not bump the revision', async () => {
      await using(async (repo) => {
        const project = await create(repo);
        const input = {
          id: project.id, actor: 'system', component: 'engine', at: AT + 5,
          commits: [{ sha: 'abc1234', branch: 'main', at: AT + 1000 }],
          flowRuns: [{ jobId: 'job1', runId: 'run1', status: 'succeeded', durationMs: 128000, at: AT + 2000 }],
        };
        const once = await repo.ingestActivity(input);
        assert.equal(once.revision, 1);
        assert.equal(once.lastActivityAt, AT + 2000);
        await repo.ingestActivity(input);
        const events = (await repo.getHistory(project.id)).events;
        assert.equal(events.filter((e) => e.kind === 'commit').length, 1);
        assert.equal(events.filter((e) => e.kind === 'flow-run').length, 1);
        assert.equal(events.find((e) => e.kind === 'commit').dedupeKey, 'commit:abc1234');
        assert.equal(events.find((e) => e.kind === 'commit').actor.component, 'engine');
      });
    });

    it('lets Timmy append an activity event without a new revision', async () => {
      await using(async (repo) => {
        const project = await create(repo);
        const noted = await repo.appendHistory({
          id: project.id, expectedRevision: 1, actor: { kind: 'agent', agentId: 'main' }, at: AT + 5,
          kind: 'agent-action', action: 'commented', note: 'Je m’en occupe.', dedupeKey: 'note:1',
        });
        assert.equal(noted.revision, 1);
        assert.equal(noted.lastActivityAt, AT + 5);
        const again = await repo.appendHistory({
          id: project.id, expectedRevision: 1, actor: { kind: 'agent', agentId: 'main' }, at: AT + 6,
          kind: 'agent-action', action: 'commented', note: 'Encore.', dedupeKey: 'note:1',
        });
        assert.equal(again.revision, 1);
        assert.equal((await repo.getHistory(project.id)).events.filter((e) => e.kind === 'agent-action').length, 1);
        await rejects(() => repo.appendHistory({
          id: project.id, expectedRevision: 1, actor: { kind: 'agent', agentId: 'main' }, at: AT + 7, kind: 'status',
        }), (e) => e.status === 400);
        await rejects(() => repo.appendHistory({
          id: project.id, expectedRevision: 9, actor: { kind: 'agent', agentId: 'main' }, at: AT + 8,
          kind: 'agent-action', action: 'commented', note: 'Non.',
        }), (e) => e.status === 409 && e.revision === 1);
        assert.equal((await repo.getProject(project.id)).revision, 1);
      });
    });

    it('commits nothing when a feature flag or a repo cache is invalid', async () => {
      await using(async (repo) => {
        const project = await create(repo);
        await rejects(() => repo.replaceFeatureFlags({
          id: project.id,
          features: [{ key: 'sample', state: 'on', foundIn: { path: '', line: -1 } }],
        }), (e) => e.status === 400 && e.code === 'validation_failed');
        assert.equal((await repo.getProject(project.id)).revision, 1);
        assert.equal((await repo.getProject(project.id)).flags.some((f) => f.kind === 'feature'), false);
        assert.equal((await repo.listProjects()).length, 1);
        const flagged = await repo.replaceFeatureFlags({
          id: project.id, actor: 'system', component: 'engine', at: AT + 2,
          features: [
            { key: 'zeta', state: 'off', foundIn: { path: 'src/z.js', line: 2 } },
            { key: 'alpha', state: 'on', foundIn: { path: 'src/a.js', line: 1 } },
          ],
        });
        assert.equal(flagged.revision, 2);
        assert.equal(flagged.lastActivityAt, project.lastActivityAt);
        const updated = (await repo.getHistory(project.id)).events.find((e) => e.kind === 'flags-updated');
        assert.deepEqual(updated.flags.map((f) => f.key), ['alpha', 'zeta']);
        assert.equal(updated.actor.component, 'engine');
        const linked = await repo.linkSource({
          id: project.id, expectedRevision: 2, actor: 'owner', at: AT + 3,
          source: { kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } },
        });
        await rejects(() => repo.putRepoCache({
          owner: 'alexdeg92', name: 'demo', repo: { url: 'http://example.invalid/demo' }, authors: [],
        }), (e) => e.status === 400);
        assert.equal((await repo.getProject(project.id)).repo, null);
        assert.equal((await repo.listProjects()).length, 1);
        const address = 'synthetic@example.invalid';
        await repo.putRepoCache({
          owner: 'alexdeg92', name: 'demo', repo: repoPayload(),
          authors: [{ name: address, emailHash: hashEmail(address) }],
        });
        const hydrated = await repo.getProject(project.id);
        assert.equal(hydrated.revision, linked.revision);
        assert.equal(hydrated.repoStatus.state, 'ok');
        assert.equal(hydrated.repo.commits[0].message, 'Bonjour');
        assert.equal(JSON.stringify(hydrated).includes(address), false);
        const person = (await repo.listPersons()).find((p) => p.links && p.links.gitEmailHash === hashEmail(address));
        assert.equal(person.name, 'inconnu');
        await repo.recordRepoFailure({ owner: 'alexdeg92', name: 'demo', at: AT + 4, error: 'timeout' });
        const failed = await repo.getProject(project.id);
        assert.equal(failed.repoStatus.state, 'error');
        assert.equal(failed.repoStatus.lastError, 'timeout');
        assert.equal(failed.repo.commits[0].sha, SHA);
      });
    });

    it('clears a job whose latest run succeeded and keeps a manual block', async () => {
      await using(async (repo) => {
        const project = await create(repo);
        const raised = await repo.applyProjectRisks({
          id: project.id, at: AT + 1000,
          flows: [{ jobId: 'flow-1', runId: 'run-old', status: 'failed', at: AT }],
          ci: { state: 'failing', at: AT, url: 'https://github.com/alexdeg92/demo/actions/runs/1' },
        });
        assert.equal(raised.revision, 2);
        assert.equal(raised.lastActivityAt, project.lastActivityAt);
        assert.equal(raised.flags.find((f) => f.key === 'flow-failing').clearedAt, null);
        const acked = await repo.ackRisk({
          id: project.id, expectedRevision: raised.revision, key: 'ci-red', ack: true, actor: 'owner', at: AT + 10,
        });
        const newer = await repo.applyProjectRisks({
          id: project.id, at: AT + 50,
          flows: [
            { jobId: 'flow-1', runId: 'run-old', status: 'failed', at: AT },
            { jobId: 'flow-1', runId: 'run-new', status: 'succeeded', at: AT + 1 },
            { jobId: 'flow-2', runId: 'run-2', status: 'failed', at: AT },
          ],
          ci: { state: 'failing', at: AT + 20, url: 'https://github.com/alexdeg92/demo/actions/runs/2' },
        });
        assert.equal(newer.flags.find((f) => f.key === 'flow-failing').clearedAt, null);
        assert.equal(newer.flags.find((f) => f.key === 'flow-failing').evidence.ref, 'run-2');
        assert.equal(newer.flags.find((f) => f.key === 'ci-red').ack, null);
        assert.equal(newer.lastActivityAt, project.lastActivityAt);
        const quiet = await repo.applyProjectRisks({
          id: project.id, at: AT + 60, lastActivityAt: AT + 999999,
          flows: [{ jobId: 'flow-2', runId: 'run-3', status: 'succeeded', at: AT + 2 }],
          ci: { state: 'passing', at: AT + 60, url: null },
        });
        assert.equal(quiet.flags.find((f) => f.key === 'flow-failing').clearedAt != null, true);
        assert.equal(quiet.flags.find((f) => f.key === 'ci-red').clearedAt != null, true);
        assert.equal(quiet.lastActivityAt, project.lastActivityAt);
      });
    });

    it('imports a candidate as Owner and hides a person', async () => {
      await using(async (repo) => {
        const hash = hashEmail('ada@example.com');
        const result = await repo.importCandidates({
          actor: 'owner', at: AT,
          candidates: [{
            key: 'gh:alexdeg92/demo',
            name: 'Démo',
            summary: 'Site web',
            status: 'todo',
            labels: [{ key: 'client', label: 'client' }],
            sources: [
              { kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } },
              { kind: 'workspace', ref: { path: 'sites/demo' } },
            ],
            lastActivityAt: AT - 5000,
          }],
        });
        assert.equal(result.result.created.length, 1);
        const project = await repo.getProject(result.result.created[0].id);
        assert.equal(project.name, 'Démo');
        assert.equal(project.status, 'todo');
        assert.equal(project.createdAt, AT);
        assert.equal(project.lastActivityAt, AT - 5000);
        assert.equal(project.repo, null);
        assert.equal(project.repoStatus.state, 'pending');
        assert.equal(project.flags.some((f) => f.kind === 'label' && f.key === 'client'), true);
        const created = (await repo.getHistory(project.id)).events.find((e) => e.kind === 'project-created');
        assert.equal(created.actor.personId, 'per_alexowner000000');
        const sourceId = project.sources.find((s) => s.kind === 'workspace').id;
        await repo.putWorkspaceSnapshot({
          sourceId, branch: 'main', commits: [],
          authors: [{ name: 'Ada', emailHash: hash }, { name: 'Ada', emailHash: hash }],
        });
        const withAda = await repo.getProject(project.id);
        const ada = (await repo.listPersons()).find((p) => p.links && p.links.gitEmailHash === hash);
        assert.equal(ada.kind, 'git');
        assert.equal(withAda.people.find((p) => p.personId === ada.id).commitCount, 2);
        const hidden = await repo.setPersonOverride({
          id: project.id, expectedRevision: withAda.revision, personId: ada.id, hidden: true, actor: 'owner', at: AT + 1,
        });
        assert.equal(hidden.lastActivityAt, AT - 5000);
        assert.equal(hidden.people.some((p) => p.personId === ada.id), false);
        const event = (await repo.getHistory(project.id)).events.find((e) => e.kind === 'people-override');
        assert.equal(event.personId, ada.id);
        assert.equal(event.hidden, true);
        const again = await repo.importCandidates({
          at: AT + 2,
          candidates: [{
            key: 'gh:alexdeg92/demo',
            name: 'Démo',
            status: 'todo',
            sources: [{ kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } }],
            lastActivityAt: AT,
          }],
          keys: ['gh:alexdeg92/demo', 'missing'],
        });
        assert.deepEqual(again.result.skipped.map((s) => s.reason).sort(), ['exists', 'unknown']);
        assert.equal((await repo.listProjects()).length, 1);
      });
    });

    it('covers the remaining methods, revision conflicts, and history order', async () => {
      await using(async (repo) => {
        const project = await create(repo);
        const renamed = await repo.rename({
          id: project.id, expectedRevision: 1, name: 'Nouveau', actor: 'owner', at: AT + 1,
        });
        assert.equal(renamed.revision, 2);
        assert.equal(renamed.name, 'Nouveau');
        assert.equal(renamed.lastActivityAt, AT + 1);
        await rejects(() => repo.rename({
          id: project.id, expectedRevision: 1, name: 'Autre', actor: 'owner', at: AT + 2,
        }), (e) => e.status === 409 && e.code === 'conflict' && e.revision === 2);
        assert.equal((await repo.getProject(project.id)).name, 'Nouveau');

        const prioritized = await repo.setPriority({
          id: project.id, expectedRevision: 2, priority: 'P0', actor: 'owner', at: AT + 3,
        });
        assert.equal(prioritized.revision, 3);
        assert.equal(prioritized.priority, 'P0');
        const summarized = await repo.editSummary({
          id: project.id, expectedRevision: 3, summary: 'Résumé.', actor: 'owner', at: AT + 4,
        });
        assert.equal(summarized.revision, 4);
        assert.equal(summarized.summary, 'Résumé.');
        assert.equal(summarized.lastActivityAt, AT + 4);

        const labeled = await repo.addFlag({
          id: project.id, expectedRevision: 4, kind: 'label', label: 'Perso', actor: 'owner', at: AT + 5,
        });
        assert.equal(labeled.flags.some((f) => f.kind === 'label' && f.key === 'perso'), true);
        await rejects(() => repo.addFlag({
          id: project.id, expectedRevision: labeled.revision, kind: 'feature', key: 'board', actor: 'owner', at: AT + 6,
        }), (e) => e.status === 400 && e.details[0].issue === 'flag-not-writable');
        assert.equal((await repo.getProject(project.id)).revision, labeled.revision);

        const samePlan = await repo.applyRisks({
          id: project.id, at: AT + 7, actor: 'system', plan: { raise: [], clear: [], refresh: [] },
        });
        assert.equal(samePlan.revision, labeled.revision);
        const raised = await repo.applyRisks({
          id: project.id, at: AT + 8, actor: 'system', component: 'risk-monitor',
          plan: {
            raise: [{
              key: 'stale', severity: 'low', staleDays: 14,
              evidence: { kind: 'inactivity', ref: String(project.lastActivityAt), at: project.lastActivityAt },
            }],
            clear: [],
            refresh: [],
          },
        });
        assert.equal(raised.revision, labeled.revision + 1);
        assert.equal(raised.lastActivityAt, labeled.lastActivityAt);
        assert.equal(raised.flags.find((f) => f.key === 'stale').origin, 'auto');

        const linked = await repo.linkSource({
          id: project.id, expectedRevision: raised.revision, actor: 'owner', at: AT + 9,
          source: { kind: 'sessionGroup', ref: { by: 'keys', sessionKeys: ['agent:main:one'] } },
        });
        const sourceId = linked.sources.find((s) => s.kind === 'sessionGroup').id;
        await repo.putSessionSnapshot({
          sourceId,
          sessionCount: 1,
          sessions: [{ key: 'agent:main:one', class: { kind: 'main', agentId: 'main', interlocutorId: null } }],
        });
        assert.deepEqual(await repo.sourceStats(project.id), { [sourceId]: { sessionCount: 1 } });
        await repo.setLiveStates({ per_timmymain000000: 'working' });
        const timmy = (await repo.getProject(project.id)).people.find((p) => p.personId === 'per_timmymain000000');
        assert.equal(timmy.liveState, 'working');

        const guest = await repo.upsertPerson({
          id: 'per_guest0000000001', kind: 'human', name: 'Guest', avatarUrl: null, links: {},
        });
        assert.equal((await repo.getPerson(guest.id)).name, 'Guest');
        assert.equal(await repo.getPerson('per_bbbbbbbbbbbbbbbb'), null);

        const first = await repo.appendHistory({
          id: project.id, expectedRevision: linked.revision, actor: { kind: 'agent', agentId: 'main' }, at: AT + 20,
          kind: 'commit', branch: 'main', shas: ['abc1234'], dedupeKey: 'commit:one',
        });
        const second = await repo.appendHistory({
          id: project.id, expectedRevision: linked.revision, actor: { kind: 'agent', agentId: 'main' }, at: AT + 20,
          kind: 'commit', branch: 'main', shas: ['def5678'], dedupeKey: 'commit:two',
        });
        assert.equal(first.revision, linked.revision);
        assert.equal(second.revision, linked.revision);
        assert.equal(second.lastActivityAt, AT + 20);
        const commits = (await repo.getHistory(project.id)).events.filter((e) => e.kind === 'commit');
        assert.equal(commits.length, 2);
        assert.equal(commits[0].at, commits[1].at);
        assert.ok(commits[0].id > commits[1].id);
      });
    });
  });
}

defineRepositoryContract((options) => createMemoryRepository(options), 'memory');

module.exports = { defineRepositoryContract };
