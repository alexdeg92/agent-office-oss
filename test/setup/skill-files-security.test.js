'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const I = require('../../src/adapters/openclaw/integration');
const { createSetupIntegrations } = require('../../src/ops/setup-integrations');
const ORIGINAL = '# Synthetic instructions\n\nKeep this unrelated text.\n';
function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-skill-security-'));
  const workspace = path.join(tmp, 'workspace'), backupDir = path.join(tmp, 'data/integrations/backups');
  fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'AGENTS.md'), ORIGINAL, { mode: 0o600 });
  return { tmp, workspace, backupDir, agent: { id: 'synthetic', workspace } };
}
const owned = f => [path.join(f.workspace, 'AGENTS.md'), ...Object.keys(I.expected(f.workspace, 'fr').files).map(n => path.join(f.workspace, 'skills/projet', n))];

test('S01-01: predictable temporary links before/after review never overwrite any outside sentinel', async () => {
  for (const beforePlan of [true, false]) for (let index = 0; index < 3; index++) {
    const f = fixture();
    try {
      I.install(f.agent, { locale: 'fr', backupDir: f.backupDir });
      const sentinel = path.join(f.tmp, 'outside-sentinel'), bytes = Buffer.from('synthetic outside bytes\n'); fs.writeFileSync(sentinel, bytes);
      const destination = owned(f)[index], planted = destination + '.agent-office-tmp-' + process.pid;
      if (beforePlan) fs.symlinkSync(sentinel, planted);
      const service = createSetupIntegrations({ env: { HOME: f.tmp, AO_ENV: 'test', PATH: '' }, paths: {}, dataDir: path.join(f.tmp, 'data') });
      const plan = await service.plan({ runtime: 'openclaw', agents: [f.agent], locale: 'en' });
      if (!beforePlan) fs.symlinkSync(sentinel, planted);
      let error; try { service.apply({ planId: plan.planId, agentIds: [f.agent.id], confirmed: true }); } catch (e) { error = e; }
      assert.deepEqual(fs.readFileSync(sentinel), bytes, `outside sentinel preserved for ${destination}`);
      assert.ok(!fs.lstatSync(destination).isSymbolicLink(), 'no link published as a destination');
      assert.ok(fs.lstatSync(planted).isSymbolicLink(), 'unrelated planted entry was not cleaned up');
      assert.equal(error, undefined);
    } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
  }
});

test('S01-01: uninstall does not follow temporary links or clean up unreviewed entries', async () => {
  const f = fixture();
  try {
    I.install(f.agent, { locale: 'fr', backupDir: f.backupDir });
    const sentinel = path.join(f.tmp, 'outside-sentinel'); fs.writeFileSync(sentinel, 'unchanged\n');
    const service = createSetupIntegrations({ env: { HOME: f.tmp, AO_ENV: 'test', PATH: '' }, paths: {}, dataDir: path.join(f.tmp, 'data') });
    const plan = await service.plan({ runtime: 'openclaw', agents: [f.agent], locale: 'fr' });
    const planted = owned(f).map(file => file + '.agent-office-tmp-' + process.pid);
    for (const file of planted) fs.symlinkSync(sentinel, file);
    const extra = path.join(f.workspace, 'skills/projet/unrelated.txt'); fs.writeFileSync(extra, 'keep me');
    let error; try { service.apply({ planId: plan.planId, agentIds: [f.agent.id], confirmed: true, action: 'uninstall' }); } catch (e) { error = e; }
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged\n');
    assert.equal(fs.readFileSync(path.join(f.workspace, 'AGENTS.md'), 'utf8'), ORIGINAL);
    assert.ok(!fs.lstatSync(path.join(f.workspace, 'AGENTS.md')).isSymbolicLink());
    for (const file of planted) assert.ok(fs.lstatSync(file).isSymbolicLink(), 'unrelated link survives uninstall');
    assert.equal(fs.readFileSync(extra, 'utf8'), 'keep me'); assert.equal(error, undefined);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('S01-01: legacy backup collisions never follow links and backups start private', () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.backupDir, { recursive: true });
    const sentinel = path.join(f.tmp, 'outside-sentinel'); fs.writeFileSync(sentinel, 'unchanged\n');
    const planted = path.join(f.backupDir, f.agent.id + '-AGENTS.md-1000'); fs.symlinkSync(sentinel, planted);
    const result = I.install(f.agent, { locale: 'fr', backupDir: f.backupDir, now: () => 1000 });
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged\n');
    assert.ok(fs.lstatSync(planted).isSymbolicLink());
    assert.equal(fs.statSync(result.backup).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(result.backup, 'utf8'), ORIGINAL);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('S01-01: parent replacement between validation and open cannot mutate outside directories', () => {
  for (const parentKind of ['workspace', 'skills', 'skill-directory', 'backups']) {
    const f = fixture();
    try {
      I.install(f.agent, { locale: 'fr', backupDir: f.backupDir });
      const parent = { workspace: f.workspace, skills: path.join(f.workspace, 'skills'), 'skill-directory': path.join(f.workspace, 'skills/projet'), backups: f.backupDir }[parentKind];
      const outside = path.join(f.tmp, 'outside'); fs.mkdirSync(outside);
      fs.mkdirSync(path.join(outside, 'skills/projet'), { recursive: true });
      fs.mkdirSync(path.join(outside, 'projet'), { recursive: true });
      for (const file of ['AGENTS.md', 'SKILL.md', 'projet.js', 'skills/projet/SKILL.md', 'skills/projet/projet.js', 'projet/SKILL.md', 'projet/projet.js']) fs.writeFileSync(path.join(outside, file), 'outside ' + file);
      const snapshot = () => fs.readdirSync(outside, { recursive: true }).sort().map(name => [name, fs.statSync(path.join(outside, name)).isFile() ? fs.readFileSync(path.join(outside, name), 'utf8') : null]);
      const before = snapshot(); let replaced = false;
      const replace = () => { if (!replaced) { replaced = true; fs.renameSync(parent, parent + '.held'); fs.symlinkSync(outside, parent); } };
      const fsx = Object.create(fs);
      fsx.lstatSync = (file, ...args) => { const s = fs.lstatSync(file, ...args); if (file === parent) replace(); return s; };
      // The same controlled race also exercises the old unpinned writer in failing-before runs.
      fsx.writeFileSync = (file, ...args) => { if (typeof file === 'string' && file.includes('.agent-office-tmp-') && (path.dirname(file) === parent || file.startsWith(parent + path.sep))) replace(); return fs.writeFileSync(file, ...args); };
      fsx.copyFileSync = (from, to, ...args) => { if (parentKind === 'backups') replace(); return fs.copyFileSync(from, to, ...args); };
      let error; try { I.install(f.agent, { locale: 'en', backupDir: f.backupDir, fsx }); } catch (e) { error = e; }
      assert.ok(replaced, parentKind + ' race was exercised');
      assert.deepEqual(snapshot(), before, parentKind + ' outside tree is byte-identical');
      assert.equal(error?.code, 'EUNSAFEPATH', 'replacement is refused');
      assert.ok(fs.existsSync(parent + '.held'), 'no unrelated directory cleanup');
    } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
  }
});

test('S01-01: exclusive open and failure cleanup preserve attacker replacement inodes', () => {
  const P = require('../../src/ops/safe-fs'), f = fixture();
  try {
    const worker = require.resolve('../../src/ops/safe-fs');
    const sentinel = path.join(f.tmp, 'outside-sentinel'); fs.writeFileSync(sentinel, 'outside unchanged');
    for (const collision of [true, false]) {
      const job = { ...P.capture(f.workspace), file: collision ? 'new-file' : 'other-file', operation: { type: 'write', text: 'integration', mode: 0o600 } };
      const script = `const fs=require('fs'), P=require(${JSON.stringify(worker)}), job=JSON.parse(process.argv[1]), fsx=Object.create(fs); let tmp;
        fsx.openSync=(file,flags,mode)=>{tmp=file;if(!(flags&fs.constants.O_EXCL)||mode!==0o600)throw Error('not exclusive/private');if(${collision})fs.symlinkSync(${JSON.stringify(sentinel)},file);return fs.openSync(file,flags,mode);};
        fsx.writeFileSync=(fd,text)=>{fs.writeFileSync(fd,text);fs.unlinkSync(tmp);fs.writeFileSync(tmp,'attacker replacement');throw Object.assign(Error('injected write failure'),{code:'EIO'});};
        let code;try{P.execute(job,fsx);}catch(e){code=e.code;}process.stdout.write(JSON.stringify({code,tmp}));`;
      const r = spawnSync(process.execPath, ['-e', script, JSON.stringify(job)], { cwd: f.workspace, env: { PATH: '', NODE_OPTIONS: '' }, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr); const result = JSON.parse(r.stdout);
      assert.equal(result.code, collision ? 'EEXIST' : 'EIO');
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside unchanged');
      assert.ok(!fs.existsSync(path.join(f.workspace, job.file)), 'no destination published');
      if (collision) assert.ok(fs.lstatSync(path.join(f.workspace, result.tmp)).isSymbolicLink());
      else assert.equal(fs.readFileSync(path.join(f.workspace, result.tmp), 'utf8'), 'attacker replacement', 'cleanup did not unlink another inode');
    }
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('S01-03: existing instruction modes survive install/update/uninstall and mode changes invalidate plans', async () => {
  for (const mode of [0o600, 0o640]) {
    const f = fixture();
    try {
      const file = path.join(f.workspace, 'AGENTS.md'); fs.chmodSync(file, mode);
      for (const locale of ['fr', 'en']) { I.install(f.agent, { locale, backupDir: f.backupDir }); assert.equal(fs.statSync(file).mode & 0o777, mode); }
      const service = createSetupIntegrations({ env: { HOME: f.tmp, AO_ENV: 'test', PATH: '' }, paths: {}, dataDir: path.join(f.tmp, 'data') });
      const plan = await service.plan({ runtime: 'openclaw', agents: [f.agent], locale: 'fr' });
      fs.chmodSync(file, mode === 0o600 ? 0o640 : 0o600);
      assert.throws(() => service.apply({ planId: plan.planId, agentIds: [f.agent.id], confirmed: true }), { code: 'ESTALEPLAN' });
      fs.chmodSync(file, mode); I.uninstall(f.agent, { locale: 'en', backupDir: f.backupDir });
      assert.equal(fs.statSync(file).mode & 0o777, mode);
      for (const name of fs.readdirSync(f.backupDir)) assert.equal(fs.statSync(path.join(f.backupDir, name)).mode & 0o777, 0o600);
      fs.unlinkSync(file); I.install(f.agent, { locale: 'fr', backupDir: f.backupDir }); assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'new instructions are private');
    } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
  }
});

test('S01-04: unknown files, directories, links and edited marker-bearing files survive uninstall', () => {
  const f = fixture();
  try {
    I.install(f.agent, { locale: 'fr', backupDir: f.backupDir });
    const dir = path.join(f.workspace, 'skills/projet'), edited = path.join(dir, 'SKILL.md'); fs.appendFileSync(edited, '\nUnrelated owner edits.\n');
    const before = fs.readFileSync(edited); fs.mkdirSync(path.join(dir, 'unknown')); fs.writeFileSync(path.join(dir, 'unknown/owner.txt'), 'keep');
    const outside = path.join(f.tmp, 'outside'); fs.writeFileSync(outside, 'unchanged'); fs.symlinkSync(outside, path.join(dir, 'owner-link'));
    I.uninstall(f.agent, { locale: 'fr', backupDir: f.backupDir });
    assert.deepEqual(fs.readFileSync(edited), before); assert.equal(fs.readFileSync(path.join(dir, 'unknown/owner.txt'), 'utf8'), 'keep');
    assert.ok(fs.lstatSync(path.join(dir, 'owner-link')).isSymbolicLink()); assert.equal(fs.readFileSync(outside, 'utf8'), 'unchanged');
    assert.equal(fs.readFileSync(path.join(f.workspace, 'AGENTS.md'), 'utf8'), ORIGINAL);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});
