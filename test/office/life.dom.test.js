const { test } = require('node:test');
const assert = require('node:assert/strict');
const { launch, findChrome } = require('./helpers/browser');
test('office life: every landmark has a complete return, gear survives, real work cancels every phase', {skip:!findChrome(),timeout:120000}, async()=>{
 const b=await launch();try {
 const p=await b.page('/test/office/harness.html');await p.waitFor('window.H?.ready');
 const result=await p.eval(`
 window.sc=new H.OfficeScene(document.getElementById('stage'),{manifest:H.manifest,layout:H.layout,assetBase:H.assetBase,life:{intervalMs:600000}});
 sc.setReducedMotion(true);
 window.src=[{id:'main',role:'main',sourceName:'Agent',state:'idle',stateSince:Date.now()}, {id:'subagent:peer',role:'subagent',sourceName:'Collègue',state:'idle',stateSince:Date.now()}, {id:'dm:visitor',role:'dm',sourceName:'Visite',state:'idle',stateSince:Date.now()}];
 window.push=()=>sc.setOccupants(H.occupants(src));push();
 const outcomes=[];
 for(const k of ['coffee','water','window','book','whiteboard','chat','highfive','wave','sleep','server']) {
   const ok=sc.interact('main',k,{durationMs:20}); const c=sc.chars.get('main');
   const phase=c.activity?.phase;
   await H.until(()=>!c.activity && !c.walking);await H.until(()=>c.displayed===c.poseEl);
   outcomes.push({k,ok,phase,home:c.seatUid===c.occ.stationUid,prop:!!c.el.querySelector('.ao-life-prop'),gear:[...c.displayed.querySelectorAll('[data-layer=front],[data-layer=back]')].length});
 }
 const matrix=[];
 for(const ch of H.manifest.characters) for(const variant of ch.variants?.length?ch.variants:[{id:null}]) {
   sc.setOccupants([{...sc.chars.get('main').occ,look:{character:ch.id,variant:variant.id,accessories:['cap','headphones','glasses','scarf','badge']}}]);
   for(const kind of ['coffee','water','window','book','whiteboard','sleep','server']) {
     if(!sc.interact('main',kind,{durationMs:60000})) throw Error(kind+' unavailable');
     const c=sc.chars.get('main');
     if(kind==='window' && c.activity.target.landmark.x!==0) throw Error('Wrong window wall');
     if(kind==='whiteboard' && c.activity.target.landmark.y!==0) throw Error('Wrong board wall');
     for(const dir of ['sw','se','ne','nw']) {
       c.facing=dir;sc._renderPose(c);await H.until(()=>c.displayed===c.poseEl);
       if([...c.displayed.querySelectorAll('img')].some(i=>!i.naturalWidth)) throw Error('Undecoded gear');
       matrix.push(ch.id+'/'+variant.id+'/'+kind+'/'+dir);
     }
     sc._cancelActivity(c);
   }
 }
 push();
 sc.setReducedMotion(false);sc.interact('main','coffee',{durationMs:60000});
 const c=sc.chars.get('main');const walking=c.walking;
 src[0].state='working';push(); const cancelled=!c.activity && c.target.uid===c.occ.stationUid;
 sc.setReducedMotion(true);await H.until(()=>!c.walking);
 src[0].state='idle';push();sc.interact('main','coffee',{durationMs:60000});src[0].state='writing';push();
 const interactCancelled=!c.activity && c.seatUid===c.occ.stationUid;
 const rejected=sc.interact('main','coffee');sc.cue('main','celebrating');const success=c.reaction==='success';
 sc.setFrozen(true);const paused=!c.activity;sc.destroy();
 return {outcomes,matrix,walking,cancelled,interactCancelled,rejected,success,paused,empty:document.getElementById('stage').children.length===0};
 `);
 assert.equal(result.outcomes.length,10);assert.equal(result.matrix.length,224);
 for(const r of result.outcomes){assert.equal(r.ok,true,r.k);assert.equal(r.phase,'interact',r.k);assert.equal(r.home,true,r.k);assert.ok(r.gear>0,r.k);}
 for(const k of ['walking','cancelled','interactCancelled','success','paused','empty']) assert.equal(result[k],true,k);
 assert.equal(result.rejected,false);assert.deepEqual(p.logs,[]);
 }finally{await b.close();}
});

test('Round 2: visible glyphs, generated seated gestures, landmark facings and separated social palms on every look', {skip:!findChrome(),timeout:120000}, async()=>{
 const b=await launch();try{
  const p=await b.page('/test/office/harness.html');await p.waitFor('window.H?.ready');
  const result=await p.eval(`
   const errors=[];const sc=new H.OfficeScene(stage,{manifest:H.manifest,layout:H.layout,assetBase:H.assetBase,life:{intervalMs:600000}});sc.setReducedMotion(true);
   const looks=H.manifest.characters.flatMap(ch=>(ch.variants?.length?ch.variants:[{id:null}]).map(v=>({character:ch.id,variant:v.id,accessories:['glasses','scarf','badge']})));
   const peer={id:'subagent:peer',role:'subagent',sourceName:'Collègue',state:'idle',stateSince:Date.now(),stationUid:'st-2',look:{character:'subagent',variant:'sage',accessories:['headphones']}};
   for(const width of [1440,360]) {
    stage.style.width=width+'px';
    for(const look of looks) {
     sc.setOccupants([{id:'main',role:'main',sourceName:'Agent',state:'idle',stateSince:Date.now(),stationUid:'st-timmy',look},peer]);sc.fit();const c=sc.chars.get('main');
     const label=width+'/'+look.character+'/'+look.variant;
     const check=async()=>{await H.until(()=>c.displayed===c.poseEl);if([...c.displayed.querySelectorAll('img')].some(i=>i.naturalWidth!==192))errors.push(label+': missing registered layers');};
     for(const [kind,pose,glyph] of [['error','life-error-sw','!'],['success','life-success-sw','✓'],['stretch','life-stretch-ne','↔'],['waiting','working-ne','…'],['message','working-ne','✉']]) {
      sc.react('main',kind,{durationMs:60000});await check();const bubble=c.plate.querySelector('.ao-life-bubble');
      if(c.renderedPose!==pose||bubble?.textContent!==glyph)errors.push(label+': wrong '+kind+' frame/glyph');
      if(parseFloat(getComputedStyle(bubble).fontSize)!==20||bubble.getBoundingClientRect().height<30)errors.push(label+': bubble scaled down');
      if(['error','success','stretch'].includes(kind)&&(!c.poseSeat||!c.displayed.querySelector('[data-layer=body]').src.endsWith(pose+'.webp')))errors.push(label+': gesture lost seated raster');
     }
     sc._clear(c,c.reactionTimer);c.reaction=null;
     for(const kind of ['coffee','water','window','book','whiteboard','server','sleep','chat','highfive']){
      if(!sc.interact('main',kind,{durationMs:60000})){errors.push(label+': unavailable '+kind);continue;}await check();
      const target=c.activity.target;
      if(target.landmark){const dir=sc._facingToward(c.pos,target.landmark);if(c.facing!==dir||!c.renderedPose.endsWith('-'+dir)&&['ne','nw'].includes(dir))errors.push(label+': faces away '+kind);}
      if(kind==='sleep'&&(c.renderedPose!=='life-sleep-ne'||c.plate.querySelector('.ao-life-bubble')?.textContent!=='Zzz'))errors.push(label+': nap invisible');
      if(['chat','highfive'].includes(kind)){
       const other=sc.chars.get(target.partnerId);await H.until(()=>other.displayed===other.poseEl);
       if(c.seatMode==='desk'||other.seatMode==='desk'||c.facing===other.facing)errors.push(label+': social partner still in chair');
       for(const who of [c,other]){const x=Math.floor(who.pos.x),y=Math.floor(who.pos.y);if(sc.grid.blocked[y*sc.grid.cols+x])errors.push(label+': social tile blocked');}
       if(Math.floor(c.pos.x)===Math.floor(other.pos.x)&&Math.floor(c.pos.y)===Math.floor(other.pos.y))errors.push(label+': same social tile');
       const pos=who=>({x:((who.pos.x-who.pos.y)*sc.proj.tileWidth)/2,y:((who.pos.x+who.pos.y)*sc.proj.tileHeight)/2});const a=pos(c),z=pos(other);
       if(Math.abs(a.x-z.x)<55)errors.push(label+': bodies too close');
       if(kind==='highfive'){
        const hand=who=>{const p=pos(who),k=who.poseScale/sc.proj.artScale;return {x:p.x+(who.poseHand.x-who.poseAnchor.x)*k,y:p.y+(who.poseHand.y-who.poseAnchor.y)*k};};
        const h=hand(c),ph=hand(other);if(Math.hypot(h.x-ph.x,h.y-ph.y)>1)errors.push(label+': palms do not meet');if(!c.el.querySelector('.ao-life-clap'))errors.push(label+': clap missing');
       }
      }
      sc._cancelActivity(c);await check();
     }
    }
   }
   sc.setReducedMotion(false);sc.opts.walkTilesPerS=.01;const c=sc.chars.get('main');sc.interact('main','coffee',{durationMs:60000});
   c.pos={x:c.activity.target.x,y:c.activity.target.y};c.path=[];c.walking=false;c.onArrive();sc._cancelActivity(c);const cupReturn=c.walking&&c.carryProp==='cup'&&c.renderedPose.startsWith('life-cupwalk-')&&!c.el.querySelector('.ao-life-prop');
   sc.setOccupants([{...c.occ,state:'working'},peer]);const workClean=!c.activity&&!c.social&&c.target.uid===c.occ.stationUid;
   sc.destroy();return {errors,cupReturn,workClean};
  `);
  assert.deepEqual(result.errors,[]);assert.equal(result.cupReturn,true);assert.equal(result.workClean,true);assert.deepEqual(p.logs,[]);await p.close();
 }finally{await b.close();}
});
