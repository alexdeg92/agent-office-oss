import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {createChat} from '../../public/v2/mock/chat.js';
const require=createRequire(import.meta.url),s=require('../../src/schema');
const {schemasFor}=require('../../src/api/v2/vm/schemas');
for(const version of [2,3])test(`Chat mock and canonical example retain typed message bodies v${version}`,()=>{
 const schema=schemasFor(version).chat;
 const path=version===3?'../../docs/architecture/examples/v3/chat-vm.json':'../../docs/architecture/examples/chat-vm.json';
 const example=JSON.parse(readFileSync(new URL(path,import.meta.url))).data;
 assert.equal(s.validate(schema,example).ok,true);
 const vm=createChat(1791223200000).vm(),validation=s.validate(schema,vm);assert.equal(validation.ok,true,JSON.stringify(validation.issues));
 for(const message of vm.messages){assert.equal(message.kind,'message');assert.equal(message.body.text,message.text);assert.equal(message.statusLabel,null);assert.equal(message.collapsedByDefault,false);}
 const child=example.messages.find(m=>m.kind==='subagent-result');assert.equal(child.role,'assistant');assert.equal(child.status,'completed');assert.equal(child.collapsedByDefault,true);assert.ok(child.body.text.includes('**pass**'));
});
