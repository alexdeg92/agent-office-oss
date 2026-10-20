// Synthetic v3 Chat examples only. No provider or runtime business logic.
import agentsExample from './examples/v3/chat-agents-vm.json' with {type:'json'};
import sessionsExample from './examples/v3/chat-agent-sessions-vm.json' with {type:'json'};
import sessionExample from './examples/v3/chat-session-vm.json' with {type:'json'};
import { PROPOSED_AGENT } from './meta.js';
import {assetUrl} from '../config.js';
export function createChatV3Mock({scenario,onChange,full=false,failTurns=false,readonly=false,slow=false}){
 const index=structuredClone(agentsExample.data),list=structuredClone(sessionsExample.data),session=structuredClone(sessionExample.data),sessions=new Map([[list.agentId,list]]),threads=new Map([[session.id,session]]);
 if(scenario==='capture-t0189-empty'){list.sessions=[];list.defaultSessionId=null;}
 if(scenario==='vide'){index.agents=[];}
 if(scenario==='capture-t0185'){
  const primary=index.agents.find(row=>row.kind==='agent'),team=index.agents.find(row=>row.kind==='team');
  const sentMessage=session.messages.find(row=>row.role==='user');
  primary.name='Atlas';primary.context='Assistant principal';primary.provider={id:'runtime-openclaw',label:{key:'chat.provider.named',params:{name:'OpenClaw'}},mark:{monogram:'OC',color:'#315c76',providerName:'OpenClaw'}};primary.portrait={look:null,avatarUrl:PROPOSED_AGENT.avatarUrl?new URL(PROPOSED_AGENT.avatarUrl,globalThis.location?.origin||'http://localhost').href:null,alt:'Atlas'};
  if(sentMessage){sentMessage.status='sent';sentMessage.statusLabel={key:'chat.pane.messageSent',params:{name:primary.name}};}
  let portraitIndex=0;
  const makeMember=(id,name,provider,state='chat.agent.idle',readOnly=false)=>{
   const row=structuredClone(primary);row.id='ca_'+id.padEnd(32,'0').slice(0,32);row.name=name;row.context='Équipe du PM';row.parentId=primary.id;row.teamId=team.teamId;
   row.provider={id:'runtime-'+provider.toLowerCase().replace(/[^a-z0-9]+/g,'-'),label:{key:'chat.provider.named',params:{name:provider}},mark:{monogram:provider.slice(0,2).toUpperCase(),color:'#526477',providerName:provider}};
   const looks=[['subagent','teal'],['subagent','ochre'],['subagent','sage']];
   const look=looks[portraitIndex++%looks.length];
   row.portrait={look:{character:look[0],variant:look[1],accessories:[]},avatarUrl:null,alt:name};row.stateLabel={key:state};row.defaultSessionId='cs_'+id.padEnd(32,'0').slice(0,32);row.unread={count:0,label:{key:'chat.unread.none'}};
   if(readOnly){row.capabilities={...row.capabilities,startSession:false,sendMessage:false,storyboard:{available:false,reason:{key:'chat.storyboard.unavailable'}},retry:false,attachments:{allowed:false,maxBytes:0,maxCountPerMessage:0,maxCountPerSession:0,mimeTypes:[],reason:{key:'chat.attachments.unsupported'}}};}
   return row;
  };
  team.name='Équipe du PM';team.contextLabel={key:'chat.target.team'};team.teamId=primary.teamId;team.defaultSessionId='cs_TeamSynthetic0000000000000000000';
  index.agents=[primary,makeMember('PmSynthetic','PM','Claude Code','chat.agent.available'),makeMember('BackendSynthetic','backend-codex','Codex','chat.agent.idle'),makeMember('MobileSynthetic','mobile-ux','Cursor','chat.agent.available'),makeMember('CriticSynthetic','critic','Codex','chat.agent.available',true),makeMember('SecuritySynthetic','security-claude','Claude Code','chat.agent.idle'),team];
 }
 const previewFor=file=>{
  const image=file.type?.startsWith('image/'),pdf=file.type==='application/pdf';
  if(image)return {kind:'image',thumbnailUrl:assetUrl('mock/attachment-previews/atelier-image.svg'),openUrl:assetUrl('mock/attachment-previews/atelier-image.svg'),icon:'image',label:null,alt:'Aperçu illustré d’un atelier'};
  if(pdf)return {kind:'pdf',thumbnailUrl:assetUrl('mock/attachment-previews/report-page.svg'),openUrl:assetUrl('mock/attachment-previews/report-page.svg'),icon:'file-text',label:null,alt:null};
  return {kind:'file',thumbnailUrl:null,openUrl:null,icon:'file',label:null,alt:null};
 };
 if(scenario==='capture-t0223'){
  const vm=threads.get(session.id),user=vm?.messages.find(row=>row.role==='user'),assistant=vm?.messages.find(row=>row.role==='assistant');
  if(user){user.body={text:'Voici la photo et le compte rendu de l’atelier.',blocks:[{type:'text',text:'Voici la photo et le compte rendu de l’atelier.'}]};user.text=user.body.text;user.attachments=[];}
  if(assistant){assistant.body={text:'J’ai parcouru les deux documents. Voici les prochaines étapes.',blocks:[{type:'text',text:'J’ai parcouru les deux documents. Voici les prochaines étapes.'}]};assistant.text=assistant.body.text;assistant.attachments=[];}
 }
 if(full){const template=structuredClone(session.messages[0]);session.messages=Array.from({length:50},(_,n)=>({...structuredClone(template),id:'msg_'+String(n).padStart(32,'0'),text:'Message de vérification du défilement. '.repeat(5),body:{text:'Message de vérification du défilement. '.repeat(5),blocks:[{type:'text',text:'Message de vérification du défilement. '.repeat(5)}]}}));}
 if(readonly||scenario==='panne')for(const caps of [...index.agents.map(row=>row.capabilities),list.capabilities,session.capabilities]){caps.startSession=false;caps.sendMessage=false;caps.retry=false;caps.attachments.allowed=false;caps.attachments.reason={key:'chat.attachments.unsupported'};}

 const files=new Map();
 const clone=value=>structuredClone(value),opaque=kind=>kind+'_'+crypto.randomUUID().replaceAll('-','');
 for(const agent of index.agents){
  if(!sessions.has(agent.id)){const value={...structuredClone(list),agentId:agent.id,defaultSessionId:agent.defaultSessionId,capabilities:structuredClone(agent.capabilities),sessions:[]};if(agent.defaultSessionId)value.sessions=[{...structuredClone(list.sessions[0]),id:agent.defaultSessionId,title:agent.name,preview:null,unread:structuredClone(agent.unread)}];sessions.set(agent.id,value);}
  for(const row of sessions.get(agent.id).sessions)if(!threads.has(row.id))threads.set(row.id,{...structuredClone(session),id:row.id,agentId:agent.id,title:row.title,messages:[],capabilities:structuredClone(agent.capabilities)});
 }
 const archivedId=opaque('cs'),archivedRows=sessions.get(list.agentId);if(archivedRows){const source=archivedRows.sessions[0];archivedRows.sessions.push({...clone(source),id:archivedId,title:'Conversation archivée',preview:'Un ancien échange',updatedAt:Date.now()-86400000,archived:true,stateLabel:{key:'chat.session.archived'},actions:{rename:true,archive:false,restore:true,delete:true}});threads.set(archivedId,{...clone(session),id:archivedId,agentId:list.agentId,title:'Conversation archivée',messages:[],capabilities:clone(archivedRows.capabilities)});}
 if(scenario==='capture-t0189'&&archivedRows){const source=archivedRows.sessions[0];for(let n=1;n<=12;n++){const id='cs_'+String(n).padStart(32,'0'),title=`Conversation de test ${String(n).padStart(2,'0')}`;archivedRows.sessions.push({...clone(source),id,title,preview:'Échange de démonstration',updatedAt:Date.now()-n*60000,archived:false,actions:{rename:true,archive:true,restore:false,delete:true}});threads.set(id,{...clone(session),id,agentId:list.agentId,title,messages:clone(session.messages),capabilities:clone(archivedRows.capabilities)});}}
 const changed=()=>setTimeout(()=>onChange(),0);
 function filtered(id,filter='active'){const value=sessions.get(id);if(!value)return undefined;const archivedCount=value.sessions.filter(row=>!row.deleted&&row.archived).length,rows=value.sessions.filter(row=>!row.deleted&&(filter==='archived'?row.archived:!row.archived)).map(({deleted,deletedAt,...row})=>row);return {...clone(value),filter,labels:{...(clone(value.labels||list.labels)),archivedCount:{key:archivedCount?'chat.sessions.archivedCount':'chat.sessions.noArchived',params:{count:archivedCount}},empty:{key:filter==='archived'?'chat.sessions.emptyArchived':'chat.sessions.emptyActive'}},archivedCount,sessions:clone(rows),defaultSessionId:filter==='active'?(rows[0]?.id||null):null};}
 function build(topic){if(topic==='chat-agents')return clone(index);if(topic.startsWith('chat-agent-sessions-archived:'))return filtered(topic.slice('chat-agent-sessions-archived:'.length),'archived');if(topic.startsWith('chat-agent-sessions:')){const id=topic.slice(20);return filtered(id);}if(topic.startsWith('chat-session:'))return clone(threads.get(topic.slice(13)));}
 async function handle(method,path,body){
  const url=new URL(path,'http://mock'),p=url.pathname;
  const missing=()=>({status:404,body:{error:{code:'not_found',message:'Discussion introuvable.',requestId:'mock_chat'}}});
  const ok=(data,topic,status=200)=>({status,body:{data,meta:{modelVersion:1,generatedAt:Date.now(),stale:[],...(topic?{topic:{id:topic,rev:1}}:{})}}});
  if(method==='GET'&&p==='/api/v3/chat/agents')return ok(clone(index),'chat-agents');
  const target=/^\/api\/v3\/chat\/agents\/([^/]+)\/sessions$/.exec(p);
  if(target){const agent=index.agents.find(row=>row.id===target[1]);if(!agent)return missing();
   if(!sessions.has(agent.id))sessions.set(agent.id,{revision:1,agentId:agent.id,sessions:[],defaultSessionId:null,capabilities:clone(agent.capabilities)});
   const rows=sessions.get(agent.id);
   if(method==='GET')return ok(filtered(agent.id,url.searchParams.get('filter')||'active'),'chat-agent-sessions:'+agent.id);
   if(method==='POST'&&agent.capabilities.startSession){const id=opaque('cs'),value={...clone(session),id,agentId:agent.id,title:'Nouvelle discussion',messages:[],turnPending:null,pagination:{hasOlder:false,olderCursor:null},capabilities:clone(agent.capabilities)};threads.set(id,value);rows.sessions.unshift({id,title:value.title,preview:null,updatedAt:Date.now(),unread:{count:0,label:{key:'chat.unread.none'}},stateLabel:{key:'chat.session.idle'},turnPending:false,archived:false,actions:{rename:true,archive:true,restore:false,delete:true},runtimeTranscriptDeleteLabel:{key:'chat.session.runtimeTranscriptRetained'}});rows.defaultSessionId=id;agent.defaultSessionId=id;changed();return ok({ok:true,result:{sessionId:id},revision:null,vm:null},null,201);}
   return missing();
  }
  const fileRoute=/^\/api\/v3\/chat\/sessions\/([^/]+)\/attachments(?:\/([^/]+))?$/.exec(p);
  if(fileRoute){const vm=threads.get(fileRoute[1]);if(!vm)return missing();
   if(method==='POST'&&!fileRoute[2]&&vm.capabilities.attachments.allowed){const file=body.get('file'),attachmentId=opaque('att'),result={attachmentId,name:file.name,mimeType:file.type,size:file.size,preview:previewFor(file),url:'/api/v3/chat/attachments/'+encodeURIComponent(attachmentId)};files.set(attachmentId,result);return ok({ok:true,result,revision:null,vm:null},null,201);}
   if(method==='DELETE'&&fileRoute[2]&&files.has(fileRoute[2])){files.delete(fileRoute[2]);return ok({ok:true,result:{removed:true},revision:null,vm:null});}
   return missing();
  }
  const lifecycle=/^\/api\/v3\/chat\/sessions\/([^/]+)(?:\/(title|archive|undo-delete))?$/.exec(p);
  if(lifecycle&&(lifecycle[2]||method!=='GET')){const id=lifecycle[1],action=lifecycle[2],vm=threads.get(id),row=[...sessions.values()].flatMap(value=>value.sessions).find(item=>item.id===id);if(!vm||!row)return missing();
   if(method==='PATCH'&&action==='title'&&typeof body?.title==='string'&&body.title.trim()&&body.title.length<=120){row.title=body.title.trim();vm.title=row.title;row.updatedAt=Date.now();changed();return ok({ok:true,result:{sessionId:id,title:row.title},revision:null,vm:null});}
   if(method==='POST'&&action==='archive'&&typeof body?.archived==='boolean'){row.archived=body.archived;row.stateLabel={key:body.archived?'chat.session.archived':'chat.session.idle'};row.actions={rename:true,archive:!body.archived,restore:body.archived,delete:true};changed();return ok({ok:true,result:{sessionId:id,archived:row.archived},revision:null,vm:null});}
   if(method==='DELETE'&&!action){row.deleted=true;row.deletedAt=Date.now();changed();return ok({ok:true,result:{sessionId:id,deletedAt:row.deletedAt,undoUntil:row.deletedAt+30000,deletedLabel:{key:'chat.session.deletedUndoable'},runtimeTranscriptDeleted:false,runtimeTranscriptLabel:{key:'chat.session.runtimeTranscriptRetained'}},revision:null,vm:null});}
   if(method==='POST'&&action==='undo-delete'){row.deleted=false;changed();return ok({ok:true,result:{sessionId:id,restored:true},revision:null,vm:null});}
   return missing();
  }
  const thread=/^\/api\/v3\/chat\/sessions\/([^/]+)(?:\/(messages|read|retry))?$/.exec(p);
  if(thread){const vm=threads.get(thread[1]);if(!vm)return missing();const topic='chat-session:'+vm.id;
   if(method==='GET'&&!thread[2])return ok(clone(vm),topic);
   if(method==='POST'&&thread[2]==='read')return ok({ok:true,result:{revision:1,unread:{count:0,label:{key:'chat.unread.none'}}},revision:null,vm:null});
   if(method==='POST'&&thread[2]==='messages'&&vm.capabilities.sendMessage){const turnId=opaque('turn'),attachments=(body.attachmentIds||[]).map(attachmentId=>files.get(attachmentId)).filter(Boolean).map(file=>({id:file.attachmentId,name:file.name,mimeType:file.mimeType,size:file.size,url:file.url,preview:file.preview}));vm.messages.push({...clone(session.messages[0]),id:opaque('msg'),at:Date.now(),text:body.text,body:{text:body.text,blocks:[{type:'text',text:body.text}]},attachments});vm.messages=vm.messages.slice(-50);vm.turnPending={turnId,since:Date.now()};changed();setTimeout(()=>{vm.messages.push({...clone(sessionExample.data.messages[1]),id:opaque('msg'),at:Date.now(),role:failTurns?'error':'assistant',text:failTurns?'La réponse n’a pas pu être reçue.':'La vérification est terminée.',body:{text:failTurns?'La réponse n’a pas pu être reçue.':'La vérification est terminée.',blocks:[]},attachments:[]});vm.messages=vm.messages.slice(-50);vm.turnPending=null;changed();},slow?3000:900);return ok({ok:true,result:{turnId},revision:null,vm:null},null,202);}
  }
  return missing();
 }
 return {build,handle};
}
