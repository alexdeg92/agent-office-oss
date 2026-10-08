'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { commands, ProjectError } = require('../../src/projects');
const { AT, repository } = require('./helpers');

function create(repo, extra = {}) {
  return commands.createProject(repo, { name: 'Portail', actor: 'owner', at: AT, ...extra });
}

describe('project commands', () => {
  it('creates a project and records the actor', () => {
    const repo = repository();
    const project = create(repo, { summary: 'Un résumé.', status: 'todo', priority: 'P1' });
    assert.equal(project.revision, 1);
    assert.equal(project.status, 'todo');
    assert.equal(project.priority, 'P1');
    assert.equal(project.summaryMeta.author.kind, 'human');
    assert.equal(project.flags.some((f) => f.kind === 'priority' && f.key === 'P1'), true);
    assert.equal(project.flags.some((f) => f.kind === 'priority'), true);
    assert.equal(project.flags.filter((f) => f.kind === 'priority').length, 1);
    const history = repo.getHistory(project.id).events;
    assert.equal(history[0].kind, 'project-created');
    assert.equal(history[0].actor.personId, 'per_alexowner000000');
    assert.throws(() => { project.name = 'x'; }, TypeError);
  });

  it('rejects a bad name without writing', () => {
    const repo = repository();
    assert.throws(() => create(repo, { name: '' }), (e) => e instanceof ProjectError && e.status === 400);
    assert.equal(repo.listProjects().length, 0);
  });

  it('renames, edits the summary and sets priority in one revision', () => {
    const repo = repository();
    const project = create(repo);
    const next = commands.edit(repo, {
      id: project.id, expectedRevision: 1, name: 'Bureau', summary: 'Nouveau.', priority: 'P0', actor: 'owner', at: AT + 10,
    });
    assert.equal(next.revision, 2);
    assert.equal(next.name, 'Bureau');
    assert.equal(next.priority, 'P0');
    assert.equal(next.summaryMeta.at, AT + 10);
    const kinds = repo.getHistory(project.id).events.map((e) => e.kind);
    assert.deepEqual(kinds.slice(0, 3).sort(), ['priority', 'renamed', 'summary-edited']);
  });

  it('moves status with optimistic revision and returns 409 on mismatch', () => {
    const repo = repository();
    const project = create(repo);
    const moved = commands.setStatus(repo, {
      id: project.id, expectedRevision: 1, status: 'in-progress', actor: { kind: 'agent', agentId: 'main' }, at: AT + 5,
    });
    assert.equal(moved.status, 'in-progress');
    assert.equal(moved.revision, 2);
    const before = repo.getHistory(project.id).events.length;
    assert.throws(() => commands.setStatus(repo, {
      id: project.id, expectedRevision: 1, status: 'shipped', actor: 'owner', at: AT + 6,
    }), (e) => e.status === 409 && e.code === 'conflict' && e.revision === 2);
    assert.equal(repo.getProject(project.id).status, 'in-progress');
    assert.equal(repo.getHistory(project.id).events.length, before);
    const statusEvent = repo.getHistory(project.id).events.find((e) => e.kind === 'status');
    assert.equal(statusEvent.actor.kind, 'agent');
    assert.deepEqual({ from: statusEvent.from, to: statusEvent.to }, { from: 'idea', to: 'in-progress' });
  });

  it('treats reorder as a status move and does not store a card index', () => {
    const repo = repository();
    const project = create(repo, { priority: 'P2' });
    assert.throws(() => commands.reorder(repo, {
      id: project.id, expectedRevision: 1, status: 'todo', index: 0, actor: 'owner', at: AT + 1,
    }), (e) => e.status === 400 && e.details[0].field === 'index');
    assert.equal(repo.getProject(project.id).revision, 1);
    const same = commands.reorder(repo, {
      id: project.id, expectedRevision: 1, status: 'idea', actor: 'owner', at: AT + 1,
    });
    assert.equal(same.revision, 1);
    const moved = commands.reorder(repo, {
      id: project.id, expectedRevision: 1, status: 'in-review', actor: 'system', component: 'scheduler', at: AT + 2,
    });
    assert.equal(moved.status, 'in-review');
    assert.equal(moved.revision, 2);
    const ev = repo.getHistory(project.id).events.find((e) => e.kind === 'status');
    assert.equal(ev.actor.component, 'scheduler');
    assert.equal('index' in moved, false);
  });

  it('adds and removes a label, and blocks a project manually', () => {
    const repo = repository();
    const project = create(repo);
    const labeled = commands.addLabel(repo, { id: project.id, expectedRevision: 1, label: 'Site Web', actor: 'owner', at: AT + 1 });
    const label = labeled.flags.find((f) => f.kind === 'label');
    assert.equal(label.key, 'site-web');
    assert.equal(label.label, 'Site Web');
    const again = commands.addLabel(repo, {
      id: project.id, expectedRevision: labeled.revision, label: 'site-web', actor: 'owner', at: AT + 2,
    });
    assert.equal(again.revision, labeled.revision);
    assert.equal(again.flags.filter((f) => f.kind === 'label').length, 1);
    const blocked = commands.setBlocked(repo, {
      id: project.id, expectedRevision: labeled.revision, actor: { kind: 'agent', agentId: 'main' }, at: AT + 3,
    });
    const risk = blocked.flags.find((f) => f.key === 'blocked');
    assert.equal(risk.origin, 'manual');
    assert.equal(risk.severity, 'high');
    assert.equal(blocked.lastActivityAt, labeled.lastActivityAt);
    assert.throws(() => commands.removeFlag(repo, {
      id: project.id, expectedRevision: blocked.revision, kind: 'risk', key: 'flow-failing', actor: 'owner',
    }), (e) => e.status === 404);
    const cleared = commands.removeFlag(repo, {
      id: project.id, expectedRevision: blocked.revision, kind: 'risk', key: 'blocked', actor: 'owner', at: AT + 4,
    });
    assert.equal(cleared.flags.some((f) => f.key === 'blocked'), false);
    assert.equal(cleared.lastActivityAt, blocked.lastActivityAt);
  });

  it('acks and unacks a risk without moving last activity', () => {
    const repo = repository();
    const project = create(repo);
    const blocked = commands.setBlocked(repo, { id: project.id, expectedRevision: 1, actor: 'owner', at: AT + 10 });
    const acked = commands.ackRisk(repo, {
      id: project.id, expectedRevision: blocked.revision, key: 'blocked', ack: true, actor: 'owner', at: AT + 20,
    });
    assert.equal(acked.lastActivityAt, blocked.lastActivityAt);
    assert.equal(acked.flags.find((f) => f.key === 'blocked').ack.by.kind, 'human');
    const kinds = repo.getHistory(project.id).events.map((e) => e.kind);
    assert.ok(kinds.includes('risk-acked'));
    const unacked = commands.ackRisk(repo, {
      id: project.id, expectedRevision: acked.revision, key: 'blocked', ack: false, actor: { kind: 'agent', agentId: 'main' }, at: AT + 30,
    });
    assert.equal(unacked.flags.find((f) => f.key === 'blocked').ack, null);
    assert.ok(repo.getHistory(project.id).events.some((e) => e.kind === 'risk-unacked' && e.actor.kind === 'agent'));
  });

  it('links and unlinks sources and keeps a github repo on one active project', () => {
    const repo = repository();
    const project = create(repo);
    const linked = commands.linkSource(repo, {
      id: project.id, expectedRevision: 1, actor: 'owner', at: AT + 1,
      source: { kind: 'github', ref: { owner: 'alexdeg92', repo: 'Demo' } },
    });
    assert.equal(linked.sources[0].kind, 'github');
    assert.equal(linked.sources[0].ref.repo, 'Demo');
    const other = create(repo, { name: 'Autre' });
    assert.throws(() => commands.linkSource(repo, {
      id: other.id, expectedRevision: 1, actor: 'owner', at: AT + 2,
      source: { kind: 'github', ref: { owner: 'AlexDeg92', repo: 'demo' } },
    }), (e) => e.status === 409 && e.revision == null && e.details[0].issue === 'source-in-use');
    assert.throws(() => commands.linkSource(repo, {
      id: project.id, expectedRevision: linked.revision, actor: 'owner',
      source: { kind: 'github', ref: { owner: 'other', repo: 'demo' } },
    }), (e) => e.status === 400 && e.details[0].issue === 'owner-not-allowed');
    assert.throws(() => commands.linkSource(repo, {
      id: project.id, expectedRevision: linked.revision, actor: 'owner',
      source: { kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' }, addedAt: AT, addedBy: { kind: 'human', personId: 'per_alexowner000000' } },
    }), (e) => e.status === 400 && e.details[0].issue === 'server-owned');
    const same = commands.linkSource(repo, {
      id: project.id, expectedRevision: linked.revision, actor: 'owner', at: AT + 2,
      source: { kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } },
    });
    assert.equal(same.revision, linked.revision);
    const manual = commands.linkSource(repo, {
      id: project.id, expectedRevision: linked.revision, actor: 'system', at: AT + 3,
      source: { kind: 'manual' },
    });
    assert.equal(manual.sources.some((s) => s.kind === 'manual' && s.ref === null), true);
    const sourceId = manual.sources.find((s) => s.kind === 'manual').id;
    const unlinked = commands.unlinkSource(repo, {
      id: project.id, expectedRevision: manual.revision, sourceId, actor: 'owner', at: AT + 4,
    });
    assert.equal(unlinked.sources.some((s) => s.kind === 'manual'), false);
    assert.ok(repo.getHistory(project.id).events.some((e) => e.kind === 'source-unlinked'));
  });

  it('archives with a history event and frees the github repo', () => {
    const repo = repository();
    const project = create(repo);
    const linked = commands.linkSource(repo, {
      id: project.id, expectedRevision: 1, actor: 'owner', at: AT + 1,
      source: { kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } },
    });
    const activity = linked.lastActivityAt;
    const archived = commands.setArchived(repo, {
      id: project.id, expectedRevision: linked.revision, archived: true, actor: 'owner', at: AT + 50,
    });
    assert.equal(archived.archivedAt, AT + 50);
    assert.equal(archived.lastActivityAt, activity);
    const archivedEvent = repo.getHistory(project.id).events.find((e) => e.kind === 'archived');
    assert.equal(archivedEvent.kind, 'archived');
    assert.equal('archived' in archivedEvent, false);
    assert.equal(archivedEvent.actor.kind, 'human');
    assert.equal(repo.listProjects().length, 0);
    const other = create(repo, { name: 'Reprise' });
    const relinked = commands.linkSource(repo, {
      id: other.id, expectedRevision: 1, actor: 'owner', at: AT + 60,
      source: { kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } },
    });
    assert.equal(relinked.sources.length, 1);
    assert.throws(() => commands.setArchived(repo, {
      id: project.id, expectedRevision: archived.revision, archived: false, actor: 'owner', at: AT + 70,
    }), (e) => e.status === 409 && e.details[0].issue === 'source-in-use');
  });

  it('ingests derived history once per dedupe key', () => {
    const repo = repository();
    const project = create(repo);
    const input = {
      id: project.id,
      actor: 'system',
      component: 'engine',
      at: AT + 5,
      commits: [{ sha: 'abc1234', branch: 'main', at: AT + 1000 }],
      flowRuns: [{ jobId: 'job1', runId: 'run1', status: 'succeeded', durationMs: 128000, at: AT + 2000 }],
    };
    const once = commands.ingestActivity(repo, input);
    assert.equal(once.revision, 1);
    assert.equal(once.lastActivityAt, AT + 2000);
    commands.ingestActivity(repo, input);
    const events = repo.getHistory(project.id).events;
    assert.equal(events.filter((e) => e.kind === 'commit').length, 1);
    assert.equal(events.filter((e) => e.kind === 'flow-run').length, 1);
    assert.equal(events.find((e) => e.kind === 'commit').dedupeKey, 'commit:abc1234');
  });

  it('pages history newest first', () => {
    const repo = repository();
    const project = create(repo);
    commands.setStatus(repo, { id: project.id, expectedRevision: 1, status: 'todo', actor: 'owner', at: AT + 1 });
    commands.setStatus(repo, { id: project.id, expectedRevision: 2, status: 'in-progress', actor: 'owner', at: AT + 2 });
    const page = repo.getHistory(project.id, { limit: 2 });
    assert.equal(page.events.length, 2);
    assert.ok(page.events[0].at >= page.events[1].at);
    assert.ok(page.nextCursor);
    const rest = repo.getHistory(project.id, { cursor: page.nextCursor, limit: 2 });
    assert.equal(rest.events.length, 1);
    assert.equal(rest.events[0].kind, 'project-created');
    assert.equal(rest.nextCursor, null);
    assert.throws(() => repo.getHistory(project.id, { cursor: 'nope' }), (e) => e.status === 400);
  });

  it('requires a revision on user writes and refuses monitor-owned flag edits', () => {
    const repo = repository();
    const project = create(repo);
    const missing = (fn) => assert.throws(fn, (e) => e instanceof ProjectError && e.details[0].field === 'expectedRevision');
    missing(() => commands.edit(repo, { id: project.id, name: 'Autre', actor: 'owner', at: AT }));
    missing(() => commands.appendHistory(repo, {
      id: project.id, actor: { kind: 'agent', agentId: 'main' }, kind: 'agent-action', action: 'commented', note: 'x', at: AT,
    }));
    const refused = (fn) => assert.throws(fn, (e) => e.details[0].issue === 'flag-not-writable');
    refused(() => commands.addFlag(repo, { id: project.id, expectedRevision: 1, kind: 'feature', actor: 'owner', at: AT }));
    refused(() => commands.addFlag(repo, { id: project.id, expectedRevision: 1, kind: 'risk', key: 'ci-red', actor: 'owner', at: AT }));
    assert.throws(() => commands.removeFlag(repo, {
      id: project.id, expectedRevision: 1, kind: 'priority', key: 'P2', actor: 'owner', at: AT,
    }), (e) => e.details[0].issue === 'flag-not-removable');
    const raised = commands.applyProjectRisks(repo, {
      id: project.id, at: AT + 1,
      flows: [{ jobId: 'flow-1', runId: 'run-f', status: 'failed', at: AT }],
    });
    assert.throws(() => commands.removeFlag(repo, {
      id: project.id, expectedRevision: raised.revision, kind: 'risk', key: 'flow-failing', actor: 'owner', at: AT,
    }), (e) => e.details[0].issue === 'flag-not-removable');
    const flagged = commands.replaceFeatureFlags(repo, {
      id: project.id, actor: 'system', component: 'engine', at: AT + 2,
      features: [{ key: 'board', state: 'off', foundIn: { path: 'src/a.js', line: 1 } }],
    });
    assert.throws(() => commands.removeFlag(repo, {
      id: project.id, expectedRevision: flagged.revision, kind: 'feature', key: 'board', actor: 'owner', at: AT,
    }), (e) => e.details[0].issue === 'flag-not-removable');
    const labeled = commands.addFlag(repo, {
      id: project.id, expectedRevision: flagged.revision, kind: 'label', label: 'Client', actor: 'owner', at: AT + 3,
    });
    assert.equal(labeled.lastActivityAt, AT + 3);
    assert.ok(repo.getHistory(project.id).events.some((e) => e.kind === 'flag-added' && e.flagKind === 'label'));
  });

  it('commits nothing when a feature flag or a repo cache fails validation', () => {
    const repo = repository();
    const project = create(repo);
    assert.throws(() => commands.replaceFeatureFlags(repo, {
      id: project.id,
      features: [{ key: 'sample', state: 'on', foundIn: { path: '', line: -1 } }],
    }), (e) => e.status === 400 && e.code === 'validation_failed');
    const after = repo.getProject(project.id);
    assert.equal(after.revision, 1);
    assert.equal(after.flags.some((f) => f.kind === 'feature'), false);
    assert.equal(repo.getHistory(project.id).events.some((e) => e.kind === 'flags-updated'), false);
    assert.doesNotThrow(() => repo.listProjects());

    commands.linkSource(repo, {
      id: project.id, expectedRevision: 1, actor: 'owner', at: AT,
      source: { kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } },
    });
    assert.throws(() => repo.putRepoCache({
      owner: 'alexdeg92', name: 'demo', repo: { url: 'http://example.invalid/demo' }, authors: [],
    }), (e) => e.status === 400);
    const still = repo.getProject(project.id);
    assert.equal(still.repo, null);
    assert.doesNotThrow(() => repo.listProjects());
  });
});
