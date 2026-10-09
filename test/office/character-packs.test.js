'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { contract } = require('../../packaging/validate-character-pack');
const { validateIntegratedPack, buildCharacterRegistry, requireEnabledCharacterRegistry, SURPRISE_FRAMES } = require('../../packaging/character-pack-registry');
const { packDescriptor, adaptCharacterPack, installCharacterPack } = require('../../public/v2/office/character-packs');
const { indexManifest, poseImage, accessoryLayers, seatModeFor } = require('../../public/v2/office/assets');
const { characterItems } = require('../../public/v2/office/catalog');
const { ensureCharacterPack } = require('../../public/v2/office/character-pack-loader');
function fixture(t, id='test-bot') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'char-integrate-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const packRoot=path.join(root,id);fs.mkdirSync(packRoot);
  fs.writeFileSync(path.join(packRoot,'b.webp'),Buffer.from('UklGRiIAAABXRUJQVlA4TBYAAAAvv8BHEAcQEREQkCT+/09F9D/tf/8C','base64'));
  fs.writeFileSync(path.join(packRoot,'t.webp'),Buffer.from('UklGRiAAAABXRUJQVlA4TBQAAAAvX8AjEAcQEREGICH8/69E9D/1BQ==','base64'));
  const pack={schemaVersion:1,contract:contract.id,id,names:{fr:'Test',en:'Test'},license:'CC0-1.0',canvas:[192,288],artScale:2,scale:1,
    locomotion:{type:'walks',hoverPx:0},seats:{desk:{supported:true,mode:'sit'},sofa:{supported:true,mode:'sit'}},
    accessories:Object.fromEntries(contract.accessories.map(id=>[id,{supported:true}])),variants:[{id:'pearl',names:{fr:'Perle',en:'Pearl'},swatch:'#aabbcc',thumbnail:'t.webp',frames:[...contract.frames,...SURPRISE_FRAMES.map(id=>({id,facing:'sw',seated:id.includes('bench')}))].map((r,n)=>{
      const rear=['ne','nw'].includes(r.facing);return {...r,image:'b.webp',anchors:{ground:[96,276],hip:[96,220+n],handLeft:[40,180],handRight:[140,180],head:[96,110],headBox:[40,60,150,160],earLeft:[40,110],earRight:[150,110],neck:[96,170],chest:[96,190],tilt:16,eyes:{visibility:rear?'occluded':'visible',line:rear?null:[[70,120],[100,130]]},...(r.fx?{fx:[40,150]}:{})},accessories:Object.fromEntries(contract.accessories.map(id=>{const hidden=rear&&['glasses','badge'].includes(id);return [id,{body:r.id,facing:r.facing,anchor:[96,276],occluded:hidden,front:hidden?null:'b.webp',back:hidden?null:'b.webp',...(['cap','headphones'].includes(id)?{sourceFacing:r.facing,mirrored:false,matrix:[1,0,0,0,1,0]}:{})}]}))};
    })}]};
  const save=()=>fs.writeFileSync(path.join(packRoot,'manifest.json'),JSON.stringify(pack));save();
  return {root,packRoot,pack,save,index:()=>indexManifest({characters:[],characterPacks:{packs:[packDescriptor(pack,'assets/Characters/'+id+'/')]},accessories:contract.accessories.map(id=>({id,slot:id==='headphones'?'head':id==='glasses'?'face':id==='scarf'?'neck':id}))})};
}
test('final integration rejects missing surprises, bad head boxes and unsupported gear without changing the proposal gate',t=>{
 const f=fixture(t);assert.equal(validateIntegratedPack(f.pack,f.packRoot).ok,true);
 f.pack.variants[0].frames.pop();f.pack.variants[0].frames[0].anchors.headBox=[3,4,2,1];f.pack.accessories.cap.supported=false;
 const errors=validateIntegratedPack(f.pack,f.packRoot).errors.join('\n');assert.match(errors,/missing final 26b/);assert.match(errors,/valid headBox/);assert.match(errors,/final delivery must support cap/);
});
test('floating substitutes are checked against room contacts, every variant and the ground contact',t=>{
 const f=fixture(t);f.pack.locomotion={type:'floats',hoverPx:8};assert.match(validateIntegratedPack(f.pack,f.packRoot).errors.join('\n'),/must declare gym.bench/);
 f.pack.substitutes={'gym.bench':{point:'benchFloor',anchor:'ground',poses:['egg-bench-low-sw','egg-bench-high-sw'],label:{fr:'Presse',en:'Press'}},'smoke.crush':{point:'covered',anchor:'ground',poses:['egg-crush-sw']}};assert.equal(validateIntegratedPack(f.pack,f.packRoot).ok,true);
 f.pack.substitutes['gym.bench'].point='bench';f.pack.substitutes['smoke.crush'].poses=['absent'];f.pack.substitutes['smoke.crush'].run='code';
 const errors=validateIntegratedPack(f.pack,f.packRoot).errors.join('\n');assert.match(errors,/hover press must attach/);assert.match(errors,/missing substitute absent/);assert.match(errors,/unknown field run/);
});
test('thin descriptors populate the Store; adapting metadata preserves typing registrations, seating and rear occlusion',t=>{
 const f=fixture(t);const idx=f.index();assert.deepEqual(characterItems(idx,{character:'test-bot',variant:'pearl',accessories:[]},[],{}).map(c=>c.id),['test-bot']);
 assert.equal(idx.characters.get('test-bot').packLoaded,undefined);assert.ok(JSON.stringify(packDescriptor(f.pack,'p/')).length<1800);
 const c=installCharacterPack(idx,f.pack,'p/');const typing=poseImage(c,'pearl','working-ne');assert.equal(typing.frames.length,3);assert.equal(typing.frameMs,350);assert.equal(new Set(typing.frameSeatAnchors.map(p=>p.y)).size,3);
 assert.equal(seatModeFor(c,'pearl',{kind:'desk',seated:{}}),'desk');assert.equal(seatModeFor(c,'pearl',{kind:'lounge',seated:{}}),'sofa');
 assert.equal(accessoryLayers(idx,c.id,['glasses','badge'],'walking-ne','pearl').front.length,0);
 assert.equal(accessoryLayers(idx,c.id,['headphones'],'working-ne','pearl').front[0].frames.length,3);
 assert.equal(adaptCharacterPack(f.pack,'p/').character.variants[0].landmarks['idle'].headBox.w,110);
});
test('discovery batch gate ignores other packs and excludes invalid JSON; reserved IDs cannot replace old models',t=>{
 const f=fixture(t);assert.equal(buildCharacterRegistry(f.root,[]).packs.length,0);assert.equal(buildCharacterRegistry(f.root,['test-bot']).packs.length,1);
 fs.mkdirSync(path.join(f.root,'other'));fs.writeFileSync(path.join(f.root,'other','manifest.json'),'{');assert.equal(buildCharacterRegistry(f.root).pending[0].id,'other');
 f.pack.id='timmy';fs.cpSync(f.packRoot,path.join(f.root,'timmy'),{recursive:true});fs.writeFileSync(path.join(f.root,'timmy','manifest.json'),JSON.stringify(f.pack));assert.match(buildCharacterRegistry(f.root).pending.find(p=>p.id==='timmy').errors.join('\n'),/reserved/);
 assert.deepEqual(buildCharacterRegistry(f.root).packs.map(p=>p.id),['test-bot']);
 assert.throws(()=>requireEnabledCharacterRegistry(f.root,['timmy']),/reserved/);
});
test('metadata requests deduplicate; cancelling one consumer preserves another and cancelling the last aborts fetch',async t=>{
 const f=fixture(t,'load-bot');let resolve,aborts=0,calls=0;
 t.mock.method(globalThis,'fetch',(_url,{signal})=>{calls++;return new Promise((res,rej)=>{resolve=()=>res(new Response(JSON.stringify(f.pack)));signal.addEventListener('abort',()=>{aborts++;rej(new DOMException('cancelled','AbortError'));});});});
 const a=new AbortController(),b=new AbortController(),idx=f.index();const first=ensureCharacterPack(idx,f.pack.id,'/first/',{signal:a.signal});const second=ensureCharacterPack(idx,f.pack.id,'/first/',{signal:b.signal});await Promise.resolve();assert.equal(calls,1);
 a.abort();await assert.rejects(first,{name:'AbortError'});assert.equal(aborts,0);resolve();assert.equal((await second).packLoaded,true);
 const c=new AbortController();const last=ensureCharacterPack(f.index(),f.pack.id,'/other/',{signal:c.signal});await Promise.resolve();c.abort();await assert.rejects(last,{name:'AbortError'});assert.equal(aborts,1);await new Promise(r=>setImmediate(r));
});

test('shipping requires every enabled pack; malformed, missing and duplicate ids fail the build gate',t=>{
 const f=fixture(t,'good');fs.mkdirSync(path.join(f.root,'bad'));fs.writeFileSync(path.join(f.root,'bad','manifest.json'),'{');
 const result=buildCharacterRegistry(f.root,['good','bad']);assert.deepEqual(result.packs.map(p=>p.id),['good']);assert.deepEqual(result.pending.map(p=>p.id),['bad']);
 assert.throws(()=>requireEnabledCharacterRegistry(f.root,['good','bad']),/bad: invalid manifest JSON/);
 assert.throws(()=>requireEnabledCharacterRegistry(f.root,['good','missing']),/missing: enabled pack manifest missing/);
 assert.throws(()=>requireEnabledCharacterRegistry(f.root,['good','good']),/duplicate enabled/);
 assert.deepEqual(requireEnabledCharacterRegistry(f.root,['good']).packs.map(p=>p.id),['good']);
});
test('a consumer started from the shared fetch abort listener retries instead of joining an aborted request',async t=>{
 const f=fixture(t,'retry-bot'),idx=f.index(),a=new AbortController();let second,resolveSecond,calls=0;
 t.mock.method(globalThis,'fetch',(_url,{signal})=>new Promise((resolve,reject)=>{
  calls++;
  if(calls===1)signal.addEventListener('abort',()=>{
   second=ensureCharacterPack(idx,f.pack.id,'/retry/');
   reject(new DOMException('cancelled','AbortError'));
  },{once:true});
  else resolveSecond=()=>resolve(new Response(JSON.stringify(f.pack)));
 }));
 const first=ensureCharacterPack(idx,f.pack.id,'/retry/',{signal:a.signal});await Promise.resolve();a.abort();
 await assert.rejects(first,{name:'AbortError'});assert.equal(calls,2);resolveSecond();assert.equal((await second).packLoaded,true);
});
test('cancelling before the deferred fetch starts still aborts it when the last consumer releases',async t=>{
 const f=fixture(t,'early-bot'),a=new AbortController();let calls=0,aborts=0;
 t.mock.method(globalThis,'fetch',(_url,{signal})=>{calls++;return new Promise((resolve,reject)=>{
  signal.addEventListener('abort',()=>{aborts++;reject(new DOMException('cancelled','AbortError'));},{once:true});
 });});
 const request=ensureCharacterPack(f.index(),f.pack.id,'/early/',{signal:a.signal});a.abort();
 await assert.rejects(request,{name:'AbortError'});assert.equal(calls,1);assert.equal(aborts,1);
});

test('pack and variant names follow the selected setup and Store locale',t=>{
 const f=fixture(t,'locale-bot');f.pack.names={fr:'Orbite',en:'Orbit'};f.pack.variants[0].names={fr:'Perle',en:'Pearl'};
 const {characterChoices}=require('../../public/v2/office/setup-looks');const {labelOf}=require('../../public/v2/office/strings');
 const idx=f.index(),descriptor=idx.characters.get(f.pack.id);
 assert.equal(descriptor.label,undefined);assert.equal(descriptor.variants[0].label,undefined);
 assert.equal(characterChoices(idx,'en')[0].label,'Orbit');assert.equal(characterChoices(idx,'en')[0].variants[0].label,'Pearl');
 assert.equal(characterChoices(idx,'fr')[0].label,'Orbite');assert.equal(labelOf(descriptor,'character','en'),'Orbit');
});
test('runtime shape gate rejects oversized metadata and missing surprise bounds without mutating the index',async t=>{
 const f=fixture(t,'shape-bot');let text=JSON.stringify(f.pack);
 t.mock.method(globalThis,'fetch',async()=>new Response(text));
 for(const kind of ['oversized','bounds','frame','registration']){
  const pack=structuredClone(f.pack);
  if(kind==='bounds')delete pack.variants[0].frames.find(f=>f.id==='egg-crush-sw').anchors.headBox;
  if(kind==='frame')pack.variants[0].frames.pop();
  if(kind==='registration')pack.variants[0].frames[0].accessories.cap.matrix=[-1,0,0,0,1,0];
  text=JSON.stringify(pack)+(kind==='oversized'?' '.repeat(contract.budgets.manifestBytes):'');
  const idx=f.index(),before=JSON.stringify([...idx.accessories]);const descriptor=idx.characters.get(f.pack.id);
  await assert.rejects(ensureCharacterPack(idx,f.pack.id,'/shape-'+kind+'/'),/metadata budget|headBox|missing final 26b|positive affine/);
  assert.equal(JSON.stringify([...idx.accessories]),before);assert.equal(idx.characters.get(f.pack.id),descriptor);
 }
});
test('stream admission cancels over-budget bodies before parsing, despite absent or false length headers',async t=>{
 for(const length of [null,'1','invalid']){
  const f=fixture(t,'stream-limit-bot'),idx=f.index(),descriptor=idx.characters.get(f.pack.id),accessories=[...idx.accessories];
  let pulls=0,cancels=0,parses=0;
  const response=new Response(new ReadableStream({
   pull(controller){pulls++;controller.enqueue(new Uint8Array(contract.budgets.manifestBytes/2));},
   cancel(){cancels++;}
  },{highWaterMark:0}),{headers:length===null?{}:{'content-length':length}});
  response.text=()=>assert.fail('must not consume an unbounded text body');
  const fetch=t.mock.method(globalThis,'fetch',async()=>response);
  const parse=t.mock.method(JSON,'parse',()=>{parses++;assert.fail('over-budget metadata must not be parsed');});
  try{await assert.rejects(ensureCharacterPack(idx,f.pack.id,'/stream-limit-'+length+'/'),/metadata budget/);}
  finally{fetch.mock.restore();parse.mock.restore();}
  assert.equal(pulls,3);assert.equal(cancels,1);assert.equal(parses,0);
  assert.equal(response.body.locked,false);assert.equal(idx.characters.get(f.pack.id),descriptor);assert.deepEqual([...idx.accessories],accessories);
 }
});
test('known oversized Content-Length cancels without reading or parsing',async t=>{
 const f=fixture(t,'header-limit-bot'),idx=f.index();let pulls=0,cancels=0,parses=0;
 const response=new Response(new ReadableStream({pull(){pulls++;},cancel(){cancels++;}},{highWaterMark:0}),{headers:{'content-length':String(contract.budgets.manifestBytes+1)}});
 t.mock.method(globalThis,'fetch',async()=>response);
 t.mock.method(JSON,'parse',()=>{parses++;assert.fail('oversized header must fail before parsing');});
 await assert.rejects(ensureCharacterPack(idx,f.pack.id,'/header-limit/'),/metadata budget/);
 assert.equal(pulls,0);assert.equal(cancels,1);assert.equal(parses,0);assert.equal(idx.characters.get(f.pack.id).packLoaded,undefined);
});
test('exact-budget metadata and split UTF-8 chunks install; failed stream entries can retry',async t=>{
 const f=fixture(t,'utf-stream-bot');f.pack.names.en='Robot é';const idx=f.index();let calls=0;
 const raw=new TextEncoder().encode(JSON.stringify(f.pack));
 const good=new Uint8Array(contract.budgets.manifestBytes);good.fill(32);good.set(raw);
 const split=raw.findIndex((b,i)=>b===0xc3&&raw[i+1]===0xa9)+1;assert.ok(split>0);
 t.mock.method(globalThis,'fetch',async()=>{
  if(++calls===1)return new Response(new Uint8Array(contract.budgets.manifestBytes+1));
  let n=0;const chunks=[good.subarray(0,split),good.subarray(split)];
  return new Response(new ReadableStream({pull(c){if(n<chunks.length)c.enqueue(chunks[n++]);else c.close();}},{highWaterMark:0}));
 });
 await assert.rejects(ensureCharacterPack(idx,f.pack.id,'/utf-stream/'),/metadata budget/);
 assert.equal((await ensureCharacterPack(idx,f.pack.id,'/utf-stream/')).names.en,'Robot é');assert.equal(calls,2);
});
test('cancelling the last consumer cancels a pending body read and leaves the index untouched',async t=>{
 const f=fixture(t,'body-cancel-bot'),idx=f.index(),a=new AbortController();let reading,cancels=0;
 const started=new Promise(resolve=>reading=resolve);
 t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({pull(){reading();},cancel(){cancels++;}},{highWaterMark:0})));
 const first=ensureCharacterPack(idx,f.pack.id,'/body-cancel/',{signal:a.signal});await started;a.abort();
 await assert.rejects(first,{name:'AbortError'});await new Promise(r=>setImmediate(r));
 assert.equal(cancels,1);assert.equal(idx.characters.get(f.pack.id).packLoaded,undefined);
});
test('one consumer can cancel during streaming while another shares the body and installs',async t=>{
 const f=fixture(t,'body-share-bot'),idx=f.index(),a=new AbortController();let reading,controller,cancels=0,calls=0;
 const started=new Promise(resolve=>reading=resolve);
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(new ReadableStream({start(c){controller=c;},pull(){reading();},cancel(){cancels++;}},{highWaterMark:0}));});
 const first=ensureCharacterPack(idx,f.pack.id,'/body-share/',{signal:a.signal}),second=ensureCharacterPack(idx,f.pack.id,'/body-share/');
 await started;a.abort();await assert.rejects(first,{name:'AbortError'});assert.equal(cancels,0);
 controller.enqueue(new TextEncoder().encode(JSON.stringify(f.pack)));controller.close();
 assert.equal((await second).packLoaded,true);assert.equal(calls,1);assert.equal(cancels,0);
});
test('ordinary offline head bounds remain optional and are never synthesized at runtime',t=>{
 const f=fixture(t);delete f.pack.variants[0].frames[0].anchors.headBox;
 const {checkPackShape}=require('../../public/v2/office/character-pack-shape');
 assert.equal(checkPackShape(f.pack).ok,true);assert.equal(validateIntegratedPack(f.pack,f.packRoot).ok,true);
 assert.equal(adaptCharacterPack(f.pack,'p/').character.landmarks.idle.headBox,undefined);
});
test('generated browser contract matches the unchanged offline contract',()=>{
 const browser=require('../../public/v2/generated/character-pack-contract').contract;
 for(const key of ['id','canvas','accessories','budgets','frames'])assert.deepEqual(browser[key],contract[key]);
});
