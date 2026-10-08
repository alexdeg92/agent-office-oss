'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { commands } = require('../../src/projects');
const { hashEmail } = require('../../src/projects/email');
const { AT, repository, Owner, timmy } = require('./helpers');

describe('project people', () => {
  it('merges a git author into the human with the same email hash', () => {
    const hash = hashEmail('Ada@Example.com');
    const repo = repository({ persons: [Owner({ gitEmailHash: hash, discordUserId: '100000000000000001' }), timmy()] });
    const project = commands.createProject(repo, { name: 'Portail', actor: 'owner', at: AT });
    const linked = commands.linkSource(repo, {
      id: project.id, expectedRevision: 1, actor: 'owner', at: AT,
      source: { kind: 'workspace', ref: { path: 'sites/demo' } },
    });
    repo.putWorkspaceSnapshot({
      sourceId: linked.sources[0].id,
      branch: 'main',
      authors: [{ name: 'owner', emailHash: hash }, { name: 'owner', emailHash: hash }],
      commits: [],
    });
    const people = repo.getProject(project.id).people;
    assert.equal(people.filter((p) => p.personId === 'per_alexowner000000').length, 1);
    assert.equal(people[0].commitCount, 2);
    assert.equal(repo.listPersons().some((p) => p.kind === 'git'), false);
  });

  it('adds a discord human and Timmy from a session group, and honours a hide', () => {
    const repo = repository({
      persons: [Owner({ discordUserId: '100000000000000001' }), timmy()],
    });
    const project = commands.createProject(repo, { name: 'Portail', actor: 'owner', at: AT });
    const linked = commands.linkSource(repo, {
      id: project.id, expectedRevision: 1, actor: 'owner', at: AT,
      source: { kind: 'sessionGroup', ref: { by: 'interlocutor', interlocutorId: 'discord-user:100000000000000001' } },
    });
    repo.putSessionSnapshot({
      sourceId: linked.sources[0].id,
      sessions: [{
        key: 'agent:main:discord',
        class: { kind: 'chat-direct', agentId: 'main', interlocutorId: 'discord-user:100000000000000001' },
      }],
    });
    const shown = repo.getProject(project.id);
    assert.deepEqual(shown.people.map((p) => p.personId).sort(), ['per_alexowner000000', 'per_timmymain000000']);
    const hidden = commands.setPersonOverride(repo, {
      id: project.id, expectedRevision: shown.revision, personId: 'per_timmymain000000', hidden: true, actor: 'owner', at: AT + 1,
    });
    assert.equal(hidden.people.some((p) => p.personId === 'per_timmymain000000'), false);
    const guest = repo.upsertPerson({
      id: 'per_guest0000000001', kind: 'human', name: 'Guest', avatarUrl: null, links: {},
    });
    const withRole = commands.setPersonOverride(repo, {
      id: project.id, expectedRevision: hidden.revision, personId: guest.id, role: 'Client', actor: 'owner', at: AT + 2,
    });
    const membership = withRole.people.find((p) => p.personId === guest.id);
    assert.equal(membership.origin, 'manual');
    assert.equal(membership.role, 'Client');
  });
});
