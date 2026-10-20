'use strict';
const {ApiError,invalid,sendError}=require('./v2/errors');
const {declareRoute}=require('../security/route-policy');
const {APP_ROUTES}=require('../security/route-declarations');
const {createRefreshLimits}=require('../security/refresh-limits');
const PATH=/^\/api\/auth\/refresh\/?$/i,COOKIE='__Secure-ao_refresh',ADMISSION=Symbol('human-auth-admission');
function refreshCookie(req) {
  let value=null,count=0;
  for(const part of String(req.headers.cookie||'').split(';')) {
    const i=part.indexOf('=');if(i<0||part.slice(0,i).trim()!==COOKIE)continue;
    count++;try{value=decodeURIComponent(part.slice(i+1).trim());}catch{throw new ApiError('unauthorized');}
  }
  if(count>1)throw new ApiError('unauthorized');return value;
}
function createHumanAuthTransport({store,auth,boundary,me,partitioned=false,timeoutMs=15000,limits=createRefreshLimits(),verify=(...args)=>auth.verifyAdmittedCredentials(...args)}) {
  if(typeof boundary!=='function'||typeof me!=='function'||typeof partitioned!=='boolean'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)throw new TypeError('invalid human auth transport');
  const matches=req=>req.method==='POST'&&PATH.test(req.path);
  function cookieAttrs(policy,expiresAt) {
    const prefix=new URL(policy.apiPublicUrl).pathname.replace(/\/$/,'');
    return '; HttpOnly; Secure; SameSite=None; Path='+prefix+'/api/auth/refresh; Max-Age='+Math.max(0,Math.floor((expiresAt-Date.now())/1000))+'; Expires='+new Date(expiresAt).toUTCString()+(partitioned?'; Partitioned':'');
  }
  const clear=(res,policy)=>res.setHeader('Set-Cookie',COOKIE+'='+cookieAttrs(policy,0));
  function assertCurrent(req,res,state) {
    const policy=boundary();
    if(!state?.open||res.writableEnded||res.destroyed)return false;
    if(policy!==state.policy||!policy.allows(req.headers.origin)) {
      if(!policy.allows(req.headers.origin))for(const h of ['Access-Control-Allow-Origin','Access-Control-Allow-Credentials','Access-Control-Expose-Headers'])res.removeHeader(h);
      throw new ApiError('forbidden',{details:[{issue:'access-config-changed'}]});
    }
    return true;
  }
  function audit(req,{policy,actor={kind:'anonymous'},command='auth.refresh',status,detail=null}) {
    const outcome=status>=500?'failed':status>=400?'rejected':'ok';
    try {store.audit.append({at:Date.now(),requestId:req.requestId||'req_unknown',actor,command,target:null,outcome,detail:outcome==='ok'?null:detail||'http-'+status,origin:policy.allows(req.headers.origin)?req.headers.origin:null});}catch{} // categorized only; never credentials/body
  }
  function corsRefused(req,res,issue) {
    if(!matches(req))return;
    limits.admit(req.ip||req.socket?.remoteAddress||'unknown');
    audit(req,{policy:boundary(),status:403,detail:issue});
  }
  function admit(req,res,next) {
    if(!matches(req))return next();
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    const policy=boundary();if(!policy.allows(req.headers.origin))return sendError(req,res,new ApiError('forbidden',{details:[{issue:'origin'}]}));
    let presented,cookieError;try{presented=refreshCookie(req);}catch(error){cookieError=error;}
    let audited=false,actor={kind:'anonymous'},command='auth.refresh',detail=null;
    const json=res.json.bind(res);res.json=value=>{const issue=value?.error?.details?.[0]?.issue;if(typeof issue==='string'&&/^[a-z][a-z0-9-]{0,40}$/.test(issue))detail=issue;return json(value);};
    const record=(status=res.statusCode)=>{if(audited)return;audited=true;audit(req,{policy,actor,command,status,detail});};res.once('finish',()=>record());res.once('close',()=>record(res.writableEnded?res.statusCode:499));
    const rate=limits.admit(req.ip||req.socket?.remoteAddress||'unknown',store.humanTokens.refreshAdmissionId(presented));
    if(!rate.ok){res.setHeader('Retry-After',String(rate.retryAfterSec));return sendError(req,res,new ApiError('rate_limited'));}
    const gate=auth.reserveCredentialWork(req);
    if(!gate.ok){res.setHeader('Retry-After',String(gate.retryAfterSec));return sendError(req,res,new ApiError('rate_limited'));}
    const state={open:true,hashing:false,released:false,gate,policy,presented};req[ADMISSION]=state;
    state.release=ok=>{if(state.released)return;state.released=true;gate.release(ok);};
    let timer;const end=()=>{state.open=false;clearTimeout(timer);if(!state.hashing)state.release(false);};
    res.once('finish',end);res.once('close',end);
    timer=setTimeout(()=>{if(!state.open)return;sendError(req,res,new ApiError('validation_failed',{status:408,details:[{issue:'request-timeout'}]}));end();},timeoutMs);timer.unref?.();
    state.capture=(value,op)=>{actor=value||{kind:'anonymous'};command='auth.'+op;};
    state.auditCommitted=()=>{audited=true;};
    if(cookieError){clear(res,policy);return sendError(req,res,cookieError);}
    if(Object.hasOwn(req.headers,'authorization'))return sendError(req,res,new ApiError('forbidden'));
    if(req.headers['x-ao-request']!=='1')return sendError(req,res,new ApiError('forbidden',{details:[{issue:'request-header'}]}));
    if(req.url.includes('?'))return sendError(req,res,invalid(null,'unexpected-query'));
    const encoding=String(req.headers['content-encoding']||'').trim().toLowerCase(),charset=/;\s*charset\s*=\s*"?([^";\s]+)/i.exec(String(req.headers['content-type']||''));
    if(!req.is('application/json')||charset&&charset[1].toLowerCase()!=='utf-8'||encoding&&encoding!=='identity')return sendError(req,res,new ApiError('validation_failed',{status:415,details:[{issue:'content-type'}]}));
    if(Number(req.headers['content-length']||0)>4096)return sendError(req,res,new ApiError('validation_failed',{status:413,details:[{issue:'too-large'}]}));
    next();
  }
  function body(req) {
    const b=req.body;
    if(!b||typeof b!=='object'||Array.isArray(b)||!['challenge','login','refresh','logout'].includes(b.operation))throw invalid(null,'invalid-operation');
    const keys=b.operation==='challenge'?['operation','purpose']:b.operation==='login'?['operation','email','password']:['operation'];
    if(Object.keys(b).some(k=>!keys.includes(k)))throw invalid(null,'unexpected-field');
    return b;
  }
  function mount(app) {
    declareRoute(app,'post','/api/auth/refresh',APP_ROUTES.get('POST /api/auth/refresh'),{store,auth},async(req,res)=>{
      const state=req[ADMISSION];
      try {
        if(!assertCurrent(req,res,state))return;
        const b=body(req);state.capture(null,b.operation);
        let auditWritten=false;
        const auditWrite=(user,outcome='ok',detail=null)=>{store.audit.append({at:Date.now(),requestId:req.requestId,actor:user?{kind:'human',personId:user.person_id}: {kind:'anonymous'},command:'auth.'+b.operation,target:null,outcome,detail,origin:req.headers.origin});auditWritten=true;};
        const committed=()=>{if(auditWritten)state.auditCommitted();};
        const common={auditWrite,origin:req.headers.origin,audience:state.policy.audience,refreshToken:state.presented,csrfToken:req.headers['x-ao-csrf']};
        if(b.operation==='challenge') {
          if(!['login','refresh','logout'].includes(b.purpose))throw invalid('purpose','invalid');
          const result=store.humanTokens.createChallenge({...common,purpose:b.purpose});committed();
          if(!result.ok){if(result.issue==='limited'){res.setHeader('Retry-After','120');throw new ApiError('rate_limited');}throw new ApiError('unauthorized');}
          state.release(false);return res.json({csrfToken:result.csrfToken,expiresAt:result.expiresAt,purpose:result.purpose});
        }
        let issued;
        if(b.operation==='login') {
          if(typeof b.email!=='string'||b.email.length>320||typeof b.password!=='string'||b.password.length>1024)throw invalid(null,'invalid-credentials');
          if(!store.humanTokens.loginChallengeCurrent(common))throw new ApiError('unauthorized');
          let verified;state.hashing=true;
          try{verified=await verify(req,{email:b.email,password:b.password},state.gate);}finally{state.hashing=false;if(!state.open)state.release(false);}
          if(!assertCurrent(req,res,state))return;
          if(verified.retryAfterSec){res.setHeader('Retry-After',String(verified.retryAfterSec));throw new ApiError('rate_limited');}
          if(!verified.ok||!verified.identity?.userId)throw new ApiError('unauthorized');
          // A recovery credential is deliberately confined to the signed repair
          // cookie flow in /api/login. It must never be exchanged for a bearer
          // family, even when the same stable Owner account is returned.
          if(verified.identity.recoveryOnly===true) {
            auditWrite(store.users.byId(verified.identity.userId),'rejected','recovery-login');committed();
            state.release(false);throw new ApiError('unauthorized');
          }
          // Verify actual HMAC cookie with the historical auth implementation; its
          // user/generation/SID/expiry are checked again inside loginFamily.
          state.capture({kind:'human',personId:verified.identity.personId},'login');
          const cookieSession=auth.verifySession(auth.parseCookies(req).taco_sess);
          issued=store.humanTokens.loginFamily({...common,userId:verified.identity.userId,expectedGeneration:verified.identity.authGeneration,cookieSession});
        } else if(b.operation==='refresh'){state.capture(store.humanTokens.refreshAuditActor(state.presented,common),'refresh');issued=store.humanTokens.rotate(common);}
        else {
          if(state.presented===null){state.release(false);clear(res,state.policy);return res.json({ok:true});}
          state.capture(store.humanTokens.refreshAuditActor(state.presented,common),'logout');
          issued=store.humanTokens.logout(common);committed();
          clear(res,state.policy);
          if(!issued.ok)throw new ApiError('unauthorized');state.release(false);return res.json({ok:true});
        }
        committed();
        if(!issued.ok){if(b.operation==='refresh')clear(res,state.policy);throw new ApiError('unauthorized');}
        const resolved=store.humanTokens.resolveAccess(issued.accessToken,{audience:state.policy.audience,origin:req.headers.origin});
        if(!resolved.ok)throw new ApiError('unauthorized');
        const currentMe=me(resolved.session); // synchronous current identity/policy projection
        res.setHeader('Set-Cookie',COOKIE+'='+issued.refreshToken+cookieAttrs(state.policy,issued.refreshExpiresAt));state.release(b.operation==='login');
        res.json({accessToken:issued.accessToken,expiresAt:issued.accessExpiresAt,me:currentMe});
      }catch(error){if(res.writableEnded||res.destroyed)return;sendError(req,res,error);}
    });
  }
  return {matches,admit,mount,boundary,corsRefused};
}
module.exports={createHumanAuthTransport,refreshCookie,COOKIE};
