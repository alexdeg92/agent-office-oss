const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {launch,findChrome}=require('./helpers/browser'),serve=require('../../scripts/serve-frontend');
test('27: authenticated readonly route uses registries, twelve local agents, chosen partner, reproducible URL and no writes',{skip:!findChrome(),timeout:180000},async()=>{
 const srv=serve.createFrontendServer({root:path.resolve(__dirname,'../../public/v2'),basePath:'/',apiBase:'/backend'});await new Promise(r=>srv.listen(0,'127.0.0.1',r));const b=await launch();
 try{
  const origin='http://127.0.0.1:'+srv.address().port,p=await b.page(origin+'/bureau/test-animations?mock=1&lecture=1');
  await p.waitFor("document.querySelector('.ao-animations-stage')?.aoScene?.chars.size===2");
  const initial=await p.eval(`const version='?'+document.querySelector('script[type=module][src*="app.js"]').src.split('?')[1];window.qaVersion=version;
   const tools=await import('/office/animation-tools.js'+version),{STATES}=await import('/office/states.js'+version),{services}=await import('/services.js'+version);
   window.qaWrites=[];const writes=()=>{qaWrites.push('write');throw Error('sandbox wrote');};services.officeApi={get:writes,put:writes,putTheme:writes};
   const oldFetch=window.fetch;window.fetch=(url,opts={})=>{if(opts.method&&!['GET','HEAD'].includes(opts.method))qaWrites.push(opts.method);return oldFetch(url,opts);};
   window.qaScene=()=>document.querySelector('.ao-animations-stage').aoScene;window.qaChange=(selector,value)=>{const el=document.querySelector(selector);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));};
   const s=qaScene(),original=s.setOccupants.bind(s);window.qaOccupants=[];s.setOccupants=list=>{qaOccupants.push(list.map(o=>({id:o.id,state:o.state})));return original(list);};
   return {buttons:[...document.querySelectorAll('[data-animation]')].map(b=>b.dataset.animation).sort(),entries:tools.animationEntries().map(e=>e.key).sort(),states:[...document.querySelector('[data-test-state]').options].map(o=>o.value),expected:STATES,ids:[...s.chars.keys()],
    looks:[...document.querySelector('[data-test-look]').options].map(o=>o.value).sort(),
    expectedLooks:[...s.index.characters.values()].flatMap(c=>c.variants?.length?c.variants.map(v=>c.id+':'+v.id):[c.id]).sort()};`);
  assert.deepEqual(initial.buttons,initial.entries);assert.deepEqual(initial.states,initial.expected);assert.ok(initial.ids.every(id=>id.startsWith('animation-agent-')));
  assert.deepEqual(initial.looks,initial.expectedLooks);
  await p.eval(`const {ACTIVITIES}=await import('/office/life.js'+qaVersion);ACTIVITIES.qaAdded={home:true,ms:30,weight:1,pose:'thinking'};qaChange('[data-test-state]','thinking');`);
  await p.waitFor("document.querySelector('[data-animation=\"activity:qaAdded\"]')");
  await p.waitFor("qaScene() && qaScene().chars.get('animation-agent-1').occ.state==='thinking'");
  assert.ok(await p.eval(`return qaOccupants.some(list=>list.some(o=>o.id==='animation-agent-1'&&o.state==='thinking'));`));
  await p.eval(`const {ACTIVITIES}=await import('/office/life.js'+qaVersion);delete ACTIVITIES.qaAdded;qaChange('[data-test-count]','12');`);
  await p.waitFor("[...document.querySelectorAll('.ao-animations-stage')].reduce((n,el)=>n+(el.aoScene?.chars.size??0),0)===12");
  assert.equal(await p.eval(`return [...document.querySelectorAll('.ao-animations-stage')].every(el=>[...el.aoScene.chars.values()].every(c=>c.occ.stationUid));`),true);
  await p.eval(`qaChange('[data-test-count]','6');`);await p.waitFor("qaScene() && qaScene().chars.size===6 && !document.querySelector('.ao-animations-scenes section')");
  await p.eval(`qaChange('[data-test-agent]','2');`);await p.waitFor("document.querySelector('[data-test-agent]').value==='2'");
  await p.eval(`qaChange('[data-test-state]','calling');`);await p.waitFor("qaScene() && qaScene().chars.get('animation-agent-3').occ.state==='calling'");
  await p.eval(`qaChange('[data-test-reduced]',true);qaChange('[data-test-partner]','3');`);await p.waitFor("qaScene() && qaScene().reducedMotion");
  await p.eval(`document.querySelector('[data-animation="activity:highfive"]').click();`);
  await p.waitFor("qaScene() && qaScene().chars.get('animation-agent-3').activity?.target.partnerId==='animation-agent-4'");
  assert.equal(await p.eval(`return qaScene().chars.get('animation-agent-4').social?.owner;`),'animation-agent-3');
  await p.eval(`document.querySelector('[data-test-reset]').click();`);await p.waitFor("qaScene() && [...qaScene().chars.values()].every(c=>c.occ.state==='idle'&&!c.activity&&!c.egg&&!c.walking)");
  await p.eval(`const el=document.querySelector('[data-test-look]');qaChange('[data-test-look]',el.options[el.options.length-1].value);qaChange('[data-test-accessory]','headphones');qaChange('[data-test-moment]','nuit');qaChange('[data-test-rain]',true);qaChange('[data-test-state]','working');`);
  await p.waitFor("qaScene() && qaScene().chars.get('animation-agent-3').occ.state==='working' && location.search.includes('meteo=pluie')");
  const url=await p.eval('return location.href;'),c=await p.eval(`return qaScene().chars.get('animation-agent-3').occ;`);assert.ok(c.look.accessories.includes('headphones'));
  assert.deepEqual(await p.eval('return qaWrites;'),[]);await p.close();const q=await b.page(url);await q.waitFor("document.querySelector('.ao-animations-stage')?.aoScene?.chars.get('animation-agent-3')?.occ.state==='working'");
  const restored=await q.eval(`const sc=document.querySelector('.ao-animations-stage').aoScene;return {look:sc.chars.get('animation-agent-3').occ.look,count:sc.chars.size,theme:sc.stage.dataset.officeTheme,rain:document.querySelector('[data-test-rain]').checked};`);
  assert.deepEqual(restored.look,c.look);assert.equal(restored.count,6);assert.equal(restored.theme,'night');assert.equal(restored.rain,true);
  await q.eval(`window.qaScene=()=>document.querySelector('.ao-animations-stage').aoScene;const v='?'+document.querySelector('script[type=module][src*="app.js"]').src.split('?')[1];const {services}=await import('/services.js'+v);window.qaWrites=[];const writes=()=>{qaWrites.push('write');throw Error('sandbox wrote');};services.officeApi={get:writes,put:writes,putTheme:writes};
   const {ACTIVITIES,REACTIONS}=await import('/office/life.js'+v),{CUES}=await import('/office/states.js'+v);for(const d of [...Object.values(ACTIVITIES),...Object.values(REACTIONS),...Object.values(CUES)])d.ms=20;
   document.querySelector('[data-test-reset]').click();`);await q.waitFor("qaScene() && [...qaScene().chars.values()].every(c=>c.occ.state==='idle')");
  await q.eval(`localStorage.setItem('office.animations-surprises','off');window.qaTime=Date.now();qaScene().now=()=>qaTime;document.querySelector('[data-test-all]').click();window.qaDriver=setInterval(()=>{const s=qaScene();qaTime+=500;for(const c of s.chars.values()){const ctl=c.egg?.controller;if(ctl?.next)qaTime=Math.max(qaTime,ctl.next.at+1);}s._tickLife();},50);`);
  await q.waitFor("document.querySelector('.ao-animations-status').textContent==='Lecture terminée.'",60000);
  await q.eval(`clearInterval(qaDriver);`);
  assert.deepEqual(await q.eval('return qaWrites;'),[]);assert.deepEqual(p.logs,[]);assert.deepEqual(q.logs,[]);
 }finally{await b.close();await new Promise(r=>srv.close(r));}
});
