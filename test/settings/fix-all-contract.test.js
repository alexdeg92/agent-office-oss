'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const s=require('../../src/schema'),{SettingsVM,SettingsFixAllRequest,SettingsFixAllResult}=require('../../src/api/v2/vm/schemas');
const {labelsFor}=require('../../src/i18n');
const read=name=>JSON.parse(fs.readFileSync(path.join(__dirname,'../../docs/architecture/examples/settings',name+'.json')));
test('canonical fix-all sheet covers automatic integration actions, input links and explicit runtime opt-in',()=>{
 const vm=read('settings-fixall-vm').data;assert.equal(s.validate(SettingsVM,vm).ok,true);
 const fixes=vm.diagnostics.flatMap(d=>d.fix?[d.fix]:[]);
 for(const kind of ['integration.install','integration.update','integration.review','runtime.configure','runtime.enable'])assert.ok(fixes.some(f=>f.kind===kind),kind);
 const enable=fixes.find(f=>f.kind==='runtime.enable');assert.equal(enable.automatic,false);assert.equal(enable.requiresConsent,true);assert.equal(enable.requiresInput,false);assert.ok(enable.detail);
 for(const f of fixes)for(const lang of ['fr','en'])for(const label of [f.label,f.detail].filter(Boolean))assert.equal(typeof labelsFor(lang,3)[label.key],'string',label.key);
});
test('fix-all request pins the revision and admits selection IDs only; results preserve partial outcomes',()=>{
 const request=read('fix-all-request');assert.equal(s.validate(SettingsFixAllRequest,request).ok,true);
 for(const name of ['fix-all-result','fix-all-partial-result']){const r=read(name).data;assert.equal(s.validate(SettingsFixAllResult,r.result).ok,true);assert.equal(s.validate(SettingsVM,r.vm).ok,true);assert.equal(r.revision,r.vm.revision);}
 const statuses=read('fix-all-partial-result').data.result.items.map(i=>i.status);assert.ok(statuses.includes('applied'));assert.ok(statuses.includes('failed'));assert.ok(statuses.includes('input-required'));
 for(const mutation of [b=>b.items.push(b.items[0]),b=>b.items=[],b=>b.confirmed=false,b=>b.expectedRevision=-1,b=>b.items[0].path='/tmp/outside',b=>b.items[0].kind='integration.install',b=>b.items[0].target={runtime:'other'},b=>b.items[0].consent=false]) {
  const bad=structuredClone(request);mutation(bad);assert.equal(s.validate(SettingsFixAllRequest,bad).ok,false);
 }
});
test('strict diagnostic schema forbids unsupported levels, automatic runtime opt-in and undeclared fix paths',()=>{
 for(const mutation of [v=>v.diagnostics[0].level='warn',v=>v.diagnostics[0].level='alert',v=>v.diagnostics[0].fix={path:'/tmp/secret'},v=>{const f=v.diagnostics.find(d=>d.fix?.kind==='runtime.enable').fix;f.automatic=true;f.requiresConsent=false;}]) {
  const bad=read('settings-fixall-vm').data;mutation(bad);assert.equal(s.validate(SettingsVM,bad).ok,false);
 }
});
