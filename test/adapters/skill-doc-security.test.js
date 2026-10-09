'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSkillDocReader, MAX_BYTES } = require('../../src/adapters/openclaw/skill-doc');
const NONE = { markdown: '', frontmatter: {} };

for (const replacement of ['link', 'directory']) {
  test('S07-01: approved skill root ' + replacement + ' replacement is refused from configuration onward', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-skill-root-'));
    const root = path.join(tmp, 'home/.openclaw/skills'), file = path.join(root, 'synthetic/SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'Reviewed.');
    try {
      const reader = createSkillDocReader({ home: path.join(tmp, 'home'), bin: null });
      fs.renameSync(root, root + '.held');
      if (replacement === 'link') fs.symlinkSync(root + '.held', root);
      else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'Substituted.'); }
      assert.deepEqual(reader.read(file), NONE);
      assert.equal(fs.readFileSync(path.join(root + '.held', 'synthetic/SKILL.md'), 'utf8'), 'Reviewed.');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
}

for (const replacement of ['leaf-link', 'parent-link', 'regular-file', 'oversized-file']) {
  test('S06-01: validated ' + replacement + ' replacement never returns substituted bytes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-skill-read-security-'));
    const home = path.join(tmp, 'home'), parent = path.join(home, '.openclaw/skills/synthetic'), file = path.join(parent, 'SKILL.md');
    const outside = path.join(tmp, 'outside'); fs.mkdirSync(parent, { recursive: true }); fs.mkdirSync(outside);
    fs.writeFileSync(file, '---\nname: synthetic\n---\nReviewed bytes.');
    const sentinel = path.join(outside, 'SKILL.md'); fs.writeFileSync(sentinel, 'Synthetic private outside bytes.');
    const originalStat = fs.statSync; let swapped = false;
    try {
      const reader = createSkillDocReader({ home, bin: null });
      assert.deepEqual(reader.read(file), { markdown: 'Reviewed bytes.', frontmatter: { name: 'synthetic' } });
      // Instrument the real validation call in both releases, preserving its result.
      fs.statSync = (target, ...args) => {
        const before = originalStat(target, ...args);
        if (target === file && !swapped) {
          swapped = true;
          if (replacement === 'parent-link') { fs.renameSync(parent, parent + '.held'); fs.symlinkSync(outside, parent); }
          else {
            fs.unlinkSync(file);
            if (replacement === 'leaf-link') fs.symlinkSync(sentinel, file);
            else fs.writeFileSync(file, replacement === 'oversized-file' ? 'x'.repeat(MAX_BYTES + 1) : 'Unreviewed regular-file bytes.');
          }
        }
        return before;
      };
      assert.deepEqual(reader.read(file), NONE, 'no substituted document reaches the VM');
      assert.equal(swapped, true, 'the controlled interleaving ran');
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'Synthetic private outside bytes.');
    } finally { fs.statSync = originalStat; fs.rmSync(tmp, { recursive: true, force: true }); }
  });
}

test('S06-01: descriptor growth is bounded and special files/symlinks are refused', () => {
  const safe = require('../../src/ops/safe-fs'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-skill-fd-'));
  try {
    const file = path.join(tmp, 'SKILL.md'); fs.writeFileSync(file, 'reviewed');
    const identity = fs.statSync(file, { bigint: true });
    const job = { ...safe.capture(tmp), file: 'SKILL.md', operation: { type: 'read', identity: { dev: String(identity.dev), ino: String(identity.ino) }, maxBytes: MAX_BYTES } };
    const script = `const fs=require('fs'),safe=require(${JSON.stringify(require.resolve('../../src/ops/safe-fs'))}),job=JSON.parse(process.argv[1]),fsx=Object.create(fs);let count=0,grown=false;
      fsx.openSync=(p,flags)=>{if(!(flags&fs.constants.O_NOFOLLOW))throw Error('nofollow absent');return fs.openSync(p,flags);};
      fsx.readSync=(fd,buffer,offset,size,position)=>{if(!grown){grown=true;fs.appendFileSync('SKILL.md','x'.repeat(job.operation.maxBytes));}const n=fs.readSync(fd,buffer,offset,size,position);count+=n;return n;};
      let code;try{safe.execute(job,fsx);}catch(e){code=e.code;}process.stdout.write(JSON.stringify({code,count}));`;
    const r = spawnSync(process.execPath, ['-e', script, JSON.stringify(job)], { cwd: tmp, encoding: 'utf8', env: { PATH: '', NODE_OPTIONS: '' } });
    assert.equal(r.status, 0); const result = JSON.parse(r.stdout);
    assert.equal(result.code, 'EUNSAFEPATH'); assert.equal(result.count, MAX_BYTES + 1, 'one ceiling byte, never an unbounded read');
    fs.unlinkSync(file); fs.mkdirSync(file);
    assert.throws(() => safe.read(file, { roots: [tmp], maxBytes: MAX_BYTES }), { code: 'EUNSAFEPATH' });
    fs.rmdirSync(file); const outside = path.join(tmp, 'sentinel'); fs.writeFileSync(outside, 'private'); fs.symlinkSync(outside, file);
    assert.throws(() => safe.read(file, { roots: [tmp], maxBytes: MAX_BYTES }));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
