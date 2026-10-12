'use strict';
const {ApiError,invalid}=require('../api/v2/errors');
const WINDOW_MS=300000,MAX_CONFIRMATIONS=1024;
const required=()=>new ApiError('forbidden',{details:[{issue:'reauth-required'}]});
// Shared by current-user Settings and management commands. Never stores a password or a permission matrix.
function createReauthentication({store,auth,now=Date.now,elapsed=()=>Number(process.hrtime.bigint()/1000000n)}) {
  const confirmations=new Map();let closed=false;
  function identity(req) {
    if(closed)throw new ApiError('unauthorized');
    req.authorize?.();
    const session=auth.sessionOf(req),user=session&&store.users.byId(session.userId);
    const sessionId=session?.sid||session?.legacyId;
    if(req.principal||!sessionId||session.exp<=now()||user?.status!=='active'||(session.authGeneration??0)!==user.auth_generation||req.user&&req.user.id!==user.id)throw new ApiError('unauthorized');
    return {userId:user.id,roleId:user.role_id,generation:user.auth_generation,sessionId,
      fingerprint:store.rbac.fingerprint(user.id),key:user.id+':'+sessionId,session,user};
  }
  function matches(row,binding) {
    return row&&row.userId===binding.userId&&row.sessionId===binding.sessionId&&row.generation===binding.generation&&row.fingerprint===binding.fingerprint&&elapsed()<row.until;
  }
  function invalidate(change) {
    for(const [key,row] of confirmations)if(change.registry||change.userId&&change.userId===row.userId||change.roleId&&change.roleId===row.roleId||change.sessionId&&change.sessionId===row.sessionId)confirmations.delete(key);
  }
  store.authorizationEvents.on('change',invalidate);
  async function confirm(req,password,res) {
    if(typeof password!=='string'||password.length>1024)throw invalid('password','invalid');
    const before=identity(req);
    // createAuth owns login's shared IP/global/in-flight throttle and actual-source credential verification.
    const result=await auth.confirmPassword(req,password);
    if(result.rateLimit) {
      res?.setHeader('Retry-After',String(result.rateLimit.retryAfterSec));
      throw new ApiError('rate_limited');
    }
    if(!result.ok)throw new ApiError('unauthorized',{details:[{issue:'current-password'}]});
    const after=identity(req);
    if(after.key!==before.key||after.generation!==before.generation||after.fingerprint!==before.fingerprint)throw new ApiError('unauthorized');
    const monotonic=elapsed(),expiresAt=now()+WINDOW_MS;
    for(const [key,row] of confirmations)if(monotonic>=row.until)confirmations.delete(key);
    if(confirmations.size>=MAX_CONFIRMATIONS&&!confirmations.has(after.key))confirmations.delete(confirmations.keys().next().value);
    confirmations.set(after.key,{userId:after.userId,roleId:after.roleId,generation:after.generation,sessionId:after.sessionId,fingerprint:after.fingerprint,until:monotonic+WINDOW_MS,expiresAt});
    return {expiresAt};
  }
  function requireRecent(req) {
    const binding=identity(req),row=confirmations.get(binding.key);
    if(!matches(row,binding)){confirmations.delete(binding.key);throw required();}
    return binding;
  }
  function expiresAt(req) {
    try {const binding=identity(req),row=confirmations.get(binding.key);if(matches(row,binding))return row.expiresAt;confirmations.delete(binding.key);}catch{}
    return null;
  }
  function clear(req) {const binding=identity(req);confirmations.delete(binding.key);}
  return {identity,confirm,requireRecent,expiresAt,clear,
    close:()=>{closed=true;confirmations.clear();store.authorizationEvents.off('change',invalidate);}};
}
module.exports={createReauthentication,WINDOW_MS,MAX_CONFIRMATIONS};
