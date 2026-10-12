'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const { launch, findChrome } = require('./helpers/browser');
let browser;
before(async()=>{if(findChrome())browser=await launch();});
after(async()=>{await browser?.close();});
const options={skip:!findChrome(),timeout:60000};
async function open(){const p=await browser.page('/test/office/harness.html');await p.waitFor('window.H?.ready');return p;}
test('all 30 production items decode in the real office at day and night, including all authored SE views',options,async()=>{
 const p=await open();try{
  let count=0;
  for(const packId of ['essentials','workspace','display','break']){
  const r=await p.eval(`const {findFreeSpot,addItem,validateLayout,unreachableStations}=await import('/public/v2/office/editor-model.js');const {indexManifest}=await import('/public/v2/office/assets.js');const index=indexManifest(H.manifest);let layout={...structuredClone(H.layout),items:[structuredClone(H.layout.items[0])]};for(const f of H.manifest.furniture.filter(f=>f.packId===${JSON.stringify(packId)})){const spot=findFreeSpot(layout,index,{asset:f.id,orientation:f.orientations.includes('se')?'se':'sw',near:{x:2,y:7}});if(!spot)throw Error('no spot '+f.id);layout=addItem(layout,spot).layout;}if(validateLayout(layout,index).length)throw Error('invalid layout '+JSON.stringify(validateLayout(layout,index)));if(unreachableStations(layout,index).length)throw Error('blocked station');window.decorCandidate=new H.OfficeScene(stage,{manifest:H.manifest,layout,assetBase:H.assetBase,theme:'day'});const sc=decorCandidate;await H.until(()=>[...sc.index.furniture.values()].filter(f=>f.packId===${JSON.stringify(packId)}).every(f=>f.packLoaded));await H.until(()=>[...sc.itemNodes.values()].every(n=>n.parts[n.f.id]?.naturalWidth>0));sc.setOccupants([]);await H.frames(2);const nodes=[...sc.itemNodes.values()].filter(n=>n.f.packId);return nodes.map(n=>({id:n.f.id,width:n.parts[n.f.id].naturalWidth,registered:n.f.size.w,cssWidth:parseFloat(n.parts[n.f.id].style.width),src:n.parts[n.f.id].src}));`);
  count+=r.length;for(const item of r){assert.equal(item.width,item.registered);assert.equal(item.cssWidth,item.registered/2);}
  fs.writeFileSync(path.join(__dirname,`../../design/reports/decor-02/office-${packId}-day.png`),await p.screenshot());
  const night=await p.eval(`decorCandidate.setTheme('night');await H.until(()=>[...decorCandidate.itemNodes.values()].filter(n=>n.f.packId).every(n=>n.parts[n.f.id].src.includes('-night.webp')&&n.parts[n.f.id].naturalWidth>0));return [...decorCandidate.itemNodes.values()].filter(n=>n.f.packId).map(n=>n.parts[n.f.id].src);`);
  assert.equal(night.length,r.length);fs.writeFileSync(path.join(__dirname,`../../design/reports/decor-02/office-${packId}-night.png`),await p.screenshot());
  await p.eval('decorCandidate.destroy();');
  }
  assert.equal(count,30);assert.deepEqual(p.logs,[]);
 }finally{await p.close();}
});
test('an office with no placed décor packs requests no décor rasters or pack metadata',options,async()=>{
 const p=await open();try{
  const r=await p.eval(`const sc=new H.OfficeScene(stage,{manifest:H.manifest,layout:H.layout,assetBase:H.assetBase});await H.frames(3);const urls=performance.getEntriesByType('resource').filter(e=>e.name.includes('/assets/Decor/')).map(e=>e.name);sc.destroy();return urls;`);
  assert.deepEqual(r,[]);assert.deepEqual(p.logs,[]);
 }finally{await p.close();}
});
test('a placed study item loads its metadata once, renders at registered scale and switches to its night sprite',options,async()=>{
 const p=await open();try{
  const r=await p.eval(`const {decorDescriptors}=await import('/public/v2/office/decor-packs.js');const {findFreeSpot,addItem}=await import('/public/v2/office/editor-model.js');const pack=await (await fetch('/design/assets/Decor/style-preview/manifest.json')).json();const manifest=structuredClone(H.manifest);manifest.furniture.push(...decorDescriptors(pack,'assets/Decor/style-preview/'));const {indexManifest}=await import('/public/v2/office/assets.js');const idx=indexManifest(manifest);const layout=addItem(H.layout,findFreeSpot(H.layout,idx,{asset:'arc-lamp'})).layout;const sc=new H.OfficeScene(stage,{manifest,layout,assetBase:H.assetBase,theme:'day'});await H.until(()=>sc.index.furniture.get('arc-lamp').packLoaded);const node=[...sc.itemNodes.values()].find(n=>n.f.id==='arc-lamp');await H.until(()=>node.parts['arc-lamp'].complete&&node.parts['arc-lamp'].naturalWidth>0);const day=node.parts['arc-lamp'];const result={day:day.src,width:day.naturalWidth,cssWidth:parseFloat(day.style.width),registered:sc.index.furniture.get('arc-lamp').size.w};sc.setTheme('night');await H.until(()=>node.parts['arc-lamp'].src.includes('arc-lamp-night.webp')&&node.parts['arc-lamp'].naturalWidth>0);result.night=node.parts['arc-lamp'].src;sc.destroy();return result;`);
  assert.match(r.day,/arc-lamp-day\.webp$/);assert.match(r.night,/arc-lamp-night\.webp$/);assert.equal(r.width,r.registered);assert.equal(r.cssWidth,r.registered/2);assert.deepEqual(p.logs,[]);
 }finally{await p.close();}
});
test('removing a placed item during metadata fetch cancels it and cannot revive the item',options,async()=>{
 const p=await open();try{
  const r=await p.eval(`const {decorDescriptors}=await import('/public/v2/office/decor-packs.js');const pack=await (await fetch('/design/assets/Decor/style-preview/manifest.json')).json();const manifest=structuredClone(H.manifest);manifest.furniture.push(...decorDescriptors(pack,'assets/Decor/style-preview/'));const {indexManifest}=await import('/public/v2/office/assets.js');const {findFreeSpot,addItem}=await import('/public/v2/office/editor-model.js');const layout=addItem(H.layout,findFreeSpot(H.layout,indexManifest(manifest),{asset:'monstera'})).layout;const real=window.fetch;let held,aborted=false;window.fetch=(url,opts)=>String(url).includes('style-preview/manifest.json')?new Promise((resolve,reject)=>{held=()=>real(url).then(resolve,reject);opts.signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('cancelled','AbortError'));});}):real(url,opts);const sc=new H.OfficeScene(stage,{manifest,layout,assetBase:H.assetBase});await H.until(()=>held);sc.setLayout(H.layout);await sc._decorReady;held();await H.frames(3);const result={aborted,count:[...sc.itemNodes.values()].filter(n=>n.f.packId).length};sc.destroy();window.fetch=real;return result;`);
  assert.deepEqual(r,{aborted:true,count:0});assert.deepEqual(p.logs,[]);
 }finally{await p.close();}
});
