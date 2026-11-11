'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..');

test('packed npm artifact installs sharp and re-encodes a profile image', t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-avatar-pack-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const pack = path.join(work, 'pack');
  const install = path.join(work, 'install');
  fs.mkdirSync(pack); fs.mkdirSync(install);
  const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', pack], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(packed.status, 0, packed.stderr);
  const rows = JSON.parse(packed.stdout);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].files.some(file => file.path === 'src/api/v3/avatar-image.js'));
  const tarball = path.join(pack, rows[0].filename);
  const installed = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefix', install, tarball], {
    cwd: work, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(installed.status, 0, [installed.stdout, installed.stderr].filter(Boolean).join('\n'));
  const packageName = require('../../package.json').name;
  const modulePath = path.join(install, 'node_modules', ...packageName.split('/'), 'src', 'api', 'v3', 'avatar-image.js');
  const sharpPath = path.join(install, 'node_modules', 'sharp');
  const verify = spawnSync(process.execPath, ['-e', `
    const sharp=require(${JSON.stringify(sharpPath)});
    const {normalizeAvatarImage}=require(${JSON.stringify(modulePath)});
    (async()=>{
      const source=await sharp({create:{width:12,height:8,channels:4,background:'#4070a0'}}).png().toBuffer();
      const result=await normalizeAvatarImage(source,'image/png');
      const meta=await sharp(result.bytes).metadata();
      if(result.mimeType!=='image/webp'||meta.format!=='webp'||meta.width!==512||meta.height!==512||(meta.pages||1)!==1) {
        console.error(JSON.stringify({mimeType:result.mimeType,format:meta.format,width:meta.width,height:meta.height,pages:meta.pages||1}));
        process.exitCode=1;
      }
    })().catch(error=>{console.error(error?.stack||String(error));process.exitCode=1});
  `], { cwd: work, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);
});
