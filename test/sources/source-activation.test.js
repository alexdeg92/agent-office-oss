'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createSourceActivation}=require('../../src/sources/source-activation');
const {defaultSourceEnable,sourceBrand}=require('../../src/adapters');

test('source defaults are adapter-declared, independent of runtime type',()=>{
 assert.equal(defaultSourceEnable('herdr'),true);assert.equal(defaultSourceEnable('agent-team-pm'),false);assert.equal(defaultSourceEnable('future-unknown'),false);
 assert.equal(sourceBrand('herdr').logo,'assets/connectors/herdr.svg');
 const future=createSourceActivation({detected:true,capabilities:{autoEnableDefault:true}});
 assert.equal(future.shouldProbe,true);assert.equal(future.enabled,false,'detection is insufficient');
 future.observe(false);assert.equal(future.enabled,false,'an unavailable source stays off');
 future.observe(true);assert.equal(future.enabled,true,'a valid response activates it without owner action');
 future.observe(false);assert.equal(future.enabled,true,'a later read error preserves activation and leaves health to its own projection');
 const optional=createSourceActivation({detected:true,capabilities:{autoEnableDefault:false}});
 assert.equal(optional.shouldProbe,false);optional.observe(true);assert.equal(optional.enabled,false,'sources without the capability remain opt-in');
});

test('explicit OFF persists through healthy probes; a missing source is never probed',()=>{
 const off=createSourceActivation({configured:false,detected:true,capabilities:{autoEnableDefault:true}});
 assert.equal(off.shouldProbe,false);off.observe(true);assert.equal(off.enabled,false);
 off.configure(true);assert.equal(off.enabled,true);off.configure(false);assert.equal(off.enabled,false);
 assert.throws(()=>off.configure(undefined),TypeError);
 const absent=createSourceActivation({detected:false,capabilities:{autoEnableDefault:true}});
 absent.observe(true);assert.equal(absent.shouldProbe,false);assert.equal(absent.enabled,false);
});
