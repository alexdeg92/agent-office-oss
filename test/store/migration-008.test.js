'use strict';
// R22-04 · migration 008: the seen-occupant inventory becomes canonical (3.0); 2.x rows are converted, nothing lost.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { openDatabase, MIGRATIONS_DIR } = require('../../src/store/db');

it('2.x rows → canonical ids and roles; canonical rows are accepted, 2.x roles refused afterwards', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-m008-')), mig = path.join(d, 'm');
  try {
    fs.mkdirSync(mig);
    for (const f of fs.readdirSync(MIGRATIONS_DIR)) if (Number(f.slice(0, 3)) <= 7) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(mig, f));
    const pre = openDatabase({ dir: path.join(d, 'data'), instance: 'test', migrationsDir: mig });
    const ins = pre.db.prepare('INSERT INTO office_agents_seen VALUES (?, ?, ?, ?)');
    for (const [id, role] of [['main', 'main'], ['cron:j1', 'cron'], ['dm:discord-user:1', 'dm'], ['channel:slack-room:C1', 'channel'], ['subagent:s1', 'subagent']]) ins.run(id, role, id, 1);
    pre.close();
    fs.copyFileSync(path.join(MIGRATIONS_DIR, '008_seen_canonical.sql'), path.join(mig, '008_seen_canonical.sql'));
    const h = openDatabase({ dir: path.join(d, 'data'), instance: 'test', migrationsDir: mig });
    try {
      assert.deepEqual(h.applied, [8]);
      assert.deepEqual(h.db.prepare('SELECT occupant_id, role FROM office_agents_seen ORDER BY occupant_id').all().map((r) => [r.occupant_id, r.role]),
        [['direct:discord-user:1', 'direct'], ['group:slack-room:C1', 'group'], ['primary', 'primary'], ['scheduled:j1', 'scheduled'], ['subagent:s1', 'subagent']]);
      h.db.prepare("INSERT INTO office_agents_seen VALUES ('conversation:x', 'conversation', 'x', 2)").run();
      assert.throws(() => h.db.prepare("INSERT INTO office_agents_seen VALUES ('cron:x', 'cron', 'x', 2)").run(), /CHECK/);
    } finally { h.close(); }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
