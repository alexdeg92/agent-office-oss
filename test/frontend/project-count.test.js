import {test} from 'node:test';
import assert from 'node:assert/strict';
import {countDiscussion} from '../../public/v2/pages/project-count.js';
test('mobile comment counts include replies across older pages, excluding deleted messages and system/event lines',async () => {
 const pages={older:{items:[{id:'old',kind:'comment',deleted:false},{id:'reply',kind:'comment',deleted:false},{id:'gone',kind:'comment',deleted:true},{id:'event',kind:'event'}],nextCursor:null}};
 const current={items:[{id:'reply',kind:'comment',deleted:false},{id:'new',kind:'comment',deleted:false},{id:'status',kind:'system'}],nextCursor:'older'};
 assert.equal(await countDiscussion(current,async cursor=>pages[cursor]),3);
 assert.equal(await countDiscussion({items:[],nextCursor:null},()=>assert.fail('no older page')),0);
});
test('mobile comment counts reject a repeated cursor instead of looping forever',async () => {
 const page={items:[],nextCursor:'same'};
 await assert.rejects(countDiscussion(page,async()=>page),/Repeated comment cursor/);
});
