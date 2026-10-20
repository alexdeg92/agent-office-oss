'use strict';
/*
 * Typed on-demand reads (ADR-001 §12.4). Each read asks the runtime and resolves once the answer has been
 * ingested: the taps feed the RPC/CLI output through the engine (validation, quarantine, last-good), so the
 * caller then reads the canonical value from the engine. → { ok: true } | { ok: false, category }.
 * Each read exists iff its capability is true (definition.capabilities()).
 */
const { errorCategory } = require('../../engine/redact');
const { createBoundedPrivateCache } = require('../../util/bounded-private-cache');
const { redactAttachmentBlocks, redactAttachmentLocators, attachmentPathLabels } = require('./normalise/transcript');

const fail = (e) => ({ ok: false, category: errorCategory(e && e.message) });

function bind({ gw, cli, conversationCacheOptions = {}, attachmentInboxName = 'agent-office-inbox' }) {
  const conversationCache=createBoundedPrivateCache(conversationCacheOptions);
  const activeSubscriptions=new Set();let closed=false;
  const canonicalMessage=(message,labels=new Map())=>{
    const id=message?.id||message?.messageId||message?.__openclaw?.messageId;
    if(typeof id!=='string'||!['user','assistant'].includes(message?.role))return null;
    const content=message?.text??message?.content??message?.message?.content;
    const text=typeof content==='string'?content:Array.isArray(content)?content.map(part=>typeof part==='string'?part:(typeof part?.text==='string'?part.text:'')).filter(Boolean).join('\n').trim():'';
    const at=Number.isSafeInteger(message.timestamp)?message.timestamp:(Date.parse(message.timestamp)||Date.now());
    const clean=redactAttachmentLocators(message.role==='user'?redactAttachmentBlocks(text):text,{labels,inboxName:attachmentInboxName});
    return {id,role:message.role,at,text:clean.slice(0,8000),model:message.model||message.__openclaw?.model||null,
      tokens:Number.isSafeInteger(message.usage?.totalTokens)?message.usage.totalTokens:null};
  };
  const olderPage=result=>{
    // Current Gateway chat.history returns continuation at the top level.
    // Do not infer it from page size: filtered transcript rows can make that
    // offset wrong and silently skip older messages.
    const nextOffset=Number.isSafeInteger(result?.nextOffset)&&result.nextOffset>=0&&result.nextOffset<=9_999_999_999?result.nextOffset:null;
    const hasOlder=result?.hasMore===true&&nextOffset!==null;
    return {olderCursor:hasOlder?String(nextOffset):null,hasOlder};
  };
  const conversationHistory=async({sessionKey,agentId,cursor,before,limit=50}={})=>{
    if(closed)throw new Error('conversation reader is closed');
    if(typeof sessionKey!=='string'||!sessionKey)throw new TypeError('conversation history requires a session key');
    const pageLimit=Math.max(1,Math.min(200,limit));
    // `cursor` is Gateway delta synchronization; `before` is canonical older
    // history pagination. Keep them disjoint because chat.history rejects a
    // cursor combined with an offset.
    if(before!==undefined){
      if(typeof before!=='string'||!/^(0|[1-9][0-9]{0,9})$/.test(before))throw new TypeError('conversation history continuation is invalid');
      const offset=Number(before);if(!Number.isSafeInteger(offset))throw new TypeError('conversation history continuation is invalid');
      const result=await gw.call('chat.history',{sessionKey,...(agentId?{agentId}:{}),offset,limit:pageLimit});
      if(!result||!Array.isArray(result.messages))throw new Error('conversation history unavailable');
      const labels=attachmentPathLabels(result.messages);const messages=result.messages.map(message=>canonicalMessage(message,labels)).filter(Boolean).sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
      return {messages,cursor:null,conversationId:result.sessionInfo?.sessionId||result.sessionInfo?.id||null,...olderPage(result)};
    }
    let cached=conversationCache.get(sessionKey);const prior=cached?.messages||[];const nextCursor=cursor||cached?.cursor||null;
    let result=await gw.call('chat.history',{sessionKey,...(agentId?{agentId}:{}),...(nextCursor?{cursor:nextCursor}:{limit:pageLimit})});
    if(result?.kind==='reset'){
      result=await gw.call('chat.history',{sessionKey,...(agentId?{agentId}:{}),limit:Math.max(1,Math.min(200,limit))});
      conversationCache.delete(sessionKey);cached=null;
    }
    if(!result||!Array.isArray(result.messages))throw new Error('conversation history unavailable');
    const current=result.kind==='delta'?prior:[],byId=new Map(current.map(message=>[message.id,message]));
    const labels=attachmentPathLabels(result.messages);for(const raw of result.messages){const message=canonicalMessage(raw,labels);if(message)byId.set(message.id,message);}
    const all=[...byId.values()].sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id)).slice(-Math.max(1,Math.min(200,limit)));
    const sessionInfo=result.sessionInfo||{};const conversationId=sessionInfo.sessionId||sessionInfo.id||cached?.conversationId||null;
    const continuation=olderPage(result);
    const next={messages:all,cursor:typeof result.deltaCursor==='string'?result.deltaCursor:(cached?.cursor||null),conversationId,
      olderCursor:continuation.hasOlder?continuation.olderCursor:(cached?.olderCursor||null),hasOlder:continuation.hasOlder||cached?.hasOlder===true};
    conversationCache.set(sessionKey,next);
    return next;
  };
  // `background` (architect-54, the project-tag scan): a failed read is not recorded as a source error (a session may be
  // gone since the list); a successful one is ingested like any other. The flag never reaches the gateway.
  const rpc = (method, params, opts = {}) => gw.call(method, params, opts.background ? { background: true } : undefined).then(() => ({ ok: true }), fail);
  const chatHistory = ({ sessionKey, agentId, cursor, limit = 50, maxBytes } = {}) => {
    if (typeof sessionKey !== 'string' || !sessionKey) return Promise.reject(new TypeError('chat history requires a session key'));
    return gw.call('chat.history', { sessionKey, ...(typeof agentId === 'string' && agentId ? { agentId } : {}),
      ...(typeof cursor === 'string' && cursor ? { cursor } : {}),
      ...(!cursor && Number.isSafeInteger(limit) ? { limit: Math.max(1, Math.min(200, limit)) } : {}),
      ...(Number.isSafeInteger(maxBytes) && maxBytes >= 1024 ? { maxBytes } : {}) });
  };
  const subscribeChat = async ({ sessionKey, agentId, onEvent } = {}) => {
    if(closed)throw new Error('conversation reader is closed');
    if (typeof sessionKey !== 'string' || !sessionKey || typeof onEvent !== 'function') throw new TypeError('chat subscription requires a session key and listener');
    const subscriptionId = 'ao-chat-' + require('node:crypto').randomUUID();
    const matches = payload => payload && (payload.sessionKey === sessionKey || payload.key === sessionKey) &&
      (!agentId || !payload.agentId || payload.agentId === agentId);
    const listener = (event, payload) => {
      if (!['session.message', 'agent', 'chat'].includes(event) || !matches(payload)) return;
      try { onEvent({ event, payload }); } catch { /* event consumers must not break the shared gateway connection */ }
    };
    gw.on('gwevent', listener);
    try {
      await gw.call('sessions.messages.subscribe', { key: sessionKey, ...(agentId ? { agentId } : {}), subscriptionId });
    } catch (error) {
      gw.off('gwevent', listener);
      throw error;
    }
    let stopped = false;
    const stop=async () => {
      if (stopped) return;
      stopped = true;
      activeSubscriptions.delete(stop);
      gw.off('gwevent', listener);
      try { await gw.call('sessions.messages.unsubscribe', { key: sessionKey, ...(agentId ? { agentId } : {}), subscriptionId }); } catch {}
    };
    activeSubscriptions.add(stop);
    return stop;
  };
  return {
    chatHistory,
    subscribeChat,
    conversationHistory,
    async subscribeConversation({sessionKey,agentId,onChange}={}){
      const stop=await subscribeChat({sessionKey,agentId,onEvent:()=>onChange?.()});let stopped=false;
      return async()=>{if(stopped)return;stopped=true;await stop();conversationCache.delete(sessionKey);};
    },
    close(){if(closed)return;closed=true;conversationCache.close();for(const stop of [...activeSubscriptions])void stop();},
    // sessions.get takes the key only on 2026.9.8; the window is applied by the caller (transcript normaliser).
    transcript: (sessionKey, opts = {}) => rpc('sessions.get', { key: sessionKey }, opts),
    describeSession: (sessionKey) => rpc('sessions.describe', { key: sessionKey }),
    // S7b: the session-group catalog (read scope, path-free); membership arrives on the session rows (`category`)
    sessionGroups: () => rpc('sessions.groups.list', {}),
    flowRuns: (flowId, opts = {}) => rpc('cron.runs', Object.assign({ jobId: flowId }, Number.isInteger(opts.limit) ? { limit: Math.min(200, Math.max(1, opts.limit)) } : {})),
    // Per-agent CLI command: --agent is mandatory (CLAUDE.md gotcha). The primary agent comes from the resolver in G3a.
    skillInfo: async (name, opts = {}) => {
      if (!opts.agentId) return { ok: false, category: 'missing-agent' };   // G3a: the caller passes the resolver's primary
      const r = await cli.run(['skills', 'info', name, '--agent', opts.agentId, '--json'], 30000);
      if (r.ok) return { ok: true };
      return { ok: false, category: r.refused || errorCategory(r.err) };
    },
  };
}

module.exports = { bind };
