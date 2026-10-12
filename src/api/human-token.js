'use strict';
const {ApiError,sendError}=require('./v2/errors');
const {createRefreshLimits}=require('../security/refresh-limits');
const BEARER=/^Bearer ([^\s]+)$/;
const STREAM_PATH=/^\/api\/v[23]\/stream\/?$/i;
// Opt-in composition around the existing machine gate. Human authority remains
// a verified session; req.principal is reserved for the machine's scoped actor.
function createHumanTokenGate({store,auth,boundary,agentGate,limits=createRefreshLimits({ipLimit:600,familyLimit:300,maxFamilies:10000})}) {
  if(typeof boundary!=='function'||typeof agentGate?.auth!=='function'||typeof agentGate?.scope!=='function')throw new TypeError('invalid human token gate');
  function resolve(req) {
    const policy=boundary(),m=BEARER.exec(String(req.headers.authorization||''));
    if(!m||!policy.allows(req.headers.origin))return {ok:false,issue:'unauthorized'};
    return store.humanTokens.resolveAccess(m[1],{audience:policy.audience,origin:req.headers.origin});
  }
  auth.useHumanAccess({resolve:req=>{const result=resolve(req);return result.ok?result.session:null;},
    cookieAllowed:req=>req.headers.origin===undefined||req.headers.origin===boundary().apiOrigin});
  function record(req,session,detail) {
    req.auditedByGate=true;
    const policy=boundary();
    try{store.audit.append({at:Date.now(),requestId:req.requestId||'req_unknown',actor:session?{kind:'human',personId:session.personId}:{kind:'anonymous'},command:'token.request',target:null,outcome:'rejected',detail,origin:policy.allows(req.headers.origin)?req.headers.origin:null});}catch{}
  }
  function refuse(req,res,error,session=null) {
    record(req,session,error.code==='rate_limited'?'rate-limited':error.details?.[0]?.issue||'unauthorized');
    return sendError(req,res,error);
  }
  function corsRefused(req,res) {
    if(!Object.hasOwn(req.headers,'authorization'))return;
    limits.admit(req.ip||req.socket?.remoteAddress||'unknown');record(req,null,'origin');
  }
  function authenticate(req,res,next) {
    // Native EventSource cannot attach Authorization. A one-use ticket is consumed
    // before route admission and becomes a narrowly scoped, internal stream session.
    if(req.method==='GET'&&STREAM_PATH.test(req.path)) {
      let parsed;try{parsed=new URL(req.originalUrl,'http://agent-office.invalid');}catch{return next(new ApiError('unauthorized'));}
      const tickets=parsed.searchParams.getAll('ticket');
      if(tickets.length||parsed.searchParams.has('ticket')) {
        if(tickets.length!==1||[...parsed.searchParams.keys()].some(key=>key!=='ticket')||Object.hasOwn(req.headers,'authorization'))return next(new ApiError('unauthorized'));
        delete req.headers.cookie;res.setHeader('Cache-Control','no-store');
        const policy=boundary(),result=store.humanTokens.consumeStreamTicket({ticket:tickets[0],origin:req.headers.origin,audience:policy.audience});
        if(!result.ok)return next(new ApiError('unauthorized'));
        const rate=limits.admit(req.ip||req.socket?.remoteAddress||'unknown',result.userId);
        if(!rate.ok){res.setHeader('Retry-After',String(rate.retryAfterSec));return next(new ApiError('rate_limited'));}
        req.humanStreamTicket=result;return next();
      }
    }
    if(!Object.hasOwn(req.headers,'authorization'))return next();
    delete req.headers.cookie;
    res.setHeader('Cache-Control','no-store');
    const m=BEARER.exec(String(req.headers.authorization));
    // Only the recognized machine credential class reaches its original gate.
    if(m&&/^aot_[A-Za-z0-9_-]{43}$/.test(m[1]))return agentGate.auth(req,res,next);
    const result=resolve(req),session=result.ok?result.session:null;
    const rate=limits.admit(req.ip||req.socket?.remoteAddress||'unknown',session?.userId);
    if(!rate.ok){res.setHeader('Retry-After',String(rate.retryAfterSec));return refuse(req,res,new ApiError('rate_limited'),session);}
    if(!session)return refuse(req,res,new ApiError('unauthorized',{details:result.issue==='access-stale'?[{issue:'access-stale'}]:[] }));
    // Legacy cookie endpoints keep their credential behavior. Token mode owns
    // login/logout through the purpose-bound refresh protocol instead.
    if(/^\/api\/(?:login|logout)\/?$/i.test(req.path))return refuse(req,res,new ApiError('forbidden',{details:[{issue:'auth-transport'}]}),session);
    req.session=session;req.user=store.users.byId(session.userId);next();
  }
  return {auth:authenticate,scope:agentGate.scope,corsRefused};
}
module.exports={createHumanTokenGate};
