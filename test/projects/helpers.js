'use strict';

const { createMemoryRepository } = require('../../src/projects');

const AT = Date.UTC(2026, 9, 1, 12, 0, 0);

function Owner(extra = {}) {
  return {
    id: 'per_alexowner000000',
    kind: 'human',
    name: 'owner',
    avatarUrl: null,
    links: { isOwner: true, ...extra },
  };
}

function timmy() {
  return {
    id: 'per_timmymain000000',
    kind: 'agent',
    name: 'Timmy',
    avatarUrl: null,
    links: { agentId: 'main' },
  };
}

function repository(options = {}) {
  const persons = options.persons || [Owner(), timmy()];
  return createMemoryRepository({
    persons,
    ownerPersonId: options.ownerPersonId || persons[0].id,
    timmyPersonId: options.timmyPersonId || persons[1].id,
    now: options.now || (() => AT),
    githubOwners: options.githubOwners === undefined ? ['alexdeg92'] : options.githubOwners,
    portability: options.portability,
    workspaceRootIds: options.workspaceRootIds,
    workspaceRoots: options.workspaceRoots,
    randomBytes: options.randomBytes,
  });
}

module.exports = { AT, Owner, timmy, repository };
