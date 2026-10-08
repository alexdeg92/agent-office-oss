'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { commands, discovery, linkProjectActivity, buildCandidatesVM, createSessionGroupSource } = require('../../src/projects');
const { compareShape, loadExample } = require('../helpers/contract-shape');
const { AT, repository } = require('./helpers');

const GROUP = { by: 'group', groupId: 'netzach-id', name: 'Netzach' };

function session(key, group) {
  return {
    key,
    group: group === undefined ? null : group,
    updatedAt: AT,
    class: { kind: 'explicit', agentId: 'main', interlocutorId: null, heartbeatOf: null },
    usage: { total: 4 },
  };
}

describe('session-group source', () => {
  it('matches membership by groupId, including a session that joins later', () => {
    const groups = createSessionGroupSource();
    const ref = groups.parseRef({ by: 'group', groupId: ' netzach-id ', name: ' Netzach ' }).ref;
    assert.deepEqual(ref, GROUP);
    const first = groups.fetch(ref, { sessions: [session('agent:main:a', 'netzach-id'), session('agent:main:other', 'other')] });
    assert.deepEqual(first.sessions.map((s) => s.key), ['agent:main:a']);
    const later = groups.fetch(ref, {
      sessions: [session('agent:main:a', 'netzach-id'), session('agent:main:b', 'netzach-id'), session('agent:main:named', 'Netzach'), session('agent:main:none', null)],
    });
    assert.deepEqual(later.sessions.map((s) => s.key), ['agent:main:a', 'agent:main:b']);
    assert.throws(() => groups.parseRef({ by: 'group', groupId: 'netzach-id' }), (e) => e.code === 'validation_failed');
  });

  it('keeps {by:\'keys\'} as a fallback that ignores the group field', () => {
    const groups = createSessionGroupSource();
    const matched = groups.fetch(
      { by: 'keys', sessionKeys: ['agent:main:listed'] },
      { sessions: [session('agent:main:listed', 'somewhere-else'), session('agent:main:grouped', 'netzach-id')] },
    );
    assert.deepEqual(matched.sessions.map((s) => s.key), ['agent:main:listed']);
  });

  it('links a project by groupId and does not pull a heartbeat in', () => {
    const member = session('agent:main:a', 'netzach-id');
    const joined = session('agent:main:b', 'netzach-id');
    const heartbeat = session('agent:main:a:heartbeat', 'netzach-id');
    heartbeat.class.heartbeatOf = 'agent:main:a';
    const listed = session('agent:main:listed', null);
    const linked = linkProjectActivity({
      projects: [
        { id: 'prj_group', archivedAt: null, lastActivityAt: AT, sources: [{ kind: 'sessionGroup', ref: GROUP }], flags: [], repo: null },
        { id: 'prj_keys', archivedAt: null, lastActivityAt: AT, sources: [{ kind: 'sessionGroup', ref: { by: 'keys', sessionKeys: ['agent:main:listed'] } }], flags: [], repo: null },
      ],
      sessions: [member, joined, heartbeat, listed],
      now: AT,
    });
    assert.deepEqual(linked.matches.filter((m) => m.projectId === 'prj_group').map((m) => m.ref).sort(), ['agent:main:a', 'agent:main:b']);
    assert.equal(linked.matches.some((m) => m.ref === heartbeat.key), false);
    assert.deepEqual(linked.matches.filter((m) => m.projectId === 'prj_keys').map((m) => m.ref), ['agent:main:listed']);
  });

  it('round-trips a group ref through the repository', () => {
    const repo = repository();
    const project = commands.createProject(repo, { name: 'Netzach', actor: 'owner', at: AT });
    const linked = commands.linkSource(repo, {
      id: project.id, expectedRevision: project.revision, actor: 'owner', at: AT,
      source: { kind: 'sessionGroup', ref: GROUP },
    });
    const stored = repo.getProject(linked.id).sources.find((s) => s.kind === 'sessionGroup');
    assert.deepEqual(stored.ref, GROUP);
    const history = repo.getHistory(linked.id);
    assert.equal(history.events.find((e) => e.kind === 'source-linked').ref, 'Netzach');
  });

  it('discovers a catalog group by id and falls back to keys when there is no group', () => {
    const named = discovery.proposeCandidates({
      now: AT,
      sessionGroups: [{ groupId: 'Automations', name: 'Automations', sessionKeys: ['agent:main:cron:old'], lastActivityAt: AT }],
    });
    assert.equal(named.length, 1);
    assert.equal(named[0].key, 'sg:group:Automations');
    assert.deepEqual(named[0].sources[0].ref, { by: 'group', groupId: 'Automations', name: 'Automations' });
    assert.equal('sessionKeys' in named[0].sources[0].ref, false);

    const keysOnly = discovery.proposeCandidates({
      now: AT,
      sessionGroups: [{ sessionKeys: ['agent:main:explicit:orphan'], lastActivityAt: AT }],
    });
    assert.deepEqual(keysOnly[0].sources[0].ref, { by: 'keys', sessionKeys: ['agent:main:explicit:orphan'] });

    const explicitKeys = discovery.normalizeSessionGroup({
      name: 'Démo',
      ref: { by: 'keys', sessionKeys: ['agent:main:demo'] },
    });
    assert.deepEqual(explicitKeys.ref, { by: 'keys', sessionKeys: ['agent:main:demo'] });
  });

  it('keeps a renamed OpenClaw group as a new candidate and leaves the old link', () => {
    const repo = repository();
    const project = commands.createProject(repo, { name: 'Netzach', actor: 'owner', at: AT });
    const linked = commands.linkSource(repo, {
      id: project.id, expectedRevision: project.revision, actor: 'owner', at: AT,
      source: { kind: 'sessionGroup', ref: { by: 'group', groupId: 'Netzach', name: 'Netzach' } },
    });
    const stored = repo.getProject(linked.id);
    const historyBefore = repo.getHistory(linked.id).events.filter((e) => e.kind === 'source-linked');
    const moved = {
      key: 'agent:main:a',
      group: 'Notes de veille',
      updatedAt: AT,
      class: { kind: 'explicit', agentId: 'main', interlocutorId: null },
      usage: { total: 4 },
    };
    const activity = linkProjectActivity({
      projects: [stored],
      sessions: [moved],
      now: AT,
    });
    assert.equal(activity.matches.some((m) => m.projectId === stored.id), false);
    const candidates = discovery.proposeCandidates({
      now: AT,
      sessionGroups: [{ groupId: 'Notes de veille', name: 'Notes de veille', sessionKeys: ['agent:main:a'], lastActivityAt: AT }],
    });
    assert.deepEqual(candidates[0].sources[0].ref, { by: 'group', groupId: 'Notes de veille', name: 'Notes de veille' });
    assert.equal(candidates[0].key, 'sg:group:Notes de veille');
    const after = repo.getProject(stored.id);
    assert.deepEqual(after.sources.find((s) => s.kind === 'sessionGroup').ref, { by: 'group', groupId: 'Netzach', name: 'Netzach' });
    assert.deepEqual(repo.getHistory(stored.id).events.filter((e) => e.kind === 'source-linked'), historyBefore);
  });

  it('matches the example session-group ref', () => {
    const example = loadExample('candidates-vm').data.candidates.find((c) => c.key === 'sg:group:Automations');
    assert.equal(example.sources[0].ref.by, 'group');
    const found = discovery.proposeCandidates({
      now: example.lastActivityAt,
      sessionGroups: [{ groupId: example.sources[0].ref.groupId, name: example.sources[0].ref.name, lastActivityAt: example.lastActivityAt }],
    });
    const vm = buildCandidatesVM(found, { scannedAt: loadExample('candidates-vm').data.scannedAt });
    assert.deepEqual(compareShape(example, vm.candidates[0]), []);
    assert.deepEqual(vm.candidates[0].sources[0].ref, example.sources[0].ref);
    assert.equal(vm.candidates[0].key, example.key);

    const projectExample = loadExample('project-vm').data.sources.find((s) => s.kind === 'sessionGroup');
    assert.deepEqual(Object.keys(projectExample.ref).sort(), ['by', 'groupId', 'name']);
    const errorExample = loadExample('error-409-project').error.current.vm.sources.find((s) => s.kind === 'sessionGroup');
    assert.deepEqual(errorExample.ref, projectExample.ref);
  });
});
