const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'design/office/manifest.example.json')));
const registry=JSON.parse(fs.readFileSync(path.join(root,'design/assets/anchors.json'))).assets;
test('26c: every body frame has pose-local registration for all five accessories; rear headwear has a dedicated rear source',()=>{
 let bodies=0,layers=0;
 for(const ch of manifest.characters)for(const v of ch.variants?.length?ch.variants:[ch]) {
  const key=v===ch?ch.id:ch.id+'/'+v.id;
  for(const [pose,entry] of Object.entries(v.poses??ch.poses)) {
   const frames=typeof entry==='string'?[entry]:entry.frames??[entry.image];
   for(const [i,body] of frames.entries()) {
    bodies++;const meta=registry[body.replace(/^assets\//,'')];assert.ok(meta?.headLandmarks,body);
    for(const a of manifest.accessories) {
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
 assert.ok(bodies>=360);assert.equal(layers,bodies*10);
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
