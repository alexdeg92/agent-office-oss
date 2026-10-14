import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chatResultsFixture,readChat}=require('../helpers/chat-results-fixture');
for(const version of [2,3])test(`real ChatVM has two child cards and Office portraits v${version}`,async()=>{
 const h=await chatResultsFixture();
 try{
  const vm=await readChat(h,version),results=vm.messages.filter(m=>m.kind==='subagent-result');
  assert.equal(results.length,2);assert.deepEqual(results.map(m=>m.status),['completed','failed']);
  assert.equal(vm.messages.filter(m=>m.role==='user').length,1,'trusted context never becomes a human bubble');
  assert.deepEqual(results.map(m=>m.senderInfo.delegation.sessionKey),h.children);
  assert.deepEqual(results.map(m=>m.senderInfo.name),h.authors);
  assert.deepEqual(results.map(m=>m.title),h.titles);
  assert.ok(results.every(m=>m.collapsedByDefault&&m.avatar),'every child has its Office appearance');
  const lead=vm.messages.find(m=>m.role==='assistant'&&m.kind==='message');assert.ok(lead.avatar,'lead has its Office appearance');
  const office=await h.get(`/api/v${version}/views/office`);assert.equal(office.status,200,office.text);
  for(const result of results){const author=office.json.data.occupants.find(o=>o.sessionKey===result.senderInfo.delegation.sessionKey);assert.ok(author);assert.deepEqual(result.avatar,author.look);}
  assert.equal(results[0].body.text,h.result);
 }finally{await h.stop();}
});
