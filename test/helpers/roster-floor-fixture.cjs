'use strict';
require('./scratch-home.cjs').refuseEntry(__filename);
const assert=require('node:assert/strict');
const {officeSceneFixture}=require('./office-scene-fixture.cjs');

async function rosterFloorFixture({publicUrl,scoped=true}={}){
 const source=({engine,clock})=>({detected:true,hasHerdr:true,hasTeamStore:true,enabled:true,start(){},close(){},onChange:()=>()=>{},getSnapshot:()=>({
  observedAt:clock.value,revision:1,hostRevision:1,teamRevision:1,sourcesReady:true,
  team:{id:'team:fixture',label:'Équipe synthétique',status:'active'},
  hosts:[{id:'host:fixture',label:'Hôte synthétique',platform:'container',status:'available',observedAt:clock.value}],
  orchestrators:[{id:'orchestrator:fixture',hostId:'host:fixture',kind:'synthetic-office',label:'Orchestrateur synthétique',sourceStatus:'available',observedAt:clock.value}],
  agents:[1,2,3].map(i=>({id:`host:worker-${i}`,hostId:'host:fixture',orchestratorId:'orchestrator:fixture',name:['','PM synthétique','Membre A','Membre B'][i],runtimeKind:'synthetic-office',role:i===1?'primary':'delegate',status:engine.session(`worker-${i}`)?.run.status==='running'?'working':'idle',observedAt:clock.value,staleAfter:clock.value+60000})),
  identityLinks:[1,2,3].map(i=>({hostAgentId:`host:worker-${i}`,agentId:`worker-${i}`,confidence:'exact',evidence:'explicit-runtime-identity'})),
  members:[1,2,3].map(i=>({id:`member:worker-${i}`,teamId:'team:fixture',name:['','PM synthétique','Membre A','Membre B'][i],roleKind:i===1?'lead':'member',roleLabel:i===1?'pm':'builder',roleEvidence:'explicit',sourceAgentName:null,runtimeKind:'synthetic-office',hostAgentId:`host:worker-${i}`,parentMemberId:i===1?null:'member:worker-1',status:'active'})),
  tasks:[],reviews:[],privateMemberSessionKeys:{},privateMemberSessionRefs:{},
 })});
 const h=await officeSceneFixture({publicUrl,occupantCount:4,namedAgents:true,...(scoped?{orchestratorTeams:source,sourcePrincipalFor:()=>({id:'admin-fixture',role:'admin',permissionRevision:1}),sessionsReadable:()=>true}:{} )});
 try{
  const catalog=h.viewEngine.agents().map((a,i)=>({...a,name:['Hôte synthétique','PM synthétique','Membre A','Membre B'][i],
   spawnedBy:i>1?{agentId:'worker-1',sessionKey:'worker-1',via:'orchestrator',label:null}:null}));
  const admitted=h.viewEngine.ingestCanonical('agents',catalog);assert.equal(admitted.ok,true,JSON.stringify(admitted.issues));
  const repair=()=>{
   const rows=h.viewEngine.sessions().map(s=>({...s,parentKey:s.key==='worker-2'||s.key==='worker-3'?'worker-1':null}));
   const result=h.viewEngine.ingestCanonical('sessions.snapshot',rows);assert.equal(result.ok,true,JSON.stringify(result.issues));h.api.topics.invalidate();
  };
  const publish=states=>{h.publish(states);repair();};
  // Remove only the declared lobby activity props so the engine assigns idle
  // activity targets to the actual Gym. No mocked VM or client-side placement.
  const lobby=await h.get('/api/v3/office/layout?floorId=rdc');assert.equal(lobby.status,200,lobby.text);
  const lobbyRoom=lobby.json.data.manifest.rooms.find(r=>r.id===lobby.json.data.layout.data.room);
  const activityAssets=new Set(lobbyRoom.activitySpots.map(s=>s.asset));
  const data={...lobby.json.data.layout.data,items:lobby.json.data.layout.data.items.filter(i=>!activityAssets.has(i.asset))};
  const saved=await h.put('/api/v3/office/layout?floorId=rdc',{expectedRevision:lobby.json.data.layout.revision,data});assert.equal(saved.status,200,saved.text);
  publish(['idle','idle','working','working']);
  return {...h,publish,advance(ms,states){h.clock.value+=ms;publish(states);}};
 }catch(error){await h.close();throw error;}
}
module.exports={rosterFloorFixture};
