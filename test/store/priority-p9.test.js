'use strict';
// architect-55 (PM decision): project priorities P0–P9. Migration 010 rebuilds `projects` (SQLite can't alter a CHECK)
// with the other project tables' references checked; stored P0–P3 values are kept as they are.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase, MIGRATIONS_DIR } = require('../../src/store/db');
const { createProjectsRepository } = require('../../src/store/repos/projects');
const { AT, Owner, timmy } = require('../projects/helpers');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao-p9-'));
const repoOf = (h) => createProjectsRepository(h.db, { persons: [Owner(), timmy()], ownerPersonId: Owner().id, timmyPersonId: timmy().id, githubOwners: ['acme'], now: () => AT });

describe('migration 010 · priorities P0–P9', () => {
  it('a 009 store with projects (sources, flags, history) upgrades: every row and reference kept, P0–P3 unchanged', () => {
    const d = tmp(), mig = path.join(d, 'm');
    try {
      fs.mkdirSync(mig);
      for (const f of fs.readdirSync(MIGRATIONS_DIR)) if (Number(f.slice(0, 3)) <= 9) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(mig, f));
      let h = openDatabase({ dir: path.join(d, 'data'), instance: 'test', migrationsDir: mig });
      let repo = repoOf(h);
      const ids = [];
      for (const [name, priority] of [['Un', 'P0'], ['Deux', 'P1'], ['Trois', 'P2'], ['Quatre', 'P3']]) {
        const p = repo.createProject({ name, priority, actor: 'owner', sources: [{ kind: 'github', ref: { owner: 'acme', repo: name.toLowerCase() } }] });
        const q = repo.addLabel({ id: p.id, expectedRevision: p.revision, label: 'client', actor: 'owner' });
        repo.setStatus({ id: p.id, expectedRevision: q.revision, status: 'in-progress', actor: 'owner' });
        ids.push(p.id);
      }
      const snapshot = (db) => ['projects', 'project_sources', 'project_flags', 'history_events'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all().map((r) => ({ ...r })));
      const before = snapshot(h.db);
      assert.throws(() => h.db.prepare("UPDATE projects SET priority = 'P7' WHERE id = ?").run(ids[0]), /CHECK/);
      h.close();
      for (const f of fs.readdirSync(MIGRATIONS_DIR)) if (Number(f.slice(0, 3)) > 9) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(mig, f));
      h = openDatabase({ dir: path.join(d, 'data'), instance: 'test', migrationsDir: mig });
      try {
        assert.deepEqual(snapshot(h.db), before, 'every row identical');
        assert.deepEqual(h.db.prepare('PRAGMA foreign_key_check').all(), []);
        assert.equal(h.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'references enforced again');
        assert.ok(h.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'projects_board'").get());
        repo = repoOf(h);
        const p = repo.getProject(ids[3]);
        assert.equal(repo.edit({ id: p.id, expectedRevision: p.revision, priority: 'P7', actor: 'owner' }).priority, 'P7');
        assert.throws(() => h.db.prepare("UPDATE projects SET priority = 'P10' WHERE id = ?").run(ids[0]), /CHECK/);
        assert.throws(() => repo.edit({ id: ids[0], expectedRevision: repo.getProject(ids[0]).revision, priority: 'P10', actor: 'owner' }), /Priorité invalide/);
      } finally { h.close(); }
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  it("a migration that would break a reference is refused and rolled back (the runner's foreign-key check)", () => {
    const d = tmp(), mig = path.join(d, 'm');
    try {
      fs.mkdirSync(mig);
      for (const f of fs.readdirSync(MIGRATIONS_DIR)) if (Number(f.slice(0, 3)) <= 10) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(mig, f));
      let h = openDatabase({ dir: path.join(d, 'data'), instance: 'test', migrationsDir: mig });
      const p = repoOf(h).createProject({ name: 'Un', actor: 'owner', sources: [{ kind: 'github', ref: { owner: 'acme', repo: 'un' } }] });
      h.close();
      fs.writeFileSync(path.join(mig, '099_bad.sql'), "-- ao:foreign-keys-off\nDELETE FROM projects;\n");
      assert.throws(() => openDatabase({ dir: path.join(d, 'data'), instance: 'test', migrationsDir: mig }), (e) => e.code === 'migration-failed');
      const db = new DatabaseSync(path.join(d, 'data', 'agent-office.sqlite'), { readOnly: true });
      try { assert.equal(db.prepare('SELECT count(*) AS n FROM projects WHERE id = ?').get(p.id).n, 1, 'nothing changed'); } finally { db.close(); }
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

describe('priorities P0–P9 · the API (v2 and v3) and meta', () => {
  let h;
  before(async () => { h = await startServer(loadScenario('synthetic-basic')); });
  after(async () => { if (h) await h.stop(); });
  it('a project at P9, then P5; P10 is refused; meta has ten labels in both locales', async () => {
    const r = await h.post('/api/v2/projects', { name: 'Échelle', status: 'todo', priority: 'P9', summary: '', sources: [] });
    assert.equal(r.status, 200, r.text);
    const id = r.json.data.result && r.json.data.result.id ? r.json.data.result.id : r.json.data.vm.id;
    for (const v of ['v2', 'v3']) assert.equal((await h.get(`/api/${v}/views/projects/${id}`)).json.data.priority, 'P9', v);
    const rev = (await h.get(`/api/v3/views/projects/${id}`)).json.data.revision;
    const e = await h.patch(`/api/v3/projects/${id}`, { expectedRevision: rev, priority: 'P5' });
    assert.equal(e.status, 200, e.text);
    const bad = await h.patch(`/api/v2/projects/${id}`, { expectedRevision: e.json.data.revision ?? rev + 1, priority: 'P10' });
    assert.equal(bad.status, 400);
    for (const v of ['v2', 'v3']) {
      const meta = (await h.get(`/api/${v}/meta`)).json.data;
      const labels = meta.labels || {};
      for (const p of ['P0', 'P4', 'P9']) assert.ok(labels['priority.' + p], `${v} priority.${p}`);
    }
    const en = await fetch(h.base + '/api/v3/meta', { headers: { 'accept-language': 'en' } }).then((x) => x.json());
    assert.equal(en.data.labels['priority.P9'], 'P9 · minimal');
  });
});
