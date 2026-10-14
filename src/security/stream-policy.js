'use strict';
const {ApiError}=require('../api/v2/errors');
// One authority snapshot for admission; live identity and fingerprint checks on every send.
function createStreamPolicy({store,auth,topics,project,filterFrame,revision=null,fingerprint=null,mayExposeSources=()=>false,now=Date.now}) {
  if(typeof project!=='function'||typeof filterFrame!=='function')throw new TypeError('stream projection callbacks required');
  function capture(req) {
    const ticket=req.humanStreamTicket;
    if(ticket) {
      const user=store.users.byId(ticket.userId);
      if(user?.status!=='active'||store.rbac.fingerprint(user.id)!==ticket.fingerprint
        ||!store.humanTokens.validFamilySession({familyId:ticket.familyId,sessionId:ticket.sessionId,userId:ticket.userId,generation:ticket.generation,origin:ticket.origin,audience:ticket.audience}))throw new ApiError('unauthorized');
      return {userId:user.id,roleId:user.role_id,authGeneration:user.auth_generation,fingerprint:ticket.fingerprint,sessionId:ticket.sessionId,
        session:{userId:user.id,sid:ticket.sessionId,exp:ticket.expiresAt},ticketFamilyId:ticket.familyId,ticketOrigin:ticket.origin,ticketAudience:ticket.audience,ticketTopics:[...ticket.topics]};
    }
    const session=auth.sessionOf(req),user=session&&store.users.byId(session.userId);
    if(!session||!user||user.status!=='active'||session.exp<=now()||(session.authGeneration??0)!==user.auth_generation)throw new ApiError('unauthorized');
    if(!(session.sid || session.legacyId))throw new ApiError('unauthorized');
    return {userId:user.id,roleId:user.role_id,authGeneration:user.auth_generation,
      fingerprint:store.rbac.fingerprint(user.id),sessionId:session.sid || session.legacyId,
      session:{userId:user.id,sid:session.sid,legacyId:session.legacyId,exp:session.exp},
      // Retain only credentials needed for live verification, never the request/response object.
      request:{headers:{cookie:req.headers.cookie,...(req.headers.authorization!==undefined?{authorization:req.headers.authorization}:{}),...(req.headers.origin!==undefined?{origin:req.headers.origin}:{})}}};
  }
  function valid(binding) {
    if(!binding)return false;
    if(binding.ticketFamilyId) {
      const user=store.users.byId(binding.userId);
      return !!user&&user.status==='active'&&user.auth_generation===binding.authGeneration&&binding.session.exp>now()
        &&store.rbac.fingerprint(binding.userId)===binding.fingerprint
        &&store.humanTokens.validFamilySession({familyId:binding.ticketFamilyId,sessionId:binding.sessionId,userId:binding.userId,generation:binding.authGeneration,origin:binding.ticketOrigin,audience:binding.ticketAudience});
    }
    const session=auth.sessionOf(binding.request),user=store.users.byId(binding.userId);
    return !!session && user?.status==='active' && user.auth_generation===binding.authGeneration
      && session.userId===binding.userId && (session.sid || session.legacyId)===binding.sessionId
      && session.exp>now() && (session.authGeneration??0)===binding.authGeneration && store.rbac.fingerprint(binding.userId)===binding.fingerprint;
  }
  function can(binding,raw) {
    const spec=topics.declaration(raw);
    return !!spec && valid(binding) && store.policy.can(binding.userId,spec.resource,spec.level);
  }
  return {
    capture,valid,can,
    mayExposeSources:binding=>valid(binding)&&mayExposeSources(store.users.byId(binding.userId)),
    project:(binding,raw,vm)=>{if(!can(binding,raw))throw new ApiError('forbidden',{details:[{issue:'permission-denied'}]});return project(store.users.byId(binding.userId),raw,vm);},
    revision:(binding,raw,vm)=>{if(!can(binding,raw))throw new ApiError('forbidden',{details:[{issue:'permission-denied'}]});return revision?revision(store.users.byId(binding.userId),raw,vm):null;},
    fingerprint:(binding,raw,vm)=>{if(!can(binding,raw))throw new ApiError('forbidden',{details:[{issue:'permission-denied'}]});return fingerprint?fingerprint(store.users.byId(binding.userId),raw,vm):null;},
    frame:(binding,type,data)=>valid(binding)?filterFrame(store.users.byId(binding.userId),type,data):null,
  };
}
module.exports={createStreamPolicy};
