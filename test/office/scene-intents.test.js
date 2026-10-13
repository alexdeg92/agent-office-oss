'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const intents=require('../../public/v2/office/scene-intents.js');
const {sleepBox,positionSleep}=require('../../public/v2/office/sleep-letters.js');
const target=(floorId,x,y,mode='stand')=>({kind:'destination',floorId,stationUid:null,point:{x,y},approachPoint:{x,y},seatContact:null,mode,seatIndex:null,facing:'sw'});
const travel=id=>({id,fromFloorId:'1',toFloorId:'rdc',departure:target('1',1.5,.5),arrival:target('rdc',1.5,.5)});

test('renderer projects exactly the supplied target without allocating a floor or spot',()=>{
  const supplied={...target('rdc',9.5,6.5,'sofa'),stationUid:'bench',seatIndex:1,seatContact:{x:9.25,y:1.25}};
  const c={id:'member',occ:{sceneTarget:supplied}};
  assert.deepEqual(intents.target(c),{x:9.5,y:6.5,uid:'bench',mode:'sofa',seatIndex:1,seatContact:supplied.seatContact,approachPoint:supplied.approachPoint,facing:'sw'});
  assert.equal(intents.target({id:'member',occ:{sceneTarget:null}}),null);
});

test('a new sleep effect after a wave is placed even when head/camera geometry is unchanged',()=>{
 const fx=()=>({hidden:true,dataset:{},style:{},toggleAttribute(){}});
 const c={id:'sleeper',head:{sx:100,sy:150},sleepLetters:fx(),sleepVersion:1};
 const scene={chars:new Map([[c.id,c]]),viewport:{clientWidth:343,clientHeight:261},stage:{hasAttribute:()=>true},cam:{zoom:1,x:0,y:0},origin:{x:0,y:0}};
 positionSleep(scene,[]);assert.equal(c.sleepLetters.hidden,false);const position=c.sleepLetters.style.transform;
 c.sleepLetters=fx();c.sleepVersion++;
 positionSleep(scene,[]);assert.equal(c.sleepLetters.hidden,false);assert.equal(c.sleepLetters.style.transform,position);
});

test('initial travel is not replayed; a new journey leaves and arrives once at supplied elevators',()=>{
  const memory=new Map(),scene={_floorId:'1',_travelMemory:memory,_travelRows:[{id:'member',sceneTravel:travel('old')} ]};
  intents.setTravel(scene);assert.equal(intents.departure(scene,{id:'member'}),null);
  scene._travelRows=[{id:'member',sceneTravel:travel('new')}];intents.setTravel(scene);
  const exit=intents.departure(scene,{id:'member'});assert.deepEqual({x:exit.target.x,y:exit.target.y},{x:1.5,y:.5});
  assert.equal(intents.departure(scene,{id:'member'}),null);
  scene._floorId='rdc';
  assert.deepEqual(intents.arrival(scene,{id:'member'}).target.approachPoint,{x:1.5,y:.5});
  assert.equal(intents.arrival(scene,{id:'member'}),null);
  const remount={...scene,_travelRows:scene._travelRows};intents.setTravel(remount);
  assert.equal(intents.arrival(remount,{id:'member'}),null);
});

test('animation replay cache is bounded without changing authoritative travel data',()=>{
  const scene={_floorId:'1',_travelMemory:new Map(),_travelRows:[]};intents.setTravel(scene);
  for(let n=0;n<600;n++){scene._travelRows=[{id:'member',sceneTravel:travel('trip-'+n)}];intents.setTravel(scene);}
  assert.equal(scene._travelMemory.size,256);assert.equal(scene._travelById.get('member').id,'trip-599');
});

test('activity frames come from supplied kind/mode and sip timing changes animation only',()=>{
  const c={walking:false,target:{mode:'stand',facing:'sw'},occ:{activity:{id:'coffee',kind:'coffee'}}};
  let renders=0;const scene={reducedMotion:false,_renderPose:()=>renders++};
  assert.equal(intents.pose(c),'life-drink-sw');intents.tick(scene,c,0);intents.tick(scene,c,1500);
  assert.equal(intents.pose(c),'life-cupwalk-sw');assert.equal(renders,1);assert.equal(c.occ.activity.id,'coffee');
  c.occ.activity.kind='smoke';assert.equal(intents.pose(c),'egg-smoke-sw');
  c.occ.activity.kind='gym';assert.equal(intents.pose(c),'egg-curl-high-sw');
  c._sipNext=null;intents.tick(scene,c,2000);intents.tick(scene,c,2750);assert.equal(intents.pose(c),'egg-curl-low-sw');
  scene.reducedMotion=true;intents.tick(scene,c,4000);assert.equal(intents.pose(c),'egg-curl-low-sw');
  c.target.mode='sofa';assert.equal(intents.pose(c),'sofa-sit-sw');
  c.walking=true;assert.equal(intents.pose(c),null);assert.equal(intents.activity(c),'');
});

test('idle at a supplied desk dozes; active, away and explicit interaction poses stay intact',()=>{
  const c={walking:false,target:{mode:'desk'},occ:{state:'idle',activity:null}};
  assert.equal(intents.pose(c),'life-sleep-ne');
  assert.equal(intents.activity(c),'sleep');assert.equal(intents.bubble(c,'Zzz'),null,'sleep uses separate head letters, not a desk nameplate bubble');
  assert.equal(intents.bubble(c,'!'),null,'state alerts still belong on the desk monitor');
  for(const state of ['working','thinking','waiting','blocked','error','unknown','offline']) {
    c.occ.state=state;assert.equal(intents.pose(c),null,state);
  }
  c.occ.state='idle';c.target.mode='stand';assert.equal(intents.pose(c),null);
  c.target.mode='desk';c.walking=true;assert.equal(intents.pose(c),null);c.walking=false;
  for(const field of ['activity','deskTalk','social','cue','egg','reaction','wave']) {
    c[field]=true;assert.equal(intents.pose(c),null,field);delete c[field];
  }
  assert.equal(intents.pose(c),'life-sleep-ne');
  c.wave=true;assert.equal(intents.pose(c),null,'user selection delegates to the existing seated wave');
  assert.equal(intents.activity(c),'','sleep bubble clears during the wave');
  c.wave=false;assert.equal(intents.pose(c),'life-sleep-ne','idle doze resumes after the wave');
  assert.deepEqual(c.occ,{state:'idle',activity:null},'pose presentation does not alter state or placement');
});

test('sleep trajectory envelopes stay inside the viewport and clear names, controls and one another',()=>{
 for(const mobile of [true,false]){
  const width=mobile?343:795,height=mobile?261:537;
  const anchored=sleepBox({x:100,y:150},width,height,mobile,[]);
  assert.equal(anchored.left,100,'the cascade begins at the rendered head, with no horizontal gap');
  assert.equal(anchored.bottom,150,'the first letter baseline meets the rendered head');
  const fractional=sleepBox({x:100.2,y:150.2},width,height,mobile,[]);
  assert.equal(fractional.side,'right','pixel rounding cannot flip a head-adjacent cascade to its far edge');
  assert.ok(Math.abs(fractional.left-100.2)<1&&Math.abs(fractional.bottom-150.2)<1);
  const blocked=[{left:width-58,right:width-8,top:8,bottom:58},{left:150,right:230,top:56,bottom:100},{left:112,right:204,top:116,bottom:160},{left:205,right:265,top:138,bottom:182}];
  for(const head of [{x:232,y:178},{x:190,y:157}]){
   const box=sleepBox(head,width,height,mobile,blocked);
   assert.ok(box.left>=0&&box.top>=0&&box.right<=width&&box.bottom<=height);
   assert.ok(blocked.every(p=>box.right<=p.left||box.left>=p.right||box.bottom<=p.top||box.top>=p.bottom),JSON.stringify(box));
   blocked.push(box);
  }
 }
});
