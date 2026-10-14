'use strict';
const test = require('node:test'),assert = require('node:assert/strict');
const { officeDefaults } = require('../../../src/api/v2/vm/office');
const { buildOfficeStoreVM } = require('../../../src/api/v2/vm/office-store');
const { createVmCheck } = require('../../../src/api/v2/vm/check');
const { compareExample } = require('../../helpers/contract-shape');
const { loadScenario } = require('../../helpers/scenario');
const { startServer } = require('../../helpers/harness');
test('Store navigation keeps registered pack entries, filters categories server-side and carries floor order unchanged',()=>{
  const index=officeDefaults().index,office={rosterFloors:[{id:'gym',label:{key:'office.floor.gym'}},{id:'1',label:{key:'office.floor.first'}}]};
  const all=buildOfficeStoreVM({office,index});
  assert.deepEqual(all.floors.options.map(x=>x.id),['gym','1']);
  const cabinets=buildOfficeStoreVM({office,index,section:'mobilier',category:'rangement'});
  assert.ok(cabinets.itemIds.length>0);
  assert.ok(cabinets.itemIds.every(id=>index.furniture.get(id).category==='rangement'));
  const neck=buildOfficeStoreVM({office,index,section:'accessoires',category:'neck'});
  assert.equal(neck.floors,null);assert.equal(neck.itemIds.length,4);
  const characters=buildOfficeStoreVM({office,index,section:'personnages'});
  assert.equal(characters.floors,null);assert.equal(characters.categories,null);assert.equal(characters.categoryId,null);
  for(const vm of [all,cabinets,neck,characters])for(const version of [2,3]) {
    createVmCheck({mode:'throw',version}).check('officeStore',vm);
    assert.deepEqual(compareExample('office-store-vm',vm,{version}),[]);
  }
});
test('Store endpoint is authenticated, validates selections and returns the same navigation on v2/v3',async t=>{
  const h=await startServer(loadScenario('synthetic-basic'));t.after(()=>h.stop());
  const v2=await h.get('/api/v2/views/office/store'),v3=await h.get('/api/v3/views/office/store');
  assert.equal(v2.status,200,v2.text);assert.equal(v3.status,200,v3.text);assert.deepEqual(v2.json.data,v3.json.data);
  assert.ok(v2.json.data.sections.options.every(option=>Number.isInteger(option.count)));
  for(const version of [2,3])for(const query of ['floorId=../2','floorId=10001','section=bogus','category=missing','section=personnages&category=neck'])
    assert.equal((await h.get(`/api/v${version}/views/office/store?${query}`)).status,400,query);
  assert.equal((await fetch(h.base+'/api/v2/views/office/store')).status,401);
});
