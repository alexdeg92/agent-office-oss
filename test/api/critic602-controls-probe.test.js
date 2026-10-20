 'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {settingsFixture}=require('../helpers/settings-fixture');
test('critic602 valid non-ASCII name search fits the documented character bound',async t=>{
 const h=await settingsFixture();t.after(()=>h.close());
 const query='é'.repeat(60);const result=await h.get('/api/v3/views/projects?search='+encodeURIComponent(query));
 console.log('bounded Unicode search',JSON.stringify({characters:query.length,status:result.status,error:result.json.error}));
 assert.equal(result.status,200,'60 French characters fit the documented 120-character search bound');assert.equal(result.json.data.controls.search.selected,query);
});
test('critic602 authorization keeps truthful stage facet counts for a fully permitted owner',async t=>{
 const h=await settingsFixture({enforceAuthorization:true});t.after(()=>h.close());
 for(const [name,status] of [['Synthetic alpha','todo'],['Synthetic beta','in-progress']]){const r=await h.post('/api/v3/projects',{name,status});assert.equal(r.status,200,r.text);}
 const all=await h.get('/api/v3/views/projects');assert.equal(all.status,200,all.text);
 const selected=await h.get('/api/v3/views/projects?stage=todo');assert.equal(selected.status,200,selected.text);
 console.log('authorized stage counts',JSON.stringify({all:all.json.data.controls.stage.counts,selected:selected.json.data.controls.stage.counts}));
 assert.deepEqual(selected.json.data.columns.flatMap(c=>c.cards).map(c=>c.name),['Synthetic alpha']);
 assert.equal(selected.json.data.controls.stage.counts.find(c=>c.id==='all').count,2,'all stages still contain both authorized projects');
 assert.equal(selected.json.data.controls.stage.counts.find(c=>c.id==='in-progress').count,1,'switching stage has one authorized result');
});
