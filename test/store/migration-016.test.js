'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { openDatabase, MIGRATIONS_DIR } = require('../../src/store/db');
test('migration 016 retains active summary identities while completed/ordinary deliveries remain unlocked', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-m016-')), migrationsDir = path.join(dir, 'migrations'), data = path.join(dir, 'data');
  fs.mkdirSync(migrationsDir);
  for (const n of fs.readdirSync(MIGRATIONS_DIR)) if (Number(n.slice(0, 3)) <= 15) fs.copyFileSync(path.join(MIGRATIONS_DIR, n), path.join(migrationsDir, n));
  let h = openDatabase({ dir: data, instance: 'test', migrationsDir });
  t.after(() => { h.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const insert = h.db.prepare("INSERT INTO projects(id, name, status, priority, summary, last_activity_at, revision, created_at) VALUES (?, 'Fixture', 'todo', 'P2', '', 1, 1, 1)");
  // Seed the historical schema directly: today's repository requires migration 025 provenance.
  const comment=h.db.prepare("INSERT INTO project_comments(id,project_id,kind,author_kind,author_name,body,mentions_json,delivery_json,created_at) VALUES (?, ?, ?, 'system', 'Fixture', 'summary-requested', '[]', ?, 1)");
  for (const [id, phase, status, kind] of [['active','queued','pending','event'], ['tracking','tracking','replied','event'], ['settled','settled','replied','event'], ['ordinary','tracking','working','comment']]) {
    insert.run('prj_' + id);
    comment.run('cmt_'+id,'prj_'+id,kind,JSON.stringify([{agentId:'main',status,follow:{phase,summary:{turnId:'trn_'+id}}}]));
  }
  h.close();
  fs.copyFileSync(path.join(MIGRATIONS_DIR, '016_summary_turn.sql'), path.join(migrationsDir, '016_summary_turn.sql'));
  h = openDatabase({ dir: data, instance: 'test', migrationsDir });
  assert.deepEqual(h.applied, [16]);
  const rows = h.db.prepare('SELECT id, summary_turn, revision FROM projects ORDER BY id').all();
  assert.deepEqual(rows.map(r => [r.id, r.summary_turn, r.revision]), [['prj_active','trn_active',1],['prj_ordinary',null,1],['prj_settled',null,1],['prj_tracking','trn_tracking',1]]);
  h.close(); h = openDatabase({ dir: data, instance: 'test', migrationsDir }); assert.deepEqual(h.applied, []);
  assert.deepEqual(h.db.prepare('SELECT id, summary_turn, revision FROM projects ORDER BY id').all(), rows);
});
