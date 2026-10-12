'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {ACCESSORY_BUDGETS:B,checkAccessoryPack,accessoryPlacement}=require('../../public/v2/office/accessory-packs');
const {validateAccessoryPack,requireAccessoryRegistry}=require('../../packaging/accessory-pack-registry');
const {indexManifest}=require('../../public/v2/office/assets');
const {installCharacterPack}=require('../../public/v2/office/character-packs');
const {supportedAccessories,chooseAutomaticLook}=require('../../public/v2/office/automatic-looks');
const {prepareAccessoryLayers}=require('../../public/v2/office/accessory-pack-loader');
const manifest=require('../../design/office/manifest.example.json');
const root=path.resolve(__dirname,'../../design/assets/Accessories'),dir=path.join(root,'accessories-1');
const raw=fs.readFileSync(path.join(dir,'manifest.json')),pack=JSON.parse(raw);
test('fifteen accessories ship through a bounded shared pack with all canonical models and typing registrations',()=>{
  assert.equal(manifest.accessories.length,15);
  const valid=validateAccessoryPack(pack,dir,raw.length);assert.deepEqual(valid.errors,[]);assert.equal(valid.files,90);assert.ok(valid.bytes<B.pack);
  const items=requireAccessoryRegistry(root,['accessories-1']);assert.equal(items.length,10);
  assert.ok(items.every(a=>!a.layers && !a.views && a.thumbnail && a.supportedModels.length===14));
  assert.equal(Object.keys(pack.fits).length,41);
  for(const poses of Object.values(pack.fits)) {assert.equal(poses['working-ne'].length,3);assert.ok(['idle','walking-se','walking-ne','walking-nw'].every(p=>poses[p]));}
  assert.throws(()=>requireAccessoryRegistry(root,['accessories-1','accessories-1']),/enabled/);
  assert.throws(()=>requireAccessoryRegistry(root,['accessories-1'],['beanie']),/reserved/);
});
test('every authored pose uses positive, bounded fitting; front ornaments stay hidden behind the head',()=>{
  let records=0;
  for(const poses of Object.values(pack.fits))for(const frames of Object.values(poses))for(const r of frames) {
    records++;
    for(const item of pack.items) {
      const result=accessoryPlacement(item,r);
      if(item.fit.hideRear&&r[0]>1)assert.equal(result.pieces.length,0);
      for(const p of result.pieces) {
        const [w,h]=p.rect?p.rect.slice(2):result.view.size;
        assert.ok(p.scale>0);
        assert.ok(p.dest[0]-p.origin[0]*p.scale>=-1e-8);
        assert.ok(p.dest[1]-p.origin[1]*p.scale>=-1e-8);
        assert.ok(p.dest[0]+(w-p.origin[0])*p.scale<=192+1e-8);
        assert.ok(p.dest[1]+(h-p.origin[1])*p.scale<=288+1e-8);
      }
    }
  }
  assert.equal(records,2411);
});
test('automatic first-sight looks can use new accessories before body loading; installing a family preserves support',()=>{
  const index=indexManifest(manifest);
  for(const c of index.characters.values())assert.equal(supportedAccessories(index,c.id,c.variants?.[0]?.id).length,15,c.id);
  const c=[...index.characters.values()].find(c=>c.packManifest);
  const body=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../design',c.packManifest)));
  installCharacterPack(index,body,c.packManifest.replace(/manifest.json$/,''));
  assert.equal(supportedAccessories(index,c.id,c.variants[0].id).length,15);
  const selected=new Set();for(let n=0;n<500;n++)for(const a of chooseAutomaticLook(index,'agent:test-'+n).look.accessories)selected.add(a);
  for(const a of pack.items)assert.ok(selected.has(a.id),a.id);
  assert.equal(manifest.accessories.find(a=>a.id==='beanie').layers,undefined,'per-index composition does not mutate the shared manifest');
});
test('unsafe source paths, dimensions, registration numbers and metadata fail admission',()=>{
  for(const mutate of [p=>p.items[0].views.sw.day='../evil.webp',p=>p.items[0].views.sw.size=[100000,100000],p=>p.fits.timmy.idle[0][3]=-1,p=>p.fits.timmy.idle[0][5]=1e9,p=>p.items[0].fit.width=NaN,p=>p.items[9].views.sw.pieces[0].rect=[-1,0,1,1]]) {
    const broken=structuredClone(pack);mutate(broken);assert.equal(checkAccessoryPack(broken).ok,false);
  }
  assert.equal(checkAccessoryPack(pack,{metadataBytes:B.metadata+1}).ok,false);
});
const rear={character:'bastion',variant:'slate',accessories:['bow-tie']};
test('lazy metadata deduplicates while consumers cancel independently; failure leaves the index untouched',async t=>{
  const index=indexManifest(manifest);let calls=0,aborts=0,resolve;
  t.mock.method(globalThis,'fetch',(_url,{signal})=>new Promise((res,rej)=>{
    calls++;resolve=()=>res(new Response(raw));signal.addEventListener('abort',()=>{aborts++;rej(new DOMException('cancelled','AbortError'));});
  }));
  const a=new AbortController(),first=prepareAccessoryLayers(index,rear,'walking-ne','/shared/',{signal:a.signal}),second=prepareAccessoryLayers(index,rear,'walking-ne','/shared/');
  await Promise.resolve();a.abort();await assert.rejects(first,{name:'AbortError'});assert.equal(calls,1);assert.equal(aborts,0);
  resolve();await second;assert.deepEqual(index.accessories.get('bow-tie').layers['bastion/slate']['walking-ne'].modes.day,{});
  const b=new AbortController(),alone=prepareAccessoryLayers(index,rear,'walking-nw','/last/',{signal:b.signal});await Promise.resolve();b.abort();await assert.rejects(alone,{name:'AbortError'});await new Promise(r=>setImmediate(r));assert.equal(aborts,1);
  assert.equal(index.accessories.get('bow-tie').layers['bastion/slate']['walking-nw'],undefined);
});
test('stream budget admission cancels oversized bodies before parse; the same URL can retry',async t=>{
  const index=indexManifest(manifest);let calls=0,cancels=0;
  t.mock.method(globalThis,'fetch',async()=>{
    if(++calls>1)return new Response(raw);
    return new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(B.metadata/2));},cancel(){cancels++;}},{highWaterMark:0}),{headers:{'content-length':'1'}});
  });
  await assert.rejects(prepareAccessoryLayers(index,rear,'walking-ne','/stream/'),/budget/);assert.equal(cancels,1);assert.deepEqual(index.accessories.get('bow-tie').layers,{});
  await prepareAccessoryLayers(index,rear,'walking-ne','/stream/');assert.equal(calls,2);
});
test('invalid lazy metadata and enabled membership are rejected without partial registration',async t=>{
  const index=indexManifest(manifest),invalid=structuredClone(pack);invalid.items[0].views.sw.day='https://example.test/unsafe.webp';
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(invalid)));
  await assert.rejects(prepareAccessoryLayers(index,rear,'walking-ne','/invalid/'),/invalid/);assert.deepEqual(index.accessories.get('bow-tie').layers,{});
  invalid.items[0].views.sw.day=pack.items[0].views.sw.day;invalid.items[0].names.fr='Unexpected';
  await assert.rejects(prepareAccessoryLayers(index,rear,'walking-ne','/mismatch/'),/registry mismatch/);assert.deepEqual(index.accessories.get('bow-tie').layers,{});
});
