'use strict';
// A store built by the approved go-live release (5a38aec, schema v6) opens on HEAD.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('../../src/store/db');

const REPO = path.resolve(__dirname, '../..');
const SHA = '5a38aec573ee942a1e1d551b488700c8ed614c5e';
const SEED = path.join(__dirname, 'golive-store-seed.js');
const cleanup = [];

function git(args, cwd = REPO) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'git failed').trim());
  return result.stdout;
}

function ensureCommit() {
  const have = spawnSync('git', ['cat-file', '-e', SHA + '^{commit}'], { cwd: REPO });
  if (have.status === 0) return;
  git(['fetch', '--depth', '1', 'origin', SHA]);
}

function worktree() {
  ensureCommit();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-golive-'));
  cleanup.push(dir);
  git(['worktree', 'add', '--detach', '--no-checkout', dir, SHA]);
  git(['sparse-checkout', 'set', '--cone', 'src', 'design/office'], dir);
  git(['checkout', '--detach', SHA], dir);
  return dir;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

after(() => {
  for (const dir of cleanup) {
    spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: REPO });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  spawnSync('git', ['worktree', 'prune'], { cwd: REPO });
});

describe('upgrade from the go-live release', () => {
  it('migrates a 5a38aec store to the latest (012), keeps its data, backs up first, and refuses a downgrade', () => {
    const tree = worktree();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-golive-data-'));
    cleanup.push(data);
    const seeded = spawnSync(process.execPath, [SEED, tree, data], { encoding: 'utf8' });
    assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
    const marker = JSON.parse(seeded.stdout.trim());
    const logs = [];
    const opened = openDatabase({ dir: data, instance: 'test', log: (line) => logs.push(line) });
    assert.deepEqual(opened.applied, [7, 8, 9, 10, 11, 12]);
    assert.equal(opened.db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v, 12);
    assert.match(logs.join('\n'), /pre-migration backup agent-office-premigrate-v006-/);

    const project = opened.db.prepare('SELECT name, summary FROM projects WHERE id = ?').get(marker.projectId);
    assert.equal(project.name, 'Agent Office');
    assert.equal(project.summary, 'Le bureau');
    const source = opened.db.prepare('SELECT ref_key FROM project_sources WHERE project_id = ?').get(marker.projectId);
    assert.equal(source.ref_key, 'acme-labs/agent-office');
    const layout = opened.db.prepare('SELECT name, data_json FROM office_layouts WHERE id = ?').get(marker.layoutId);
    assert.equal(layout.name, 'Bureau principal');
    assert.equal(JSON.parse(layout.data_json).room, 'bureau');
    const audit = opened.db.prepare('SELECT command, target, outcome FROM audit_log').get();
    assert.equal(audit.command, 'projects.create');
    assert.equal(audit.target, marker.projectId);
    assert.equal(audit.outcome, 'ok');
    assert.equal(opened.db.prepare('SELECT sid FROM revoked_sessions').get().sid, '0123456789abcdef');
    const identity = opened.db.prepare("SELECT family, external_id FROM person_identities WHERE person_id = ?").get(marker.ownerId);
    assert.equal(identity.family, 'discord');
    assert.equal(identity.external_id, '100000000000000001');
    const seen = opened.db.prepare('SELECT occupant_id, role, name FROM office_agents_seen').get();
    assert.equal(seen.occupant_id, 'scheduled:morning');
    assert.equal(seen.role, 'scheduled');
    assert.equal(seen.name, 'Revue du matin');

    const backups = fs.readdirSync(path.join(data, 'backups')).filter((name) => name.startsWith('agent-office-premigrate-'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^agent-office-premigrate-v006-\d+\.sqlite$/);
    const backup = new DatabaseSync(path.join(data, 'backups', backups[0]), { readOnly: true });
    assert.equal(backup.prepare('SELECT max(version) AS v FROM schema_migrations').get().v, 6);
    assert.equal(backup.prepare('SELECT name FROM projects').get().name, 'Agent Office');
    assert.equal(backup.prepare('SELECT name FROM office_layouts').get().name, 'Bureau principal');
    assert.equal(backup.prepare('SELECT command FROM audit_log').get().command, 'projects.create');
    assert.equal(backup.prepare('SELECT sid FROM revoked_sessions').get().sid, '0123456789abcdef');
    assert.equal(backup.prepare('SELECT discord_user_id FROM persons WHERE is_owner = 1').get().discord_user_id, '100000000000000001');
    const seenThen = backup.prepare('SELECT occupant_id, role FROM office_agents_seen').get();
    assert.equal(seenThen.occupant_id, 'cron:morning');
    assert.equal(seenThen.role, 'cron');
    assert.equal(backup.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'person_identities'").get().n, 0);
    backup.close();

    opened.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    opened.close();
    const file = path.join(data, 'agent-office.sqlite');
    const before = sha256(file);
    const downgrade = spawnSync(process.execPath, ['-e', `
      const { openDatabase } = require(process.argv[1]);
      try { openDatabase({ dir: process.argv[2], instance: 'test' }).close(); process.exit(0); }
      catch (e) { process.stdout.write(JSON.stringify({ code: e.code || '', message: e.message })); process.exit(3); }
    `, path.join(tree, 'src/store/db.js'), data], { encoding: 'utf8' });
    assert.equal(downgrade.status, 3, downgrade.stderr || downgrade.stdout);
    const refused = JSON.parse(downgrade.stdout);
    assert.equal(refused.code, 'schema-too-new');
    assert.match(refused.message, /newer than this build/);
    assert.equal(sha256(file), before);
    const still = new DatabaseSync(file, { readOnly: true });
    assert.equal(still.prepare('SELECT max(version) AS v FROM schema_migrations').get().v, 12);
    assert.equal(still.prepare('SELECT name FROM projects').get().name, 'Agent Office');
    still.close();
  });
});
