'use strict';
// S5: the SQL projects repository passes the projects module's repository contract unchanged (projects-05).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { after } = require('node:test');
const { openDatabase } = require('../../src/store/db');
const { createProjectsRepository } = require('../../src/store/repos/projects');
const { defineRepositoryContract } = require('../projects/repository-contract.test.js');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// A fresh database per repository: the contract creates one repository per case.
defineRepositoryContract((options) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-prj-'));
  dirs.push(dir);
  const handle = openDatabase({ dir, instance: 'test' });
  const repo = createProjectsRepository(handle.db, options);
  repo.close = () => handle.close();
  return repo;
}, 'sql');

// SQL-specific: what the memory repository can't show.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { AT, Owner, timmy } = require('../projects/helpers');
const { OWNER_ACTOR_SHORT } = require('../../src/projects/constants');
const { openStore } = require('../../src/store');
const { tryLoadConfig } = require('../../src/config');
const { createProjectService } = require('../../src/projects');

describe('SQL projects repository · durability', () => {
  const open = (dir) => { const h = openDatabase({ dir, instance: 'test' }); return { h, repo: createProjectsRepository(h.db, { persons: [Owner(), timmy()], ownerPersonId: Owner().id, timmyPersonId: timmy().id, githubOwners: ['alexdeg92'], now: () => AT }) }; };
  const plain = (x) => JSON.parse(JSON.stringify(x));

  it('reopens an existing owner and agent without changing IDs, rows or configured code-host owners; old and new commands work', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-existing-owner-')); dirs.push(dir);
    const cfg = tryLoadConfig({ AO_ENV: 'test', AO_DATA_DIR: dir, HOME: dir, OC_HOME: dir,
      PORTAL_EMAIL: 'owner@example.invalid', PORTAL_PASSWORD: 'test-password', PORTAL_SECRET: 'test-secret',
      AO_PROJECTS_OWNERS: ' acme, existing-org ' });
    assert.deepEqual(cfg.projectsOwners, ['acme', 'existing-org']);
    const legacyActor = OWNER_ACTOR_SHORT.find((value) => value !== 'owner');
    assert.equal(legacyActor, ['al', 'ex'].join(''));
    let h = openDatabase({ dir, instance: 'test' });
    const existingOwner = Owner();
    let repo = createProjectsRepository(h.db, { persons: [existingOwner, timmy()], ownerPersonId: existingOwner.id,
      timmyPersonId: timmy().id, githubOwners: cfg.projectsOwners, now: () => AT });
    const p = repo.createProject({ name: 'Existing project', actor: legacyActor,
      sources: [{ kind: 'github', ref: { owner: 'existing-org', repo: 'agent-office' } }] });
    const q = repo.addLabel({ id: p.id, expectedRevision: p.revision, label: 'existing', actor: legacyActor });
    const snapshot = (db) => ['persons', 'person_identities', 'projects', 'project_sources', 'project_flags', 'project_people', 'history_events']
      .map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(plain));
    const before = snapshot(h.db);
    h.close();
    const store = openStore({ dir: cfg.dataDir, instance: cfg.instance, ownerName: 'New default name', now: () => AT });
    try {
      assert.equal(store.owner.id, existingOwner.id);
      assert.equal(store.owner.name, existingOwner.name);
      assert.equal(store.persons.ensureAgent('main', 'New default agent name').person.id, timmy().id);
      repo = createProjectsRepository(store.db, { persons: [], ownerPersonId: store.owner.id,
        primaryAgentId: () => 'main', githubOwners: cfg.projectsOwners, now: () => AT });
      const restored = repo.getProject(p.id);
      assert.equal(restored.sources[0].ref.owner, 'existing-org');
      assert.equal(restored.sources[0].ref.repo, 'agent-office');
      assert.deepEqual(restored.sources[0].addedBy, { kind: 'human', personId: existingOwner.id });
      assert.ok(repo.getHistory(p.id).events.every((event) => event.actor.personId === existingOwner.id));
      assert.deepEqual(snapshot(store.db), before, 'boot and reads never rewrite persisted people, sources or actors');
      let current = repo.rename({ id: p.id, expectedRevision: q.revision, name: 'Old caller', actor: legacyActor });
      current = repo.edit({ id: p.id, expectedRevision: current.revision, summary: 'New caller', actor: 'owner' });
      current = repo.edit({ id: p.id, expectedRevision: current.revision, summary: 'Canonical caller',
        actor: { kind: 'human', personId: existingOwner.id } });
      const service = createProjectService({ repository: repo, clock: () => AT });
      const created = service.commands.create({ name: 'Default caller' });
      assert.equal(created.ok, true);
      assert.deepEqual(repo.getHistory(created.vm.id).events[0].actor, { kind: 'human', personId: existingOwner.id });
      const imported = repo.importCandidates({ candidates: [{ key: 'gh:acme/example', name: 'Existing owner config', status: 'todo',
        labels: [], sources: [{ kind: 'github', ref: { owner: 'acme', repo: 'example' } }] }] });
      assert.equal(imported.result.created.length, 1);
      assert.deepEqual(repo.getHistory(imported.result.created[0].id).events[0].actor, { kind: 'human', personId: existingOwner.id });
      repo.edit({ id: p.id, expectedRevision: current.revision, summary: 'Agent caller', actor: { kind: 'agent', agentId: 'main' } });
      const history = repo.getHistory(p.id).events;
      assert.ok(history.some((event) => event.actor.kind === 'agent' && event.actor.personId === timmy().id));
      assert.ok(history.filter((event) => event.actor.kind === 'human').every((event) => event.actor.personId === existingOwner.id));
      assert.deepEqual(store.db.prepare('SELECT * FROM persons ORDER BY rowid').all().map(plain), before[0]);
    } finally { store.close(); }
  });

  it('projects, flags, sources and history survive a reopen, identically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-prj-')); dirs.push(dir);
    let { h, repo } = open(dir);
    const p = repo.createProject({ name: 'Agent Office', actor: 'owner', sources: [{ kind: 'github', ref: { owner: 'alexdeg92', repo: 'agent-office' } }] });
    const q = repo.addLabel({ id: p.id, expectedRevision: p.revision, label: 'client', actor: 'owner' });
    const r = repo.setStatus({ id: p.id, expectedRevision: q.revision, status: 'in-progress', actor: 'owner' });
    const before = { project: plain(repo.getProject(p.id)), history: plain(repo.getHistory(p.id)) };
    h.close();
    ({ h, repo } = open(dir));
    assert.deepEqual(plain(repo.getProject(p.id)), before.project);
    assert.deepEqual(plain(repo.getHistory(p.id)), before.history);
    assert.equal(repo.getProject(p.id).revision, r.revision);
    h.close();
  });

  it('history is append-only at the database level; a refused command writes nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-prj-')); dirs.push(dir);
    const { h, repo } = open(dir);
    const p = repo.createProject({ name: 'X', actor: 'owner' });
    assert.throws(() => h.db.exec('DELETE FROM history_events'), /append-only/);
    assert.throws(() => h.db.exec("UPDATE history_events SET at = 0"), /append-only/);
    const n = () => h.db.prepare('SELECT count(*) AS n FROM history_events').get().n;
    const before = n();
    assert.throws(() => repo.setStatus({ id: p.id, expectedRevision: p.revision + 5, status: 'todo', actor: 'owner' }));   // 409
    assert.equal(n(), before); assert.equal(repo.getProject(p.id).revision, p.revision);
    h.close();
  });

  it('reads a stored timmy actor as the agent Person and leaves the row unchanged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-prj-')); dirs.push(dir);
    const { h, repo } = open(dir);
    const p = repo.createProject({ name: 'X', actor: 'owner' });
    const stored = JSON.stringify({
      id: 'evt_legacytimmy0001', projectId: p.id, at: AT + 1, kind: 'summary-edited', dedupeKey: null, actor: 'timmy',
    });
    h.db.prepare('INSERT INTO history_events (id, project_id, at, kind, dedupe_key, data_json) VALUES (?, ?, ?, ?, ?, ?)').run(
      'evt_legacytimmy0001', p.id, AT + 1, 'summary-edited', null, stored,
    );
    const event = repo.getHistory(p.id).events.find((item) => item.id === 'evt_legacytimmy0001');
    assert.deepEqual(event.actor, { kind: 'agent', personId: timmy().id });
    assert.equal(h.db.prepare('SELECT data_json FROM history_events WHERE id = ?').get('evt_legacytimmy0001').data_json, stored);
    h.close();
  });
});
