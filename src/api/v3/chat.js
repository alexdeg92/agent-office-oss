'use strict';
const crypto = require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const { ApiError, invalid } = require('../v2/errors');
const { scopeForAccount, sessionRefForScope, supportsPrincipalChat, visibleToAccount } = require('../chat-identity');
const { parseId } = require('../../runtime-ids');
const { runAuthorized } = require('../../security/dispatch-context');
const { CHAT_MIME, OPAQUE } = require('../../store/repos/chat-v3');
const { privateDirectory, receiveUpload, readPrivateAttachment, MAX_FILE } = require('./chat-upload');
const { LABELS } = require('../../i18n/fr');
const { resolveSender, knownSender, Sender } = require('../../engine/model/sender');
const { validate } = require('../../schema');
const { mountChatSessionManagement, buildSessionRows, listLabels } = require('./chat-session-management');
const { createBoundedPrivateCache } = require('../../util/bounded-private-cache');
const { pruneAttachmentInboxPage } = require('./attachment-inbox-cleanup');
const { drainQueuedPaneMembers } = require('./pane-queue-drain');
const { previewAllowed, createPreviewReadLimiter, dimensionsFromHeader } = require('./chat-preview');
const PAGE = 50;
const cursorSecret = crypto.randomBytes(32);
const randomId = kind => kind + '_' + crypto.randomBytes(24).toString('base64url');
// OpenClaw folds session keys to lowercase, so chat session ids use an
// already-folded alphabet to avoid two private IDs collapsing to one key.
const randomSessionId = () => 'cs_' + crypto.randomBytes(24).toString('hex');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const canonicalJson=value=>JSON.stringify(value,(key,child)=>child&&typeof child==='object'&&!Array.isArray(child)?Object.fromEntries(Object.entries(child).sort(([a],[b])=>a.localeCompare(b))):child);
const label = (key, params = null) => ({ key, ...(params ? { params } : {}) });
const megabytesLabel = bytes => Math.round(bytes / 104857.6) / 10;
const textBody = text => ({ text, blocks: [{ type: 'text', text }] });
const safeDispatchFailure = value => {
  const text=typeof value==='string'?value.toLowerCase():'';
  if(['readonly','busy','pane_busy','invalid_message','invalid-agent','invalid-session','session-key-collision','delivery-policy-unconfirmed','not-ok','invalid-output','timeout','killed-or-timeout','wrong-runtime','unavailable'].includes(text))return text==='pane_busy'?'busy':text;
  if(/^exit-\d{1,3}$/.test(text))return text;
  if(['error','upstream-failed','provider-failed'].includes(text))return 'provider-failed';
  return 'dispatch-failed';
};
const sessionTitleFromFirstMessage = text => String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
const previewText = value => String(value||'')
  .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/<[^>]*>/g, ' ').replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, '')
  .replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*>\s?/gm, '').replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, '')
  .replace(/\|/g, ' · ').replace(/[\*_~`]/g, '').replace(/[\t ]+/g, ' ').replace(/\s*\n\s*/g, ' · ').replace(/(?:\s*·\s*){2,}/g, ' · ').trim()
  .slice(0,180).trim() || null;
function sessionPreview(message){
  if(!message)return null;
  const blocks=message.body?.blocks;
  if(!Array.isArray(blocks)||!blocks.length)return previewText(message.body?.text);
  const parts=[];
  for(const block of blocks){
    if(block?.type==='text'&&typeof block.text==='string')parts.push(block.text);
    else if(block?.type==='table'&&Array.isArray(block.rows))for(const row of block.rows){
      if(!Array.isArray(row))continue;
      parts.push(row.map((cell,index)=>`${block.headers?.[index]?`${block.headers[index]}: `:''}${cell}`).join(' · '));
    }else if(block?.type==='team-result')parts.push([block.label,block.summary].filter(Boolean).join(': '));
  }
  return previewText(parts.length?parts.join('\n'):message.body?.text);
}
const safeName = value => String(value || '').normalize('NFKC').replace(/[\\/\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,120) || 'attachment';
const signedCursor = (sessionId, sequence) => { const data = sessionId + ':' + sequence; const sig = crypto.createHmac('sha256',cursorSecret).update(data).digest('base64url'); return Buffer.from(data + ':' + sig).toString('base64url'); };
const signedRuntimeCursor = (sessionId, continuation) => {
  const payload=Buffer.from(JSON.stringify({sessionId,continuation})).toString('base64url');
  const data='runtime:'+payload,sig=crypto.createHmac('sha256',cursorSecret).update(data).digest('base64url');
  return Buffer.from(data+':'+sig).toString('base64url');
};
function readCursor(value, sessionId) {
  if (typeof value !== 'string' || value.length > 512) return null;
  try { const decoded=Buffer.from(value,'base64url').toString('utf8');
    if(decoded.startsWith('runtime:')){
      const [,payload,sig,extra]=decoded.split(':'),data='runtime:'+payload;
      if(extra||!payload||!/^[A-Za-z0-9_-]{1,400}$/.test(payload))return null;
      const expected=crypto.createHmac('sha256',cursorSecret).update(data).digest('base64url');
      if(!crypto.timingSafeEqual(Buffer.from(sig||''),Buffer.from(expected)))return null;
      const parsed=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
      if(parsed?.sessionId!==sessionId||typeof parsed.continuation!=='string'||parsed.continuation.length>128)return null;
      return {kind:'runtime',continuation:parsed.continuation};
    }
    const [sid, raw, sig, extra] = decoded.split(':'); const data=sid+':'+raw;
    if(extra || sid!==sessionId || !/^[1-9][0-9]{0,12}$/.test(raw))return null;
    const expected=crypto.createHmac('sha256',cursorSecret).update(data).digest('base64url');
    if(!crypto.timingSafeEqual(Buffer.from(sig||''),Buffer.from(expected)))return null;return {kind:'local',sequence:Number(raw)};
  } catch { return null; }
}
function mountChat({ r, engine, topics, store, runtime, runtimeWritable = true, dataDir, orchestratorTeams = null, avatarFor = () => null, authed, guard, ok, now = () => Date.now(), log = () => {}, dispatchScheduler = { schedule: setImmediate, cancel: clearImmediate }, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), paneReplyTimeoutMs = 30000, conversationCacheOptions = {}, lateReply = { timeoutMs: 10 * 60 * 1000, intervalMs: 4000, sleep: ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); }) } }) {
  const repo=store?.chatV3;if(!repo) return null;
  const scopeUsers=new Map();
  const scopeTokens=new Map(),tokenScopes=new Map();
  const conversationHistoryCache=createBoundedPrivateCache({...conversationCacheOptions,now});
  const uploadLimits=new Map();
  const paneLocks=new Set(),paneSendAttempts=new Map();
  const previewReadLimiter=createPreviewReadLimiter({globalLimit:8,ownerLimit:4});
  const paneTextLimit=4000,paneSendLimit=12,paneSendWindow=60_000;
  const boundedConversationMessages=messages=>{
    if(!Array.isArray(messages))return [];
    const rows=messages.filter(message=>message&&['user','assistant'].includes(message.role)&&typeof message.id==='string'&&message.id.length>0&&message.id.length<=256)
      .slice(-PAGE).map(message=>({id:message.id,role:message.role,at:Number.isSafeInteger(message.at)?message.at:now(),text:String(message.text||'').slice(0,8000),
        model:typeof message.model==='string'?message.model.slice(0,200):null,tokens:Number.isSafeInteger(message.tokens)?message.tokens:null}));
    const budget=Number.isSafeInteger(conversationCacheOptions.maxEntryBytes)?conversationCacheOptions.maxEntryBytes:512*1024;
    const bytes=()=>Buffer.byteLength(JSON.stringify(rows),'utf8');
    while(rows.length&&bytes()>budget){
      if(rows.length>1){rows.shift();continue;}
      const text=rows[0].text;if(text.length){rows[0].text=text.slice(0,Math.floor(text.length/2));continue;}
      rows.pop();
    }
    return rows;
  };
  const principalId=req=>req.user?.id||req.session?.userId||req.principal?.id||null;
  const topicTokenFor=(scope,variant='default')=>{const key=variant==='default'?scope:scope+'\0'+variant;let token=scopeTokens.get(key);if(!token){token=crypto.createHmac('sha256',cursorSecret).update('chat-topic\0'+scope+(variant==='default'?'':'\0'+variant)).digest('base64url');scopeTokens.set(key,token);tokenScopes.set(token,scope);}return token;};
  const scopeForTopic=token=>tokenScopes.get(token)||null;
  const scopeOf=req=>{const id=principalId(req),scope=scopeForAccount(id,store);topicTokenFor(scope);if(id)scopeUsers.set(scope,id);return scope;};
  const allowed=(req,resource,level='read')=>!store.policy||store.policy.can(req.user||principalId(req),resource,level);
  const requireGrant=(req,resource,level='read')=>{req.authorize?.();if(!allowed(req,resource,level))throw new ApiError('forbidden',{details:[{issue:'permission-denied'}]});};
  const runtimeOf=agentId=>engine.runtimeFor?.(agentId)||engine.runtime?.();
  const canonicalFromTarget=target=>typeof target?.source_ref==='string'&&target.source_ref.startsWith('agent:')?target.source_ref.slice(6):null;
  const targetRuntime=target=>runtimeOf(canonicalFromTarget(target)||target?.canonicalAgentId)||engine.runtimeForInstance?.(target?.runtime_id)||engine.runtime?.();
  const parseAgent=id=>{const parsed=parseId(id,'agent');return parsed?{runtimeId:parsed.runtime,nativeAgentId:parsed.local}:{runtimeId:engine.runtime?.()?.adapterId||'legacy',nativeAgentId:id};};
  const paneStatusFor=member=>{
    if(!member)return 'unknown';const snapshot=orchestratorTeams?.getSnapshot?.(),hostId=member.hostAgentId;
    const host=typeof hostId==='string'?(snapshot?.agents||[]).find(row=>row.id===hostId):null;
    if(!host||!Number.isSafeInteger(host.staleAfter)||host.staleAfter<=now())return 'unknown';return host.status||'unknown';
  };
  const paneSendAvailable=member=>!!member&&orchestratorTeams?.chatPaneMessaging?.sendText===true&&
    orchestratorTeams?.chatPaneMessaging?.exactPaneIdentity===true&&orchestratorTeams?.chatPaneMessaging?.readTranscript===true&&
    typeof orchestratorTeams?.sendPaneText==='function';
  const reservePaneSendAttempt=memberId=>{
    const key='herdr:'+memberId,t=now();for(const [candidate,attempts] of paneSendAttempts)if(!attempts.some(at=>at>t-paneSendWindow))paneSendAttempts.delete(candidate);
    const attempts=(paneSendAttempts.get(key)||[]).filter(at=>at>t-paneSendWindow);
    if(attempts.length>=paneSendLimit||(!paneSendAttempts.has(key)&&paneSendAttempts.size>=4096))throw new ApiError('rate_limited');
    attempts.push(t);paneSendAttempts.set(key,attempts);
  };
  const linkedPaneRows=agentId=>{
    const snapshot=orchestratorTeams?.getSnapshot?.(),sessions=engine.sessions?.()||[],rows=[];
    for(const member of snapshot?.members||[]){
      const ref=snapshot?.privateMemberSessionRefs?.[member.id];
      if(!ref||ref.agentId!==agentId||typeof ref.sessionKey!=='string'||typeof ref.sessionRef!=='string')continue;
      const session=sessions.find(item=>item.key===ref.sessionKey);
      if(session&&session.class?.agentId!==ref.agentId)continue;
      rows.push({member,nativeSessionKey:ref.sessionKey,nativeSessionRef:ref.sessionRef,runtimeKind:ref.runtimeKind});
    }
    return rows;
  };
  const paneResolution=(target,sessionRef=null)=>{
    if(target?.target_kind==='team'){
      const teamPane=paneTargetFor(target);if(!teamPane?.member)return target?.pane_member_id||target?.pane_provenance_required?{unavailable:true,paneBacked:true}:null;
      if(sessionRef&&teamPane.nativeSessionRef!==sessionRef)return {ambiguous:true};
      return {member:teamPane.member,nativeSessionKey:teamPane.nativeSessionKey||null,nativeSessionRef:teamPane.nativeSessionRef||null,runtimeKind:teamPane.runtimeKind||null};
    }
    const agentId=canonicalFromTarget(target)||target?.canonicalAgentId;
    if(!agentId)return null;
    let candidates=linkedPaneRows(agentId);
    if(target?.member)candidates=candidates.filter(row=>row.member.id===target.member.id);
    if(sessionRef)candidates=candidates.filter(row=>row.nativeSessionRef===sessionRef);
    else if(!target?.member&&typeof target?.agent?.mainSessionKey==='string')candidates=candidates.filter(row=>row.nativeSessionKey===target.agent.mainSessionKey);
    if(candidates.length===1){
      if(target?.pane_member_id&&target.pane_member_id!=='legacy:unresolved'&&candidates[0].member.id!==target.pane_member_id)return {unavailable:true,paneBacked:true};
      return candidates[0];
    }
    if(candidates.length>1)return {ambiguous:true};
    if(target?.pane_member_id||target?.pane_provenance_required)return {unavailable:true,paneBacked:true};
    return null;
  };
  const isPaneStoredRow=row=>!!row?.pane_member_id;
  const hasStoredPaneSession=(req,target)=>!!target?.target_id&&repo.hasPaneSessions(scopeOf(req),target.target_id);
  const requirePaneReadAccess=(req,target,row=null)=>{
    const resolution=paneResolution(target,row?.native_session_ref||target?.native_session_ref||null);
    if(resolution?.ambiguous)throw new ApiError('not_found');
    if(resolution?.member||resolution?.paneBacked||isPaneStoredRow(row)||hasStoredPaneSession(req,target))requireGrant(req,'teams','read');
    return resolution;
  };
  const paneReadAllowed=(req,target,row=null)=>{
    const resolution=paneResolution(target,row?.native_session_ref||target?.native_session_ref||null);
    return !resolution?.ambiguous&&(!resolution?.member&&!resolution?.paneBacked&&!isPaneStoredRow(row)&&!hasStoredPaneSession(req,target)||allowed(req,'teams','read'))&&
      (target?.target_kind!=='team'||allowed(req,'teams','read'));
  };
  const paneTargetFor=target=>{
    if(target?.member)return target;
    // Principal-capable runtimes keep their own team dispatch path. A team
    // whose lead runtime cannot accept agent turns may use the audited pane
    // sender only when that exact lead has a registered pane identity.
    if(target?.target_kind==='team'&&!supportsPrincipalChat(targetRuntime(target)?.capabilities||{})&&target.teamLead?.member)return target.teamLead;
    return null;
  };
  const conversationPort=rt=>{
    const cap=rt?.capabilities?.conversations;
    const port=rt?.conversations;
    return cap?.read===true&&typeof port?.send==='function'&&typeof port?.history==='function'&&typeof port?.subscribe==='function'?port:null;
  };
  const conversationCanSend=rt=>rt?.capabilities?.conversations?.send===true&&!!conversationPort(rt);
  const attachmentFilePort=rt=>{const port=rt?.attachmentFiles;return typeof port?.stage==='function'&&typeof port?.remove==='function'&&typeof port?.canStage==='function'?port:null;};
  const canStageAttachments=(rt,agentId,principalScope)=>{try{return attachmentFilePort(rt)?.canStage({agentId,principalScope})===true;}catch{return false;}};
  const targetPublic=(req,owner,row,agent,{team=null,member=null,teamLead=null}={})=>{
    const canonical=canonicalFromTarget(row)||agent.id,rt=targetRuntime({...row,canonicalAgentId:canonical});
    // connectorOf accepts session keys in the multi-runtime facade. A canonical
    // agent id is not a session key, so resolve its owning runtime explicitly;
    // otherwise every target inherits the preferred runtime's badge.
    const sourceRuntimeId=parseId(agent.id,'agent')?.runtime||row.runtime_id||null;
    const connector=engine.connectorById?.(sourceRuntimeId)
      || (agent.mainSessionKey&&engine.connectorOf?.(agent.mainSessionKey))
      || engine.connectorOf?.() || {};
    const caps=rt?.capabilities||{}, attachments=caps.chatAttachments;
    const paneResolutionForTarget=paneResolution({...row,canonicalAgentId:canonical,agent,team,teamLead,member:member||row.member||null},row.native_session_ref||row.nativeSessionRef||null);
    const paneMember=paneResolutionForTarget?.member||null;
    const isPane=!!paneMember;
    const paneSessionsPresent=repo.hasPaneSessions(owner,row.target_id),paneDataVisible=!paneSessionsPresent||allowed(req,'teams','read');
    const allowedRead=allowed(req,'chat','read')&&(!isPane||allowed(req,'teams','read'))&&!paneResolutionForTarget?.ambiguous;
    const allowedWrite=isPane?allowed(req,'chat.pane.send','write')&&allowed(req,'chat','write'):allowed(req,'chat','write');
    const conversation=conversationPort(rt);
    const hasConversationPort=!!conversation;
    const fileReferenceDelivery=caps.attachmentDelivery==='file-reference'&&attachments?.enabled===true&&!!attachmentFilePort(rt)&&canStageAttachments(rt,agent.id,owner);
    const conversationRequired=!!caps.conversations||attachments?.enabled===true&&!fileReferenceDelivery;
    const writable=paneResolutionForTarget?.ambiguous?false:isPane?paneSendAvailable(paneMember)&&allowedWrite&&allowed(req,'teams','read'):runtimeWritable&&!!rt?.connected&&(conversationRequired?conversationCanSend(rt):supportsPrincipalChat(caps)&&typeof runtime?.commands?.agentTurn==='function');
    const storyboardAvailable=writable&&(!isPane||paneStatusFor(paneMember)==='idle');
    const acceptedMimes=Array.isArray(attachments?.mimeTypes)?attachments.mimeTypes.filter(x=>CHAT_MIME.has(x)):[];
    const attachmentAllowed=!isPane&&writable&&allowedWrite&&attachments?.enabled===true&&acceptedMimes.length>0&&Number.isSafeInteger(attachments.maxBytes)&&attachments.maxBytes>0&&
      (hasConversationPort&&rt.capabilities.conversations?.attachments===true||fileReferenceDelivery&&supportsPrincipalChat(caps)&&typeof runtime?.commands?.agentTurn==='function');
    const providerName=connector.mark?.providerName||connector.name||rt?.name||'Agent';
    const mark=connector.mark||{};
    const runtimeId=connector.adapter||rt?.adapterId||'generic';
    const sender=resolveSender({role:'assistant'},{runtime:runtimeId,agent:{id:'agent:'+canonical,name:agent.name||null}});
    let look=null;try{look=avatarFor(sender,{officeRead:allowed(req,'office','read')})||null;}catch{}
    return {id:row.target_id,kind:team?'team':'agent',name:team?.label||member?.name||agent.name||'Agent',context:member?.roleLabel||null,contextLabel:team?label('chat.target.team'):null,
      provider:{id:runtimeId,label:label('chat.provider.named',{name:providerName}),
        mark:{monogram:mark.monogram||'AG',color:mark.color||'#526477',...(mark.logo?{logo:mark.logo}:{}),...(mark.logoDark?{logoDark:mark.logoDark}:{}),providerName}},
      portrait:{look,avatarUrl:null,alt:team?.label||member?.name||agent.name||'Agent'},teamId:team?.id||member?.teamId||null,parentId:member?.parentMemberId||null,
      stateLabel:label(agent.isPrimary?'chat.agent.primary':'chat.agent.available'),
      unread:paneDataVisible?unreadFor(owner,row.target_id):unreadEmpty(),capabilities:{read:allowedRead,startSession:allowedRead&&allowedWrite&&writable,
        sendMessage:allowedWrite&&writable,storyboard:{available:allowedWrite&&storyboardAvailable,reason:allowedWrite&&storyboardAvailable?null:label('chat.storyboard.unavailable')},
        sendNowWarning:isPane&&paneStatusFor(member)!=='idle'&&allowedWrite&&writable?label('chat.pane.sendNowWarning'):null,
        markRead:allowedRead,retry:!isPane&&allowedWrite&&writable&&caps.chatRetry===true,attachments:{allowed:attachmentAllowed,
          maxBytes:attachmentAllowed?Math.min(MAX_FILE,attachments.maxBytes):0,maxCountPerMessage:attachmentAllowed?Math.min(5,attachments.maxCountPerMessage||5):0,
          maxCountPerSession:attachmentAllowed?Math.min(20,attachments.maxCountPerSession||20):0,maxImageBytes:attachmentAllowed?Math.min(MAX_FILE,attachments.maxImageBytes||attachments.maxBytes):0,
          mimeTypes:attachmentAllowed?acceptedMimes:[],limitsLabel:label('chat.attachments.limits',{maxMb:attachmentAllowed?megabytesLabel(Math.min(MAX_FILE,attachments.maxBytes)):0,
            maxImageMb:attachmentAllowed?megabytesLabel(Math.min(MAX_FILE,attachments.maxImageBytes||attachments.maxBytes)):0}),reason:attachmentAllowed?null:label('chat.attachments.unsupported')}},
      defaultSessionId:paneDataVisible?repo.activeSummary(owner,row.target_id).defaultSessionId:null};
  };
  const unreadEmpty=()=>({count:0,label:label('chat.unread.none')});
  const unreadFor=(owner,targetId)=>{const count=repo.activeSummary(owner,targetId).unreadCount;return {count,label:count?{key:'chat.unread.count',params:{count}}:label('chat.unread.none')};};
  const targetRowsFor=req=>{
    requireGrant(req,'chat','read');const owner=scopeOf(req),rows=[];
    const agents=engine.agents?.()||[],sessions=engine.sessions?.()||[],snapshot=orchestratorTeams?.getSnapshot?.();
    const linked=[];
    if(allowed(req,'teams','read')){
      for(const member of snapshot?.members||[]){
        const ref=snapshot.privateMemberSessionRefs?.[member.id];
        if(!ref||member.sessionStatus!=='known'||typeof ref.sessionKey!=='string'||typeof ref.sessionRef!=='string')continue;
        const session=sessions.find(item=>item.key===ref.sessionKey&&item.class?.agentId===ref.agentId);
        if(!session||!visibleToAccount(session,owner))continue;
        const agent=agents.find(item=>item.id===ref.agentId)||{id:ref.agentId,name:member.name,isPrimary:false};
        const src='member:'+member.id;let saved=repo.targetForRef(owner,'agent',src);
        if(!saved)saved=repo.createTarget({id:randomId('ca'),principalScope:owner,kind:'agent',sourceRef:src,...parseAgent(agent.id)});
        linked.push({saved,agent,team:null,member,nativeSessionKey:ref.sessionKey,nativeSessionRef:ref.sessionRef,runtimeKind:ref.runtimeKind});
      }
    }
    const exactMembers=new Map();for(const row of linked){const list=exactMembers.get(row.nativeSessionKey)||[];list.push(row);exactMembers.set(row.nativeSessionKey,list);}
    const uniqueLinked=linked.filter(row=>exactMembers.get(row.nativeSessionKey)?.length===1);
    const primaryId=engine.primaryAgent?.()?.id||agents.find(agent=>agent.isPrimary)?.id||null;
    const memberAgentIds=new Set(uniqueLinked.map(row=>row.agent.id));
    // Chat targets are agents, not every per-project/per-session grouping an
    // adapter may expose as an Agent row. Start from the resolved primary and
    // exact registered members, then follow only canonical delegation lineage.
    const eligibleAgentIds=new Set([primaryId,...memberAgentIds].filter(Boolean));
    const parentForAgent=agent=>{
      const lineage=agent?.spawnedBy;
      if(typeof lineage?.sessionKey==='string')return {agentId:lineage.agentId||sessions.find(row=>row.key===lineage.sessionKey)?.class?.agentId||null,sessionKey:lineage.sessionKey};
      for(const row of sessions)if(row?.class?.agentId===agent?.id){
        const parent=row.spawnedBy;
        if(typeof parent?.sessionKey==='string')return {agentId:parent.agentId||sessions.find(item=>item.key===parent.sessionKey)?.class?.agentId||null,sessionKey:parent.sessionKey};
      }
      return null;
    };
    const visibleParentSession=relation=>{
      if(!relation?.sessionKey)return false;
      const parent=sessions.find(row=>row.key===relation.sessionKey);
      return !!parent&&visibleToAccount(parent,owner);
    };
    let expanded=true;
    while(expanded){expanded=false;for(const agent of agents){if(eligibleAgentIds.has(agent.id))continue;
      const parent=parentForAgent(agent);if(parent?.agentId&&eligibleAgentIds.has(parent.agentId)&&visibleParentSession(parent)){eligibleAgentIds.add(agent.id);expanded=true;}
    }}
    const primaryAgent=agents.find(agent=>agent.id===primaryId),primaryCandidates=uniqueLinked.filter(row=>row.agent.id===primaryId);
    const primaryMembers=typeof primaryAgent?.mainSessionKey==='string'?primaryCandidates.filter(row=>row.nativeSessionKey===primaryAgent.mainSessionKey):primaryCandidates;
    const primaryMember=primaryMembers.length===1?primaryMembers[0]:null;
    if(primaryAgent){const src='agent:'+primaryAgent.id;let saved=repo.targetForRef(owner,'agent',src);
      if(!saved)saved=repo.createTarget({id:randomId('ca'),principalScope:owner,kind:'agent',sourceRef:src,...parseAgent(primaryAgent.id)});
      rows.push({saved,agent:primaryAgent,team:null,...(primaryMember?{member:primaryMember.member,nativeSessionKey:primaryMember.nativeSessionKey,nativeSessionRef:primaryMember.nativeSessionRef,runtimeKind:primaryMember.runtimeKind}:{})});}
    for(const a of agents){
      if(!eligibleAgentIds.has(a.id)||memberAgentIds.has(a.id)||a.id===primaryId)continue;
      const src='agent:'+a.id;let saved=repo.targetForRef(owner,'agent',src);if(!saved)saved=repo.createTarget({id:randomId('ca'),principalScope:owner,kind:'agent',sourceRef:src,...parseAgent(a.id)});rows.push({saved,agent:a,team:null});
    }
    rows.push(...uniqueLinked.filter(row=>row.agent.id!==primaryId||primaryCandidates.length>1&&row.member.id!==primaryMember?.member.id));
    if(allowed(req,'teams','read')){
      const snapshot=orchestratorTeams?.getSnapshot?.(),team=snapshot?.team,members=(snapshot?.members||[]).filter(m=>m.teamId===team?.id);
      const leads=members.filter(m=>m.roleKind==='lead');const roots=members.filter(m=>!m.parentMemberId);
      const lead=(leads.length===1?leads[0]:leads.length===0&&roots.length===1?roots[0]:null);
      const linked=snapshot?.privateMemberSessionRefs?.[lead?.id]?.agentId||snapshot?.identityLinks?.find(x=>x.hostAgentId===lead?.hostAgentId&&x.confidence==='exact')?.agentId;
      const agent=linked&&(engine.agents?.()||[]).find(x=>x.id===linked);
      if(team&&lead&&agent){
        const src='team:'+team.id;let saved=repo.targetForRef(owner,'team',src);if(!saved)saved=repo.createTarget({id:randomId('ct'),principalScope:owner,kind:'team',sourceRef:src,...parseAgent(agent.id)});
        const teamLead=uniqueLinked.find(row=>row.member.id===lead.id&&row.agent.id===linked)||null;
        rows.push({saved,agent,team,teamLead});
      }
    }
    return rows;
  };
  const targetFor=(req,id)=>{
    if(!OPAQUE.test(String(id||'')))throw new ApiError('not_found');
    const row=repo.target(scopeOf(req),id);if(!row)throw new ApiError('not_found');
    if(row.target_kind==='team'&&!allowed(req,'teams','read'))throw new ApiError('forbidden',{details:[{issue:'permission-denied'}]});
    const info=targetRowsFor(req).find(x=>x.saved.target_id===id);
    if(!info)throw new ApiError('not_found');if(info.team||info.member)requireGrant(req,'teams','read');const primaryTarget=!!info.agent.isPrimary;return {...info.saved,canonicalAgentId:info.agent.id,agent:info.agent,team:info.team,member:primaryTarget?null:info.member||null,teamLead:info.teamLead||null,
      nativeSessionKey:primaryTarget?null:info.nativeSessionKey||null,nativeSessionRef:primaryTarget?null:info.nativeSessionRef||null,runtimeKind:primaryTarget?null:info.runtimeKind||null};
  };
  const storedSessionTarget=(req,row)=>{
    const owner=row?.principal_scope||scopeOf(req),saved=row&&repo.target(owner,row.agent_id);if(!saved)throw new ApiError('not_found');
    if(saved.target_kind==='team')requireGrant(req,'teams','read');
    const info=targetRowsFor(req).find(item=>item.saved.target_id===saved.target_id);
    const paneMemberId=row.pane_member_id||null,paneProvenanceRequired=isPaneStoredRow(row);
    if(info){if(info.member||info.team||paneProvenanceRequired)requireGrant(req,'teams','read');const primaryTarget=!!info.agent.isPrimary;return {...info.saved,pane_member_id:paneMemberId,pane_provenance_required:paneProvenanceRequired,canonicalAgentId:info.agent.id,agent:info.agent,team:info.team||null,member:primaryTarget?null:info.member||null,teamLead:info.teamLead||null,
      nativeSessionKey:primaryTarget?null:info.nativeSessionKey||null,nativeSessionRef:primaryTarget?null:info.nativeSessionRef||null,runtimeKind:primaryTarget?null:info.runtimeKind||null};}
    const canonicalAgentId=canonicalFromTarget(saved),agent=canonicalAgentId&&(engine.agents?.()||[]).find(item=>item.id===canonicalAgentId);
    if(saved.target_kind==='agent'&&!canonicalAgentId)requireGrant(req,'teams','read');
    if(paneProvenanceRequired)requireGrant(req,'teams','read');
    return {...saved,pane_member_id:paneMemberId,pane_provenance_required:paneProvenanceRequired,canonicalAgentId,agent:agent||{id:canonicalAgentId||saved.native_agent_id,name:null,isPrimary:false},team:null,member:null,teamLead:null};
  };
  const sessionsFor=(req,target,filter='active')=>repo.list(scopeOf(req),target.target_id,{filter});
  const streamSessionTopic=id=>'chat-session:'+id;
  const internalSessionTopic=(owner,id)=>topics.parse('chat-session-scope?scope='+encodeURIComponent(topicTokenFor(owner))+'&sessionId='+encodeURIComponent(id),3)?.id||null;
  const internalAgentsTopic=(owner,teamsRead)=>topics.parse('chat-agents-scope?scope='+encodeURIComponent(topicTokenFor(owner,'agents:'+(teamsRead?'teams':'chat'))),3)?.id||null;
  const internalSessionsTopic=(owner,id,filter='active')=>topics.parse('chat-agent-sessions-scope?scope='+encodeURIComponent(topicTokenFor(owner))+'&targetId='+encodeURIComponent(id)+'&filter='+encodeURIComponent(filter),3)?.id||null;
  const requestForScope=owner=>{const userId=scopeUsers.get(owner),user=userId&&store.users.byId(userId);return {user:user||null,session:user?{userId:user.id}:null,query:{}};};
  // Durable dispatches may resume before any HTTP request repopulates the
  // in-memory scopeUsers index. Reconstruct the request from the principal
  // persisted with the accepted turn instead of relying on that cache.
  const requestForPrincipal=userId=>{const user=userId&&store.users?.byId?.(userId);return {user:user||null,session:user?{userId:user.id}:null,query:{}};};
  const projectSession=(req,row,remotePage=null)=>{
    const msgs=repo.messages(row.session_id,{limit:PAGE}),first=msgs[0],hasOlder=!!first&&first.sequence>1;
    const before=readCursor(req.query?.before,row.session_id);if(req.query?.before&&!before)throw new ApiError('not_found');
    const selected=before?.kind==='local'?repo.messages(row.session_id,{before:before.sequence,limit:PAGE}):before?.kind==='runtime'?[]:msgs;
    const storedFallback=before?.kind==='runtime'?msgs:selected;
    const ownerId=row.principal_scope&&scopeUsers.get(row.principal_scope)||principalId(req),user=ownerId&&store.users?.byId?.(ownerId);
    const person=user?.person_id?store.db.prepare('SELECT id,name,avatar_url FROM persons WHERE id=?').get(user.person_id):null;
    const target=repo.target(row.principal_scope,row.agent_id),targetInfo=target&&targetRowsFor(req).find(x=>x.saved.target_id===row.agent_id);
    const canonicalAgent=targetInfo?.agent||engine.agents?.().find(a=>a.id===target?.source_ref?.slice(6))||null;
    const connector=canonicalAgent&&engine.connectorOf?.(canonicalAgent.id)||{};
    const cached=conversationHistoryCache.get(row.session_id),remote=remotePage||cached;
    const remoteMessages=Array.isArray(remote)?remote:remote?.messages;
    const transcriptRows=Array.isArray(remoteMessages)?remoteMessages.filter(m=>['user','assistant'].includes(m?.role)&&typeof m?.id==='string')
      .slice(-PAGE).map(m=>{const meta={model:m.model||null,tokens:m.tokens??null,durationMs:null};
        return {message_id:'msg_'+hash('chat-v3-conversation\0'+row.session_id+'\0'+m.id),kind:'message',role:m.role,at:Number.isSafeInteger(m.at)?m.at:now(),body:textBody(String(m.text||'').slice(0,8000)),title:null,status:null,status_label_json:null,
          meta_json:JSON.stringify(meta),attachments_json:'[]',meta,attachments:[]};}) : null;
    // A runtime can legitimately report no transcript for a stored Discuter
    // session (for example, an older session key that the Gateway no longer
    // recognizes). An empty remote page is not evidence that stored history
    // should be hidden.
    const usableTranscriptRows=transcriptRows?.length?transcriptRows:null;
    const localPending=row.pending_turn_id?storedFallback.filter(m=>m.role==='user'&&m.turn_id===row.pending_turn_id&&
      !usableTranscriptRows?.some(remoteMessage=>remoteMessage.role==='user'&&remoteMessage.body?.text===m.body?.text&&remoteMessage.at>=m.at-5000)):[];
    const localSent=isPaneStoredRow(row)?storedFallback.filter(m=>m.role==='user'&&m.status==='sent'):[];
    const matchedSent=new Set();
    const transcriptWithQueueState=usableTranscriptRows?.map(remoteMessage=>{
      if(remoteMessage.role!=='user')return remoteMessage;
      const match=localSent.filter(candidate=>!matchedSent.has(candidate.message_id)&&candidate.body?.text===remoteMessage.body?.text&&remoteMessage.at>=candidate.at-5000)
        .sort((a,b)=>Math.abs(remoteMessage.at-a.at)-Math.abs(remoteMessage.at-b.at))[0];
      if(!match)return remoteMessage;matchedSent.add(match.message_id);return {...remoteMessage,message_id:match.message_id,turn_id:match.turn_id,status:match.status,status_label_json:match.status_label_json};
    });
    const displayedRows=usableTranscriptRows?([...(transcriptWithQueueState||[]),...localPending.filter(m=>!usableTranscriptRows.some(remoteMessage=>remoteMessage.message_id===m.message_id))].sort((a,b)=>a.at-b.at)):storedFallback;
    const messageContext={runtime:connector.adapter||target?.runtime_id||'generic',operator:person?{id:person.id,name:person.name,avatarUrl:person.avatar_url}:null,
      agent:canonicalAgent?{id:'agent:'+canonicalAgent.id,name:canonicalAgent.name||null}:null,
      sessionOf:key=>engine.session?.(key)};
    const messages=displayedRows.map(m=>{
      const storedMeta=m.meta||{};
      const candidate=storedMeta.senderInfo&&typeof storedMeta.senderInfo==='object'?storedMeta.senderInfo:null;
      const explicit=candidate&&validate(Sender,candidate).ok?candidate:null;
      const resolved=knownSender(explicit||resolveSender({role:m.role==='error'?'system':m.role},messageContext),messageContext);
      // senderInfo.avatarHint is a scalar identity hint, while Office portraits
      // are structured appearance descriptors. Keep those contracts separate.
      const appearance=resolved.kind==='agent'
        ? avatarFor(resolved,{officeRead:allowed(req,'office','read')})||(!resolved.delegation?.sessionKey&&targetInfo?.agent&&target
          ? targetPublic(req,row.principal_scope,target,targetInfo.agent,{team:targetInfo.team}).portrait.look
          : null)
        : null;
      const meta={model:storedMeta.model||null,tokens:storedMeta.tokens??null,durationMs:storedMeta.durationMs??null};
      const queueActions=m.role==='user'&&m.status==='queued'&&m.turn_id&&row.pending_turn_id!==m.turn_id&&isPaneStoredRow(row)?{turnId:m.turn_id,cancelLabel:label('chat.pane.cancelQueued'),
        sendNowLabel:label('chat.pane.sendNowAction'),titleLabel:label('chat.pane.sendNowTitle'),warningLabel:label('chat.pane.sendNowWarning'),keepQueuedLabel:label('chat.pane.keepQueued')}:null;
      return {id:m.message_id,kind:m.kind,role:m.role,at:m.at,text:m.body.text||'',body:m.body,title:m.title,status:m.status,
        statusLabel:m.status_label_json?JSON.parse(m.status_label_json):null,queueActions,collapsedByDefault:m.kind==='subagent-result',avatar:appearance||null,senderInfo:resolved,meta,
        attachments:JSON.parse(m.attachments_json).map(a=>({...a,url:'/api/v3/chat/attachments/'+encodeURIComponent(a.id),preview:attachmentPreview(row,a)}))};
    });
    const oldest=storedFallback[0];const paginationRemote=usableTranscriptRows?remote:null;return {id:row.session_id,agentId:row.agent_id,title:row.title||label('chat.newSession'),messages,
      turnPending:row.pending_turn_id?{turnId:row.pending_turn_id,since:row.pending_since}:null,
      pagination:{olderCursor:paginationRemote?.hasOlder===true&&typeof paginationRemote.olderCursor==='string'?signedRuntimeCursor(row.session_id,paginationRemote.olderCursor):oldest&&oldest.sequence>1?signedCursor(row.session_id,oldest.sequence):null,
        hasOlder:paginationRemote?.hasOlder===true||!!oldest&&oldest.sequence>1},
      capabilities:capabilitiesForSession(req,row),retryEligible:!!row.retry_eligible_turn_id,retryEligibleTurnId:row.retry_eligible_turn_id||null};
  };
  const capabilitiesForSession=(req,row)=>{
    const owner=row.principal_scope||scopeOf(req),userId=scopeUsers.get(owner),effectiveReq=req?.user||req?.session?req:{...req,user:userId?store.users.byId(userId):null};
    const target=repo.target(owner,row.agent_id),info=target&&targetRowsFor(effectiveReq).find(item=>item.saved.target_id===target.target_id);const rt=targetRuntime(target),attachments=rt?.capabilities?.chatAttachments;
    const pane=paneResolution({...target,canonicalAgentId:info?.agent?.id||target?.source_ref?.slice(6),member:info?.agent?.isPrimary?null:info?.member||null,teamLead:info?.teamLead},row.native_session_ref),paneMember=pane?.member||null,isPane=!!paneMember;
    const paneReadAllowed=!pane?.ambiguous&&(!isPane||allowed(effectiveReq,'teams','read'));
    const conversation=conversationPort(rt);
    const hasConversationPort=!!conversation;
    const fileReferenceDelivery=rt?.capabilities?.attachmentDelivery==='file-reference'&&attachments?.enabled===true&&!!attachmentFilePort(rt)&&canStageAttachments(rt,row.native_agent_id||target?.native_agent_id,owner);
    const conversationRequired=!!rt?.capabilities?.conversations||attachments?.enabled===true&&!fileReferenceDelivery;
    const write=!paneReadAllowed?false:isPane?allowed(effectiveReq,'chat','write')&&allowed(effectiveReq,'chat.pane.send','write')&&paneSendAvailable(paneMember)
      :runtimeWritable&&allowed(effectiveReq,'chat','write')&&!!rt?.connected&&(conversationRequired?conversationCanSend(rt):supportsPrincipalChat(rt?.capabilities||{})&&typeof runtime?.commands?.agentTurn==='function');
    const storyboardAvailable=write&&(!isPane||paneStatusFor(paneMember)==='idle');
    const acceptedMimes=Array.isArray(attachments?.mimeTypes)?attachments.mimeTypes.filter(x=>CHAT_MIME.has(x)):[];
    const attachmentAllowed=write&&attachments?.enabled===true&&acceptedMimes.length>0&&Number.isSafeInteger(attachments.maxBytes)&&attachments.maxBytes>0&&
      (hasConversationPort&&rt.capabilities.conversations?.attachments===true||fileReferenceDelivery&&supportsPrincipalChat(rt?.capabilities||{})&&typeof runtime?.commands?.agentTurn==='function');
    const canRead=allowed(effectiveReq,'chat','read')&&paneReadAllowed;
    return {read:canRead,startSession:canRead&&write,
      sendMessage:write,storyboard:{available:storyboardAvailable,reason:storyboardAvailable?null:label('chat.storyboard.unavailable')},sendNowWarning:isPane&&paneStatusFor(paneMember)!=='idle'&&write?label('chat.pane.sendNowWarning'):null,markRead:canRead,retry:!isPane&&write&&rt?.capabilities?.chatRetry===true,attachments:{allowed:!isPane&&attachmentAllowed,
        maxBytes:attachmentAllowed?Math.min(MAX_FILE,attachments.maxBytes):0,maxCountPerMessage:attachmentAllowed?Math.min(5,attachments.maxCountPerMessage||5):0,
        maxCountPerSession:attachmentAllowed?Math.min(20,attachments.maxCountPerSession||20):0,maxImageBytes:attachmentAllowed?Math.min(MAX_FILE,attachments.maxImageBytes||attachments.maxBytes):0,
        mimeTypes:attachmentAllowed?acceptedMimes:[],limitsLabel:label('chat.attachments.limits',{maxMb:attachmentAllowed?megabytesLabel(Math.min(MAX_FILE,attachments.maxBytes)):0,
          maxImageMb:attachmentAllowed?megabytesLabel(Math.min(MAX_FILE,attachments.maxImageBytes||attachments.maxBytes)):0}),reason:attachmentAllowed?null:label('chat.attachments.unsupported')}};
  };
  const refreshConversationHistory=async(req,row,target)=>{
    const rt=targetRuntime(target),conversation=conversationPort(rt);if(!conversation)return;
    const agentId=row.native_agent_id||target.native_agent_id;
    const cursor=readCursor(req.query?.before,row.session_id);
    if(req.query?.before&&!cursor)throw new ApiError('not_found');
    try{const result=await runAuthorized(()=>requireGrant(req,'chat','read'),()=>conversation.history({agentId,sessionRef:row.native_session_ref,limit:PAGE,
      ...(cursor?.kind==='runtime'?{before:cursor.continuation}:{})}));
      if(result&&Array.isArray(result.messages)){
        if(result.messages.length===0&&cursor?.kind!=='runtime'){
          conversationHistoryCache.delete(row.session_id);
          return null;
        }
        const page={messages:result.messages,olderCursor:typeof result.olderCursor==='string'?result.olderCursor:null,hasOlder:result.hasOlder===true};
        if(cursor?.kind!=='runtime'){
          const bounded=boundedConversationMessages(result.messages);
          // A partial in-memory cache must never masquerade as a complete
          // runtime page: its continuation would otherwise skip the dropped
          // suffix. Keep complete pages only; the current HTTP response still
          // receives the full valid page even when it is too large to retain.
          if(JSON.stringify(bounded)===JSON.stringify(result.messages))conversationHistoryCache.set(row.session_id,{...page,messages:bounded});
          else conversationHistoryCache.delete(row.session_id);
        }
        return page;
      }
      conversationHistoryCache.delete(row.session_id);
    }catch(error){conversationHistoryCache.delete(row.session_id);try{log({event:'chat.history.unavailable',runtime:rt.adapterId||target.runtime_id||'unknown'});}catch{}if(cursor?.kind==='runtime')return null;}
    return null;
  };
  const idempotencyRequest=(req,route,payload,level='write')=>{
    requireGrant(req,'chat',level);const key=req.get('Idempotency-Key');if(typeof key!=='string'||!/^[A-Za-z0-9._~-]{16,128}$/.test(key))throw invalid('Idempotency-Key','invalid');
    return {scope:scopeOf(req),method:req.method,route,key,requestHash:hash(canonicalJson(payload))};
  };
  const reserve=(req,route,payload,level='write')=>{
    const request=idempotencyRequest(req,route,payload,level);
    const hit=repo.reserveIdempotency(request);
    if(hit.kind==='conflict')throw new ApiError('conflict',{details:[{issue:'idempotency-conflict'}]});
    if(hit.kind==='in-flight')throw new ApiError('conflict',{details:[{issue:'idempotency-in-progress'}]});
    return hit.kind==='reserved'?request:hit;
  };
  const complete=(reservation,status,value,state='complete')=>{if(reservation?.requestHash)repo.completeIdempotency({...reservation,status,result:value,state});};
  const abandon=reservation=>{if(reservation?.requestHash)repo.abandonIdempotency(reservation);};
  const respondReplay=(res,hit)=>{if(hit?.kind==='complete'||hit?.kind==='uncertain'){res.status(hit.status||200);mutationOk(res,{ok:true,result:hit.result,revision:null,vm:null});return true;}return false;};
  const invalidate=(id=null,owner=null,targetId=null)=>{topics.invalidate('chat-agents-scope');topics.invalidate('chat-agent-sessions-scope');if(id&&owner){const topic=internalSessionTopic(owner,id);if(topic)topics.invalidateIds([topic]);}if(owner&&targetId){for(const filter of ['active','archived']){const topic=internalSessionsTopic(owner,targetId,filter);if(topic)topics.invalidateIds([topic]);}}};
  const removeChatStorage=name=>{if(!/^[a-f0-9]{64}$/.test(String(name||'')))return false;try{fs.unlinkSync(path.join(privateDirectory(dataDir),name));return true;}catch(error){return error?.code==='ENOENT';}};
  const purgeExpiredFor=(owner,at=now(),limit=20)=>{const result=repo.purgeExpired(owner,at,limit,removeChatStorage);
    for(const row of result.sessions)invalidate(row.session_id,owner,row.agent_id);return result;};
  const dispatchTimers=new Set();let closed=false;
  const uncertainTurnMessage=()=>({id:randomId('msg'),role:'error',at:now(),body:textBody(LABELS['chat.turnUncertain']||'The result could not be confirmed after a restart. Check the conversation before sending again.'),status:'unknown',statusLabel:label('chat.turnUncertain'),attachments:[]});
  // Accepted turns outlive their HTTP request. Revalidate the captured
  // principal and current grants, never the request-bound cookie closure.
  const recoveredAuthorization=(job,paneMemberId=null)=>()=>{
    const id=job.principal_id,user=id&&store.users.byId(id);
    if(store.policy&&(!user||user.status!=='active'||!store.policy.can(user,'chat','read')||!store.policy.can(user,'chat','write')||
      (job.target_kind==='team'&&!store.policy.can(user,'teams','read'))||
      ((String(job.source_ref||'').startsWith('member:')||paneMemberId)&&(!store.policy.can(user,'teams','read')||!store.policy.can(user,'chat.pane.send','write')))))throw new Error('chat dispatch authority is no longer available');
  };
  const dispatchAcceptedTurn=async(sessionId,turnId)=>{
    const job=repo.claimTurnDispatch(sessionId,turnId);if(!job)return;
    let authorize=recoveredAuthorization(job);
    const owner=job.principal_scope,row=repo.get(owner,sessionId);
    let target=null,selectedRuntime=null,commands=null;
    let canonicalAgentId=typeof job.source_ref==='string'&&job.source_ref.startsWith('agent:')?job.source_ref.slice(6):null;
    const message=repo.messageForTurn(sessionId,turnId),attachmentIds=message?.attachments?.map(item=>item.id)||[];
    const bound=attachmentIds.map(id=>repo.ownedAttachment(owner,sessionId,id));let invoked=false,stagedFiles=[],stagedFilePort=null,stagedAgentId=null;
    const finish=async(value,{retryEligible=false,nativeSessionKey=null,priorEventIds=new Set(),hasPriorEventBaseline=false,startedAt=now(),failure=null}={})=>{
      let events=[],authorized=true;
      const requireCurrentAuthority=()=>{try{(authorize||recoveredAuthorization(job))();}catch(error){authorized=false;throw error;}};
      try{requireCurrentAuthority();}catch{}
      // The adapter's envelope can omit text while the Gateway has already committed
      // the assistant event. Reconcile the exact adapter-mapped transcript before
      // deciding that an accepted turn failed.
      const readEvents=async()=>{
        if(!authorized)return [];
        if(!nativeSessionKey||typeof engine.request!=='function')return events;
        let refreshed=null;
        try{refreshed=await runAuthorized(requireCurrentAuthority,()=>engine.request('transcript',nativeSessionKey));}catch{}
        try{requireCurrentAuthority();}catch{}
        if(!authorized)return [];
        return refreshed?.ok?refreshed.value?.events||[]:events;
      };
      const isNewReply=event=>event&&event.kind==='assistant'&&typeof event.id==='string'&&!priorEventIds.has(event.id)&&
        String(event.text||'').trim()&&(hasPriorEventBaseline||!Number.isSafeInteger(event.at)||event.at>=startedAt-2000);
      events=await readEvents();
      // An agent can end its first run without text while delegated work continues
      // (sub-agents, long tools); the answer is committed to the same transcript later.
      // Keep the turn pending and follow that transcript instead of failing early.
      if(!failure&&!value?.failed&&!(typeof value?.text==='string'&&value.text.trim())&&nativeSessionKey){
        const deadline=now()+lateReply.timeoutMs;
        while(authorized&&!closed&&!events.some(isNewReply)&&now()<deadline){
          await lateReply.sleep(lateReply.intervalMs);if(closed)return;
          events=await readEvents();
        }
      }
      const agent=engine.agents?.().find(item=>item.id===canonicalAgentId)||null;
      const senderContext={runtime:selectedRuntime?.adapterId||selectedRuntime?.definition?.id||job.runtime_id,
        agent:agent?{id:'agent:'+agent.id,name:agent.name||null}:null,sessionOf:key=>engine.session?.(key)};
      if(!authorized)events=[];
      let messages=[];
      for(const event of events){
        if(!event||!['assistant','subagent-result'].includes(event.kind)||typeof event.id!=='string'||!event.id||priorEventIds.has(event.id))continue;
        const eventAt=Number.isSafeInteger(event.at)?event.at:now();
        if(!hasPriorEventBaseline&&eventAt<startedAt-2000)continue;
        const bodyText=String(event.kind==='subagent-result'?(event.body??event.text):(event.text||'')).slice(0,8000);
        if(!bodyText.trim())continue;
        const candidate=event.senderInfo?knownSender(event.senderInfo,senderContext):null;
        const sender=candidate&&validate(Sender,candidate).ok?candidate:null;
        const status=['completed','failed','running','unknown'].includes(event.status)?event.status:'unknown';
        const id='msg_'+hash('chat-v3-event\0'+sessionId+'\0'+event.id);
        messages.push({id,role:'assistant',kind:event.kind==='subagent-result'?'subagent-result':'message',at:eventAt,body:textBody(bodyText),title:event.kind==='subagent-result'?String(event.title||sender?.delegation?.label||sender?.name||'').slice(0,120)||null:null,
          status:event.kind==='subagent-result'?status:null,statusLabel:event.kind==='subagent-result'?label('chat.result.status.'+status):null,
          meta:{...(sender?{senderInfo:sender}:{}),...(event.kind==='assistant'?{model:event.model||null,tokens:Number.isSafeInteger(event.outputTokens)?event.outputTokens:null,durationMs:null}:{})},attachments:[]});
      }
      messages.sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
      if(authorized&&typeof value?.text==='string'&&value.text.trim()&&!messages.some(message=>message.kind!=='subagent-result'))messages.push({id:randomId('msg'),role:'assistant',at:now(),body:textBody(String(value.text).slice(0,8000)),
        meta:{senderInfo:knownSender(resolveSender({role:'assistant'},senderContext),senderContext),model:value.meta?.model||null,tokens:value.meta?.tokens??null,durationMs:value.meta?.durationMs??null},attachments:[]});
      const hasReply=messages.some(message=>message.kind!=='subagent-result');
      const failed=!hasReply;
      if(failed&&isPaneStoredRow(row)&&repo.messageForTurn(sessionId,turnId)?.status==='queued')
        repo.setPaneMessageStatus(owner,sessionId,turnId,'failed',label('chat.turnFailed'),now());
      if(failed){
        const reason=failure||safeDispatchFailure(value?.failed);
        try{log({event:'chat.turn.dispatch_failed',runtime:selectedRuntime?.adapterId||selectedRuntime?.definition?.id||job.runtime_id||'unknown',stage:(failure||value?.failed)?'dispatch':'reply-reconciliation',reason,targetKind:job.target_kind||'agent',authorized,valueHadText:typeof value?.text==='string'&&!!value.text.trim()});}catch{}
        messages=[{id:randomId('msg'),role:'assistant',at:now(),body:textBody(''),status:'failed',statusLabel:label('chat.turnFailed'),attachments:[]}];
      }
      repo.completeTurnDispatch(sessionId,turnId,messages,{attachmentIds,retryEligible:failed&&retryEligible,unread:!failed});invalidate(sessionId,owner,job.agent_id);
    };
    try{
      // Keep the persisted runtime available even if current grants prevent
      // rebuilding the team target. This lets a denied dispatch record the
      // adapter's retry capability without bypassing target authorization.
      selectedRuntime=engine.runtimeForInstance?.(job.runtime_id)||engine.runtimeFor?.(canonicalAgentId)||runtime||null;
      commands=selectedRuntime?.commands||runtime?.commands;
      const principalReq=requestForPrincipal(job.principal_id);
      authorize=recoveredAuthorization(job,row?.pane_member_id||null);
      target=targetFor(principalReq,job.agent_id);
      selectedRuntime=targetRuntime({...target,canonicalAgentId});commands=selectedRuntime?.commands||runtime?.commands;
      if(!row||!target||!message||bound.some(item=>!item||item.state!=='bound'))throw new Error('accepted chat turn is incomplete');
      target={...target,pane_member_id:row.pane_member_id||null,pane_provenance_required:isPaneStoredRow(row)};
      const pane=paneResolution(target,row?.native_session_ref),paneMember=pane?.member||null;
      if(pane?.ambiguous)throw new Error('pane identity is ambiguous');
      if((row.pane_member_id||isPaneStoredRow(row))&&!paneMember)throw new Error('pane identity is unavailable');
      if(paneMember){
        const memberId=paneMember.id,lockKey='herdr:'+memberId;
        authorize=recoveredAuthorization(job,memberId);
        if(!paneLocks.has(lockKey))paneLocks.add(lockKey);
        let done=false;
        try{
          authorize();requireGrant(principalReq,'teams','read');requireGrant(principalReq,'chat.pane.send','write');
          if(attachmentIds.length||String(message.body?.text||'').length>paneTextLimit||/[\u0000-\u001f\u007f-\u009f\u001b]/u.test(message.body?.text||''))throw new Error('invalid pane message');
          if(typeof orchestratorTeams?.refresh!=='function'||typeof orchestratorTeams?.sendPaneText!=='function')throw new Error('pane messaging is unavailable');
          await orchestratorTeams.refresh();authorize();
          const fresh={...targetFor(principalReq,job.agent_id),pane_member_id:row.pane_member_id||null,pane_provenance_required:isPaneStoredRow(row)},freshPane=paneResolution(fresh,row.native_session_ref),freshPaneMember=freshPane?.member;
          if(fresh.source_ref!==job.source_ref||freshPaneMember?.id!==memberId||freshPane?.nativeSessionRef!==job.native_session_ref||!freshPane?.nativeSessionKey||freshPaneMember?.hostAgentId!==paneMember.hostAgentId||fresh.native_agent_id!==job.target_native_agent_id||fresh.runtime_id!==job.runtime_id)throw new Error('pane identity changed');
          if(!job.send_now&&paneStatusFor(freshPaneMember)!=='idle'){
            if(repo.requeuePaneMessage(sessionId,turnId,label('chat.pane.messageQueued'),now())){done=true;invalidate(sessionId,owner,job.agent_id);return;}
          }
          canonicalAgentId=fresh.canonicalAgentId;
          const latest=(engine.transcript?.(freshPane.nativeSessionKey)?.events||[]),priorEventIds=new Set(latest.map(event=>event?.id).filter(id=>typeof id==='string'));
          await runAuthorized(authorize,()=>orchestratorTeams.sendPaneText({memberId,sessionRef:freshPane.nativeSessionRef,runtimeKind:freshPane.runtimeKind,text:message.body?.text||''}));
          if(!repo.setPaneMessageStatus(owner,sessionId,turnId,'sent',label('chat.pane.messageSent',{name:freshPaneMember.name||fresh.canonicalAgentId||'agent'}),now()))throw new Error('pane message status could not be recorded');
          invalidate(sessionId,owner,job.agent_id);
          const startedAt=now(),deadline=startedAt+paneReplyTimeoutMs;let replyEvents=[];
          while(now()<deadline){authorize();const refreshed=await runAuthorized(authorize,()=>engine.request('transcript',freshPane.nativeSessionKey));if(refreshed?.ok&&Array.isArray(refreshed.value?.events)){
              replyEvents=refreshed.value.events.filter(event=>event&&event.kind==='assistant'&&typeof event.id==='string'&&!priorEventIds.has(event.id)&&String(event.text||'').trim());if(replyEvents.length)break;
            }await sleep(Math.min(500,Math.max(1,deadline-now())));
          }
          done=true;
          await finish({text:'',failed:replyEvents.length?'':'timeout',meta:null},{nativeSessionKey:freshPane.nativeSessionKey,priorEventIds,hasPriorEventBaseline:true,startedAt,failure:replyEvents.length?'': 'timeout'});
        } finally {paneLocks.delete(lockKey);if(!done)invalidate(sessionId,owner,job.agent_id);}
        return;
      }
      const agentId=job.native_agent_id||job.target_native_agent_id||(parseId(canonicalAgentId,'agent')?.local||canonicalAgentId);
      const nativeSessionKey=typeof selectedRuntime.definition?.sessionKeyFor==='function'
        ? selectedRuntime.definition.sessionKeyFor(agentId,job.native_session_ref,{purpose:'chat'}) : null;
      const conversation=conversationPort(selectedRuntime);
      const hasConversationPort=!!conversationPort(selectedRuntime);
      const attachmentCaps=selectedRuntime?.capabilities?.chatAttachments||{};
      const filePort=attachmentFilePort(selectedRuntime);
      const fileReferenceDelivery=selectedRuntime?.capabilities?.attachmentDelivery==='file-reference'&&attachmentCaps.enabled===true&&!!filePort&&canStageAttachments(selectedRuntime,agentId,job.principal_scope);
      const conversationRequired=!!selectedRuntime?.capabilities?.conversations||attachmentCaps.enabled===true&&!fileReferenceDelivery;
      if(!selectedRuntime?.connected||(hasConversationPort?!conversationCanSend(selectedRuntime):conversationRequired||typeof commands?.agentTurn!=='function'))throw new Error('chat runtime is unavailable');
      // Some runtimes normalize session keys (OpenClaw folds them to lower
      // case). Historical mixed-case IDs can therefore alias a different
      // persisted conversation. Check the runtime's complete key namespace,
      // across principals, before reading or dispatching that transcript.
      if(nativeSessionKey&&typeof selectedRuntime.definition?.sessionKeyFor==='function'&&typeof repo.sessionRefsForRuntime==='function'){
        const collision=repo.sessionRefsForRuntime(job.runtime_id).some(existing=>existing.session_id!==sessionId&&
          selectedRuntime.definition.sessionKeyFor(existing.native_agent_id,existing.native_session_ref,{purpose:'chat'})===nativeSessionKey);
        if(collision){const error=new Error('canonical chat session key collision');error.code='session-key-collision';throw error;}
      }
      const priorTranscript=nativeSessionKey&&typeof engine.transcript==='function'?engine.transcript(nativeSessionKey):null;
      const hasPriorEventBaseline=Array.isArray(priorTranscript?.events),priorEvents=hasPriorEventBaseline?priorTranscript.events:[];
      const priorEventIds=new Set(priorEvents.map(event=>event?.id).filter(id=>typeof id==='string'));
      const startedAt=now();
      let dispatchText=message.body?.text||'';
      const attachments=bound.map(item=>({path:path.join(privateDirectory(dataDir),item.storage_name),name:item.display_name,mimeType:item.mime_type,size:item.byte_size,sha256:item.sha256}));
      if(hasConversationPort){
        // The HTTP request may have been revoked after durable acceptance but
        // before this deferred dispatch. Do not even open private bytes until
        // the persisted principal's current grants have been checked.
        authorize();
        const conversationAttachments=await Promise.all(bound.map(item=>readPrivateAttachment(dataDir,item,{maxBytes:Math.min(MAX_FILE,attachmentCaps.maxBytes||0),
          maxImageBytes:Math.min(MAX_FILE,attachmentCaps.maxImageBytes||attachmentCaps.maxBytes||0)})));
        const priorStored=repo.messages(sessionId,{limit:PAGE}).some(item=>item.turn_id!==turnId);
        const args={agentId,sessionRef:job.native_session_ref,limit:PAGE};
        const before=priorStored?await runAuthorized(authorize,()=>conversation.history(args)):{messages:[],conversationId:null};
        const baselineIds=new Set((before.messages||[]).map(item=>item.id).filter(value=>typeof value==='string'));
        const expectedLeafId=before.messages?.at(-1)?.id||null;
        const conversationId=before.conversationId||null;
        let settled=false,reading=false,readAgain=false,resolveReply,timeout=null,stopSubscription=null;
        const replyPromise=new Promise(resolve=>{resolveReply=resolve;});
        const readConversationReply=async()=>{
          if(settled)return;if(reading){readAgain=true;return;}reading=true;
          try{do{readAgain=false;authorize();let snapshot;
            try{snapshot=await runAuthorized(authorize,()=>conversation.history(args));}catch{conversationHistoryCache.delete(sessionId);continue;}
            if(!snapshot||!Array.isArray(snapshot.messages)){conversationHistoryCache.delete(sessionId);continue;}
            const messages=boundedConversationMessages(snapshot.messages);if(messages.length)conversationHistoryCache.set(sessionId,messages);else conversationHistoryCache.delete(sessionId);
            const fresh=messages.filter(item=>item.role==='assistant'&&!baselineIds.has(item.id));
            const text=fresh.map(item=>String(item.text||'')).filter(value=>value.trim()).join('\n\n').slice(0,8000).trim();
            if(text){settled=true;const latest=fresh.at(-1);resolveReply({text,meta:{model:latest.model||null,tokens:latest.tokens??null}});return;}
          }while(readAgain&&!settled);}finally{reading=false;}
        };
        const receipt=await runAuthorized(authorize,()=>{invoked=true;return conversation.send({agentId,sessionRef:job.native_session_ref,conversationId,
          text:message.body?.text||'',turnId,expectedLeafId,attachments:conversationAttachments});});
        if(receipt?.accepted!==true){const failure=receipt?.failed||'dispatch-failed';settled=true;await finish({failed:failure},{failure});return;}
        // A new conversation may not exist until the accepted send returns.
        // Subscribe after its receipt; the adapter owns provider event details.
        try{stopSubscription=await runAuthorized(authorize,()=>conversation.subscribe({agentId,sessionRef:job.native_session_ref,onChange:()=>readConversationReply().catch(()=>{})}));}catch{}
        await readConversationReply();
        // Event subscription is best-effort; canonical history polling is the fallback.
        const deadline=new Promise(resolve=>{timeout=setTimeout(()=>resolve({failed:'timeout'}),lateReply.timeoutMs);timeout.unref?.();});
        const poller=(async()=>{while(!settled&&!closed){await sleep(Math.max(50,lateReply.intervalMs));if(!settled)await readConversationReply();}})();
        const reply=await Promise.race([replyPromise,deadline]);settled=true;clearTimeout(timeout);void poller;
        try{await stopSubscription?.();}catch{}
        if(closed)return;
        if(reply?.failed)await finish({failed:reply.failed},{failure:reply.failed});
        else await finish({text:reply.text,meta:reply.meta});
        return;
      }
      if(bound.length){
        if(!fileReferenceDelivery||!supportsPrincipalChat(selectedRuntime?.capabilities||{})||!filePort)throw new Error('chat attachments are unavailable');
        // Recheck before reading private bytes, then hand the files to the
        // runtime-owned inbox. Only adapter-issued workspace references enter
        // the prompt; private-store locators never cross this boundary.
        authorize();
        const contents=[];for(const item of bound)contents.push(await readPrivateAttachment(dataDir,item,{maxBytes:Math.min(MAX_FILE,attachmentCaps.maxBytes||0),
          maxImageBytes:Math.min(MAX_FILE,attachmentCaps.maxImageBytes||attachmentCaps.maxBytes||0)}));
        authorize();stagedFilePort=filePort;stagedAgentId=agentId;
        stagedFiles=await runAuthorized(authorize,()=>filePort.stage({agentId,principalScope:job.principal_scope,files:contents.map((file,index)=>({...file,fileName:bound[index].attachment_id}))}));
        if(!Array.isArray(stagedFiles)||stagedFiles.length!==bound.length||stagedFiles.some(file=>typeof file?.reference!=='string'||typeof file?.fileName!=='string'))throw new Error('attachment staging failed');
        const refs=stagedFiles.map(file=>({displayName:file.displayName,mimeType:file.mimeType,size:file.size,path:file.reference}));
        const block=JSON.stringify({files:refs});
        dispatchText=`${dispatchText}${dispatchText?'\n\n':''}<agent-office-attachments version="1">\n${block}\n</agent-office-attachments>\nOuvre les fichiers joints avec tes outils.`;
      }
      const result=await runAuthorized(authorize||recoveredAuthorization(job),()=>{invoked=true;return commands.agentTurn({agentId,text:dispatchText,attachments:[],sessionRef:job.native_session_ref,timeoutMs:150000});});
      await finish(result,{nativeSessionKey,priorEventIds,hasPriorEventBaseline,startedAt});
    }catch(error){
      if(!invoked&&stagedFiles.length&&stagedFilePort)try{await stagedFilePort.remove({agentId:stagedAgentId,principalScope:job.principal_scope,fileNames:stagedFiles.map(file=>file.fileName)});}catch{}
      if(String(job.source_ref||'').startsWith('member:'))paneLocks.delete(owner+':'+job.source_ref.slice(7));
      const reason=safeDispatchFailure(error?.code||error?.name);
      if(row?.pane_member_id&&!job.send_now&&reason==='busy')try{if(repo.requeuePaneMessage(sessionId,turnId,label('chat.pane.messageQueued'),now())){invalidate(sessionId,owner,job.agent_id);return;}}catch{}
      try{await finish({failed:true},{retryEligible:!invoked&&(reason==='session-key-collision'||selectedRuntime?.capabilities?.chatRetry===true),failure:reason});}catch{try{log({event:'chat.turn.finalize_failed',reason});}catch{}}
    }
  };
  const scheduleAcceptedTurn=(sessionId,turnId)=>{
    const timer=dispatchScheduler.schedule(()=>{dispatchTimers.delete(timer);dispatchAcceptedTurn(sessionId,turnId).catch(()=>{});});dispatchTimers.add(timer);
  };
  const paneQueueDrains=new Set();
  const drainPaneQueues=async()=>{
    if(closed||typeof orchestratorTeams?.refresh!=='function')return;
    try{await orchestratorTeams.refresh();}catch{return;}
    await drainQueuedPaneMembers({listPage:(limit,cursor,through)=>repo.queuedPaneMembers(limit,cursor,through),isClosed:()=>closed,visit:async memberId=>{
      const lockKey='herdr:'+memberId;if(paneQueueDrains.has(memberId)||paneLocks.has(lockKey))return;
      paneQueueDrains.add(memberId);
      try{
        while(!closed){
          try{await orchestratorTeams.refresh();}catch{break;}
          const member=(orchestratorTeams.getSnapshot?.()?.members||[]).find(row=>row.id===memberId);
          if(!member||paneStatusFor(member)!=='idle'||paneLocks.has(lockKey)||repo.paneHasPending(memberId))break;
          const job=repo.promotePaneQueue(memberId,now());if(!job)break;
          await dispatchAcceptedTurn(job.session_id,job.turn_id);
        }
      }catch{try{log({event:'chat.pane_queue.drain_failed'});}catch{}}
      finally{paneQueueDrains.delete(memberId);}
    }});
  };
  void drainPaneQueues();
  const paneQueueTimer=setInterval(()=>void drainPaneQueues(),1500);paneQueueTimer.unref?.();
  // Project creation consumes the same viewer-scoped target index and adapter
  // capabilities as Chat. These helpers stay inside this module so projects
  // never inspect native runtime ids or implement a second dispatcher.
  const projectCreateVM=req=>{
    checkVersion(req);
    const rows=targetRowsFor(req).map(({saved,agent,team,member,teamLead})=>({saved,agent,team,member,teamLead,
      vm:targetPublic(req,scopeOf(req),saved,agent,{team,member,teamLead})})).filter(row=>!row.member&&row.vm.capabilities.sendMessage);
    const ordered=rows.map(row=>({id:row.vm.id,name:row.vm.name,portrait:row.vm.portrait,provider:row.vm.provider,
      stateLabel:row.vm.stateLabel,helpLabel:{key:'project.create.assignHelp',params:{name:row.vm.name}},capabilities:{sendMessage:true}}));
    const primary=rows.find(row=>row.agent.isPrimary);
    return {targets:ordered,defaultTargetId:(primary||rows[0])?.vm.id||null,emptyLabel:label('project.create.noTargets')};
  };
  const resolveProjectTarget=(req,targetId)=>{
    checkVersion(req);requireGrant(req,'chat','read');requireGrant(req,'chat','write');
    const target=targetFor(req,targetId);const caps=targetPublic(req,scopeOf(req),target,target.agent,{team:target.team,teamLead:target.teamLead}).capabilities;
    if(!caps.sendMessage)throw new ApiError('not_found');
    const connector=engine.connectorOf?.(target.canonicalAgentId)||null;
    return {target,agent:target.agent,connectorId:connector?.id||null};
  };
  const authorizeProjectKickoff=req=>{checkVersion(req);requireGrant(req,'chat','read');requireGrant(req,'chat','write');};
  const createProjectKickoff=({req,targetId,project,idempotencyKey,requestHash})=>{
    const {target,agent,connectorId}=resolveProjectTarget(req,targetId),owner=scopeOf(req),targetVM=targetPublic(req,owner,target,agent,{team:target.team,member:target.member,teamLead:target.teamLead});
    const sessionId=randomSessionId(),turnId=randomId('turn'),at=now(),messageId=randomId('msg');
    const ref=sessionRefForScope(owner)+':session:'+sessionId;
    const created=repo.createSession({sessionId,principalScope:owner,agentId:target.target_id,runtimeId:target.runtime_id,
      nativeAgentId:target.native_agent_id,nativeSessionRef:ref,title:String(project.name||'').slice(0,160)});
    const composed=[`Project: ${project.name}`,`Summary: ${project.summary||'(none)'}`,`Stage: ${project.status}`,`Priority: ${project.priority}`,
      `Open project: ${project.url}`].join('\n');
    const message={id:messageId,turnId,role:'user',at,body:textBody(composed.slice(0,8000)),attachments:[]};
    const accepted=repo.acceptTurn({scope:owner,method:'POST',route:'/projects/kickoff',key:idempotencyKey,requestHash,
      sessionId:created.session_id,turnId,at,message,principalId:principalId(req)});
    if(accepted.kind==='conflict')throw new ApiError('conflict',{details:[{issue:'idempotency-conflict'}]});
    if(accepted.kind!=='accepted')throw new ApiError(accepted.kind==='turn-pending'||accepted.kind==='in-flight'?'conflict':'upstream_failed',
      {details:[{issue:accepted.kind||'kickoff-not-accepted'}]});
    invalidate(created.session_id,owner,target.target_id);
    return {sessionId:created.session_id,turnId,targetId:target.target_id,connectorId,agent,targetVM,
      dispatch:()=>scheduleAcceptedTurn(created.session_id,turnId)};
  };
  const projectKickoffVM=(req,record)=>{
    checkVersion(req);requireGrant(req,'chat','read');
    const owner=scopeOf(req);if(!record||record.principalScope!==owner)throw new ApiError('not_found');
    const row=repo.get(owner,record.sessionId);let status='unknown',canRetry=false;
    if(row){
      if(row.pending_turn_id===record.turnId)status='queued';
      else {
        const message=repo.messages(row.session_id,{limit:50}).find(item=>item.turn_id===record.turnId&&item.role!=='user');
        if(message?.status==='failed'||message?.role==='error')status='failed';else if(message?.role==='assistant')status='sent';
      }
      canRetry=row.retry_eligible_turn_id===record.turnId&&capabilitiesForSession(req,row).retry;
    }
    return {projectId:record.projectId,status,sessionId:record.sessionId||null,turnId:record.turnId||null,canRetry,
      label:label('project.kickoff.'+status)};
  };
  const retryProjectKickoff=(req,record)=>{
    checkVersion(req);requireGrant(req,'chat','read');requireGrant(req,'chat','write');
    const owner=scopeOf(req);if(!record||record.principalScope!==owner)throw new ApiError('not_found');
    const row=repo.get(owner,record.sessionId);if(!row||row.retry_eligible_turn_id!==record.turnId)throw new ApiError('not_found');
    const target=targetFor(req,row.agent_id),caps=capabilitiesForSession(req,row);
    if(!caps.retry)throw new ApiError('not_found');
    const idem=idempotencyRequest(req,'/projects/:id/kickoff/retry',{projectId:record.projectId,turnId:record.turnId});
    const prior=repo.idempotencyResult(idem);
    if(prior.kind==='conflict')throw new ApiError('conflict',{details:[{issue:'idempotency-conflict'}]});
    if(prior.kind==='in-flight')throw new ApiError('conflict',{details:[{issue:'idempotency-in-progress'}]});
    if(prior.kind==='uncertain'||prior.kind==='complete')return {accepted:true,turnId:record.turnId};
    req.authorize?.();
    const message=repo.messageForTurn(record.sessionId,record.turnId),attachmentIds=message?.attachments?.map(item=>item.id)||[];
    const accepted=repo.acceptRetry({...idem,sessionId:record.sessionId,turnId:record.turnId,at:now(),principalId:principalId(req),attachmentIds});
    if(accepted.kind!=='accepted')throw new ApiError(accepted.kind==='conflict'?'conflict':'not_found');
    invalidate(record.sessionId,owner,target.target_id);scheduleAcceptedTurn(record.sessionId,record.turnId);
    return {accepted:true,turnId:record.turnId};
  };
  const checkVersion=req=>{if(req.apiVersion!==3)throw new ApiError('not_found');};
  const mutationOk=(res,value)=>res.json(require('../v2/envelope').okBody(value,{now:now()}));
  const attachmentPolicy=(req,row)=>capabilitiesForSession(req,row).attachments;
  const attachmentPreview=(row,attachment)=>{
    const item=attachment&&repo.ownedAttachment(row.principal_scope,row.session_id,attachment.id);
    if(item&&previewAllowed(dataDir,item,now())){
      const url='/api/v3/chat/attachments/'+encodeURIComponent(item.attachment_id)+'/preview';
      return {kind:'image',thumbnailUrl:url,openUrl:url,icon:'image',label:null,alt:null};
    }
    const mime=String(item?.mime_type||attachment?.mimeType||'');
    if(mime==='application/pdf')return {kind:'pdf',thumbnailUrl:null,openUrl:null,icon:'file-text',label:null,alt:null};
    return {kind:'file',thumbnailUrl:null,openUrl:null,icon:'file',label:null,alt:null};
  };
  mountChatSessionManagement({r,repo,authed,scopeOf,requireGrant,reserve,respondReplay,complete,abandon,invalidate,checkVersion,mutationOk,now,
    purgeExpired:purgeExpiredFor,onPurge:()=>{},onDelete:async(_owner,row)=>{const target=repo.target(row.principal_scope,row.agent_id),rt=targetRuntime(target),port=attachmentFilePort(rt);
      const rows=repo.attachmentRowsForSession(row.session_id);if(rows.length&&port)await port.remove({agentId:row.native_agent_id||target?.native_agent_id,principalScope:row.principal_scope,fileNames:rows.map(item=>item.attachment_id)});}});
  const uploadState=owner=>{let item=uploadLimits.get(owner);if(!item){item={active:0,attempts:[]};uploadLimits.set(owner,item);}return item;};
  const authorizedAttachment=(req,id)=>{
    requireGrant(req,'chat','read');const owner=scopeOf(req),file=repo.attachmentById(owner,id);if(!file)throw new ApiError('not_found');
    if(file.state==='staged'||(file.state==='consumed'?file.consumed_at:file.created_at)<=now()-30*86400000)throw new ApiError('not_found');
    const row=repo.get(owner,file.session_id);if(!row)throw new ApiError('not_found');const target=storedSessionTarget(req,row);requirePaneReadAccess(req,target,row);
    return {owner,file,row,target};
  };

  topics.define('chat-agents',{permission:{resource:'chat',level:'read'},build:()=>{throw new ApiError('not_found');}});
  topics.define('chat-agent-sessions',{params:'path',permission:{resource:'chat',level:'read'},build:()=>{throw new ApiError('not_found');}});
  topics.define('chat-agent-sessions-archived',{params:'path',permission:{resource:'chat',level:'read'},build:()=>{throw new ApiError('not_found');}});
  topics.define('chat-session',{params:'path',permission:{resource:'chat',level:'read'},build:()=>{throw new ApiError('not_found');}});
  topics.define('chat-session-scope',{params:['scope','sessionId'],permission:{resource:'chat',level:'read'},build:({scope:owner,sessionId})=>{
    const actual=scopeForTopic(owner);if(!actual||!OPAQUE.test(sessionId))throw new ApiError('not_found');const req=requestForScope(actual),row=repo.get(actual,sessionId);if(!row)throw new ApiError('not_found');const target=storedSessionTarget(req,row);requirePaneReadAccess(req,target,row);return projectSession(req,row);
  }});
  topics.define('chat-agents-scope',{params:['scope'],permission:{resource:'chat',level:'read'},build:({scope:owner})=>{
    const actual=scopeForTopic(owner);if(!actual)throw new ApiError('not_found');const req=requestForScope(actual),rows=targetRowsFor(req);
    return {revision:1,labels:{title:label('chat.agents.title'),empty:label('chat.agents.empty')},agents:rows.map(({saved,agent,team,member,teamLead})=>targetPublic(req,actual,saved,agent,{team,member,teamLead}))};
  }});
  topics.define('chat-agent-sessions-scope',{params:['scope','targetId','filter'],queryValueLimits:{filter:16},permission:{resource:'chat',level:'read'},build:({scope:owner,targetId,filter='active'})=>{
    const actual=scopeForTopic(owner);if(!actual||!OPAQUE.test(targetId)||!['active','archived'].includes(filter))throw new ApiError('not_found');purgeExpiredFor(actual);
    const req=requestForScope(actual),target=targetFor(req,targetId);requirePaneReadAccess(req,target);const archivedCount=repo.archivedCount(actual,targetId);
    const rows=buildSessionRows(repo,actual,targetId,filter,id=>sessionPreview(repo.messages(id,{limit:1}).at(-1)));
    return {revision:1,agentId:targetId,filter,labels:listLabels(filter,archivedCount),archivedCount,sessions:rows,
      defaultSessionId:filter==='active'?rows[0]?.id||null:null,capabilities:targetPublic(req,actual,target,target.agent,{team:target.team,member:target.member,teamLead:target.teamLead}).capabilities};
  }});

  r.get('/chat/agents',authed,(req,res)=>{checkVersion(req);const owner=scopeOf(req),topic=internalAgentsTopic(owner,allowed(req,'teams','read')),current=topics.current(topic,3);ok(res,current.vm,{id:'chat-agents',rev:current.rev},'chatAgents');});
  r.get('/chat/agents/:agentId/sessions',authed,(req,res)=>{checkVersion(req);for(const key of Object.keys(req.query||{}))if(key!=='filter')throw invalid(key,'unexpected-field');
    const filter=req.query?.filter||'active';if(!['active','archived'].includes(filter))throw invalid('filter','invalid');
    const owner=scopeOf(req);purgeExpiredFor(owner);const target=targetFor(req,req.params.agentId);requirePaneReadAccess(req,target);const topic=internalSessionsTopic(owner,target.target_id,filter),current=topics.current(topic,3);
    ok(res,current.vm,{id:'chat-agent-sessions:'+target.target_id,rev:current.rev},'chatAgentSessions');});
  r.post('/chat/agents/:agentId/sessions',authed,(req,res)=>{checkVersion(req);if(req.body&&Object.keys(req.body).length)throw invalid(null,'unexpected-field');const owner=scopeOf(req);
    requireGrant(req,'chat','read');const target=targetFor(req,req.params.agentId);
    const reservation=reserve(req,'/chat/agents/:agentId/sessions',{agentId:req.params.agentId});if(respondReplay(res,reservation))return;
    const caps=targetPublic(req,owner,target,target.agent,{team:target.team,member:target.member,teamLead:target.teamLead}).capabilities;if(!caps.startSession){abandon(reservation);throw new ApiError('not_found');}
    const pane=paneResolution(target),paneMember=pane?.member||null;if(pane?.ambiguous){abandon(reservation);throw new ApiError('not_found');}
    if(paneMember)requireGrant(req,'chat.pane.send','write');
    const existing=paneMember&&repo.list(owner,target.target_id).find(row=>row.native_session_ref===pane.nativeSessionRef);
    const sessionId=existing?.session_id||randomSessionId(),ref=paneMember?pane.nativeSessionRef:sessionRefForScope(owner)+':session:'+sessionId;
    const created=existing||repo.createSession({sessionId,principalScope:owner,agentId:target.target_id,runtimeId:target.runtime_id,nativeAgentId:target.native_agent_id,nativeSessionRef:ref,paneMemberId:paneMember?.id||null,title:null});
    const value={sessionId:created.session_id};complete(reservation,201,value);invalidate(created.session_id,owner,target.target_id);res.status(201);mutationOk(res,{ok:true,result:value,revision:null,vm:null});});
  r.get('/chat/sessions/:sessionId',authed,async(req,res,next)=>{try{checkVersion(req);const owner=scopeOf(req),row=repo.get(owner,req.params.sessionId);if(!row){requireGrant(req,'chat','read');throw new ApiError('not_found');}
    requireGrant(req,'chat','read');const target=storedSessionTarget(req,row);requirePaneReadAccess(req,target,row);
    const remotePage=await refreshConversationHistory(req,row,target);const vm=projectSession(req,row,remotePage),topic=internalSessionTopic(owner,row.session_id);ok(res,vm,{id:streamSessionTopic(row.session_id),rev:topic?topics.current(topic,3).rev:1},'chatSession');}catch(error){next(error);}});
  r.post('/chat/sessions/:sessionId/read',authed,(req,res)=>{checkVersion(req);const owner=scopeOf(req);
    const body=req.body||{};if(Object.keys(body).length!==1||typeof body.throughMessageId!=='string'||!OPAQUE.test(body.throughMessageId))throw invalid('throughMessageId','invalid');
    requireGrant(req,'chat','read');const row=repo.get(owner,req.params.sessionId);if(!row)throw new ApiError('not_found');
    const target=storedSessionTarget(req,row);requirePaneReadAccess(req,target,row);
    const reservation=reserve(req,'/chat/sessions/:sessionId/read',{sessionId:req.params.sessionId,...body},'read');if(respondReplay(res,reservation))return;
    const result=repo.acknowledge(owner,row.session_id,body.throughMessageId);if(!result)throw new ApiError('not_found');
    complete(reservation,200,result);invalidate(row.session_id,owner,row.agent_id);mutationOk(res,{ok:true,result,revision:null,vm:null});});
  r.post('/chat/sessions/:sessionId/messages',authed,async(req,res)=>{checkVersion(req);const owner=scopeOf(req);
    const body=req.body||{};if(Object.keys(body).some(k=>!['text','attachmentIds','sendNow'].includes(k))||body.sendNow!==undefined&&typeof body.sendNow!=='boolean')throw invalid(null,'unexpected-field');
    if(typeof body.text!=='string'||body.text.length>8000||(!body.text.trim()&&!(body.attachmentIds||[]).length)||body.attachmentIds!==undefined&&(!Array.isArray(body.attachmentIds)||body.attachmentIds.length>5||!body.attachmentIds.every(id=>OPAQUE.test(id))))throw invalid('text','length');
    requireGrant(req,'chat','read');const row=repo.get(owner,req.params.sessionId);if(!row)throw new ApiError('not_found');let target=storedSessionTarget(req,row);
    let pane=paneResolution(target,row.native_session_ref),paneMember=pane?.member||null;if(pane?.ambiguous||pane?.paneBacked&&!paneMember)throw new ApiError('not_found');requirePaneReadAccess(req,target,row);
    let paneQueueStatus=null;
    if(paneMember){
      await orchestratorTeams?.refresh?.();target=storedSessionTarget(req,row);pane=paneResolution(target,row.native_session_ref);paneMember=pane?.member||null;if(pane?.ambiguous)throw new ApiError('not_found');requirePaneReadAccess(req,target,row);
      paneQueueStatus=paneStatusFor(paneMember);
      const paneCaps=targetPublic(req,owner,{...target,native_session_ref:row.native_session_ref},target.agent,{team:target.team,member:target.member,teamLead:target.teamLead}).capabilities;
      if(!paneCaps.sendMessage)throw new ApiError('not_found');
    }
    const isPane=!!paneMember;if(body.sendNow===true&&!isPane)throw invalid('sendNow','pane-only');
    if(isPane){requireGrant(req,'teams','read');requireGrant(req,'chat.pane.send','write');if(Buffer.byteLength(body.text,'utf8')>paneTextLimit||/[\u0000-\u001f\u007f-\u009f\u001b]/u.test(body.text)||body.attachmentIds?.length)throw invalid('text','unsafe-terminal-input');}
    const idem=idempotencyRequest(req,'/chat/sessions/:sessionId/messages',{sessionId:req.params.sessionId,...body});
    const prior=repo.idempotencyResult(idem);
    if(prior.kind==='conflict')throw new ApiError('conflict',{details:[{issue:'idempotency-conflict'}]});
    if(prior.kind==='in-flight')throw new ApiError('conflict',{details:[{issue:'idempotency-in-progress'}]});
    if(prior.kind==='uncertain'||prior.kind==='complete'){res.status(prior.status||202);mutationOk(res,{ok:true,result:prior.result,revision:null,vm:null});return;}
    const caps=capabilitiesForSession(req,row);if(!caps.sendMessage)throw new ApiError('not_found');
    const ids=body.attachmentIds||[];if(ids.length>caps.attachments.maxCountPerMessage||new Set(ids).size!==ids.length||ids.length&&!caps.attachments.allowed)throw new ApiError('not_found');
    req.authorize?.();
    const bound=ids.map(id=>repo.ownedAttachment(owner,row.session_id,id));if(bound.some(a=>!a||a.state!=='staged'||a.expires_at<=now()))throw new ApiError('not_found');
    const attachmentRows=bound.map(a=>({id:a.attachment_id,name:a.display_name,mimeType:a.mime_type,size:a.byte_size,url:'/api/v3/chat/attachments/'+encodeURIComponent(a.attachment_id)}));
    const turnId=randomId('turn'),at=now(),messageId=randomId('msg'),message={id:messageId,turnId,role:'user',at,body:textBody(body.text),attachments:attachmentRows};
    const paneLockKey=isPane?'herdr:'+paneMember.id:null;
    if(body.sendNow===true&&paneLocks.has(paneLockKey))throw new ApiError('conflict',{details:[{issue:'pane-send-in-progress'}]});
    if(paneLockKey)reservePaneSendAttempt(paneMember.id);
    const queueIt=isPane&&body.sendNow!==true&&(paneQueueStatus!=='idle'||paneLocks.has(paneLockKey)||repo.paneHasPending(paneMember.id)||repo.hasPaneQueue(paneMember.id));
    let accepted=queueIt?repo.enqueuePaneMessage({...idem,sessionId:row.session_id,turnId,paneMemberId:paneMember.id,at,message,principalId:principalId(req),
      defaultTitle:LABELS['chat.newSession']||'New conversation',firstMessageTitle:sessionTitleFromFirstMessage(body.text),statusLabel:label('chat.pane.messageQueued')})
      :repo.acceptTurn({...idem,sessionId:row.session_id,turnId,at,message,attachmentIds:ids,principalId:principalId(req),sendNow:body.sendNow===true,
        paneMemberId:isPane&&body.sendNow!==true?paneMember.id:null,
        defaultTitle:LABELS['chat.newSession']||'New conversation',firstMessageTitle:sessionTitleFromFirstMessage(body.text)});
    if(paneLockKey&&accepted.kind==='accepted'&&!queueIt)paneLocks.add(paneLockKey);
    if(accepted.kind==='uncertain'||accepted.kind==='complete'){res.status(accepted.status||202);mutationOk(res,{ok:true,result:accepted.result,revision:null,vm:null});return;}
    if(accepted.kind==='conflict')throw new ApiError('conflict',{details:[{issue:'idempotency-conflict'}]});
    if(accepted.kind==='in-flight')throw new ApiError('conflict',{details:[{issue:'idempotency-in-progress'}]});
    if(accepted.kind==='turn-pending')throw new ApiError('conflict',{details:[{issue:'turn-pending'}]});
    if(accepted.kind==='queue-full')throw new ApiError('rate_limited',{details:[{issue:'pane-queue-full',label:label('chat.pane.queueLimitReached')}]});
    if(accepted.kind==='attachments-not-found'||accepted.kind==='not-found')throw new ApiError('not_found');
    if(accepted.kind!=='accepted')throw new ApiError('internal');
    const result=accepted.result;invalidate(row.session_id,owner,row.agent_id);
    res.status(202);mutationOk(res,{ok:true,result,revision:null,vm:null});
    if(queueIt)void drainPaneQueues();else scheduleAcceptedTurn(row.session_id,turnId);
  });
  r.delete('/chat/sessions/:sessionId/queued/:turnId',authed,(req,res)=>{checkVersion(req);const owner=scopeOf(req);
    if(!OPAQUE.test(String(req.params.turnId||'')))throw new ApiError('not_found');requireGrant(req,'chat','read');
    const row=repo.get(owner,req.params.sessionId);if(!row)throw new ApiError('not_found');const target=storedSessionTarget(req,row),pane=paneResolution(target,row.native_session_ref);
    if(!pane?.member||pane.ambiguous)throw new ApiError('not_found');requirePaneReadAccess(req,target,row);requireGrant(req,'teams','read');requireGrant(req,'chat.pane.send','write');
    const reservation=reserve(req,'/chat/sessions/:sessionId/queued/:turnId',{sessionId:row.session_id,turnId:req.params.turnId});if(respondReplay(res,reservation))return;
    const result=repo.cancelPaneMessage(owner,row.session_id,req.params.turnId,label('chat.pane.messageCancelled'),now());if(!result){abandon(reservation);throw new ApiError('not_found');}
    complete(reservation,200,result);invalidate(row.session_id,owner,row.agent_id);mutationOk(res,{ok:true,result,revision:null,vm:null});
  });
  r.post('/chat/sessions/:sessionId/queued/:turnId/send-now',authed,(req,res)=>{checkVersion(req);const owner=scopeOf(req);
    if(!OPAQUE.test(String(req.params.turnId||''))||req.body&&Object.keys(req.body).length)throw new ApiError('not_found');requireGrant(req,'chat','read');
    const row=repo.get(owner,req.params.sessionId);if(!row)throw new ApiError('not_found');const target=storedSessionTarget(req,row),pane=paneResolution(target,row.native_session_ref);
    if(!pane?.member||pane.ambiguous||!paneSendAvailable(pane.member))throw new ApiError('not_found');requirePaneReadAccess(req,target,row);requireGrant(req,'teams','read');requireGrant(req,'chat.pane.send','write');
    const route='/chat/sessions/:sessionId/queued/:turnId/send-now',reservation=reserve(req,route,{sessionId:row.session_id,turnId:req.params.turnId});if(respondReplay(res,reservation))return;
    if(!repo.queuedPaneMessage(owner,row.session_id,req.params.turnId)){abandon(reservation);throw new ApiError('conflict',{details:[{issue:'queued-message-no-longer-sendable'}]});}
    try{reservePaneSendAttempt(pane.member.id);}catch(error){abandon(reservation);throw error;}
    const job=repo.sendQueuedPaneNow(owner,row.session_id,req.params.turnId,now());if(!job){abandon(reservation);throw new ApiError('conflict',{details:[{issue:'queued-message-no-longer-sendable'}]});}
    const result={turnId:req.params.turnId,status:'sending'};complete(reservation,202,result);invalidate(row.session_id,owner,row.agent_id);res.status(202);mutationOk(res,{ok:true,result,revision:null,vm:null});scheduleAcceptedTurn(row.session_id,req.params.turnId);
  });
  r.post('/chat/sessions/:sessionId/attachments',authed,guard('openclaw'),async(req,res,next)=>{
    let uploadReservation=null,reservation=null,saved=null,owner=null,state=null,countedActive=false;
    try{
      checkVersion(req);owner=scopeOf(req);requireGrant(req,'chat','read');const row=repo.get(owner,req.params.sessionId);if(!row)throw new ApiError('not_found');
      const target=storedSessionTarget(req,row);requirePaneReadAccess(req,target,row);const caps=attachmentPolicy(req,row);if(!caps.allowed||!caps.maxBytes)throw new ApiError('not_found');
      const digest=req.get('Content-Digest');const cap=Math.min(MAX_FILE,caps.maxBytes);const len=Number(req.get('Content-Length'));
      if(Number.isFinite(len)&&len>cap+256*1024)throw new ApiError('validation_failed',{details:[{field:'file',issue:'too-large'}]});
      reservation=reserve(req,'/chat/sessions/:sessionId/attachments',{sessionId:row.session_id,digest:digest||null});if(respondReplay(res,reservation))return;
      if(repo.attachmentCount(owner,row.session_id)>=caps.maxCountPerSession)throw new ApiError('rate_limited');
      req.authorize?.();state=uploadState(owner);const t=now();state.attempts=state.attempts.filter(at=>at>t-60000);
      if(state.active>=2||state.attempts.length>=10)throw new ApiError('rate_limited');state.active++;countedActive=true;state.attempts.push(t);
      uploadReservation=crypto.randomBytes(32).toString('hex');if(!repo.reserveUpload(owner,uploadReservation,cap,{sessionId:row.session_id,maxBytes:104857600,maxCountPerSession:caps.maxCountPerSession}))throw new ApiError('rate_limited');
      const root=privateDirectory(dataDir);saved=await receiveUpload(req,{root,maxBytes:cap,maxImageBytes:Math.min(cap,caps.maxImageBytes||cap),digestHeader:digest});
      if(!caps.mimeTypes.includes(saved.mimeType))throw new ApiError('validation_failed',{details:[{field:'file',issue:'unsupported-type'}]});
      const attachmentId=randomId('att'),result={attachmentId,name:safeName(saved.name),mimeType:saved.mimeType,size:saved.size};
      repo.addAttachment({attachmentId,principalScope:owner,sessionId:row.session_id,name:result.name,mimeType:saved.mimeType,size:saved.size,sha256:saved.sha256,storageName:saved.storageName},uploadReservation);uploadReservation=null;saved=null;
      complete(reservation,201,result);invalidate(row.session_id,owner,row.agent_id);res.status(201);mutationOk(res,{ok:true,result,revision:null,vm:null});
    }catch(error){if(saved?.file)try{fs.unlinkSync(saved.file);}catch{}if(uploadReservation)repo.releaseUpload(uploadReservation);abandon(reservation);
      next(error?.code==='TOO_LARGE'?new ApiError('validation_failed',{details:[{field:'file',issue:'too-large'}]}):error);
    }finally{if(countedActive)state.active--;}
  });
  r.delete('/chat/sessions/:sessionId/attachments/:attachmentId',authed,guard('openclaw'),(req,res)=>{checkVersion(req);const owner=scopeOf(req);requireGrant(req,'chat','read');
    const row=repo.get(owner,req.params.sessionId);if(!row)throw new ApiError('not_found');const target=storedSessionTarget(req,row);requirePaneReadAccess(req,target,row);
    const reservation=reserve(req,'/chat/sessions/:sessionId/attachments/:attachmentId',{sessionId:row.session_id,attachmentId:req.params.attachmentId});if(respondReplay(res,reservation))return;
    const file=repo.ownedAttachment(owner,row.session_id,req.params.attachmentId);if(!file){abandon(reservation);throw new ApiError('not_found');}
    const removed=repo.cancelAttachment(owner,row.session_id,file.attachment_id);if(removed===false)throw new ApiError('conflict');if(removed)try{fs.unlinkSync(path.join(privateDirectory(dataDir),removed.storage_name));}catch{}
    const result={removed:!!removed};complete(reservation,200,result);invalidate(row.session_id,owner,row.agent_id);mutationOk(res,{ok:true,result,revision:null,vm:null});});
  r.get('/chat/attachments/:attachmentId',authed,(req,res,next)=>sendAttachment(req,res,next));
  r.get('/chat/attachments/:attachmentId/preview',authed,(req,res,next)=>sendImagePreview(req,res,next));
  const sendImagePreview=async(req,res,next)=>{
    let handle,owner,release;
    try{
      checkVersion(req);
      const authorized=authorizedAttachment(req,req.params.attachmentId),file=authorized.file;owner=authorized.owner;
      if(!previewAllowed(dataDir,file,now()))throw new ApiError('not_found');
      release=previewReadLimiter.acquire(owner);if(!release)throw new ApiError('rate_limited');
      const root=privateDirectory(dataDir),filename=path.join(root,file.storage_name);
      handle=await fs.promises.open(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|(fs.constants.O_NONBLOCK||0));
      const st=await handle.stat();if(!st.isFile()||st.size!==file.byte_size||(st.mode&0o077)!==0)throw new ApiError('not_found');
      const head=Buffer.alloc(Math.min(st.size,65536));const read=await handle.read(head,0,head.length,0);
      const dimensions=dimensionsFromHeader(head.subarray(0,read.bytesRead),file.mime_type);
      if(!dimensions)throw new ApiError('not_found');
      res.setHeader('Cache-Control','private, no-store, no-cache, max-age=0, must-revalidate');
      res.setHeader('Pragma','no-cache');res.setHeader('Expires','0');res.setHeader('Vary','Cookie');
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
      res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
      // The digest was computed and persisted during upload. Stream the bounded
      // private file instead of buffering and re-hashing it for each preview.
      res.setHeader('Content-Type',file.mime_type);res.setHeader('Content-Length',String(file.byte_size));
      res.setHeader('Content-Disposition','inline; filename="attachment"');
      const input=handle.createReadStream({start:0,end:file.byte_size-1,autoClose:true});
      input.on('error',()=>{release?.();if(!res.headersSent)next(new ApiError('not_found'));else res.destroy();});
      input.on('close',()=>{release?.();handle?.close().catch(()=>{});});
      res.once('close',()=>{if(!res.writableFinished)input.destroy();release?.();handle?.close().catch(()=>{});});
      res.once('finish',()=>release?.());res.status(200);input.pipe(res);
    }catch(error){release?.();try{await handle?.close();}catch{}next(error);}
  };
  const sendAttachment=async(req,res,next)=>{
    let handle;
    try{
      checkVersion(req);const {file}=authorizedAttachment(req,req.params.attachmentId);const root=privateDirectory(dataDir),filename=path.join(root,file.storage_name);
      handle=await fs.promises.open(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|(fs.constants.O_NONBLOCK||0));const st=await handle.stat();if(!st.isFile()||st.size!==file.byte_size||(st.mode&0o077)!==0)throw new ApiError('not_found');
      const etag='"'+file.sha256+'"';res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Type',file.mime_type);res.setHeader('Content-Length',String(file.byte_size));
      res.setHeader('Content-Disposition',`attachment; filename="${safeName(file.display_name).replace(/["\\]/g,'_')}"; filename*=UTF-8''${encodeURIComponent(safeName(file.display_name))}`);
      res.setHeader('Content-Digest','sha-256=:'+Buffer.from(file.sha256,'hex').toString('base64')+':');res.setHeader('ETag',etag);res.setHeader('Accept-Ranges','bytes');
      if(req.get('If-None-Match')===etag){await handle.close();return res.status(304).end();}
      let start=0,end=file.byte_size-1,status=200;const range=req.get('Range');
      if(range){const match=range.match(/^bytes=(\d*)-(\d*)$/);if(!match){await handle.close();return res.status(416).setHeader('Content-Range',`bytes */${file.byte_size}`).end();}
        if(match[1]){start=Number(match[1]);end=match[2]?Number(match[2]):end;}else{const suffix=Number(match[2]);start=Math.max(0,file.byte_size-suffix);}
        if(start>end||start>=file.byte_size){await handle.close();return res.status(416).setHeader('Content-Range',`bytes */${file.byte_size}`).end();}
        end=Math.min(end,file.byte_size-1);status=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${file.byte_size}`);res.setHeader('Content-Length',String(end-start+1));}
      res.status(status);if(req.method==='HEAD'){await handle.close();return res.end();}
      const input=handle.createReadStream({start,end,autoClose:true});input.on('error',()=>{if(!res.headersSent)next(new ApiError('not_found'));else res.destroy();});input.on('close',()=>handle?.close().catch(()=>{}));
      res.once('close',()=>{if(!res.writableFinished)input.destroy();handle?.close().catch(()=>{});});input.pipe(res);
    }catch(error){try{await handle?.close();}catch{}next(error);}
  };
  r.post('/chat/sessions/:sessionId/retry',authed,guard('openclaw'),(req,res)=>{checkVersion(req);const owner=scopeOf(req),body=req.body||{};
    if(Object.keys(body).length!==1||typeof body.turnId!=='string'||!OPAQUE.test(body.turnId))throw invalid('turnId','invalid');
    requireGrant(req,'chat','read');const row=repo.get(owner,req.params.sessionId);if(!row)throw new ApiError('not_found');const target=storedSessionTarget(req,row);
    const reservation=reserve(req,'/chat/sessions/:sessionId/retry',{sessionId:row.session_id,turnId:body.turnId});if(respondReplay(res,reservation))return;
    const caps=capabilitiesForSession(req,row);if(!caps.sendMessage||!caps.retry||row.retry_eligible_turn_id!==body.turnId||row.pending_turn_id){abandon(reservation);throw new ApiError('not_found');}
    const prior=repo.messageForTurn(row.session_id,body.turnId);if(!prior){abandon(reservation);throw new ApiError('not_found');}
    const attachmentIds=prior.attachments.map(a=>a.id),bound=attachmentIds.map(id=>repo.ownedAttachment(owner,row.session_id,id));
    if(bound.some(item=>!item||!fs.existsSync(path.join(privateDirectory(dataDir),item.storage_name)))){abandon(reservation);throw new ApiError('not_found');}
    req.authorize?.();const accepted=repo.acceptRetry({...reservation,sessionId:row.session_id,turnId:body.turnId,at:now(),principalId:principalId(req),attachmentIds});
    if(accepted.kind==='conflict')throw new ApiError('conflict',{details:[{issue:'idempotency-conflict'}]});
    if(accepted.kind==='in-flight')throw new ApiError('conflict',{details:[{issue:'idempotency-in-progress'}]});
    if(accepted.kind==='not-found'){abandon(reservation);throw new ApiError('not_found');}
    invalidate(row.session_id,owner,row.agent_id);res.status(202);mutationOk(res,{ok:true,result:accepted.result,revision:null,vm:null});
    scheduleAcceptedTurn(row.session_id,body.turnId);
  });
  let attachmentCleanupCursor=null;
  const cleanupOrphanFiles=async()=>{
    try{
      const result=await pruneAttachmentInboxPage({repo,cursor:attachmentCleanupCursor,runtimeForInstance:engine.runtimeForInstance?.bind(engine),runtimeOf,attachmentFilePort,now,log});
      attachmentCleanupCursor=result.cursor;
    }catch{try{log({event:'chat.attachment.inbox_cleanup_failed'});}catch{}}
    if([...uploadLimits.values()].some(value=>value.active>0))return;
    try{
      const root=path.join(fs.realpathSync(dataDir),'chat-attachments');if(!fs.existsSync(root))return;
      privateDirectory(dataDir);
      for(const name of fs.readdirSync(root))if(/^[a-f0-9]{64}$/.test(name)&&!repo.storageNameExists(name))try{fs.unlinkSync(path.join(root,name));}catch{}
    }catch{try{log({event:'chat.attachment.cleanup_failed'});}catch{}}
  };
  void cleanupOrphanFiles();const cleanupTimer=setInterval(()=>void cleanupOrphanFiles(),60*60*1000);cleanupTimer.unref?.();
  // Older releases could persist pending_turn_id before there was a durable
  // dispatch receipt. Resolve those ambiguous turns on boot instead of
  // leaving the UI blocked forever; never guess whether the provider ran it.
  let legacyPending,legacyCursor=null,legacyRecoveryFailures=0;
  do{
    legacyPending=repo.pendingWithoutDispatches(256,legacyCursor);
    for(const pending of legacyPending){
      const message=repo.messageForTurn(pending.session_id,pending.pending_turn_id);
      try{if(!repo.resolvePendingWithoutDispatch(pending.session_id,pending.pending_turn_id,uncertainTurnMessage(),{attachmentIds:message?.attachments?.map(item=>item.id)||[]}))legacyRecoveryFailures++;else invalidate(pending.session_id,pending.principal_scope,pending.agent_id);}
      catch{legacyRecoveryFailures++;}
    }
    if(legacyPending.length)legacyCursor=legacyPending.at(-1);
  }while(legacyPending.length===256);
  if(legacyRecoveryFailures)try{log({event:'chat.turn.recovery_failed',count:legacyRecoveryFailures});}catch{}
  let dispatchingBatch,dispatchCursor=null,dispatchRecoveryFailures=0;
  do{
    dispatchingBatch=repo.dispatchingTurnDispatches(256,dispatchCursor);
    for(const job of dispatchingBatch){
      const session=repo.get(job.principal_scope,job.session_id),message=repo.messageForTurn(job.session_id,job.turn_id);
      let recovered=false;
      if(session?.pending_turn_id===job.turn_id&&message)try{recovered=repo.completeTurnDispatch(job.session_id,job.turn_id,uncertainTurnMessage(),{attachmentIds:message.attachments.map(item=>item.id)});}catch{}
      if(!recovered){
        dispatchRecoveryFailures++;
        try{repo.discardTurnDispatch(job.session_id,job.turn_id);}catch{}
        if(session?.pending_turn_id===job.turn_id)try{repo.resolvePendingWithoutDispatch(job.session_id,job.turn_id,uncertainTurnMessage(),{attachmentIds:message?.attachments?.map(item=>item.id)||[]});}catch{}
      }else{
        invalidate(job.session_id,job.principal_scope,job.agent_id);
      }
    }
    if(dispatchingBatch.length)dispatchCursor=dispatchingBatch.at(-1);
  }while(dispatchingBatch.length===256);
  if(dispatchRecoveryFailures)try{log({event:'chat.turn.recovery_failed',count:dispatchRecoveryFailures});}catch{}
  let queuedOffset=0,queuedBatch;
  do{queuedBatch=repo.queuedTurnDispatches(256,queuedOffset);for(const job of queuedBatch)scheduleAcceptedTurn(job.session_id,job.turn_id);queuedOffset+=queuedBatch.length;}while(queuedBatch.length===256);
  return { targetRowsFor, projectSession, scopeOf, projectCreateVM, resolveProjectTarget, authorizeProjectKickoff, createProjectKickoff, projectKickoffVM, retryProjectKickoff, authorizeTopic(topic,context){
    if(!['chat-session','chat-agents','chat-agent-sessions','chat-agent-sessions-archived'].includes(topic?.name))return false;
    if(context?.apiVersion!==3)return false;
    const principal=context?.session?.userId||context?.user?.id||context?.principal?.id||null;
    const owner=scopeForAccount(principal,store);topicTokenFor(owner);if(principal)scopeUsers.set(owner,principal);
    if(!store.policy)return true;const user=context?.user||principal;
    if(!store.policy.can(user,'chat','read'))return false;
    const wireId=topic.params?.key,req={user:user&&typeof user==='object'?user:store.users?.byId?.(principal)||null,session:principal?{userId:principal}:null,query:{}};
    try{
      if(topic.name==='chat-agents')return true;
      if(['chat-agent-sessions','chat-agent-sessions-archived'].includes(topic.name)){
        if(!wireId||!repo.target(owner,wireId))return false;const target=targetFor(req,wireId);return paneReadAllowed(req,target);
      }
      if(topic.name==='chat-session'&&wireId){
        const row=repo.get(owner,wireId);if(!row)return false;const target=storedSessionTarget(req,row);return paneReadAllowed(req,target,row);
      }
      return false;
    }catch{return false;}
  },topicScope(session,kind=null){const id=session?.userId||session?.user?.id||session?.principal?.id||null,owner=scopeForAccount(id,store);if(kind==='agents'){const user=session?.user||id&&store.users?.byId?.(id)||null;return topicTokenFor(owner,'agents:'+(!store.policy||store.policy.can(user||id,'teams','read')?'teams':'chat'));}return topicTokenFor(owner);},close(){closed=true;conversationHistoryCache.close();for(const timer of dispatchTimers)dispatchScheduler.cancel(timer);dispatchTimers.clear();clearInterval(cleanupTimer);clearInterval(paneQueueTimer);}};
}
module.exports={mountChat,randomId};
