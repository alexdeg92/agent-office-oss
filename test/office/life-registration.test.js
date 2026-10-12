const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'design/office/manifest.example.json')));
const registry=JSON.parse(fs.readFileSync(path.join(root,'design/assets/anchors.json'))).assets;
const {assertLazyAccessoryFrame,nativeFrameAnchors}=require('./helpers/accessory-registration');
test('26c: every native body frame registers all fifteen accessories; emitted layers and lazy day/night views preserve pose-local contacts',()=>{
 let bodies=0,layers=0,lazy=0;
 assert.ok(manifest.accessories.length>=15);
 for(const ch of manifest.characters)for(const v of ch.variants?.length?ch.variants:[ch]) {
  const key=v===ch?ch.id:ch.id+'/'+v.id;
  for(const [pose,entry] of Object.entries(v.poses??ch.poses)) {
   const frames=typeof entry==='string'?[entry]:entry.frames??[entry.image];
   for(const [i,body] of frames.entries()) {
    bodies++;const meta=registry[body.replace(/^assets\//,'')];assert.ok(meta?.headLandmarks,body);
    for(const a of manifest.accessories) {
     if(a.packManifest) {
      assertLazyAccessoryFrame(a,key,pose,i,frames.length,nativeFrameAnchors(meta));lazy++;continue;
     }
     const pair=a.layers?.[key]?.[pose];assert.ok(pair,key+'/'+a.id+'/'+pose);
     const frame=pair.frames?.[i]??pair;
     for(const side of ['back','front']) {
      const asset=frame[side];assert.ok(asset,body+'/'+a.id+'/'+side);layers++;
      const reg=registry[asset.replace(/^assets\//,'')];assert.deepEqual(reg?.canvas,[192,288],asset);
      assert.deepEqual(reg?.poseRegistration?.anchor,meta.anchor,asset+' anchor');
      assert.equal(reg.poseRegistration.body,body.replace(/^assets\//,''),asset+' registration body');
      assert.ok(reg.poseRegistration.headCentre.every(Number.isFinite),asset+' head contact');
      if(['cap','headphones'].includes(a.id)) {
       assert.equal(reg.poseRegistration.sourceFacing,reg.poseRegistration.facing,asset+' rotated from wrong facing');
       assert.equal(reg.poseRegistration.mirrored,false,asset+' mirrored');
       const m=reg.poseRegistration.matrix;assert.ok(m[0]*m[4]-m[1]*m[3]>0,asset+' reflection');
      }
     }
    }
   }
  }
 }
 assert.ok(bodies>=360);
 assert.equal(layers,bodies*manifest.accessories.filter(a=>!a.packManifest).length*2);
 assert.equal(lazy,bodies*manifest.accessories.filter(a=>a.packManifest).length);
});
test('26c: every lazy-family body frame has matching contacts for every lazy accessory, including each typing frame',()=>{
 const accessories=manifest.accessories.filter(a=>a.packManifest);assert.ok(accessories.length>=10);
 let bodies=0,looks=0;
 for(const descriptor of manifest.characterPacks.packs) {
  const pack=JSON.parse(fs.readFileSync(path.join(root,'design',descriptor.packManifest)));
  for(const v of pack.variants) {
   looks++;const key=pack.id+'/'+v.id;
   for(const f of v.frames) {
    if(f.id==='portrait')continue;
    bodies++;const typing=/^working-ne-(\d+)$/.exec(f.id),pose=typing?'working-ne':f.id;
    const anchors={...f.anchors,facing:f.facing};
    for(const a of accessories)assertLazyAccessoryFrame(a,key,pose,typing?Number(typing[1])-1:0,typing?3:1,anchors);
   }
  }
 }
 assert.equal(looks,33);assert.equal(bodies,1947);
});
test('26c: held-prop poses are complete on all looks and are raster body art',()=>{
 for(const ch of manifest.characters)for(const v of ch.variants?.length?ch.variants:[ch]) {
  for(const action of ['book','cupwalk','drink','water','pen'])for(const facing of ['sw','se','ne','nw']) {
   const e=v.poses[`life-${action}-${facing}`];assert.ok(e,`${v.id??ch.id}/${action}/${facing}`);
   assert.ok(e.image.endsWith('.webp'));const a=registry[e.image.replace(/^assets\//,'')];
   assert.equal(a.heldProp,action);assert.equal(a.facing,facing);assert.ok(a.handAnchor.every(Number.isFinite));assert.ok(a.source.includes('office26c-sources'));assert.equal(a.registration.mirrored,false);
  }
  for(const p of ['life-readseat-ne','life-phone-ne'])assert.ok(v.poses[p].seatAnchor,p+' hip anchor');
 }
 const src=fs.readFileSync(path.join(root,'public/v2/office/scene.js'),'utf8');assert.doesNotMatch(src,/propHtml|ao-life-prop/);
});
