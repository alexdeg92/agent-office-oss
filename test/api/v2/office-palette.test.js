'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {officeDefaults}=require('../../../src/api/v2/vm/office');
const {buildOfficePaletteVM}=require('../../../src/api/v2/vm/office-palette');
const {createVmCheck}=require('../../../src/api/v2/vm/check');
const {compareExample}=require('../../helpers/contract-shape');
const {loadScenario}=require('../../helpers/scenario'),{startServer}=require('../../helpers/harness');
test('Palette includes every installed lazy furniture/decor entry with server category counts/order/search',()=>{
 const index=officeDefaults().index,all=buildOfficePaletteVM({index});
 assert.deepEqual(all.itemIds,[...index.furniture.keys()]);assert.equal(all.categories.options[0].count,index.furniture.size);
 const category=buildOfficePaletteVM({index,category:'rangement',floorId:'gym',search:'bibliothèque'});
 assert.ok(category.itemIds.length>0);assert.ok(category.itemIds.every(id=>index.furniture.get(id).category==='rangement'));
 assert.deepEqual(category.categories,all.categories,'search leaves full catalogue category counts intact');
 assert.ok(buildOfficePaletteVM({index,search:'bookcase'}).itemIds.includes('shelf'),'search matches the registered English name too');
 assert.deepEqual(buildOfficePaletteVM({index,search:'cafe'}).itemIds,buildOfficePaletteVM({index,search:'CAFÉ'}).itemIds);
 for(const vm of [all,category,buildOfficePaletteVM({index,search:'no match at all'})])for(const version of [2,3]){
  createVmCheck({mode:'throw',version}).check('officePalette',vm);assert.deepEqual(compareExample('office-palette-vm',vm,{version}),[]);
 }
});
test('Palette endpoint authenticates, rejects invalid selections, and projects identical v2/v3 IDs',async t=>{
 const h=await startServer(loadScenario('synthetic-basic'));t.after(()=>h.stop());
 const v2=await h.get('/api/v2/views/office/palette?category=plante&search=plante&floorId=rdc'),v3=await h.get('/api/v3/views/office/palette?category=plante&search=plante&floorId=rdc');
 assert.equal(v2.status,200,v2.text);assert.equal(v3.status,200,v3.text);assert.deepEqual(v2.json.data,v3.json.data);
 for(const version of [2,3])for(const q of ['floorId=../1','floorId=10001','category=bad','category='+ 'x'.repeat(65),'search='+ 'x'.repeat(121)])assert.equal((await h.get(`/api/v${version}/views/office/palette?${q}`)).status,400,q);
 assert.equal((await fetch(h.base+'/api/v3/views/office/palette')).status,401);
});
