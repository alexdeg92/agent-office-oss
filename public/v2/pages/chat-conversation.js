import {html,useEffect,useLayoutEffect,useRef,useState} from '../lib.js';
import {useNow} from '../hooks.js';
import {msg,label} from '../i18n.js';
import * as fmt from '../fmt.js';
import {Button,TextArea} from '../components/bureau/index.js';
import {ConfirmDialog} from '../components/bureau/confirm-dialog.js';
import {Icon,ErrorState,Skeleton} from '../components/ui.js';
import {Modal} from '../components/modal.js';
import {chatRead,chatCommand,chatUpload,chatPath,commandKey} from './chat-api.js';
import {useChatTopic} from './chat-live.js';
import {ChatV3Message,ChatAttachmentPreview} from './chat-content.js';

// Drafts belong to this mounted session, never browser storage or another viewer.
export function ChatConversation({client,id,sessionTitle,online,small,active,drafts,onBack}){
 const topic='chat-session:'+id,view=useChatTopic(client,topic,chatPath(id));
 const forbidden=[401,403,404].includes(view.error?.status),vm=forbidden?null:view.data;
 const titleText=label(vm?.title||sessionTitle)||msg('messenger.chooseSession');
 const now=useNow(),thread=useRef(null),draftRef=useRef(drafts.get(id)||''),uploads=useRef(new Map()),localPreviews=useRef(new Set()),alive=useRef(true),first=useRef(true),nearEnd=useRef(true),readId=useRef(null),sendIntent=useRef(null),retryIntent=useRef(null);
 const [draft,setDraft]=useState(drafts.get(id)||''),[files,setFiles]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(null),[announcement,setAnnouncement]=useState(''),[sheet,setSheet]=useState(false),[latest,setLatest]=useState(false);
 const [history,setHistory]=useState([]),[cursor,setCursor]=useState(undefined),[olderBusy,setOlderBusy]=useState(false),[queuedSend,setQueuedSend]=useState(null),[queueBusy,setQueueBusy]=useState(false);
 const input=useRef(null),picker=useRef(null),imagePicker=useRef(null),pendingScroll=useRef(null),previousLast=useRef(null),previousWindow=useRef([]);
 const caps=vm?.capabilities,policy=caps?.attachments;
 const commandErrorText=e=>{const serverLabel=e?.details?.find?.(detail=>detail?.issue==='pane-queue-full')?.label;return label(serverLabel)||e?.message||'';};
 const releasePreview=url=>{if(!url||!localPreviews.current.has(url))return;URL.revokeObjectURL(url);localPreviews.current.delete(url);};
 useEffect(()=>()=>{alive.current=false;for(const controller of uploads.current.values())controller.abort();for(const url of localPreviews.current)URL.revokeObjectURL(url);localPreviews.current.clear();},[]);
 const toEnd=()=>{if(thread.current){thread.current.scrollTop=thread.current.scrollHeight;nearEnd.current=true;setLatest(false);}};
 const refresh=()=>{client.resync(topic);client.resync('chat-agents');client.resync('chat-agent-sessions:'+vm.agentId);};
 const currentIds=new Set((vm?.messages||[]).map(row=>row.id));
 const messages=[...history.filter(row=>!currentIds.has(row.id)),...(vm?.messages||[])];
 const lastMessage=vm?.messages.at(-1),last=lastMessage?.id;
 useLayoutEffect(()=>{
  if(!vm||!active)return;
  if(history.length&&previousWindow.current.length){const known=new Set([...history,...vm.messages].map(row=>row.id));const retained=previousWindow.current.filter(row=>!known.has(row.id));if(retained.length)setHistory(old=>[...old,...retained]);}
  previousWindow.current=vm.messages;
  if(pendingScroll.current){const {height,top}=pendingScroll.current;thread.current.scrollTop=top+thread.current.scrollHeight-height;pendingScroll.current=null;return;}
  if(first.current){first.current=false;toEnd();}
  else if(previousLast.current!==last){if(nearEnd.current)toEnd();else setLatest(true);if(lastMessage?.role==='assistant'||lastMessage?.role==='error'){setAnnouncement('');requestAnimationFrame(()=>{if(alive.current)setAnnouncement(msg('messenger.received'));});}}
  previousLast.current=last;
 },[vm,history,active]);
 useLayoutEffect(()=>{const el=input.current?.querySelector('textarea');if(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight+2,144)+'px';}},[draft,!!vm]);
 function acknowledge(){
  if(!active||!caps?.markRead||!last||readId.current===last||document.visibilityState!=='visible'||!nearEnd.current||!online)return;
  readId.current=last;chatCommand(chatPath(id,'/read'),{throughMessageId:last}).then(()=>{if(alive.current){client.resync('chat-agents');client.resync('chat-agent-sessions:'+vm.agentId);}},()=>{if(alive.current&&readId.current===last)readId.current=null;});
 }
 useEffect(()=>{acknowledge();document.addEventListener('visibilitychange',acknowledge);window.addEventListener('focus',acknowledge);return()=>{document.removeEventListener('visibilitychange',acknowledge);window.removeEventListener('focus',acknowledge);};},[last,caps?.markRead,online,active]);
 const changeDraft=value=>{draftRef.current=value;drafts.set(id,value);setDraft(value);setError(null);};
 const canSend=!!caps?.sendMessage&&online&&!busy&&!vm?.turnPending&&(draft.trim()||files.some(row=>row.status==='ready'))&&!files.some(row=>row.status!=='ready');
 async function send(event){
  event?.preventDefault();if(!canSend)return;
  const body={text:draftRef.current,attachmentIds:files.map(row=>row.attachment.attachmentId)},serialized=JSON.stringify(body);
  if(sendIntent.current?.serialized!==serialized)sendIntent.current={serialized,key:commandKey()};
  setBusy(true);setError(null);
  try{await chatCommand(chatPath(id,'/messages'),body,{key:sendIntent.current.key});if(!alive.current)return;
   if(draftRef.current===body.text)changeDraft('');for(const row of files)if(body.attachmentIds.includes(row.attachment?.attachmentId))releasePreview(row.localPreview?.thumbnailUrl);setFiles(old=>old.filter(row=>!body.attachmentIds.includes(row.attachment?.attachmentId)));sendIntent.current=null;refresh();toEnd();
  }catch(e){if(alive.current)setError(commandErrorText(e));}finally{if(alive.current)setBusy(false);}
 }
 async function retryTurn(){
  if(!caps.retry||!vm.retryEligible||!vm.retryEligibleTurnId||!online||busy)return;
  const turnId=vm.retryEligibleTurnId;if(retryIntent.current?.turnId!==turnId)retryIntent.current={turnId,key:commandKey()};setBusy(true);setError(null);
  try{await chatCommand(chatPath(id,'/retry'),{turnId},{key:retryIntent.current.key});if(alive.current)refresh();}catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setBusy(false);}
 }
 async function cancelQueued(message){
  const turnId=message.queueActions?.turnId;if(!turnId||queueBusy||!online)return;setQueueBusy(true);setError(null);
  try{await chatCommand(chatPath(id,'/queued/'+encodeURIComponent(turnId)),undefined,{method:'DELETE',key:commandKey()});if(alive.current)refresh();}
  catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setQueueBusy(false);}
 }
 async function sendQueuedNow(){
  const turnId=queuedSend?.queueActions?.turnId;if(!turnId||queueBusy||!online)return;setQueueBusy(true);setError(null);
  try{await chatCommand(chatPath(id,'/queued/'+encodeURIComponent(turnId)+'/send-now'),{},{key:commandKey()});if(alive.current){setQueuedSend(null);refresh();}}
  catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setQueueBusy(false);}
 }
 async function loadOlder(){
  const before=cursor===undefined?vm.pagination.olderCursor:cursor;if(!before||olderBusy)return;setOlderBusy(true);setError(null);
  try{const response=await chatRead(chatPath(id)+'?before='+encodeURIComponent(before));if(!alive.current)return;
   const seen=new Set(history.map(row=>row.id));pendingScroll.current={height:thread.current.scrollHeight,top:thread.current.scrollTop};setHistory(old=>[...response.data.messages.filter(row=>!seen.has(row.id)),...old]);setCursor(response.data.pagination.olderCursor);
  }catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setOlderBusy(false);}
 }
 async function upload(row){
  const controller=new AbortController();uploads.current.set(row.localId,controller);
  setFiles(old=>old.map(item=>item.localId===row.localId?{...item,status:'uploading',error:null}:item));
  try{const result=await chatUpload(id,row.file,{key:row.key,signal:controller.signal}),attachment=result.result;if(alive.current)setFiles(old=>old.map(item=>item.localId===row.localId?{...item,status:'ready',attachment}:item));}
  catch(e){if(alive.current&&!controller.signal.aborted)setFiles(old=>old.map(item=>item.localId===row.localId?{...item,status:'failed',error:e.message}:item));}
  finally{uploads.current.delete(row.localId);}
 }
 function addFiles(selected){
  if(!policy?.allowed||!caps.sendMessage||!online||busy)return;setSheet(false);setError(null);
  const accepted=[];
  for(const file of selected){
   if(files.length+accepted.length>=policy.maxCountPerMessage){setError(msg('messenger.tooMany'));break;}
   if(file.size>policy.maxBytes){setError(msg('messenger.tooLarge',{size:fmt.bytes(policy.maxBytes)}));continue;}
   if(!policy.mimeTypes.includes(file.type)){setError(msg('messenger.badType',{types:policy.mimeTypes.join(', ')}));continue;}
   const localUrl=file.type.startsWith('image/')?URL.createObjectURL(file):null;if(localUrl)localPreviews.current.add(localUrl);
   accepted.push({localId:commandKey(),key:commandKey(),file,status:'uploading',attachment:null,localPreview:localUrl?{kind:'image',thumbnailUrl:localUrl,openUrl:localUrl,icon:'image',label:null,alt:file.name}:null,error:null});
  }
  setFiles(old=>[...old,...accepted]);for(const row of accepted)upload(row);
 }
 async function remove(row){
  uploads.current.get(row.localId)?.abort();
  if(row.attachment){try{await chatCommand(chatPath(id,'/attachments/'+encodeURIComponent(row.attachment.attachmentId)),undefined,{method:'DELETE'});}catch(e){if(alive.current)setError(e.message);return;}}
  if(alive.current){setFiles(old=>old.filter(item=>item.localId!==row.localId));releasePreview(row.localPreview?.thumbnailUrl);}
 }
 return html`<section class="ao-messenger__pane ao-messenger__conversation ao-chat__card" data-chat-pane="conversation" aria-label=${msg('messenger.sessions')} onDragOver=${e=>{if(policy?.allowed)e.preventDefault();}} onDrop=${e=>{if(policy?.allowed){e.preventDefault();addFiles(e.dataTransfer.files);}}}>
 <header class="ao-messenger__pane-head">${small?html`<${Button} icon=${html`<${Icon} name="arrow-left" />`} label=${msg('messenger.backSessions')} variant="ghost" size="sm" onPress=${onBack} />`:null}<h2 tabindex="-1">${forbidden?msg('messenger.denied'):titleText}</h2></header>
 ${forbidden?html`<${ErrorState} error=${view.error} onRetry=${view.retry} />`:!vm?view.error?html`<${ErrorState} error=${view.error} onRetry=${view.retry} />`:html`<div class="ao-messenger__loading" role="status"><${Skeleton} /><${Skeleton} w="70" /></div>`:html`
 ${!online?html`<p class="ao-messenger__notice" role="status">${msg('messenger.offline')}</p>`:null}
 ${view.error?html`<p role="alert" class="ao-messenger__notice">${view.error.message}<${Button} size="sm" label=${msg('common.retry')} onPress=${view.retry} /></p>`:null}
 <div ref=${thread} class="ao-messenger__thread bu-chat__thread" data-chat-thread tabindex="0" role="region" aria-label=${titleText} onScroll=${()=>{const el=thread.current;nearEnd.current=el.scrollHeight-el.scrollTop-el.clientHeight<64;if(nearEnd.current){setLatest(false);acknowledge();}}}>
 ${(cursor===undefined?vm.pagination.hasOlder:!!cursor)?html`<${Button} label=${msg('messenger.older')} busy=${olderBusy} onPress=${loadOlder} />`:null}
 ${messages.length?html`<ol class="ao-chat__messages">${messages.map(message=>html`<li key=${message.id} data-chat-message=${message.id} class=${'ao-chat__msg ao-chat__msg--'+message.role}><${ChatV3Message} message=${message} now=${now} onSendNowQueued=${setQueuedSend} onCancelQueued=${cancelQueued} /></li>`)}</ol>`:html`<div class="bu-empty"><p class="bu-empty__title">${msg('messenger.emptyThread')}</p></div>`}
 ${vm.turnPending?html`<div class="ao-messenger__pending ao-chat__pending" role="status"><span class="bu-typing" aria-hidden="true"><span></span><span></span><span></span></span><span>${msg('messenger.pending')}</span></div>`:null}
 </div>
 ${latest?html`<${Button} class="ao-messenger__latest" size="sm" label=${msg('messenger.latest')} onPress=${toEnd} />`:null}
 <footer class="ao-messenger__compose" onPaste=${e=>{const pasted=[...e.clipboardData.files];if(pasted.length&&policy?.allowed){e.preventDefault();addFiles(pasted);}}}>
 ${error?html`<p role="alert" class="bu-field__error">${error}</p>`:null}
 ${caps.retry&&vm.retryEligible?html`<${Button} label=${msg('messenger.retryTurn')} disabled=${!online} busy=${busy} onPress=${retryTurn} />`:null}
 <form onSubmit=${send} onKeyDown=${e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();send();}}} class="ao-messenger__form ao-chat__composer" aria-label=${msg('messenger.compose')}>
 ${caps.sendMessage&&policy.allowed?html`<${Button} iconOnly label=${msg('messenger.attach')} icon=${html`<${Icon} name="add" />`} disabled=${!online||busy} onPress=${()=>small?setSheet(true):picker.current.click()} />`:null}
 <div ref=${input} class="ao-messenger__input">${files.length?html`<ul class="ao-chat-attachment-strip ao-chat-attachment-strip--composer" aria-label=${msg('messenger.moreFiles')}>${files.map(row=>{const file=row.attachment?{...row.attachment,preview:row.attachment.preview||row.localPreview,url:row.attachment.url||row.localPreview?.openUrl||null}:{name:row.file.name,size:row.file.size,preview:row.localPreview,url:row.localPreview?.openUrl||null};const status=row.status==='uploading'?msg('messenger.uploading'):row.status==='failed'?row.error||msg('messenger.uploadFailed'):null;return html`<li key=${row.localId} data-upload-state=${row.status}><${ChatAttachmentPreview} file=${file} compact status=${status} onRemove=${busy?null:()=>remove(row)} />${row.status==='uploading'?html`<progress aria-label=${msg('messenger.uploading')} />`:null}${row.status==='failed'?html`<${Button} size="sm" iconOnly label=${msg('messenger.retryUpload',{name:row.file.name})} icon=${html`<${Icon} name="undo" />`} onPress=${()=>upload(row)} disabled=${!online} />`:null}</li>`})}</ul>`:null}<${TextArea} id="chat-texte" label=${msg('messenger.compose')} placeholder=${msg('messenger.placeholder')} rows=${1} maxLength=${8000} value=${draft} disabled=${!caps.sendMessage} onInput=${e=>changeDraft(e.currentTarget.value)} /></div>
 <${Button} class="ao-chat__send" type="submit" variant="primary" label=${msg('chat.send')} iconOnly=${small} icon=${html`<${Icon} name="arrow-right" />`} disabled=${!canSend} busy=${busy} />
 </form>
 ${!caps.sendMessage?html`<p class="ao-messenger__hint">${caps.storyboard?.reason?label(caps.storyboard.reason):msg('messenger.readonly')}</p>`:!policy.allowed&&policy.reason?html`<p class="ao-messenger__hint">${label(policy.reason)}</p>`:null}
 <input ref=${picker} hidden type="file" accept=${policy.mimeTypes.join(',')} multiple onChange=${e=>{addFiles(e.currentTarget.files);e.currentTarget.value='';}} />
 <input ref=${imagePicker} hidden type="file" accept=${policy.mimeTypes.filter(type=>type.startsWith('image/')).join(',')} multiple onChange=${e=>{addFiles(e.currentTarget.files);e.currentTarget.value='';}} />
 </footer>`}
 ${queuedSend?html`<${ConfirmDialog} open title=${label(queuedSend.queueActions.titleLabel)} description=${label(queuedSend.queueActions.warningLabel)} confirmLabel=${label(queuedSend.queueActions.sendNowLabel)} cancelLabel=${label(queuedSend.queueActions.keepQueuedLabel)} busy=${queueBusy} error=${error} modalClass="ao-chat__send-now-modal" onCancel=${()=>{if(!queueBusy){setQueuedSend(null);setError(null);}}} onConfirm=${sendQueuedNow} />`:null}
 <p class="bu-sr-only" aria-live="polite">${announcement}</p>
 ${sheet?html`<${Modal} title=${msg('messenger.attach')} onClose=${()=>setSheet(false)}><div class="ao-messenger__file-choices"><${Button} label=${msg('messenger.file')} onPress=${()=>picker.current.click()} />${policy.mimeTypes.some(type=>type.startsWith('image/'))?html`<${Button} label=${msg('messenger.image')} onPress=${()=>imagePicker.current.click()} />`:null}<p>${msg('messenger.attachPolicy',{types:policy.mimeTypes.join(', '),size:fmt.bytes(policy.maxBytes)})}</p><p>${msg('messenger.pasteHint')}</p></div></${Modal}>`:null}
 </section>`;
}
