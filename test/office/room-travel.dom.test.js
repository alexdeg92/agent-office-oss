const {test}=require('node:test');const assert=require('node:assert/strict');const {launch,findChrome}=require('./helpers/browser');
test('26b: room travel walks on floor contacts, switches to bench hip on arrival, then stands beside the bench',{skip:!findChrome(),timeout:120000},async()=>{
 const b=await launch();try{const p=await b.page('/test/office/harness.html');await p.waitFor('window.H?.ready');const r=await p.eval(`
  let now=Date.now();const s=new H.OfficeScene(stage,{manifest:H.manifest,layout:H.layout,assetBase:H.assetBase,life:{intervalMs:600000}});s.now=()=>now;s.setReducedMotion(true);s.setOccupants(H.occupants([{id:'main',role:'main',sourceName:'Agent',state:'idle',stateSince:now}]));const c=s.chars.get('main');s._lifeTimer();s._lifeTimer=()=>{};
  const {createBreakRoom}=await import('/public/v2/office/break-room.js'),{EGGS}=await import('/public/v2/office/surprises.js');const room=await createBreakRoom(s,c,'gym',{weather:'clear'}),bench=EGGS.gym.steps.find(x=>x.id==='bench'),wipe=EGGS.gym.steps.find(x=>x.id==='wipe');room.show(true,140);
  room.move(EGGS.gym.steps[0],6000);await H.until(()=>room.pose?.pose==='egg-curl-low-sw');s.setReducedMotion(false);room.move(bench,6000);await H.until(()=>room.pose?.pose==='walking-se'&&room.point===room.host.def.points.benchFloor);
  const floorWalk=room.pendingStep?.step===bench&&room.step.anchor!=='seat'&&room.anchor===room.pose.anchor;
  now=room.pendingStep.at+1;room.tick(now);await H.until(()=>room.pose?.pose==='egg-bench-low-sw');const seat=room.point===room.host.def.points.bench&&room.anchor===room.pose.seatAnchor;
  const planted=Math.abs(parseFloat(room.actor.style.left)+room.anchor.x*room.k-room.point.x)<.01&&Math.abs(parseFloat(room.actor.style.top)+room.anchor.y*room.k-room.point.y)<.01;
  room.move(wipe,2200);await H.until(()=>room.pose?.pose==='walking'&&room.point===room.host.def.points.mat);const leftFromFloor=room.pendingStep?.step===wipe&&!room.pose.seatAnchor;
  now=room.pendingStep.at+1;room.tick(now);await H.until(()=>room.pose?.pose==='egg-wipe-sw');const towel=room.body.querySelector('[data-layer=body]').src.endsWith('/egg-wipe-sw.webp');room.destroy();s.destroy();return {floorWalk,seat,planted,leftFromFloor,towel};
 `);for(const k of ['floorWalk','seat','planted','leftFromFloor','towel'])assert.equal(r[k],true,k);assert.deepEqual(p.logs,[]);
 }finally{await b.close();}
});
