import test from 'node:test';
import assert from 'node:assert/strict';
import {pollRestart,readBootId} from '../../public/v2/settings-api.js';
import {configure} from '../../public/v2/config.js';
import * as api from '../../public/v2/api.js';

test('restart polling ignores old processes and transient failures, then accepts a different boot identity',async()=>{
 let now=0,attempt=0;const ids=['old',Error('offline'),'old','new'];
 const result=await pollRestart('old',{read:async()=>{const id=ids[attempt++];if(id instanceof Error)throw id;return id;},now:()=>now,sleep:async ms=>{now+=ms;},intervalMs:10,timeoutMs:100});
 assert.equal(result,'new');assert.equal(attempt,4);
});
test('restart polling times out without issuing a mutation; retry continues checking the original boot',async()=>{
 let now=0;await assert.rejects(pollRestart('old',{read:async()=> 'old',now:()=>now,sleep:async ms=>{now+=ms;},intervalMs:10,timeoutMs:20}),e=>e.code==='restart_timeout');
 assert.equal(await pollRestart('old',{read:async()=> 'new'}),'new');
});
test('restart polling rejects an already-aborted signal and missing process identity',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(pollRestart('old',{signal:controller.signal}),e=>e.name==='AbortError');
 await assert.rejects(pollRestart(''),/identity/);
});
test('restart metadata bypasses cache, respects the API mount and requests v2 regardless of default version',async()=>{
 const original=globalThis.fetch;configure({apiBase:'/backend',apiVersion:3});let call;
 globalThis.fetch=async(url,options)=>{call={url,options};return {ok:true,headers:{get:()=>null},json:async()=>({data:{bootId:'api-boot'}})};};
 try{assert.equal(await readBootId(),'api-boot');assert.equal(call.url,'/backend/api/v2/meta');assert.equal(call.options.cache,'no-store');assert.equal(call.options.credentials,'same-origin');}
 finally{globalThis.fetch=original;configure({});}
});

test('restart identity comes from the live API even when other view models use mocks',async()=>{
 const original=globalThis.fetch;configure({apiBase:'/backend',apiVersion:3});const calls=[];
 globalThis.fetch=async(url,options={})=>{calls.push({url,options});return {ok:true,status:200,headers:{get:()=>null},json:async()=>({data:{env:'staging',bootId:'live-api-boot'}})};};
 try{
  await api.init({search:'?mock=1',hostname:'localhost'});assert.equal(api.isMock(),true);
  assert.equal(await readBootId(),'live-api-boot');assert.equal(calls.at(-1).url,'/backend/api/v2/meta');
  assert.equal(calls.at(-1).options.cache,'no-store');
 }finally{await api.init({search:'',hostname:'localhost'});globalThis.fetch=original;configure({});}
});
