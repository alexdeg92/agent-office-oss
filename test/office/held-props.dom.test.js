const {test}=require('node:test');const assert=require('node:assert/strict');
const {launch,findChrome}=require('./helpers/browser');
test('26c: all looks grip raster props at four facings, seated phone/book stay in the chair, busy work removes carried cup',{skip:!findChrome(),timeout:180000},async()=>{
 const b=await launch();try{
  const p=await b.page('/test/office/harness.html');await p.waitFor('window.H?.ready');
  const result=await p.eval(`
   const sc=new H.OfficeScene(stage,{manifest:H.manifest,layout:H.layout,assetBase:H.assetBase,life:{intervalMs:600000}});sc.setReducedMotion(true);
   const errors=[];let checks=0;
   for(const ch of H.manifest.characters)for(const v of ch.variants?.length?ch.variants:[{id:null}]){
    const look={character:ch.id,variant:v.id,accessories:['cap','glasses','scarf','badge']};
    sc.setOccupants([{id:'main',role:'main',name:'Agent',state:'idle',stateSince:Date.now(),stationUid:'st-timmy',look}]);const c=sc.chars.get('main');
    for(const [action,pose] of [['coffee','drink'],['book','book'],['water','water'],['whiteboard','pen']]){
     if(!sc.interact(c.id,action,{durationMs:600000}))throw Error('Unavailable '+action);
     for(const facing of ['sw','se','ne','nw']){
      c.facing=facing;sc._renderPose(c);await H.until(()=>c.displayed===c.poseEl);checks++;
      const expected='life-'+pose+'-'+facing;
      if(c.renderedPose!==expected||!c.displayed.querySelector('[data-layer=body]').src.endsWith(expected+'.webp'))errors.push(expected+': flat/fallback body');
      if(c.el.querySelector('.ao-life-prop,svg'))errors.push(expected+': vector prop remains');
      if([...c.displayed.querySelectorAll('img')].some(i=>i.naturalWidth!==192))errors.push(expected+': undecoded gear');
     }
     sc._cancelActivity(c);
    }
    for(const [state,pose] of [['researching','life-readseat-ne'],['calling','life-phone-ne']]){
     sc.setOccupants([{...c.occ,state}]);await H.until(()=>c.displayed===c.poseEl);checks++;
     if(c.renderedPose!==pose||c.seatMode!=='desk'||!c.poseSeat)errors.push(state+': not genuinely seated');
    }
   }
   const c=sc.chars.get('main');sc.setOccupants([{...c.occ,state:'idle'}]);sc.setReducedMotion(false);sc.opts.walkTilesPerS=.01;sc.interact(c.id,'coffee',{durationMs:60000});
   c.pos={x:c.target.x,y:c.target.y};c.walking=false;c.onArrive();const sip=c.activity.sipTimer;
   sc._cancelActivity(c);const carry=c.carryProp==='cup'&&c.renderedPose.startsWith('life-cupwalk-')&&!c.timers.has(sip);
   sc.setOccupants([{...c.occ,state:'working'}]);const preempt=!c.carryProp&&!c.renderedPose.startsWith('life-cupwalk-')&&!c.activity;
   sc.destroy();return {errors,checks,carry,preempt};
  `);
  assert.deepEqual(result.errors,[]);assert.equal(result.checks,144);assert.equal(result.carry,true);assert.equal(result.preempt,true);assert.deepEqual(p.logs,[]);
 }finally{await b.close();}
});
