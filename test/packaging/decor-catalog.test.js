'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {requireDecorRegistry,readDecorManifest,validateDecorPack}=require('../../packaging/decor-pack-registry');
const {indexManifest}=require('../../public/v2/office/assets');
const {findFreeSpot,addItem,checkPlacement,validateLayout}=require('../../public/v2/office/editor-model');
const root=path.resolve(__dirname,'../..');
const enabled=require('../../design/office/decor-packs.enabled.json');
const manifest=require('../../design/office/manifest.example.json');
const layout=require('../../design/office/layout.example.json');
// T-0051 (29e735e9) enabled the floor-lobby and floor-wellness packs: 8 more additions, same eight categories
test('enabled production catalogue has 38 additions, 53 total, eight categories and thumbnail-only descriptors',()=>{
 const registry=requireDecorRegistry(path.join(root,'design/assets/Decor'),enabled);
 assert.equal(registry.items.length,38);assert.equal(manifest.furniture.length,53);
 assert.equal(new Set(registry.items.map(f=>f.category)).size,8);
 for(const f of registry.items){assert.ok(f.names.fr&&f.names.en);assert.equal(f.image,f.thumbnail);assert.equal(f.images,undefined);assert.equal(f.provenance,undefined);}
 for(const id of enabled){const dir=path.join(root,'design/assets/Decor',id);const {pack,metadataBytes}=readDecorManifest(path.join(dir,'manifest.json'));assert.deepEqual(validateDecorPack(pack,dir,metadataBytes).errors,[],id);}
});
test('each production item and authored rotation obeys the real layout rules',()=>{
 const index=indexManifest(manifest);
 for(const f of manifest.furniture.filter(f=>f.packId))for(const orientation of f.orientations){
  const spot=findFreeSpot(layout,index,{asset:f.id,orientation});assert.ok(spot,f.id+'/'+orientation);
  const added=addItem(layout,spot).layout;assert.deepEqual(validateLayout(added,index),[],f.id);
  assert.equal(checkPlacement(added,index,{...spot,uid:'collision'}).ok,f.placement==='decal',f.id+' overlap');
  assert.equal(checkPlacement(layout,index,f.placement==='wall'?{...spot,offset:100}:{...spot,x:100}).ok,false,f.id+' boundary');
  if(f.placement==='wall')assert.equal(checkPlacement(layout,index,{...spot,wall:'left'}).ok,false,f.id+' wall');
 }
});
