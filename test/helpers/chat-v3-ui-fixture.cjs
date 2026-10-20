'use strict';
require('./scratch-home.cjs').refuseEntry(__filename);
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {projectTeamFixture}=require('./project-team-fixture.cjs');
const key=()=>crypto.randomUUID(),id=prefix=>prefix+'_'+crypto.randomBytes(24).toString('base64url');
async function chatV3UiFixture({publicUrl,historyCount=58,resultText,targetInventory=null,attachmentCapture=false,writableCapture=false,paneQueueCapture=false,expectedTargetCount=7}={}){
 const h=await projectTeamFixture({publicUrl}),calls=[];let gate=null,release=null,failNext=false;
 try{
  const commands={agentTurn:async args=>{calls.push(args);if(gate)await gate;if(failNext){failNext=false;return {failed:'synthetic'};}return {text:'La vérification est terminée. Les éléments demandés sont prêts.'};}};
  const baseCaps={chat:true,chatSessionScope:'principal',chatRetry:true,...(writableCapture?{conversations:{read:true,send:true,attachments:true}}:{}),chatAttachments:{enabled:true,maxBytes:1024*1024,maxCountPerMessage:3,maxCountPerSession:10,mimeTypes:['application/pdf','text/plain','image/png','image/jpeg']}};
  const adapters=['claude-code','codex','openclaw'];
  const runtimes=adapters.map(adapter=>({adapterId:adapter,name:require('../../src/adapters/'+adapter).definition.name,connected:true,gatewayLabel:'Passerelle synthétique',capabilities:{...baseCaps},commands,...(writableCapture?{conversations:{async send(){return {accepted:true};},async history(){return {messages:[]};},async subscribe(){return ()=>{};}}}:{})}));
  const catalog=targetInventory?.agents||h.viewEngine.agents();
  const runtimeForId=agentId=>{const runtimeId=require('../../src/runtime-ids').parseId(agentId,'agent')?.runtime;return targetInventory?.runtimes?.[runtimeId]||null;};
  const customRuntimes=targetInventory?Object.values(targetInventory.runtimes).map(row=>({...row,commands})):null;
  const availableRuntimes=customRuntimes?.length?customRuntimes:runtimes;
  const byAgent=new Map(catalog.map((row,n)=>[row.id,runtimeForId(row.id)||runtimes[n%3]]));
  h.viewEngine.agents=()=>catalog;
  if(targetInventory){h.viewEngine.sessions=()=>targetInventory.sessions;h.viewEngine.primaryAgent=()=>targetInventory.primary;h.viewEngine.runtime=()=>runtimeForId(targetInventory.primary.id)||availableRuntimes[0];}
  h.viewEngine.runtimeFor=agent=>byAgent.get(agent)||availableRuntimes[0];
  const connectors=targetInventory?.connectors||Object.fromEntries(availableRuntimes.map(rt=>{const definition=require('../../src/adapters/'+rt.adapterId).definition;return [rt.adapterId,{id:'fixture-'+rt.adapterId,adapter:rt.adapterId,name:definition.name,mark:definition.mark}];}));
  h.viewEngine.connectorById=id=>connectors[id]||null;
  h.viewEngine.connectorOf=key=>{const native=targetInventory?.sessions?.find(row=>row.key===key),rt=native?runtimeForId(native.class?.agentId):byAgent.get(key);return rt?connectors[rt.adapterId]||null:connectors.openclaw||null;};
  const source=h.source||h.orchestratorTeams,oldSnapshot=source.getSnapshot;
  if(targetInventory?.orchestratorTeams)source.getSnapshot=()=>targetInventory.orchestratorTeams.getSnapshot();
  else source.getSnapshot=()=>{const snapshot=oldSnapshot();return {...snapshot,privateMemberSessionRefs:Object.fromEntries(snapshot.members.map((member,index)=>[
   member.id,{agentId:catalog[index]?.id||catalog[0].id,sessionKey:index===0?'main':`worker-${index}`}
  ]))};};
  const paneCalls=[];let paneEvents=[];
  if(paneQueueCapture){
   const selectedAgent=catalog.find(row=>!row.isPrimary)||catalog[0],sessionKey='capture:synthetic-pane-session',sessionRef='capture:synthetic-pane-ref';
   const oldSessions=h.viewEngine.sessions.bind(h.viewEngine),oldTranscript=h.viewEngine.transcript?.bind(h.viewEngine),oldRequest=h.viewEngine.request?.bind(h.viewEngine);
   h.viewEngine.sessions=()=>[...oldSessions(),{key:sessionKey,class:{agentId:selectedAgent.id,explicitKey:sessionRef},updatedAt:Date.now(),title:'Discussion de l’agent occupé'}];
   paneEvents=[{id:'capture-before-user',kind:'user',at:Date.now()-1200,text:'Peux-tu vérifier la dernière version ?'},{id:'capture-before-assistant',kind:'assistant',at:Date.now()-700,text:'Je termine une vérification en cours.'}];
   h.viewEngine.transcript=key=>key===sessionKey?{events:paneEvents}:oldTranscript?.(key)||null;
   h.viewEngine.request=async(op,key,...args)=>op==='transcript'&&key===sessionKey?{ok:true,value:{events:paneEvents}}:oldRequest?oldRequest(op,key,...args):{ok:false};
   const paneSnapshot={revision:4,observedAt:Date.now(),team:null,members:[{id:'member:capture-pane',name:'Atlas',roleKind:'member',roleLabel:'Agent',teamId:'team:capture-pane',parentMemberId:'member:capture-lead',hostAgentId:'host:capture-pane',sessionStatus:'known'}],
    agents:[{id:'host:capture-pane',status:'working',staleAfter:Date.now()+60000}],privateMemberSessionRefs:{'member:capture-pane':{agentId:selectedAgent.id,sessionKey,sessionRef,runtimeKind:byAgent.get(selectedAgent.id)?.adapterId||'generic'}}};
   h.setSnapshot(paneSnapshot);source.getSnapshot=()=>paneSnapshot;source.chatPaneMessaging={sendText:true,exactPaneIdentity:true,readTranscript:true};
   source.refresh=async()=>paneSnapshot;source.sendPaneText=async args=>{paneCalls.push(args);paneEvents=[...paneEvents,{id:'capture-after-'+paneCalls.length,kind:'assistant',at:Date.now(),text:'La vérification est terminée. Tout est prêt.'}];return {sent:true};};
  }
  h.api.topics.invalidate();
  const index=await h.get('/api/v3/chat/agents');assert.equal(index.status,200,index.text);
  if(!attachmentCapture&&!paneQueueCapture)assert.equal(index.json.data.agents.length,targetInventory?.expectedTargetCount||expectedTargetCount);
  else assert.ok(index.json.data.agents.length>0,'attachment capture fixture requires at least one chat target');
  const target=(paneQueueCapture?index.json.data.agents.find(row=>row.teamId==='team:capture-pane'):null)||index.json.data.agents.find(row=>row.kind==='agent')||(attachmentCapture?index.json.data.agents[0]:null);
  assert.ok(target?.id,'capture fixture requires an addressable chat target');
  if(paneQueueCapture)assert.equal(target.capabilities.sendMessage,true,'pane capture target must be sendable through the backend queue: '+JSON.stringify({kind:target.kind,teamId:target.teamId,stateLabel:target.stateLabel,capabilities:target.capabilities}));
  const createSession=async()=>{
   if(attachmentCapture){
    const owner=require('../../src/api/chat-identity').scopeForAccount(h.store.users.owner()?.id,h.store),sessionId=id('cs');
    const agent=catalog.find(row=>row.id===target.canonicalAgentId)||catalog.find(row=>row.isPrimary)||catalog[0],parsed=require('../../src/runtime-ids').parseId(agent.id,'agent');
    const sourceRef=target.kind==='team'?'team:'+target.teamId:'agent:'+agent.id;
    const saved=h.store.chatV3.target(owner,target.id)||h.store.chatV3.createTarget({id:target.id,principalScope:owner,kind:target.kind,sourceRef,
     runtimeId:parsed?.runtime||'openclaw',nativeAgentId:parsed?.local||agent.id});
    h.store.chatV3.createSession({sessionId,principalScope:owner,agentId:target.id,runtimeId:saved.runtime_id,nativeAgentId:saved.native_agent_id,nativeSessionRef:`capture:${owner}:${sessionId}`,title:null});
    return sessionId;
   }
   const response=await h.request('POST',`/api/v3/chat/agents/${target.id}/sessions`,{}, {'Idempotency-Key':key()});assert.equal(response.status,201,response.text);
   return response.json.data.result.sessionId;
  };
  const sessionId=await createSession();
  // Seed realistic server-projected titles for the visual fixture. The UI
  // renders these values; title generation itself is covered by the mounted
  // v3 API test for the first accepted user message.
  const sessionTitle='Vérifier la synchronisation et documenter les accès';
  h.store.db.prepare('UPDATE chat_v3_sessions SET title=? WHERE session_id=?').run(sessionTitle,sessionId);
  for(let n=0;n<historyCount;n++){
   const text=n===historyCount-1?'Voici les résultats de l’équipe.':n%2?'Le parcours est vérifié, les actions restent accessibles sur téléphone.':'Peux-tu vérifier le parcours et ses actions ?';
   const body=n===historyCount-1?{text,blocks:[{type:'text',text},{type:'table',headers:['Contrôle','Résultat'],rows:[['Accueil','Accessible sur téléphone et ordinateur'],['Confirmation','Le brouillon reste conservé']]},{type:'team-result',teamId:index.json.data.agents.find(row=>row.kind==='team').id,label:'Équipe Produit',summary:'Deux vérifications terminées',members:index.json.data.agents.filter(row=>row.kind==='agent').slice(1,3).map(row=>({id:row.id,name:row.name,stateLabel:row.stateLabel,portrait:row.portrait}))}]}:{text,blocks:[{type:'text',text}]};
   h.store.chatV3.addMessage(sessionId,{id:id('msg'),role:n%2?'assistant':'user',at:Date.now()-60000+n*100,body,attachments:[]},{unread:n%2===1});
  }
  h.store.chatV3.addMessage(sessionId,{id:id('msg'),role:'assistant',kind:'subagent-result',at:Date.now()-2000,title:'Vérifier la confirmation mobile',status:'completed',statusLabel:{key:'chat.result.status.completed'},meta:{senderInfo:{kind:'agent',id:'agent:'+catalog[1].id,name:catalog[1].name,runtime:byAgent.get(catalog[1].id).adapterId,channel:null,avatarHint:null}},body:{text:resultText||'**Vérifications terminées**\n\n| Contrôle | Résultat détaillé |\n| --- | --- |\n| Confirmation | Le brouillon est conservé lors du retour à la liste |',blocks:[]},attachments:[]},{unread:true});
  if(attachmentCapture){
   const scope=require('../../src/api/chat-identity').scopeForAccount(h.store.users.owner()?.id,h.store),dataDir=h.env.AO_DATA_DIR;
   const {privateDirectory}=require('../../src/api/v3/chat-upload'),root=privateDirectory(dataDir);
   const samples=[
    {name:'aperçu-projet-clair.png',mimeType:'image/png',content:fs.readFileSync(path.join(__dirname,'../../test/golden/bureau-gallery/synthetic-ui/actions-1440-light.png'))},
    {name:'aperçu-projet-sombre.png',mimeType:'image/png',content:fs.readFileSync(path.join(__dirname,'../../test/golden/bureau-gallery/synthetic-ui/forms-1440-dark.png'))},
    {name:'compte-rendu.pdf',mimeType:'application/pdf',content:Buffer.from('%PDF-1.7\nSynthetic mounted-backend PDF preview fallback')},
   ];
   const attachments=samples.map(sample=>{
    const storageName=crypto.randomBytes(32).toString('hex'),attachmentId=id('att');
    fs.writeFileSync(path.join(root,storageName),sample.content,{mode:0o600,flag:'wx'});
    h.store.chatV3.attachment({attachmentId,principalScope:scope,sessionId,name:sample.name,mimeType:sample.mimeType,size:sample.content.length,
     sha256:crypto.createHash('sha256').update(sample.content).digest('hex'),storageName});
    return {id:attachmentId,name:sample.name,mimeType:sample.mimeType,size:sample.content.length};
   });
   const legacyImage=Buffer.concat([samples[0].content,Buffer.alloc(2300*1024-samples[0].content.length)]),legacyName='monkey_desktop_test.png',legacyStorage=crypto.randomBytes(32).toString('hex'),legacyId=id('att');
   fs.writeFileSync(path.join(root,legacyStorage),legacyImage,{mode:0o600,flag:'wx'});
   h.store.chatV3.attachment({attachmentId:legacyId,principalScope:scope,sessionId,name:legacyName,mimeType:'image/png',size:legacyImage.length,
    sha256:crypto.createHash('sha256').update(legacyImage).digest('hex'),storageName:legacyStorage});
   const legacyAttachment={id:legacyId,name:legacyName,mimeType:'image/png',size:legacyImage.length};
   assert.ok(h.store.chatV3.bindAttachments(scope,sessionId,[legacyId]));
   h.store.chatV3.addMessage(sessionId,{id:id('msg'),role:'user',at:Date.now()-1000,body:{text:'',blocks:[]},attachments:[legacyAttachment]});
   h.store.chatV3.finishAttachments([legacyId]);
   assert.ok(h.store.chatV3.bindAttachments(scope,sessionId,attachments.map(item=>item.id)));
   h.store.chatV3.addMessage(sessionId,{id:id('msg'),role:'user',at:Date.now(),body:{text:'Voici les éléments à consulter.',blocks:[{type:'text',text:'Voici les éléments à consulter.'}]},attachments});
   h.store.chatV3.finishAttachments(attachments.map(item=>item.id));h.api.topics.invalidate();
  }
  const defaultSessionId=sessionId;
  h.store.chatV3.addMessage(defaultSessionId,{id:id('msg'),role:'assistant',at:Date.now(),body:{text:'La note de version est prête à être relue.',blocks:[{type:'text',text:'La note de version est prête à être relue.'}]},attachments:[]},{unread:true});
  h.api.topics.invalidate();
  return {...h,targets:index.json.data.agents,targetId:target.id,targetName:target.name,sessionId,sessionTitle,defaultSessionId,calls,paneCalls,runtimes:availableRuntimes,holdReply(){gate=new Promise(resolve=>release=resolve);},releaseReply(){release?.();release=null;gate=null;},failNextReply(){failNext=true;},
   async close(){release?.();h.controller.close();await h.close();}};
 }catch(error){h.controller.close();await h.close();throw error;}
}
module.exports={chatV3UiFixture};
