'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase, MIGRATIONS_DIR, listMigrations } = require('../../src/store/db');
const { createOfficeRepo } = require('../../src/store/repos/office');
const { indexManifest } = require('../../public/v2/office/assets.js');
const index = indexManifest(require('../../design/office/manifest.example.json'));

test('automatic appearance migration: fresh install, prior-version upgrade and the next numbered migration', t => {
  const own = listMigrations().find(m => m.name === 'office_automatic_looks');
  assert.ok(own.version < 900, 'production migrations cannot use a high placeholder');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decor-looks-upgrade-'));
  const migrationsDir = path.join(dir, 'migrations');
  fs.mkdirSync(migrationsDir);
  const ownFile = fs.readdirSync(MIGRATIONS_DIR).find(f => f.endsWith('_office_automatic_looks.sql'));
  for (const file of fs.readdirSync(MIGRATIONS_DIR)) if (Number(file.slice(0, 3)) < own.version)
    fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(migrationsDir, file));
  const options = { dir: path.join(dir, 'upgrade'), instance: 'test', migrationsDir };
  let h;
  t.after(() => { h?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  h = openDatabase(options);
  assert.equal(h.db.prepare('SELECT max(version) AS n FROM schema_migrations').get().n, own.version - 1);
  h.db.prepare('INSERT INTO office_agents_seen (occupant_id,role,name,last_seen_at) VALUES (?,?,?,?)').run('agent:foreign', 'agent', 'Nova', 123);
  const nativeMax = 'conversation:' + 'x'.repeat(200), scopedMax = 'agent:rt:' + 'x'.repeat(5526 - 'agent:rt:'.length);
  const seedSeen = h.db.prepare('INSERT INTO office_agents_seen (occupant_id,role,name,last_seen_at) VALUES (?,?,?,?)');
  seedSeen.run(nativeMax, 'conversation', 'Native boundary', 123);
  seedSeen.run(scopedMax, 'agent', 'Scoped boundary', 123);
  h.close(); h = null;
  fs.copyFileSync(path.join(MIGRATIONS_DIR, ownFile), path.join(migrationsDir, ownFile));
  h = openDatabase(options);
  assert.deepEqual(h.applied, [own.version]);
  assert.equal(h.db.prepare('SELECT name FROM office_agents_seen').get().name, 'Nova');
  const look = createOfficeRepo(h.db).automaticLook('agent:foreign', index);
  const snapshot = h.db.prepare('UPDATE office_agents_seen SET automatic_look_json=? WHERE occupant_id=?');
  for (const id of [nativeMax, scopedMax]) {
    assert.equal(snapshot.run(JSON.stringify(look), id).changes, 1, 'prior-schema boundary identity accepts its automatic snapshot');
    assert.deepEqual(JSON.parse(h.db.prepare('SELECT automatic_look_json FROM office_agents_seen WHERE occupant_id=?').get(id).automatic_look_json), look);
  }
  h.close(); h = null;
  const fresh = openDatabase({ ...options, dir: path.join(dir, 'fresh') });
  try {
    assert.ok(fresh.applied.includes(own.version));
    assert.deepEqual(createOfficeRepo(fresh.db).automaticLook('agent:foreign', index), look);
  } finally { fresh.close(); }
  const nextMigration = listMigrations().find(m => m.version === own.version + 1);
  assert.equal(nextMigration?.name, 'runtime_auto_add', 'T-0053 follows the assigned version 022 migration');
  const next = nextMigration.version;
  const nextFile = fs.readdirSync(MIGRATIONS_DIR).find(f => f.endsWith('_' + nextMigration.name + '.sql'));
  fs.copyFileSync(path.join(MIGRATIONS_DIR, nextFile), path.join(migrationsDir, nextFile));
  h = openDatabase(options);
  assert.deepEqual(h.applied, [next], 'the next ordinary migration is discovered and applied');
  assert.ok(h.db.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_auto_add'").get());
  assert.deepEqual(createOfficeRepo(h.db).automaticLook('agent:foreign', index), look);
});
