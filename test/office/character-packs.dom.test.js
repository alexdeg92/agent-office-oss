'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const manifest=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../design/office/manifest.example.json')));
const packs=manifest.characterPacks.packs;
const modelCount=manifest.characters.length+packs.length;
const serve=require('../../scripts/serve-frontend');
const {launch,findChrome}=require('./helpers/browser');
let browser;
before(async()=>{if(findChrome())browser=await launch();});
after(async()=>{await browser?.close();});
const options={skip:!findChrome(),timeout:120000};
async function open(){const p=await browser.page('/test/office/harness.html');await p.waitFor('window.H?.ready');await p.eval(`window.clock=Date.now();window.sc=new H.OfficeScene(stage,{manifest:H.manifest,layout:H.layout,assetBase:H.assetBase,now:()=>clock});sc.setReducedMotion(true);sc._lifeTimer();sc._lifeTimer=()=>{};window.occupant=(character,variant,state='working')=>({id:'main',role:'main',sourceName:'Agent',state,stateSince:clock,stationUid:'st-timmy',look:{character,variant,accessories:['headphones','glasses','scarf','badge']}});window.ready=async()=>{const c=sc.chars.get('main');await H.until(()=>c?.displayed===c?.poseEl&&c?.displayed);await H.frames();if([...c.displayed.querySelectorAll('img')].some(i=>i.naturalWidth!==192))throw Error('undecoded pack layer');return c;};`);return p;}
test('all enabled pack variants render at the chair, travel in four directions, dock at the sofa and hold a life prop',options,async()=>{
 const p=await open();try{
  const result=await p.eval(`const results=[];for(const id of H.manifest.characterPacks.packs.map(p=>p.id))for(const v of sc.index.characters.get(id).variants){await sc.setOccupants([occupant(id,v.id)]);const c=await ready();if(c.renderedPose!=='working-ne'||c.seatMode!=='desk')throw Error(id+' desk');const body=[...c.displayed.querySelectorAll('[data-layer=body]')];if(body.length!==3)throw Error('typing sequence');const hip=c.ch.variants.find(x=>x.id===v.id).poses['working-ne'].frameSeatAnchors;for(const img of body){const i=Number(img.dataset.frame),k=c.poseScale/sc.proj.artScale;const t=img.style.translate.split(' ').map(parseFloat);if(Math.abs(hip[i].x*k+t[0]-hip[0].x*k)>.01||Math.abs(hip[i].y*k+(t[1]??0)-hip[0].y*k)>.01)throw Error('typing hip drift');}for(const facing of ['sw','se','ne','nw']){c.walking=true;c.seatUid=null;c.seatMode=null;c.facing=facing;sc._renderPose(c);await ready();const expected=facing==='sw'?'walking':'walking-'+facing;if(c.renderedPose!==expected)throw Error('travel facing');if(['ne','nw'].includes(facing)&&c.displayed.querySelectorAll('[data-layer=front]').length!==2)throw Error('rear glasses');}c.walking=false;c.target=null;await sc.setOccupants([{...occupant(id,v.id,'idle'),stateSince:clock-60*60000}]);sc._retarget(c,true);await ready();if(c.seatMode!=='sofa'||c.renderedPose!=='sofa-sit-sw')throw Error('sofa '+id+'/'+v.id+' '+c.seatMode+' '+c.renderedPose+' '+JSON.stringify({busy:c.signalBusy,life:c.lifeFinished,now:clock,target:c.target}));await sc.setOccupants([occupant(id,v.id,'idle')]);if(!sc.interact('main','book',{durationMs:600000}))throw Error('book unavailable');await ready();if(!c.renderedPose.startsWith('life-book-'))throw Error('life prop');results.push({id,variant:v.id,locomotion:c.el.dataset.locomotion,images:body.length});sc._cancelActivity(c);clock+=600000;}sc.destroy();return results;`);
  assert.equal(result.length,packs.reduce((n,p)=>n+p.variants.length,0));assert.equal(result.filter(r=>r.locomotion==='floats').length,packs.filter(p=>p.locomotion.type==='floats').reduce((n,p)=>n+p.variants.length,0));assert.deepEqual(p.logs,[]);
 }finally{await p.close();}
});
test('enabled floaters use pack-declared hover press and ground-contact crush in the real surprise scheduler',options,async()=>{
 const p=await open();try{
 for(const pack of packs.filter(p=>p.locomotion.type==='floats')){
 const result=await p.eval(`await sc.setOccupants([occupant(${JSON.stringify(pack.id)},${JSON.stringify(pack.variants[0].id)},'idle')]);const c=await ready();await sc.surprise('main','gym',{arrowMs:600000,stepMs:1000,weather:'clear'});const ctrl=c.egg.controller;await ctrl.openRoom();clock+=200;ctrl.tick(clock);clock+=1001;ctrl.tick(clock);clock+=1001;ctrl.tick(clock);await H.until(()=>ctrl.room.body.querySelector('[data-pose="egg-bench-low-sw"]'));const press={anchor:ctrl.room.step.anchor,point:ctrl.room.step.point,x:ctrl.room.point.x,y:ctrl.room.point.y,caption:ctrl.room.host.caption.textContent};ctrl.cancel({immediate:true});await sc.surprise('main','smoke',{arrowMs:600000,stepMs:1000,weather:'clear'});const smoke=c.egg.controller;await smoke.openRoom();clock+=200;smoke.tick(clock);for(let i=0;i<4;i++){clock+=1001;smoke.tick(clock);}await H.until(()=>smoke.room.body.querySelector('[data-pose="egg-crush-sw"]'));const crush={anchor:smoke.room.step.anchor,point:smoke.room.step.point,pose:smoke.room.pose.pose};smoke.cancel({immediate:true});return {press,crush};`);
 assert.deepEqual(result.press,{anchor:'ground',point:'benchFloor',x:1160,y:700,caption:'Presse en suspension'});assert.deepEqual(result.crush,{anchor:'ground',point:'covered',pose:'egg-crush-sw'});assert.deepEqual(p.logs,[]);
 }
 }finally{await p.close();}
});
test('Tread parks its press on the floor and crushes with a declared tread pivot',options,async()=>{
 const p=await open();try{
 const result=await p.eval(`const results=[];for(const variant of sc.index.characters.get('tread').variants){await sc.setOccupants([occupant('tread',variant.id,'idle')]);const c=await ready();await sc.surprise('main','gym',{arrowMs:600000,stepMs:1000,weather:'clear'});const gym=c.egg.controller;await gym.openRoom();clock+=200;gym.tick(clock);for(let i=0;i<2;i++){clock+=1001;gym.tick(clock);}await H.until(()=>gym.room.body.querySelector('[data-pose="egg-bench-low-sw"]'));const press={point:gym.room.step.point,anchor:gym.room.step.anchor,caption:gym.room.host.caption.textContent};gym.cancel({immediate:true});await sc.surprise('main','smoke',{arrowMs:600000,stepMs:1000,weather:'clear'});const smoke=c.egg.controller;await smoke.openRoom();clock+=200;smoke.tick(clock);for(let i=0;i<4;i++){clock+=1001;smoke.tick(clock);}await H.until(()=>smoke.room.body.querySelector('[data-pose="egg-crush-sw"]'));results.push({variant:variant.id,press,crush:{point:smoke.room.step.point,anchor:smoke.room.step.anchor,caption:smoke.room.host.caption.textContent},locomotion:c.el.dataset.locomotion});smoke.cancel({immediate:true});clock+=600000;}sc.destroy();return results;`);
 assert.equal(result.length,3);for(const row of result){assert.deepEqual(row.press,{point:'benchFloor',anchor:'ground',caption:'Presse stationnée'});assert.deepEqual(row.crush,{point:'covered',anchor:'ground',caption:'Pivot de chenille'});assert.equal(row.locomotion,'rolls');}assert.deepEqual(p.logs,[]);
 }finally{await p.close();}
});
test('removing an occupant during metadata load aborts the request and cannot resurrect it',options,async()=>{
 const p=await open();try{
 const r=await p.eval(`const real=window.fetch;let held,aborted=false;window.fetch=(url,options)=>String(url).includes('/orbit/manifest.json')?new Promise((resolve,reject)=>{held=()=>real(url).then(resolve,reject);options.signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('cancelled','AbortError'));});}):real(url,options);const loading=sc.setOccupants([occupant('orbit','pearl')]);await H.until(()=>held);sc.setOccupants([]);await loading;held();await H.frames();const result={aborted,count:sc.chars.size};sc.destroy();window.fetch=real;return result;`);
 assert.deepEqual(r,{aborted:true,count:0});assert.deepEqual(p.logs,[]);
 }finally{await p.close();}
});
test('Store cards fetch thumbnails only; selecting, applying and saving Orbit loads only its pack; pack names translate',options,async()=>{
 const server=serve.createFrontendServer({root:path.resolve(__dirname,'../../public/v2'),basePath:'/v2/',apiBase:''});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const p=await browser.page('/');try{
 await p.eval(`location.href=${JSON.stringify('http://127.0.0.1:'+server.address().port+'/v2/boutique?mock=1&onglet=personnages')};`);
 await p.waitFor(`document.querySelectorAll('.ao-shop__name').length===${modelCount}`);
 const initial=await p.eval(`return performance.getEntriesByType('resource').filter(e=>new RegExp('Characters/('+${JSON.stringify(packs.map(p=>p.id).join('|'))}+')/').test(e.name)).map(e=>new URL(e.name).pathname);`);
 assert.ok(initial.every(url=>(/\/(?:t\.webp|thumbnails\/[^/]+\.webp)$/.test(url))),'unused pack has thumbnail requests only');
 await p.eval(`[...document.querySelectorAll('.ao-shop__card')].find(c=>c.querySelector('.ao-shop__name')?.textContent==='Orbite').click();`);
 await p.waitFor("document.querySelector('.ao-shop__previewfig img[src*=\"orbit/pearl/0.webp\"]')?.naturalWidth===192");
 await p.eval(`document.querySelector('.ao-shop__previewtext .bu-btn--primary').click();`);
 await p.waitFor("document.querySelector('.ao-shop__status').textContent==='Une modification non enregistrée.'");
 await p.eval(`document.querySelector('.ao-shop__saverow .bu-btn--primary').click();`);
 await p.waitFor("document.querySelector('.ao-shop__status').textContent==='Tout est enregistré.'");
 const resources=await p.eval(`return performance.getEntriesByType('resource').filter(e=>new RegExp('Characters/('+${JSON.stringify(packs.filter(p=>p.id!=='orbit').map(p=>p.id).join('|'))}+')/').test(e.name)).map(e=>new URL(e.name).pathname);`);
 assert.ok(resources.every(url=>(/\/(?:t\.webp|thumbnails\/[^/]+\.webp)$/.test(url))));
 await p.eval(`window.old=true;localStorage.setItem('ao.locale','en');location.reload();`);
 await p.waitFor(`!window.old&&document.documentElement?.lang?.startsWith('en')&&document.querySelectorAll('.ao-shop__name').length===${modelCount}`);
 const names=await p.eval(`return [...document.querySelectorAll('.ao-shop__name')].map(n=>n.textContent);`);
 for(const name of packs.map(p=>p.names.en))assert.ok(names.includes(name),name);
 assert.deepEqual(p.logs,[]);
 }finally{await p.close();await new Promise(r=>server.close(r));}
});
test('batch-two models can be previewed, applied and saved in the actual Store',options,async()=>{
 const server=serve.createFrontendServer({root:path.resolve(__dirname,'../../public/v2'),basePath:'/v2/',apiBase:''});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const p=await browser.page('/');try{
 await p.eval(`location.href=${JSON.stringify('http://127.0.0.1:'+server.address().port+'/v2/boutique?mock=1&onglet=personnages')};`);
 await p.waitFor(`document.querySelectorAll('.ao-shop__name').length===${modelCount}`);
 for(const pack of packs.filter(p=>['bastion','filo','tread','pip','cosmo','polo','mote'].includes(p.id))){
  await p.eval(`[...document.querySelectorAll('.ao-shop__card')].find(c=>c.querySelector('.ao-shop__name')?.textContent===${JSON.stringify(pack.names.fr)}).click();`);
  await p.waitFor(`document.querySelector('.ao-shop__previewfig img[src*="Characters/${pack.id}/"]')?.naturalWidth===192`);
  await p.eval(`document.querySelector('.ao-shop__previewtext .bu-btn--primary').click();`);
  await p.waitFor("document.querySelector('.ao-shop__status').textContent==='Une modification non enregistrée.'");
  await p.eval(`document.querySelector('.ao-shop__saverow .bu-btn--primary').click();`);
  await p.waitFor("document.querySelector('.ao-shop__status').textContent==='Tout est enregistré.'");
  const disabled=['filo','pip','cosmo','polo','mote'].filter(id=>!packs.some(p=>p.id===id));
  const unused=await p.eval(`return performance.getEntriesByType('resource').filter(e=>new RegExp('Characters/('+${JSON.stringify(disabled.join('|'))}+')/').test(e.name)).map(e=>new URL(e.name).pathname);`);
  assert.deepEqual(unused,[]);
 }
 assert.deepEqual(p.logs,[]);
 }finally{await p.close();await new Promise(r=>server.close(r));}
});
