import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require=createRequire(import.meta.url);
const { ROOT, buildId, releaseMap, releaseFiles, writePreloads }=require('../../scripts/first-load.js');
test('frontend-27: release pins scripts, CSS, core/lazy/JSON module imports and route preloads to one content build', () => {
  const html=readFileSync(join(ROOT,'index.html'),'utf8'), version=buildId();
  assert.match(html,new RegExp('name="ao-build" content="'+version+'"'));
  const urls=[...html.matchAll(/(?:src|href)="([^" ]+\.(?:js|mjs|css)(?:\?[^" ]*)?)"/g)].map((m)=>m[1]);
  assert.ok(urls.length>30);
  assert.ok(urls.every((u)=>u.endsWith('?v='+version)),urls.filter((u)=>!u.endsWith('?v='+version)));
  const map=JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.deepEqual(map,releaseMap());
  for(const rel of releaseFiles().filter((r)=>/\.(js|mjs|json)$/.test(r))) assert.equal(map.imports['./'+rel],'./'+rel+'?v='+version,rel);
  assert.ok(readFileSync(join(ROOT,'route-preload.js'),'utf8').includes("'?v="+version+"'"));
  assert.deepEqual(writePreloads(),[],'generation is stable');
});
test('frontend-27: changing a nested translation module changes the release, even when app.js is unchanged', () => {
  const root=mkdtempSync(join(tmpdir(),'ao-release-'));
  try {writeFileSync(join(root,'app.js'),"import './messages.js';");writeFileSync(join(root,'messages.js'),'export const message="ancienne";');
    const old=buildId(root);writeFileSync(join(root,'messages.js'),'export const message="nouvelle";');assert.notEqual(buildId(root),old);
  } finally {rmSync(root,{recursive:true,force:true});}
});


test('frontend-28: every runtime lazy import and dynamically created stylesheet carries the document build', () => {
  let imports=0, styles=0;
  for(const rel of releaseFiles().filter(r=>r.endsWith('.js'))) {
    const src=readFileSync(join(ROOT,rel),'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
    for(const match of src.matchAll(/\bimport\(([^)]+)\)/g)) { imports++; assert.match(match[1], /\+ buildQuery$/,rel+': '+match[0]); }
    for(const match of src.matchAll(/new URL\(([^,]+\.css[^,]*), import.meta.url\)/g)) {styles++; assert.match(match[1],/\+ buildQuery/,rel+': '+match[0]);}
    if(src.includes("l.rel = 'stylesheet'")) assert.match(src,/buildQuery/,rel);
  }
  assert.ok(imports>=22); assert.ok(styles>=2);
});
