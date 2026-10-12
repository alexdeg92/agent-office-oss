'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const s=require('../../src/schema'),{SettingsVM,VM_SCHEMAS_V3}=require('../../src/api/v2/vm/schemas');
const examples=path.join(__dirname,'../../docs/architecture/examples');
const read=file=>JSON.parse(fs.readFileSync(path.join(examples,file+'.json')));
test('restart descriptor works for supervised, standalone and read-only canonical SettingsVMs',()=>{
 for(const name of ['settings-vm','settings-readonly-vm','settings-restart-manual-vm'])assert.equal(s.validate(SettingsVM,read('settings/'+name).data).ok,true);
 const manual=read('settings/settings-restart-manual-vm').data.restart;assert.equal(manual.supported,false);assert.equal(typeof manual.command,'string');assert.equal(manual.reason.key,'settings.restart.unsupervised');
});
test('restart confirmation pins the current process and returns its identity without an optimistic replacement VM',()=>{
 const req=read('settings/restart-request'),result=read('settings/restart-result').data;
 assert.deepEqual(Object.keys(req).sort(),['bootId','confirmed','expectedRevision']);assert.equal(req.confirmed,true);assert.ok(req.bootId.length>0);
 assert.deepEqual(result,{ok:true,result:{accepted:true,bootId:req.bootId},revision:req.expectedRevision,vm:null});
});
test('canonical meta carries the same nonempty opaque process identity used for restart polling',()=>{
 const vm=read('v3/meta-vm').data;assert.equal(s.validate(VM_SCHEMAS_V3.meta,vm).ok,true);assert.equal(vm.bootId,read('settings/restart-request').bootId);
});
