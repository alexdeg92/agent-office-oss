// T-0173: backend-owned agent/session structure, three responsive presentation panes.
import {html,useEffect,useLayoutEffect,useRef,useState,createStore} from '../lib.js';
import {useStore} from '../hooks.js';
import {msg,label} from '../i18n.js';
import {services} from '../services.js';
import {buildQuery} from '../config.js';
import {chunkError} from '../build-update.js';
import {Button,Menu,loadStyles as loadBureauStyles} from '../components/bureau/index.js';
import {ConfirmDialog} from '../components/bureau/confirm-dialog.js';
import {toast} from '../toast.js';
import {Frame,Icon,ErrorState,EmptyState,Skeleton,Ago} from '../components/ui.js';
import {useSmallWorkspace,loadStyles as loadWorkspaceStyles} from './workspace-mobile.js';
import {ConnectorBrandMark} from './connector-brand.js';
import {ChatPortrait} from './chat-content.js';
import {ChatConversation} from './chat-conversation.js';
import {useChatConnection,useChatTopic} from './chat-live.js';
import {chatCommand,chatPath,agentPath,commandKey} from './chat-api.js';
import './chat-messages.js';
let styles;
export function loadStyles(){
 styles||=new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./chat.css'+buildQuery,import.meta.url).href;link.onload=resolve;link.onerror=()=>{link.remove();styles=null;reject(chunkError(Error('Chat stylesheet unavailable')));};document.head.append(link);});
 return Promise.all([styles,loadBureauStyles(),loadWorkspaceStyles()]);
}
const waiting=createStore({conn:'connecting',topicsOk:false});
function Placeholder({title,text}){return html`<div class="ao-messenger__placeholder bu-empty"><${Icon} name="discuter" /><p class="bu-empty__title">${title}</p>${text?html`<p class="bu-empty__text">${text}</p>`:null}</div>`;}
function Loading(){return html`<div class="ao-messenger__loading" role="status" aria-label=${msg('editorial.loading')}><${Skeleton} /><${Skeleton} w="70" /><${Skeleton} w="50" /></div>`;}
export function ChatPage({match}){
 const connection=useChatConnection();
 return html`<${Frame} class="bu-page ao-page ao-page--wide ao-messenger ao-chat" bodyClass="ao-frame__body--framed">
 ${connection.error?html`<${ErrorState} error=${connection.error} onRetry=${connection.retry} />`:connection.client?html`<${ChatWorkspace} key=${connection.epoch} client=${connection.client} match=${match} />`:html`<${Loading} />`}
 </${Frame}>`;
}
function ChatWorkspace({client,match}){
 const small=useSmallWorkspace(),status=useStore(client?.status||waiting),index=useChatTopic(client,'chat-agents','/api/v3/chat/agents');
 const selected={agentId:match.query.cible||null,sessionId:match.query.discussion||null};
 const screen=['agents','sessions','conversation'].includes(match.query.vue)?match.query.vue:'agents';
 const setScreen=vue=>services.router.setQuery({vue},{replace:false});
 const [creating,setCreating]=useState(false),[createError,setCreateError]=useState(null);
 const createIntent=useRef(null),currentAgent=useRef(null),drafts=useRef(new Map()),pane=useRef(null),live=useRef(true);
 useEffect(()=>()=>{live.current=false;drafts.current.clear();},[]);
 const denied=[401,403,404].includes(index.error?.status),agents=denied?null:index.data?.agents;
 const agent=agents?.find(row=>row.id===selected.agentId)||null;
 currentAgent.current=agent?.id;
 const sessionTopic=agent?'chat-agent-sessions:'+agent.id:null;
 const sessions=useChatTopic(client,sessionTopic,agent?agentPath(agent.id):null);
 const sessionDenied=[401,403,404].includes(sessions.error?.status),list=!sessionDenied&&sessions.data?.agentId===agent?.id?sessions.data:null;
 const sessionId=selected.sessionId||list?.defaultSessionId||null;
 const [renameId,setRenameId]=useState(null),[renameValue,setRenameValue]=useState(''),[rowError,setRowError]=useState(null),[rowBusy,setRowBusy]=useState(false),[deleteRow,setDeleteRow]=useState(null),[deleteError,setDeleteError]=useState(null),[swipeCue,setSwipeCue]=useState(null);
 const swipeStart=useRef(null),renameInput=useRef(null),lifecycleKeys=useRef(new Map());
 const online=status.conn==='open'&&status.topicsOk!==false;
 function selectAgent(row){services.router.setQuery({cible:row.id,discussion:null,vue:'sessions',archives:null},{replace:false});setCreateError(null);setCreating(false);createIntent.current=null;setRenameId(null);setDeleteRow(null);}
 function selectSession(id){services.router.setQuery({discussion:id,vue:'conversation'},{replace:false});}
 async function createSession(){
  if(!list?.capabilities.startSession||creating||!online)return;
  const id=agent.id;createIntent.current||={id,key:commandKey()};const intent=createIntent.current;
  setCreating(true);setCreateError(null);
  try{const result=await chatCommand(agentPath(id),{},{key:intent.key});if(!live.current||currentAgent.current!==id)return;createIntent.current=null;client.resync('chat-agent-sessions:'+id);client.resync('chat-agents');selectSession(result.result.sessionId);}
  catch(e){if(live.current&&currentAgent.current===id)setCreateError(e.message);}finally{if(live.current&&currentAgent.current===id)setCreating(false);}
 }
 function refreshSessionLists(){if(sessionTopic)client.resync(sessionTopic);client.resync('chat-agents');}
 function lifecycleKey(action,id,value=''){const key=JSON.stringify([action,id,value]);if(!lifecycleKeys.current.has(key))lifecycleKeys.current.set(key,commandKey());return [key,lifecycleKeys.current.get(key)];}
 function beginRename(row){setRowError(null);setRenameId(row.id);setRenameValue(typeof row.title==='string'?row.title:label(row.title));}
 function cancelRename(){setRenameId(null);setRowError(null);}
 useLayoutEffect(()=>{if(renameId){const input=renameInput.current;if(input){input.focus();input.select();}}},[renameId]);
 async function saveRename(row){if(rowBusy)return;const title=(renameInput.current?.value??renameValue).trim();if(!title||title.length>120){setRowError(msg('messenger.renameError'));return;}setRowBusy(true);setRowError(null);const [intent,key]=lifecycleKey('rename',row.id,title);try{await chatCommand(chatPath(row.id,'/title'),{title},{method:'PATCH',key});lifecycleKeys.current.delete(intent);setRenameId(null);refreshSessionLists();}catch(error){setRowError(error.message||msg('messenger.renameError'));}finally{setRowBusy(false);}}
 async function deleteConversation(){if(!deleteRow||rowBusy)return;const row=deleteRow;setRowBusy(true);setDeleteError(null);const [intent,key]=lifecycleKey('delete',row.id);try{const response=await chatCommand(chatPath(row.id),undefined,{method:'DELETE',key});lifecycleKeys.current.delete(intent);setDeleteRow(null);setSwipeCue(null);if(selected.sessionId===row.id)services.router.setQuery({discussion:null,vue:'sessions'},{replace:false});refreshSessionLists();const undoUntil=response.result?.undoUntil,canUndo=Number.isSafeInteger(undoUntil);toast({level:'success',message:msg('messenger.deletedToast'),duration:canUndo?Math.max(0,undoUntil-Date.now()):4000,className:'ao-chat-undo-toast',actionVariant:'text',action:canUndo?{label:msg('messenger.undoDelete'),run:async()=>{const [undoIntent,undoKey]=lifecycleKey('undo-delete',row.id);try{await chatCommand(chatPath(row.id,'/undo-delete'),undefined,{key:undoKey});lifecycleKeys.current.delete(undoIntent);refreshSessionLists();}catch(error){toast({level:'danger',message:error.message||msg('messenger.undoError')});}}}:null});}catch(error){setDeleteError(error.message||msg('messenger.deleteError'));}finally{setRowBusy(false);}}
 function sessionActions(row){const actions=row.actions||{};return [
  ...(actions.rename?[{id:'rename',label:msg('messenger.rename'),icon:html`<${Icon} name="pencil" />`,onSelect:()=>beginRename(row)}]:[]),
  ...(actions.delete?[{id:'delete',label:msg('messenger.delete'),danger:true,icon:html`<svg class="bu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-.8 13H6.8L6 7m4 4v5m4-5v5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,onSelect:()=>{setDeleteError(null);setDeleteRow(row);}}]:[])
 ];}
 useEffect(()=>{if(small)pane.current?.querySelector('[data-chat-pane]:not([hidden]) h2')?.focus();},[screen,small]);
 return html`<div ref=${pane} class="ao-messenger__workspace" data-chat-screen=${small?screen:'desktop'}>
 <section class="ao-messenger__pane ao-messenger__agents" data-chat-pane="agents" hidden=${small&&screen!=='agents'} aria-label=${msg('messenger.agents')}>
 <header class="ao-messenger__pane-head"><h2 tabindex="-1">${index.data?label(index.data.labels.title):msg('messenger.agents')}</h2></header>
 <div class="ao-messenger__list" data-chat-list="agents">
 ${index.error?html`<${ErrorState} compact error=${index.error} onRetry=${index.retry} />`:null}
 ${!agents?!index.error?html`<${Loading} />`:null:!agents.length?html`<p class="ao-messenger__notice">${label(index.data.labels.empty)}</p>`:html`<ul>${agents.map(row=>{const role=row.context||label(row.contextLabel)||'';const state=label(row.stateLabel);return html`<li key=${row.id}><button type="button" class="ao-messenger__row ao-messenger__agent-row" data-chat-agent=${row.id} data-chat-kind=${row.kind} aria-current=${agent?.id===row.id?'true':undefined} onClick=${()=>selectAgent(row)}><${ChatPortrait} portrait=${row.portrait} /><span class="ao-messenger__row-copy"><span class="ao-messenger__row-primary"><strong>${row.name}</strong>${role?html`<span aria-hidden="true">·</span><span>${role}</span>`:null}</span><span class="ao-messenger__row-secondary">${row.provider?html`<span class="ao-messenger__provider"><${ConnectorBrandMark} brand=${row.provider.mark} /><span>${label(row.provider.label)}</span></span>`:null}<span class="ao-messenger__state-dot" data-state-key=${row.stateLabel?.key||''} role="img" aria-label=${state} title=${state}></span></span></span>${row.unread.count?html`<span class="bu-count" aria-label=${label(row.unread.label)}>${row.unread.count}</span>`:null}</button></li>`})}</ul>`}
 </div></section>
 <section class="ao-messenger__pane ao-messenger__sessions" data-chat-pane="sessions" hidden=${small&&screen!=='sessions'} aria-label=${msg('messenger.sessions')}>
 <header class="ao-messenger__pane-head">${small?html`<${Button} variant="ghost" size="sm" label=${msg('messenger.backAgents')} icon=${html`<${Icon} name="arrow-left" />`} onPress=${()=>setScreen('agents')} />`:null}<h2 tabindex="-1">${agent?.name||msg('messenger.sessions')}</h2></header>
 ${agent&&list?html`<div class="ao-messenger__new"><${Button} label=${msg('messenger.new')} icon=${html`<${Icon} name="add" />`} disabled=${!list.capabilities.startSession||!online} busy=${creating} onPress=${createSession} />${!list.capabilities.startSession?html`<p>${msg('messenger.newUnavailable')}</p>`:null}${createError?html`<p role="alert" class="bu-field__error">${createError}</p>`:null}</div>`:null}
 <div class="ao-messenger__list" data-chat-list="sessions">
 ${!agent?html`<p class="ao-messenger__notice">${msg('messenger.selectAgentForSessions')}</p>`:sessions.error?html`<${ErrorState} compact error=${sessions.error} onRetry=${sessions.retry} />`:!list?html`<${Loading} />`:!list.sessions.length?html`<${EmptyState} icon="discuter" title=${label(list.labels?.empty)||msg('messenger.emptySessions')} />`:html`<ul>${list.sessions.map(row=>html`<li key=${row.id} class=${swipeCue?.id===row.id?'is-swipe-'+swipeCue.direction:''} onTouchStart=${event=>{swipeStart.current={id:row.id,x:event.touches[0].clientX,y:event.touches[0].clientY};}} onTouchEnd=${event=>{const start=swipeStart.current;if(start?.id===row.id){const dx=event.changedTouches[0].clientX-start.x,dy=event.changedTouches[0].clientY-start.y;if(Math.abs(dx)>48&&Math.abs(dx)>Math.abs(dy)){const direction=dx<0?'rename':'delete';setSwipeCue({id:row.id,direction});setTimeout(()=>setSwipeCue(current=>current?.id===row.id?null:current),180);if(direction==='rename')beginRename(row);else{setDeleteError(null);setDeleteRow(row);}}}swipeStart.current=null;}}>
  <div class=${'ao-messenger__session-line'+(sessionId===row.id?' is-current':'')+(renameId===row.id?' is-renaming':'')}><button type="button" class="ao-messenger__row ao-messenger__session-row" data-chat-session=${row.id} aria-current=${sessionId===row.id?'true':undefined} onClick=${()=>selectSession(row.id)}><span class="ao-messenger__row-copy"><strong class=${renameId===row.id?'ao-messenger__title-hidden':''}>${label(row.title)}</strong><span>${row.preview||msg('messenger.noPreview')}</span><small><span>${label(row.stateLabel)}</span>${row.updatedAt?html`<${Ago} at=${row.updatedAt} />`:null}</small></span>${row.unread.count?html`<span class="bu-count" aria-label=${label(row.unread.label)}>${row.unread.count}</span>`:null}</button>${renameId===row.id?html`<form class="ao-messenger__rename" onSubmit=${event=>{event.preventDefault();saveRename(row);}}><input ref=${renameInput} data-chat-rename=${row.id} aria-label=${msg('messenger.renamePlaceholder')} maxlength="120" value=${renameValue} onInput=${event=>setRenameValue(event.currentTarget.value)} onClick=${event=>event.stopPropagation()} onBlur=${event=>{if(!event.currentTarget.form?.contains(event.relatedTarget))cancelRename();}} onKeyDown=${event=>{if(event.key==='Escape'){event.preventDefault();cancelRename();}else if(event.key==='Enter'){event.preventDefault();saveRename(row);}}} />${rowError?html`<small role="alert">${rowError}</small>`:null}</form>`:null}<${Menu} label=${msg('messenger.sessionActions')} class="ao-messenger__row-menu" testId=${'chat-session-menu-'+row.id} items=${sessionActions(row)} /></div>
 </li>`)}</ul>`}
 </div></section>
 <div class="ao-messenger__conversation-slot" hidden=${small&&screen!=='conversation'}>
 ${agent&&sessionId&&!sessionDenied?html`<${ChatConversation} key=${sessionId} client=${client} id=${sessionId} sessionTitle=${list?.sessions.find(row=>row.id===sessionId)?.title} online=${online} small=${small} active=${!small||screen==='conversation'} drafts=${drafts.current} onBack=${()=>setScreen('sessions')} />`:html`<section class="ao-messenger__pane">${small?html`<header class="ao-messenger__pane-head"><${Button} label=${msg('messenger.backAgents')} icon=${html`<${Icon} name="arrow-left" />`} onPress=${()=>setScreen('agents')} /></header>`:null}<${Placeholder} title=${msg(agent?'messenger.chooseSession':'messenger.chooseAgent')} text=${msg(agent?'messenger.chooseSessionText':'messenger.chooseAgentText')} /></section>`}
 </div>
 </div>
 <${ConfirmDialog} open=${!!deleteRow} title=${msg('messenger.deleteTitle')} description=${deleteRow?.runtimeTranscriptDeleteLabel?label(deleteRow.runtimeTranscriptDeleteLabel):undefined} confirmLabel=${msg('messenger.deleteConfirm')} cancelLabel=${msg('common.cancel')} busy=${rowBusy} error=${deleteError} modalClass="ao-messenger__delete-modal" onCancel=${()=>{setDeleteRow(null);setDeleteError(null);}} onConfirm=${deleteConversation} />`;
}
