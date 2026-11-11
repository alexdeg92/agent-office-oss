'use strict';
require('./scratch-home.cjs').refuseEntry(__filename);
const {officeSceneFixture}=require('./office-scene-fixture.cjs');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {projectSnapshot}=require('../../src/adapters/agent-team-pm/store-reader');
const assert=require('node:assert/strict');

async function projectTeamFixture({publicUrl,sourcePortraits=false,theme='day',taskCopies=1,memberCount=6,exactLooks=true,memberNames=null,twoTeams=false,separateLeads=false,primaryFloorId=null,memberFloorIds={}}={}) {
  const at=Date.now(),teamId='team:atelier-projets',secondTeamId='team:platform-vce';
  const ids=Array.from({length:memberCount},(_,n)=>`member:12345678-1111-4111-8111-${String(n+1).padStart(12,'0')}`);
  const names=Array.isArray(memberNames)?[...memberNames]:['pm','designer','Nox','Mina','Camille','Sol','Iris'];
  while(names.length<memberCount)names.push(`Agent ${names.length+1}`);
  const looks=[{character:'family-b',variant:'pearl',accessories:[]},{character:'family-b',variant:'moss',accessories:[]},
    {character:'family-b',variant:'clay',accessories:[]},{character:'family-b',variant:'slate',accessories:[]},
    {character:'subagent',variant:'sage',accessories:[]},{character:'subagent',variant:'ochre',accessories:[]},
    {character:'subagent',variant:'teal',accessories:[]}];
  const adapters=['claude-code','codex','openclaw'];
  const sourceRoot=await fs.mkdtemp(path.join(os.tmpdir(),'ao-project-team-source-'));
  await Promise.all(['members','tasks','inbox'].map(dir=>fs.mkdir(path.join(sourceRoot,dir),{recursive:true})));
  for(const [n,id] of ids.entries())await fs.writeFile(path.join(sourceRoot,'members',`member-${n}.json`),JSON.stringify({
    id,name:names[n],role:n===0?'pm':n===1?'designer':'Membre',runtime:adapters[n%3],spawnedBy:n===0?null:n===2?ids[1]:ids[0],
  }),{mode:0o600});
  const sourceMembers=projectSnapshot({root:sourceRoot,label:'Synthetic team source',now:()=>at}).members;
  const members=ids.map((id,n)=>({...sourceMembers.find(member=>member.id===id),teamId,
      status:n===4?'inactive':'active',runtimeKind:adapters[n%3],parentMemberId:n===0?null:n===2?ids[1]:ids[0],hostAgentId:n===0&&twoTeams?'fixture-shared-lead':null,
      brand:require('../../src/adapters/'+adapters[n%3]).setup.capabilities.brand,
      ...(sourcePortraits?{portrait:{look:looks[n],avatarUrl:null}}:{})}));
  if(twoTeams&&separateLeads){
    // Two independent teams: the second is led by worker-4, so it can be homed on another floor.
    members[3].teamId=secondTeamId;members[3].parentMemberId=null;members[4].teamId=secondTeamId;members[4].parentMemberId=ids[3];
  }else if(twoTeams){
    const lead={...members[0],id:'member:12345678-1111-4111-8111-999999999999',teamId:secondTeamId};
    members.splice(1,0,lead);
    for(const member of members)if(member.teamId===secondTeamId&&member.id!==ids[0])member.teamId=secondTeamId;
    members[2].teamId=teamId;members[3].teamId=teamId;
    members[4].teamId=secondTeamId;members[5].teamId=secondTeamId;
    if(members[6])members[6].teamId='team:unassigned-fixture';
    members[4].parentMemberId=ids[0];members[5].parentMemberId=ids[0];
    members[1].parentMemberId=null;
  }
  let snapshot={revision:1,observedAt:at,hosts:[],orchestrators:[],agents:[],identityLinks:twoTeams?[{hostAgentId:'fixture-shared-lead',agentId:'worker-1',confidence:'exact',evidence:'shared-runtime-session-ref'}]:[],
    teams:twoTeams?[{id:teamId,label:'Domaine Kildare',status:'active',observedAt:at},{id:secondTeamId,label:'Synchronisation des espaces',status:'active',observedAt:at}]:undefined,
    team:{id:teamId,label:twoTeams?'Domaine Kildare':'Synchronisation des espaces',status:'active',observedAt:at},
    members,
    tasks:[['Définir les sources à synchroniser','open',1],['Normaliser les dépôts','working',2],['Vérifier les accès par source','blocked',3],
      ['Ajouter la reprise après erreur','review',4],['Préparer la documentation','done',5]].map(([title,state,owner],n)=>({
        id:`task:atelier-${n}`,teamId,title,state,priority:n%3,ownerMemberId:ids[owner%ids.length],reviewerMemberIds:n===3?[ids[4%ids.length],ids[5%ids.length]]:[],
        createdAt:at-90000,updatedAt:at-1000*(n+1)})),
    reviews:[{id:'review:fixture-atelier-3',taskId:'task:atelier-3',reviewerMemberId:ids[4],verdict:'go',createdAt:at-1000}],
    privateMemberSessionKeys:Object.fromEntries([...ids.map((id,n)=>[id,`worker-${n+1}`]),...(twoTeams?[['member:12345678-1111-4111-8111-999999999999','worker-1']]:[])]),privateMemberSessionRefs:{},diagnostics:{skippedTaskCount:0,skippedMemberCount:0,skippedCount:0,quality:'complete'}};
  if(taskCopies>1)snapshot.tasks=snapshot.tasks.flatMap(row=>Array.from({length:taskCopies},(_,copy)=>({...row,id:row.id+'-'+copy,title:row.title+' · '+(copy+1)})));
  const listeners=new Set();
  const source={detected:true,hasHerdr:false,hasTeamStore:true,enabled:true,
    teamCapabilities:require('../../src/adapters/agent-team-pm').setup.capabilities,start(){},close(){},
    onChange:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},getSnapshot:()=>snapshot};
  const primaryName=twoTeams?'Agent principal':'Atlas';
  const h=await officeSceneFixture({publicUrl,theme,occupantCount:memberCount+1,namedAgents:true,primaryName,orchestratorTeams:source});
  try {
  const agents=h.viewEngine.agents();
  assert.equal(h.viewEngine.ingestCanonical('agents',agents.map(agent=>({...agent,name:agent.isPrimary?primaryName:names[Number(agent.id.slice('worker-'.length))-1]}))).ok,true);
  const layout=await h.get('/api/v3/office/layout');assert.equal(layout.status,200,layout.text);
  const primaryRule=layout.json.data.layout.data.agents.find(rule=>['main','primary'].includes(rule.agentId));
  assert.ok(primaryRule,'the synthetic team still has a distinct main agent');
  const saved=await h.put('/api/v3/office/layout',{expectedRevision:layout.json.data.layout.revision,data:{...layout.json.data.layout.data,
    agents:[...layout.json.data.layout.data.agents.filter(rule=>!['main','primary'].includes(rule.agentId)),
      primaryFloorId ? {...primaryRule,homeFloor:primaryFloorId} : primaryRule,
      ...looks.slice(0,memberCount).map((look,n)=>({agentId:'agent:worker-'+(n+1),...look,appearance:'manual',name:names[n],role:null,station:'auto',
        ...(memberFloorIds[n+1]?{homeFloor:memberFloorIds[n+1]}:{})}))]}});
  assert.equal(saved.status,200,saved.text);
  const committedLayout=await h.get('/api/v3/office/layout');assert.equal(committedLayout.status,200,committedLayout.text);
  if(exactLooks)for(const [n,look] of looks.slice(0,memberCount).entries()){
    const rule=committedLayout.json.data.layout.data.agents.find(row=>row.agentId==='agent:worker-'+(n+1));
    assert.ok(rule,`saved synthetic appearance for worker-${n+1}`);
    assert.deepEqual({character:rule.character,variant:rule.variant,accessories:rule.accessories},look,`saved layout retains the unique canonical character for ${names[n]}`);
  }
  const metadata=new Map([['worker-1','codex'],['worker-2','claude-code']].map(([key,adapter])=>{
    const definition=require('../../src/adapters/'+adapter).definition;
    return [key,{id:'fixture-'+adapter,adapter,name:definition.name,mark:definition.mark,projectSource:definition.projectSource}];
  }));
  const connectorOf=h.viewEngine.connectorOf?.bind(h.viewEngine);
  h.viewEngine.connectorOf=key=>metadata.get(key)||connectorOf?.(key)||null;
  const sessions=h.viewEngine.sessions().map(row=>metadata.has(row.key)?{...row,projectRef:'synthetic-project:'+row.key,
    projectLabel:row.key==='worker-1'?'Connexion des sources':'Guide de prise en main',displayName:'Vérifier la synchronisation et documenter les accès',messageCount:2}:row);
  assert.equal(h.viewEngine.ingestCanonical('sessions.snapshot',sessions).ok,true);
  h.api.topics.invalidate();
  const office=await h.get('/api/v3/views/office');assert.equal(office.status,200,office.text);
  const expectedOfficeLooks=ids.map(id=>office.json.data.occupants.find(row=>row.memberId===id)?.look);
  assert.ok(expectedOfficeLooks.every(Boolean),'every canonical member joins its Office appearance by stable member ID');
  const primaryLook=office.json.data.occupants.find(row=>row.role==='primary')?.look;
  const board=await h.get('/api/v3/views/projects');assert.equal(board.status,200,board.text);
  const card=board.json.data.columns.flatMap(column=>column.cards).find(row=>row.teamProject?.teamId===teamId);
  assert.ok(card,'mounted canonical team project');
  const detail=await h.get('/api/v3/views/projects/'+encodeURIComponent(card.id));assert.equal(detail.status,200,detail.text);
  const detailV2=await h.get('/api/v2/views/projects/'+encodeURIComponent(card.id));assert.equal(detailV2.status,200,detailV2.text);
  const projectLooks=detail.json.data.teamProject.roster.members.map(member=>member.portrait.look);
  if(exactLooks&&!twoTeams)assert.deepEqual(projectLooks,expectedOfficeLooks,'team portraits resolve through stable canonical Office member IDs');
  else for(const [label,memberLooks] of [['Office',expectedOfficeLooks],['Projects',projectLooks]]){
    const keys=memberLooks.map(look=>JSON.stringify(look));
    assert.equal(new Set(keys).size,memberLooks.length,`${label} gives each projected team member a distinct portrait`);
    assert.ok(memberLooks.every(look=>JSON.stringify(look)!==JSON.stringify(primaryLook)),`${label} team member portraits exclude the primary look`);
  }
  return {...h,source,setSnapshot(next){snapshot=next;for(const listener of listeners)listener();},projectId:card.id,memberIds:ids,
    sourceRoleLabelsByMember:Object.fromEntries(sourceMembers.map(member=>[member.id,member.roleLabel])),
    expectedLooks:expectedOfficeLooks,expectedLooksByVersion:{2:detailV2.json.data.teamProject.roster.members.map(member=>member.portrait.look),3:expectedOfficeLooks},
    board:board.json.data,detail:detail.json.data,detailV2:detailV2.json.data,
    async close(){
      // Stop the source before closing its topic consumers and database. The
      // controller's final connection event can otherwise schedule a rebuild
      // after settingsFixture has already closed the topic registry.
      h.controller.close();
      await h.close();
      await fs.rm(sourceRoot,{recursive:true,force:true});
    },
    renameTask(id,title){snapshot={...snapshot,revision:snapshot.revision+1,tasks:snapshot.tasks.map(row=>row.id===id?{...row,title,updatedAt:Date.now()}:row)};for(const listener of listeners)listener();}};
  } catch(error) {h.controller.close();await h.close();await fs.rm(sourceRoot,{recursive:true,force:true});throw error;}
}
module.exports={projectTeamFixture};
