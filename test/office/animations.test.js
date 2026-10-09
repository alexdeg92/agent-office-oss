const {test}=require('node:test');const assert=require('node:assert/strict');
const {indexManifest}=require('../../public/v2/office/assets.js');
const {lookChoices,headChoices,readAnimationQuery,animationQuery,testOccupants}=require('../../public/v2/office/animations-model.js');
const manifest=require('../../design/office/manifest.example.json'),layout=require('../../design/office/layout.example.json');
const {fr,en}=require('../../public/v2/office/animations-messages.js');
test('27: Store catalog and installed packs supply every colour and head accessory',()=>{
 const m=structuredClone(manifest),installed={...structuredClone(m.characters[0]),id:'installed-robot',label:'Installed robot'};
 m.characterPacks??={schemaVersion:1,packs:[]};m.characterPacks.packs.push(installed);
 const idx=indexManifest(m),choices=lookChoices(idx);
 const expected=[...idx.characters.values()].flatMap(c=>c.variants?.length?c.variants.map(v=>c.id+':'+v.id):[c.id]);
 assert.deepEqual(choices.map(c=>c.key),expected);
 assert.ok(choices.some(c=>c.c.id===installed.id));
 assert.deepEqual(headChoices(idx,choices[0].look).map(a=>a.id),[...idx.accessories.values()].filter(a=>a.slot==='head').map(a=>a.id));
});
test('27: URLs round-trip twelve independent synthetic agents, states, looks and settings',()=>{
 const index=indexManifest(manifest),lay={theme:{mode:'auto',resolved:'day'}},cfg=readAnimationQuery({agents:'12',agent:'4',etat:'working',meteo:'pluie',moment:'nuit',theme:'dark',anim:'gym',suivre:'1'},index,lay);
 cfg.agents[3]={look:lookChoices(index).at(-1).key,accessory:headChoices(index,lookChoices(index)[0].look)[0].id,state:'calling'};
 assert.deepEqual(readAnimationQuery(animationQuery(cfg),index,lay),cfg);
 const rows=testOccupants(cfg,index,layout,0,n=>'Agent '+n);
 assert.equal(new Set(rows.map(o=>o.id)).size,12);assert.ok(rows.every(o=>o.id.startsWith('animation-agent-')));
 assert.equal(rows[3].state,'calling');assert.equal(rows[3].name,'Agent D');
 const bad=readAnimationQuery({agents:'-9',agent:'999',look:'missing',etat:'unknown'},index,lay);assert.equal(bad.agents.length,1);assert.equal(bad.selected,0);assert.equal(bad.agents[0].state,'idle');
});
test('27: lazy page FR/EN message keys and parameters match',()=>{
 assert.deepEqual(Object.keys(fr).sort(),Object.keys(en).sort());
 for(const key of Object.keys(fr))assert.deepEqual([...fr[key].matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),[...en[key].matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),key);
});
