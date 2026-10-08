'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRepository } = require('../../src/projects');
const { openDatabase } = require('../../src/store/db');
const { createProjectsRepository } = require('../../src/store/repos/projects');

const AT = Date.UTC(2026, 9, 6, 8, 0, 0);
const ATLAS = 'per_atlasprimary0000';
const REVIEWER = 'per_revieweragent000';
const dirs = [];

after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

function persons() {
  return [
    { id: ATLAS, kind: 'agent', name: 'Atlas', avatarUrl: null, links: { agentId: 'atlas' } },
    { id: REVIEWER, kind: 'agent', name: 'Aaron', avatarUrl: null, links: { agentId: 'reviewer' } },
  ];
}

function names(repo, id) {
  const byId = new Map(repo.listPersons().map((person) => [person.id, person.name]));
  return repo.getProject(id).people.map((row) => byId.get(row.personId));
}

function seat(repo) {
  const actor = { kind: 'agent', agentId: 'atlas' };
  let project = repo.createProject({ name: 'Notes', actor, at: AT });
  project = repo.setPersonOverride({
    id: project.id, expectedRevision: project.revision, personId: ATLAS, actor, at: AT,
  });
  project = repo.setPersonOverride({
    id: project.id, expectedRevision: project.revision, personId: REVIEWER, actor, at: AT + 1,
  });
  return project;
}

describe('primaryAgentId resolver', () => {
  it('orders a memory repository from a string, including the override path', () => {
    const repo = createMemoryRepository({ persons: persons(), primaryAgentId: 'atlas', now: () => AT });
    const project = seat(repo);
    assert.deepEqual(names(repo, project.id), ['Atlas', 'Aaron']);
    assert.deepEqual(project.people.map((row) => row.personId), [ATLAS, REVIEWER]);
  });

  it('reads a SQL callback at derivation time, including the override path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-primary-'));
    dirs.push(dir);
    const handle = openDatabase({ dir, instance: 'test' });
    let current = 'atlas';
    const repo = createProjectsRepository(handle.db, {
      persons: persons(),
      primaryAgentId: () => current,
      now: () => AT,
    });
    const project = seat(repo);
    assert.deepEqual(project.people.map((row) => row.personId), [ATLAS, REVIEWER]);
    current = 'reviewer';
    assert.deepEqual(names(repo, project.id), ['Aaron', 'Atlas']);
    handle.close();
  });
});
