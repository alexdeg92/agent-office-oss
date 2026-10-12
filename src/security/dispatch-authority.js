'use strict';
const {ApiError}=require('../api/v2/errors');
const {COMMANDS}=require('./route-declarations');
// Persist only verified admission metadata. A queued job never stores or reconstructs a bearer credential.
function createDispatchAuthority({store,now=Date.now}) {
  const fields=['userId','personId','generation','sessionId','expiresAt','command','legacy','familyId','origin','audience'];
  function authorize(binding,{commands,requirements=[]}={}) {
    if(!binding||Object.keys(binding).some(k=>!fields.includes(k))||!commands?.includes(binding.command)
      ||!['userId','personId','sessionId','command'].every(k=>typeof binding[k]==='string'&&binding[k].length>0&&binding[k].length<=160)
      ||!Number.isSafeInteger(binding.generation)||!Number.isFinite(binding.expiresAt)||binding.expiresAt<=now()||typeof binding.legacy!=='boolean')throw new ApiError('unauthorized');
    const user=store.users.byId(binding.userId),spec=COMMANDS.get(binding.command);
    if(user?.status!=='active'||user.person_id!==binding.personId||user.auth_generation!==binding.generation||store.sessions.isRevoked(binding.sessionId))throw new ApiError('unauthorized');
    if(binding.familyId!==undefined) {
      if(binding.legacy||typeof binding.familyId!=='string'||binding.familyId.length>160||!store.humanTokens.validFamilySession(binding))throw new ApiError('unauthorized');
    } else if(binding.origin!==undefined||binding.audience!==undefined||binding.sessionId.startsWith('family:'))throw new ApiError('unauthorized');
    if(binding.legacy) {
      const state=store.rbac.state();
      if(state.owner_user_id!==user.id||state.legacy_cookie_generation!==0||binding.generation!==0
        ||!state.legacy_cookie_deadline||now()>=state.legacy_cookie_deadline||binding.expiresAt>state.legacy_cookie_deadline)throw new ApiError('unauthorized');
    }
    if(!spec||spec.kind!=='permissions'||!spec.requirements.length||![...spec.requirements,...requirements].every(r=>store.policy.can(user,r.resource,r.level)))throw new ApiError('forbidden',{details:[{issue:'permission-denied'}]});
    return user;
  }
  function capture(req) {
    if(!req||typeof req.authorize!=='function')throw new ApiError('unauthorized');
    req.authorize();
    if(req.principal||!req.user||!req.session)throw new ApiError('unauthorized');
    const binding={userId:req.user.id,personId:req.user.person_id,generation:req.user.auth_generation,
      sessionId:req.session.sid||req.session.legacyId,expiresAt:req.session.exp,command:req.routePolicy.command,legacy:!!req.session.legacy,
      ...(req.session.familyId?{familyId:req.session.familyId,origin:req.session.origin,audience:req.session.audience}:{})};
    authorize(binding,{commands:[req.routePolicy.command]});
    return binding;
  }
  return {capture,authorize};
}
module.exports={createDispatchAuthority};
