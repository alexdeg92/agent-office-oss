import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require=createRequire(import.meta.url);
const { ROOT, buildId, releaseMap, releaseFiles, writePreloads }=require('../../scripts/first-load.js');
const BUILD_SUFFIX=/\+\s*buildQuery\s*$/;
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
  const files=releaseFiles().filter(r=>/\.(?:js|mjs)$/.test(r));
  const bureau=readdirSync(join(ROOT,'components/bureau'),{withFileTypes:true}).filter(e=>e.isFile() && /\.(?:js|mjs)$/.test(e.name));
  assert.ok(bureau.length>=4);
  for(const entry of bureau) assert.ok(files.includes('components/bureau/'+entry.name),entry.name+' is checked');
  for(const rel of files) {
    const src=readFileSync(join(ROOT,rel),'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
    for(const match of src.matchAll(/\bimport\(([^)]+)\)/g)) {
      imports++;
      assert.ok(BUILD_SUFFIX.test(match[1]) || /new URL\(['"][^'"]+['"]\s*\+\s*buildQuery\s*,\s*import\.meta\.url$/.test(match[1]),rel+': '+match[0]);
    }
    for(const match of src.matchAll(/new URL\(([^,]+\.css[^,]*),\s*import.meta.url\)/g)) {styles++; assert.match(match[1],BUILD_SUFFIX,rel+': '+match[0]);}
    if(src.includes("l.rel = 'stylesheet'")) assert.match(src,/buildQuery/,rel);
  }
  assert.ok(imports>=22); assert.ok(styles>=2);
});

test('runtime URL guard accepts whitespace variants while rejecting missing or different build suffixes', () => {
  for(const expression of ["'./mobile-roster.js'+buildQuery", "'./mobile-roster.js' + buildQuery", "'./page.css' +\n\tbuildQuery "]) {
    assert.match(expression,BUILD_SUFFIX);
  }
  for(const expression of ["'./mobile-roster.js'", "'./page.css' + otherQuery", "'./buildQuery.js'", "'./mobile-roster.js+buildQuery'", "'./page.css' + buildQueryExtra"]) {
    assert.throws(()=>assert.match(expression,BUILD_SUFFIX),{name:'AssertionError'},expression);
  }
});

test('release walker includes nested Bureau modules, imports and CSS in the map and content build', () => {
  const root=mkdtempSync(join(tmpdir(),'ao-release-nested-'));
  try {
    mkdirSync(join(root,'components/bureau/deep/empty.js'),{recursive:true});
    writeFileSync(join(root,'index.html'),'<script type="importmap">{"imports":{}}</script>');
    const files=['components/bureau/index.js','components/bureau/deep/control.mjs','components/bureau/bureau.css','components/bureau/messages.json'];
    for(const rel of files) writeFileSync(join(root,rel),rel.endsWith('index.js')?"export {Control} from './deep/control.mjs';":'initial');
    assert.deepEqual(releaseFiles(root),files.sort());
    for(const rel of files) {
      const before=buildId(root);
      writeFileSync(join(root,rel),readFileSync(join(root,rel),'utf8')+'\nchanged');
      assert.notEqual(buildId(root),before,rel+' affects the stamp');
    }
    const version=buildId(root), map=releaseMap(root);
    for(const rel of files.filter(r=>/\.(?:js|mjs|json)$/.test(r))) assert.equal(map.imports['./'+rel],'./'+rel+'?v='+version,rel);
  } finally {rmSync(root,{recursive:true,force:true});}
});
