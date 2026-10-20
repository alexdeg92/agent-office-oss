 'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {settingsFixture}=require('../helpers/settings-fixture'),{openSse}=require('../helpers/sse-client');
test('critic607 Unicode search is accepted on the mounted v3 stream',async t=>{
 const h=await settingsFixture();t.after(()=>h.close());const query='é'.repeat(60),topic='projects?search='+encodeURIComponent(query);
 const stream=openSse(h.base,'/api/v3/stream?topics='+encodeURIComponent(topic),{cookie:h.cookie});t.after(()=>stream.close());
 const frame=await stream.next(f=>f.event==='snapshot'&&f.data.topic===topic);assert.equal(frame.data.data.controls.search.selected,query);assert.equal(frame.data.data.controls.search.counts[0].count,0);
});
test('critic607 search count is authorized before selected-stage filtering over HTTP and SSE',async t=>{
 const h=await settingsFixture({enforceAuthorization:true});t.after(()=>h.close());
 for(const [name,status] of [['Synthetic alpha','todo'],['Synthetic beta','in-progress']]){const r=await h.post('/api/v3/projects',{name,status});assert.equal(r.status,200,r.text);}
 const query='projects?search=Synthetic&stage=todo',response=await h.get('/api/v3/views/'+query);assert.equal(response.status,200,response.text);
 const stream=openSse(h.base,'/api/v3/stream?topics='+encodeURIComponent(query),{cookie:h.cookie});t.after(()=>stream.close());
 const frame=await stream.next(f=>f.event==='snapshot'&&f.data.topic===query);
 console.log('pre-stage search counts',JSON.stringify({http:response.json.data.controls.search.counts,sse:frame.data.data.controls.search.counts}));
 assert.deepEqual(frame.data.data,response.json.data,'HTTP and SSE share the actor projection');
 assert.equal(response.json.data.columns.flatMap(c=>c.cards).length,1);
 assert.equal(response.json.data.controls.search.counts[0].count,2,'both permitted projects match the search before stage selection');
});
