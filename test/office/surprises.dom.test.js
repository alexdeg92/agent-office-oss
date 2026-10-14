const {test}=require('node:test');const assert=require('node:assert/strict');
const {launch,findChrome}=require('./helpers/browser');
test('26b: lazy full sequences, theme/weather, reduced motion, neutral work preemption at every phase, and cleanup',{skip:!findChrome(),timeout:120000},async()=>{
 const b=await launch();try{const p=await b.page('/test/office/harness.html');await p.waitFor('window.H?.ready');
 const r=await p.eval(`
  const sc=new H.OfficeScene(stage,{manifest:H.manifest,layout:H.layout,assetBase:H.assetBase,life:{intervalMs:600000}});sc._lifeTimer();sc._lifeTimer=()=>{};sc.setReducedMotion(true);
  let now=Date.now();sc.now=()=>now;sc.setOccupants(H.occupants([{id:'main',role:'main',sourceName:'Agent',state:'idle',stateSince:now}]));const c=sc.chars.get('main');c.reaction=null;
  const errors=[],hist=[];stage.addEventListener('office-surprise',e=>hist.push(e.detail));
  const lazy=!performance.getEntriesByType('resource').some(e=>/break-room|breaks\\/(gym|outdoor)/.test(e.name));
  const next=async()=>{const ctrl=c.egg.controller;if(ctrl.next){now=ctrl.next.at+1;sc._tickLife();}await H.frames();};
  const begin=async(kind)=>{if(!await sc.surprise(c.id,kind,{weather:'rain',arrowMs:600000,stepMs:80}))throw Error('rejected '+kind+' '+JSON.stringify({busy:c.signalBusy,egg:c.egg?.phase,walking:c.walking,activity:!!c.activity,hidden:sc.hidden,editing:sc.editing,state:c.occ.state,visit:!!c.visit}));await H.frames();};
  const room=async()=>{document.querySelector('.ao-egg-arrow').click();await H.until(()=>c.egg?.controller?.room);await next();};
  for(const kind of ['hide','gym','smoke']){
   hist.length=0;await begin(kind);
   if(kind!=='hide'){
    const arrow=document.querySelector('.ao-egg-arrow');if(!arrow?.getAttribute('aria-label')||arrow.dataset.side!==(kind==='gym'?'left':'right'))errors.push('arrow '+kind);
    await room();const a=c.egg.controller.room;if(a.root.dataset.reduced!=='true'||getComputedStyle(a.root).transitionProperty!=='opacity')errors.push('reduced '+kind);
    sc.setTheme('night');a.tick(now);if(a.root.dataset.theme!=='night'||a.weather!=='rain')errors.push('theme '+kind);
    if(!a.root.querySelector('.ao-break-window')||getComputedStyle(a.root.querySelector('.ao-break-window i')).animationName!=='none')errors.push('static rain '+kind);
    await next();
   }else if(!c.egg.controller.hideMask||!c.el.style.clipPath)errors.push('hide occlusion');
   let steps=0;while(c.egg&&steps++<14)await next();if(c.egg||c.walking||c.seatMode!=='desk'||document.querySelector('.ao-break,.ao-egg-arrow,.ao-egg-foliage'))errors.push('return '+kind);
   if(!hist.some(e=>e.phase==='transition-back')||!hist.some(e=>e.phase==='return')||hist.at(-1)?.kind!==null)errors.push('incomplete '+kind);
  }
  for(const phase of ['leave','arrow','transition','enter','activity','transition-back']){
   sc.signal(c.id,{kind:'run.succeeded'});c.reaction=null;await begin('gym');
   if(phase!=='leave'&&phase!=='arrow'){document.querySelector('.ao-egg-arrow').click();await H.until(()=>c.egg?.controller?.room);if(phase!=='transition')await next();if(phase==='activity'||phase==='transition-back')await next();if(phase==='transition-back')c.egg.controller.returnHome();}
   sc.signal(c.id,{kind:'run.started'});if(!c.signalBusy)errors.push('busy '+phase);
   let n=0;while(c.egg&&n++<4)await next();if(c.egg||c.seatMode!=='desk'||!c.el.isConnected||document.querySelector('.ao-break,.ao-egg-arrow'))errors.push('preempt '+phase);
   if(await sc.surprise(c.id,'gym'))errors.push('busy allowed '+phase);
  }
  const {saveSurprises}=await import('/public/v2/office/surprises.js');
  sc.signal(c.id,{kind:'run.succeeded'});c.reaction=null;await begin('gym');await room();saveSurprises(false);await next();if(c.egg||localStorage.getItem('office.animations-surprises')!=='off'||await sc.surprise(c.id,'gym'))errors.push('setting off');saveSurprises(true);
  for(const action of ['editing','hidden','layout','destroy']){
   if(!sc.chars.has(c.id))break;await begin('gym');await room();
   if(action==='editing'){sc.setEditing(true);sc.setEditing(false);}if(action==='hidden'){sc._frozen=true;sc._syncHidden();sc._frozen=false;sc._syncHidden();}
   if(action==='layout')sc.setLayout(H.layout);if(action==='remove'){sc.setReducedMotion(true);sc.setOccupants([]);}if(action==='destroy')sc.destroy();
   if(document.querySelector('.ao-break,.ao-egg-arrow,.ao-egg-foliage')||sc.world.style.opacity==='0')errors.push('cleanup '+action);
  }
  sc.destroy();return {errors,lazy};
 `);assert.deepEqual(r.errors,[]);assert.equal(r.lazy,true);assert.deepEqual(p.logs,[]);
 }finally{await b.close();}
});
test('26b: normal leave and return use A*; loading/decode races and removal release the egg lease',{skip:!findChrome(),timeout:120000},async()=>{
 const b=await launch();try{const p=await b.page('/test/office/harness.html');await p.waitFor('window.H?.ready');const result=await p.eval(`
  let now=Date.now(),frame=performance.now();const sc=new H.OfficeScene(stage,{manifest:H.manifest,layout:H.layout,assetBase:H.assetBase,life:{intervalMs:600000},walkTilesPerS:2.2});sc._lifeTimer();sc._lifeTimer=()=>{};sc._kick=()=>{};cancelAnimationFrame(sc._raf);sc.setReducedMotion(true);
  sc.now=()=>now;const source={id:'main',role:'main',sourceName:'Agent',state:'idle',stateSince:now};sc.setOccupants(H.occupants([source]));const c=sc.chars.get('main');c.reaction=null;const errors=[];
  const loading=sc.surprise(c.id,'gym');const loadingPhase=c.egg?.phase;sc.signal(c.id,{kind:'run.started'});const canceledLoading=!await loading&&!c.egg;sc.signal(c.id,{kind:'run.succeeded'});c.reaction=null;
  const walk=()=>{let n=0;while(c.walking&&n++<300){frame+=100;sc._frame(frame);}if(n>=300)throw Error('A* did not finish');};
  const next=()=>{if(c.egg?.controller?.next){now=c.egg.controller.next.at+1;sc._tickLife();}};
  for(const phase of ['leave','arrow','transition','enter','activity','transition-back','return']){
   sc.setReducedMotion(false);if(!await sc.surprise(c.id,'gym',{arrowMs:600000,stepMs:100}))throw Error('start '+phase);
   if(phase==='leave'&&!c.walking)errors.push('no exit path');
   if(phase!=='leave')walk();
   if(!['leave','arrow'].includes(phase)){await c.egg.controller.openRoom();if(phase!=='transition')next();if(['activity','transition-back','return'].includes(phase))next();if(['transition-back','return'].includes(phase))c.egg.controller.returnHome();if(phase==='return')next();}
   if(c.egg?.phase!==phase)errors.push('phase '+phase+' was '+c.egg?.phase);
   sc.signal(c.id,{kind:'run.started'});if(c.egg?.controller?.next)next();walk();
   if(c.egg||c.seatMode!=='desk'||c.el.style.clipPath||document.querySelector('.ao-break,.ao-egg-arrow'))errors.push('dirty '+phase);
   sc.signal(c.id,{kind:'run.succeeded'});c.reaction=null;
  }
  sc.setReducedMotion(true);await sc.surprise(c.id,'gym',{arrowMs:600000});H.holdDecodes();const ctrl=c.egg.controller,opening=ctrl.openRoom();await H.until(()=>document.querySelector('.ao-break'));
  sc.signal(c.id,{kind:'run.started'});H.releaseAll();H.restoreDecodes();await opening;if(document.querySelector('.ao-break')||c.egg)errors.push('late room');
  sc.signal(c.id,{kind:'run.succeeded'});c.reaction=null;await sc.surprise(c.id,'gym',{arrowMs:600000});await c.egg.controller.openRoom();sc.setOccupants([]);await H.until(()=>!sc.chars.size);if(document.querySelector('.ao-break,.ao-egg-arrow'))errors.push('removed room');sc.destroy();
  const again=new H.OfficeScene(stage,{manifest:H.manifest,layout:H.layout,assetBase:H.assetBase});again.setReducedMotion(true);again.setOccupants(H.occupants([source]));const released=await again.surprise('main','hide');again.destroy();
  return {errors,loadingPhase,canceledLoading,released};
 `);assert.deepEqual(result.errors,[]);assert.equal(result.loadingPhase,'loading');assert.equal(result.canceledLoading,true);assert.equal(result.released,true);assert.deepEqual(p.logs,[]);
 }finally{await b.close();}
});
test('26b: twelve occupants across two scenes obey global caps; two room actors share a host without new timers',{skip:!findChrome(),timeout:120000},async()=>{
 const b=await launch();try{const p=await b.page('/test/office/harness.html');await p.waitFor('window.H?.ready');await p.viewport(1400,1600);const r=await p.eval(`
  const make=(el,offset)=>{const sc=new H.OfficeScene(el,{manifest:H.manifest,layout:H.layout,assetBase:H.assetBase,life:{intervalMs:600000}});sc.setReducedMotion(true);sc.setOccupants(H.occupants(Array.from({length:6},(_,i)=>({id:offset+i?'subagent:'+ (offset+i):'main',role:offset+i?'subagent':'main',sourceName:'Agent '+(offset+i),state:'idle',stateSince:Date.now()}))));sc._lifeTimer();sc._lifeTimer=()=>{};return sc;};
  const el=document.createElement('div');el.style.cssText='width:1000px;height:700px';document.body.append(el);const a=make(stage,0),b=make(el,6),ca=[...a.chars.values()],cb=[...b.chars.values()];
  const egg=await a.surprise(ca[0].id,'gym',{arrowMs:600000});const second=await b.surprise(cb[0].id,'smoke');
  const wander=[a.interact(ca[1].id,'coffee',{durationMs:60000}),b.interact(cb[1].id,'book',{durationMs:60000}),b.interact(cb[2].id,'water')];
  const {wanderCount}=await import('/public/v2/office/life.js');const capped=wanderCount()===3;
  const timers=[...ca,...cb].filter(c=>c.egg?.timer||c.egg?.controller?.timer||c.activity?.timer).length;
  for(const [sc,cs] of [[a,ca],[b,cb]])for(const c of cs)sc.signal(c.id,{kind:'run.started'});const preempt=[...ca,...cb].every(c=>!c.egg&&!c.activity&&c.signalBusy);
  a.destroy();b.destroy();el.remove();
  const s=make(stage,20),cs=[...s.chars.values()];const {createBreakRoom}=await import('/public/v2/office/break-room.js');
  const r1=await createBreakRoom(s,cs[0],'gym',{weather:'clear'}),r2=await createBreakRoom(s,cs[1],'gym',{weather:'rain'});
  r1.show(true,140);const shared=r1.root===r2.root&&r1.root.querySelectorAll('.ao-break-actor').length===2;
  r1.hide(true,140);r1.destroy();const survives=r2.root.isConnected&&r2.root.dataset.open==='true'&&r2.root.querySelectorAll('.ao-break-actor').length===1;
  r2.destroy();const clean=!document.querySelector('.ao-break')&&s.world.style.opacity==='';s.destroy();
  return {count:ca.length+cb.length,egg,second,wander,capped,timers,preempt,shared,survives,clean,released:wanderCount()===0};
 `);assert.equal(r.count,12);assert.equal(r.egg,true);assert.equal(r.second,false);assert.deepEqual(r.wander,[true,true,false]);assert.equal(r.timers,0);for(const k of ['capped','preempt','shared','survives','clean','released'])assert.equal(r[k],true,k);assert.deepEqual(p.logs,[]);
 }finally{await b.close();}
});
