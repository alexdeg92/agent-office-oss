'use strict';
const {ApiError,invalid,sendError}=require('./v2/errors');
const {okBody}=require('./v2/envelope');
const {hashPassword}=require('../security/password');
const {declareRoute}=require('../security/route-policy');
const {CREDENTIAL_LINK_ROUTES}=require('../security/route-declarations');
const ADMISSION=Symbol('credential-link-admission');
const PATH=/^\/api\/auth\/(invitations|password-reset)\/accept\/?$/i;
function createCredentialLinks({store,auth,readonly=()=>false,derivePassword=hashPassword,timeoutMs=15000}) {
  const matches=req=>req.method==='POST'&&PATH.test(req.path);
  function admit(req,res,next) {
    if(!matches(req))return next();
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    const gate=auth.reserveCredentialAttempt(req);
    if(!gate.ok){res.setHeader('Retry-After',String(gate.retryAfterSec));return sendError(req,res,new ApiError('rate_limited'));}
    const state={open:true,hashing:false,released:false};req[ADMISSION]=state;
    state.releaseBudget=success=>{if(state.released)return;state.released=true;gate.release(success);};
    let timer;
    const release=()=>{state.open=false;clearTimeout(timer);if(!state.hashing)state.releaseBudget(false);};
    res.once('finish',release);res.once('close',release);
    timer=setTimeout(()=>{if(!state.open)return;sendError(req,res,invalid(null,'request-timeout'));release();},timeoutMs);timer.unref?.();
    if(readonly())return sendError(req,res,new ApiError('readonly'));
    if(req.headers.authorization||req.principal)return sendError(req,res,new ApiError('forbidden'));
    if(req.url.includes('?'))return sendError(req,res,invalid(null,'invalid-link'));
    if(!req.is('application/json'))return sendError(req,res,new ApiError('validation_failed',{status:415,details:[{issue:'content-type'}]}));
    if(Number(req.headers['content-length']||0)>4096)return sendError(req,res,new ApiError('validation_failed',{status:413,details:[{issue:'too-large'}]}));
    const encoding=String(req.headers['content-encoding']||'').trim().toLowerCase();
    if(encoding&&encoding!=='identity')return sendError(req,res,new ApiError('validation_failed',{status:415,details:[{issue:'content-encoding'}]}));
    next();
  }
  function mount(app) {
    for(const [key,spec] of CREDENTIAL_LINK_ROUTES) {
      const path=key.slice(5),purpose=path.includes('/invitations/')?'invite':'password-reset';
      declareRoute(app,'post',path,spec,{store,auth},async(req,res,next)=>{
        const state=req[ADMISSION];
        try {
          if(!state?.open||res.writableEnded||res.destroyed)throw new ApiError('forbidden');
          const b=req.body;
          if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['token','password'].includes(k)))throw invalid(null,'invalid-body');
          if(typeof b.token!=='string'||!new RegExp('^'+(purpose==='invite'?'ao_inv_':'ao_rst_')+'[A-Za-z0-9_-]{43}$').test(b.token))throw invalid(null,'invalid-link');
          if(typeof b.password!=='string'||b.password.length<12||b.password.length>1024)throw invalid('password','invalid');
          // Do not inspect a user/link before hashing. Recheck all link invariants inside the consume transaction.
          let passwordHash;state.hashing=true;
          try {passwordHash=await derivePassword(b.password);}
          finally {state.hashing=false;if(!state.open)state.releaseBudget(false);}
          if(!state.open||res.writableEnded||res.destroyed)return;
          if(readonly())throw new ApiError('readonly');
          const result=store.userManagement.accept({token:b.token,purpose,passwordHash},{requestId:req.requestId});
          req.managementAudited=true;state.releaseBudget(true);
          res.json(okBody(result));
        }catch(error){
          if(res.writableEnded||res.destroyed)return;
          next(error.code==='invalid-link'?invalid(null,'invalid-link'):error);
        }
      });
    }
  }
  return {matches,admit,mount};
}
module.exports={createCredentialLinks};
