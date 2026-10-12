'use strict';
const { test }=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openStore}=require('../../src/store');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-auto-add-'));let at=1000000;const open=()=>openStore({dir,instance:'test',ownerName:'Synthetic',now:()=>at,log:()=>{}});let store=open();t.after(()=>{if(store.db.isOpen)store.close();fs.rmSync(dir,{recursive:true,force:true});});return{dir,open,get repo(){return store.runtimeAutoAdd;},get store(){return store;},reopen(){store=open();return store;},advance(ms){at+=ms;}};}

test('auto-add defaults per runtime, stores first-added time and survives reopening',t=>{
 const f=fixture(t),r=f.repo;assert.equal(r.get('codex',true).enabled,true);assert.equal(r.get('openclaw').enabled,false);
 assert.equal(r.autoAdd('codex','project:one',true).status,'added');const state=r.get('codex');assert.deepEqual(state.added,[{id:'project:one',at:1000000}]);assert.equal(r.isNew(state,'project:one'),true);
 f.advance(86400000);assert.equal(r.isNew(r.get('codex'),'project:one'),false);f.store.close();const reopened=f.reopen();assert.equal(reopened.runtimeAutoAdd.get('codex').enabled,true);assert.equal(reopened.runtimeAutoAdd.get('codex').added[0].at,1000000);
});

test('disabled policy affects new discoveries, exclusions are permanent until explicit allow',t=>{
 const f=fixture(t),r=f.repo;assert.equal(r.autoAdd('claude','project:one',true).status,'added');r.setEnabled('claude',false,true);assert.equal(r.autoAdd('claude','project:two',true).status,'disabled');assert.deepEqual(r.get('claude').added.map(x=>x.id),['project:one']);
 assert.equal(r.exclude('claude','project:one').status,'excluded');r.setEnabled('claude',true);assert.equal(r.autoAdd('claude','project:one').status,'excluded');assert.equal(r.get('claude').added.length,0);assert.equal(r.allow('claude','project:one').status,'allowed');assert.equal(r.autoAdd('claude','project:one').status,'already-added');
});

test('explicit manual additions record their first-added time even while auto-add is off',t=>{
 const f=fixture(t),r=f.repo;r.setEnabled('codex',false,true);
 assert.equal(r.markAdded('codex','project:manual',true).status,'added');
 assert.equal(r.markAdded('codex','project:manual',true).status,'already-added');
 assert.deepEqual(r.get('codex').added,[{id:'project:manual',at:1000000}]);
 assert.equal(r.isNew(r.get('codex'),'project:manual'),true);
 f.advance(86400000);assert.equal(r.isNew(r.get('codex'),'project:manual'),false);
});

test('invalid policy fails closed and ordinary writes cannot erase unknown exclusions',t=>{
 const f=fixture(t),r=f.repo;r.exclude('codex','project:secret');f.store.db.exec('PRAGMA ignore_check_constraints=ON');f.store.db.prepare("UPDATE runtime_auto_add SET excluded='invalid-json' WHERE runtime_id='codex'").run();
 const invalid=r.get('codex',true);assert.equal(invalid.enabled,false);assert.equal(invalid.invalid,true);assert.throws(()=>r.setEnabled('codex',true,true),{code:'EPOLICYINVALID'});assert.throws(()=>r.autoAdd('codex','project:secret',true),{code:'EPOLICYINVALID'});assert.equal(f.store.db.prepare("SELECT excluded FROM runtime_auto_add WHERE runtime_id='codex'").get().excluded,'invalid-json');
});
