const {test}=require('node:test');const assert=require('node:assert/strict');
const {launch,findChrome}=require('./helpers/browser');
test('Open + scale: 12 neutral occupants share a bounded life scheduler; neutral events preempt and drive poses',{skip:!findChrome(),timeout:120000},async()=>{
 const b=await launch();try{
  const p=await b.page('/test/office/harness.html');await p.waitFor('window.H?.ready');
  const result=await p.eval(`
   const sc=new H.OfficeScene(stage,{manifest:H.manifest,layout:H.layout,assetBase:H.assetBase,life:{intervalMs:600000}});sc.setReducedMotion(true);
   const sources=Array.from({length:12},(_,i)=>({id:i?'subagent:'+i:'main',role:i?'subagent':'main',sourceName:'Agent '+i,state:'idle',stateSince:Date.now()}));
   const push=()=>sc.setOccupants(H.occupants(sources));push();
   const ids=[...sc.chars.keys()];const started=['coffee','book','water'].map((kind,i)=>sc.interact(ids[i],kind,{durationMs:60000}));
   const rejected=sc.interact(ids[3],'window');
   const before=[...sc.chars.values()].filter(c=>c.activity).length;
   const lifeTimers=[...sc.chars.values()].filter(c=>c.activity?.timer||c.activity?.sipTimer).length;
   for(const id of ids)sc.signal(id,{kind:'run.started'});
   const preempt=[...sc.chars.values()].every(c=>!c.activity&&!c.carryProp&&c.signalBusy);
   const blocked=ids.every(id=>!sc.interact(id,'book'));
   const first=sc.chars.get(ids[0]);sc.signal(first.id,{kind:'run.succeeded'});const success=first.reaction==='success'&&!first.reactionTimer;await H.until(()=>!first.reaction);
   sc.signal(first.id,{kind:'tool.kind',toolKind:'file-read'});const research=first.signalState==='researching'&&sc._currentPose(first)==='life-readseat-ne';
   sc.signal(first.id,{kind:'tool.kind',toolKind:'message'});const phone=sc._currentPose(first)==='life-phone-ne';
   sc.signal(first.id,{kind:'waiting-on-human'});const waiting=first.reaction==='waiting';
   sc.signal(first.id,{kind:'message.inbound'});const message=first.reaction==='message';
   sc.setSignals([{id:'seed',at:1,count:1,occupantId:first.id,kind:'run.failed'}]);const noReplay=first.reaction==='message';
   sc.setSignals([{id:'next',at:2,count:1,occupantId:first.id,kind:'run.failed'}]);const failure=first.reaction==='error';
   first.reaction=null;sc.setSignals([{id:'next',at:2,count:1,occupantId:first.id,kind:'run.failed'}]);const dedup=first.reaction===null;
   sc.destroy();
   const again=new H.OfficeScene(stage,{manifest:H.manifest,layout:H.layout,assetBase:H.assetBase});again.setReducedMotion(true);again.setOccupants(H.occupants(sources));const released=again.interact(ids[0],'coffee');again.destroy();
   return {count:ids.length,started,rejected,before,lifeTimers,preempt,blocked,success,research,phone,waiting,message,noReplay,failure,dedup,released};
  `);
  assert.equal(result.count,12);assert.deepEqual(result.started,[true,true,true]);assert.equal(result.rejected,false);assert.equal(result.before,3);assert.equal(result.lifeTimers,0);
  for(const key of ['preempt','blocked','success','research','phone','waiting','message','noReplay','failure','dedup','released'])assert.equal(result[key],true,key);
  assert.deepEqual(p.logs,[]);
 }finally{await b.close();}
});
