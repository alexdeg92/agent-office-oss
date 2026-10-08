'use strict';
// architect-55 · a slug the agent's tag created a project for is claimed for good (migration 011): the same slug never
// creates twice, and renaming, unlinking or archiving that project never lets an old tag create it again.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { openDatabase } = require('../../src/store/db');
const { createProjectsRepository } = require('../../src/store/repos/projects');
const { createMemoryRepository } = require('../../src/projects');
const { AT, Owner, timmy } = require('../projects/helpers');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const options = { persons: [Owner(), timmy()], ownerPersonId: Owner().id, timmyPersonId: timmy().id, githubOwners: ['acme'], now: () => AT };
const sql = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-tag-')); dirs.push(d); const h = openDatabase({ dir: d, instance: 'test' }); return { repo: createProjectsRepository(h.db, options), reopen: () => { h.close(); const h2 = openDatabase({ dir: d, instance: 'test' }); return createProjectsRepository(h2.db, options); } }; };

for (const [kind, make] of [['memory', () => ({ repo: createMemoryRepository(options), reopen: null })], ['sql', sql]]) {
  describe(`tag slugs · ${kind} repository`, () => {
    it('a slug creates one project, once; renamed, unlinked and archived, its slug stays claimed', () => {
      const { repo, reopen } = make();
      const input = { slug: 'menu-builder', name: 'Générateur de menus', status: 'in-progress', priority: 'P7', actor: 'system', component: 'engine', at: AT };
      const p = repo.createTaggedProject(input);
      assert.deepEqual([p.name, p.status, p.priority], ['Générateur de menus', 'in-progress', 'P7']);
      assert.ok(p.sources.some((s) => s.kind === 'sessionGroup' && s.ref.groupId === 'projet:menu-builder'));
      assert.equal(repo.createTaggedProject(input), null, 'never twice');
      assert.equal(repo.tagSlugOwner('menu-builder'), p.id);
      let cur = repo.rename({ id: p.id, expectedRevision: p.revision, name: 'Autre nom', actor: 'owner' });
      const src = cur.sources.find((s) => s.kind === 'sessionGroup');
      cur = repo.unlinkSource({ id: p.id, expectedRevision: cur.revision, sourceId: src.id, actor: 'owner' });
      repo.setArchived({ id: p.id, expectedRevision: cur.revision, archived: true, actor: 'owner' });
      assert.equal(repo.createTaggedProject(input), null, 'still claimed after a rename, an unlink and the archive');
      assert.equal(repo.createTaggedProject(Object.assign({}, input, { slug: 'X' })), null, 'an invalid slug claims nothing');
      if (reopen) assert.equal(reopen().tagSlugOwner('menu-builder'), p.id, 'claimed across a restart');
    });
  });
}
