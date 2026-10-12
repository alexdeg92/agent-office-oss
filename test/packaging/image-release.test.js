'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const digest = c => 'sha256:' + c.repeat(64), source = 'a'.repeat(40), base = digest('b');
const repo = 'ghcr.io/alexdeg92/agent-office-oss';
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-image-release-')), bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  return { dir, bin, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
test('S09-02: a supplied immutable image is smoke-tested without any Docker build', () => {
  const f = fixture(), log = path.join(f.dir, 'docker.log'), image = repo + '@' + digest('c');
  try {
    const docker = `#!/usr/bin/env node
const fs=require('fs'),args=process.argv.slice(2);fs.appendFileSync(process.env.DOCKER_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='build') process.exit(77);
if(args[0]==='image' && args[1]==='inspect') console.log('sha256:'+'f'.repeat(64));
if(args[0]==='run' && args.at(-1)==='version') console.log(require(${JSON.stringify(path.join(ROOT,'package.json'))}).version);
else if(args[0]==='run' && args.at(-1)==='check-config') console.log('OC_GATEWAY_TOKEN: ok\\nPORTAL_SECRET: ok');
else if(args[0]==='exec') console.log('10001');
else if(args[0]==='port') console.log('127.0.0.1:54321');
else if(args[0]==='inspect') console.log('healthy');
`;
    fs.writeFileSync(path.join(f.bin, 'docker'), docker, { mode: 0o755 });
    fs.writeFileSync(path.join(f.bin, 'curl'), '#!/bin/sh\nprintf 200\n', { mode: 0o755 });
    const result = spawnSync('sh', [path.join(ROOT, 'packaging/docker/smoke.sh')], { cwd: ROOT, encoding: 'utf8', env: { PATH: f.bin + ':' + path.dirname(process.execPath) + ':/usr/bin:/bin', IMAGE: image, DOCKER_LOG: log } });
    assert.equal(result.status, 0, result.stderr);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(!calls.some(a => a.includes('build'))); assert.ok(calls.some(a => a[0] === 'image' && a.includes(image))); assert.ok(calls.filter(a => a[0] === 'run').every(a => a.includes(digest('f'))));
  } finally { f.close(); }
});
test('S09-02: every advertised platform is built once and tested by digest before promotion', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /push-by-digest=true/); assert.match(workflow, /provenance: false/);
  assert.match(workflow, /platform: linux\/amd64/); assert.match(workflow, /platform: linux\/arm64/);
  assert.match(workflow, /IMAGE:.*steps\.build\.outputs\.digest/);
  for (const check of ['packaging/first-run.test.js', 'packaging/docker/smoke.sh', 'packaging/docker/demo-smoke.sh']) assert.ok(workflow.includes(check));
  const promote = workflow.slice(workflow.indexOf('\n  image:\n'));
  assert.ok(!promote.includes('build-push-action')); assert.ok(!promote.includes('docker build '));
  assert.match(promote, /needs: \[verify, image-verify\]/); assert.match(promote, /promote-images\.js/);
});
test('S09-02: both Docker stages use the same pinned multi-platform base', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'packaging/docker/Dockerfile'), 'utf8');
  const bases = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map(m => m[1]);
  assert.equal(bases.length, 2); assert.equal(bases[0], bases[1]); assert.match(bases[0], /^node:24-slim@sha256:[a-f0-9]{64}$/);
});
test('S09-02: promotion uses exactly the verified platform digests and verifies published descriptors', () => {
  const { promote } = require('../../packaging/docker/promote-images');
  const checks = { contents: true, firstRun: true, api: true, demo: true };
  const evidence = ['amd64', 'arm64'].map((arch, i) => ({ source, base, platform: 'linux/' + arch, digest: digest(String(i+1)), checks }));
  const manifest = { schemaVersion: 2, manifests: evidence.map(e => ({ digest: e.digest, platform: { os: 'linux', architecture: e.platform.split('/')[1] } })) };
  const calls = [], result = promote({ repo, version: '1.1.0', source, base, evidence, docker(args) { calls.push(args); return args.includes('--raw') ? JSON.stringify(manifest) : args.includes('inspect') ? JSON.stringify({digest:digest('e')}) : ''; } });
  const creation = calls.filter(a => a.includes('create')); assert.equal(creation.length, 2);
  for (const e of evidence) assert.ok(creation[0].includes(repo + '@' + e.digest));
  assert.ok(creation[1].includes(repo+'@'+digest('e')));assert.ok(!calls.some(a => a.includes('build'))); assert.deepEqual(result.platforms, manifest.manifests);
});
test('S09-02: missing verification, wrong source/base/platform or a digest mismatch refuses promotion', () => {
  const { promote } = require('../../packaging/docker/promote-images');
  const valid = ['amd64','arm64'].map((a,i) => ({ source, base, platform:'linux/'+a, digest:digest(String(i+1)), checks:{contents:true,firstRun:true,api:true,demo:true} }));
  for (const evidence of [valid.slice(0,1), [...valid,valid[0]], [{...valid[0],checks:{...valid[0].checks,demo:false}},valid[1]], [{...valid[0],source:'c'.repeat(40)},valid[1]], [{...valid[0],base:digest('d')},valid[1]], [{...valid[0],platform:'linux/386'},valid[1]], [{...valid[0],digest:'latest'},valid[1]]]) {
    let called = false; assert.throws(() => promote({repo,version:'1.1.0',source,base,evidence,docker(){called=true;return '';} })); assert.equal(called,false);
  }
  assert.throws(() => promote({repo,version:'1.1.0',source,base,evidence:valid,docker: args => JSON.stringify(args.includes('--raw') ? {manifests:[]} : {digest:digest('e')})}), /published platform digests/);
});

test('S09-02: image evidence binds architecture and OCI source revision; manual publish requires immutable tested ID', () => {
  const { record }=require('../../packaging/docker/promote-images');
  const { publishCommands }=require('../../packaging/release-tools');
  const checks={contents:true,firstRun:true,api:true,demo:true};
  const inspected={Os:'linux',Architecture:'amd64',Config:{Labels:{'org.opencontainers.image.revision':source}}};
  assert.equal(record({source,base,platform:'linux/amd64',digest:digest('c'),checks,inspected}).digest,digest('c'));
  assert.throws(()=>record({source,base,platform:'linux/arm64',digest:digest('c'),checks,inspected}),/architecture/);
  assert.throws(()=>record({source:'d'.repeat(40),base,platform:'linux/amd64',digest:digest('c'),checks,inspected}),/source/);
  assert.throws(()=>publishCommands('1.1.0'),/immutable/);
  assert.match(publishCommands('1.1.0',digest('f')),new RegExp('docker tag '+digest('f')));
});

test('S09-02: a changed final release tag is detected after promotion', () => {
  const {promote}=require('../../packaging/docker/promote-images');
  const evidence=['amd64','arm64'].map((arch,i)=>({source,base,platform:'linux/'+arch,digest:digest(String(i+1)),checks:{contents:true,firstRun:true,api:true,demo:true}}));
  const manifests=evidence.map(e=>({digest:e.digest,platform:{os:'linux',architecture:e.platform.split('/')[1]}}));
  assert.throws(()=>promote({repo,version:'1.1.0',source,base,evidence,docker(args){
    if(args.includes('--raw'))return JSON.stringify({manifests});
    return args.includes('inspect')?JSON.stringify({digest:args.includes(repo+':latest')?digest('f'):digest('e')}):'';
  }}),/release index differs/);
});
