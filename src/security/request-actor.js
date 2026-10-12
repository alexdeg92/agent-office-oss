'use strict';
const {ApiError}=require('../api/v2/errors');
// A verified identity ID is authoritative. Only pre-identity historical sessions use the legacy Person.
function humanPerson(req,store) {
  const session=req.session,userId=req.user?.id||session?.userId;
  if(userId) {
    const user=store.users.byId(userId);
    if(user?.status!=='active'||(session?.authGeneration??0)!==user.auth_generation)throw new ApiError('unauthorized');
    return user.person_id;
  }
  if(!session)throw new ApiError('unauthorized');
  return store.owner.id;
}
function requestActor(req,store) {
  if(req.principal?.kind==='agent')return {kind:'agent',agentId:req.principal.agentId};
  return {kind:'human',personId:humanPerson(req,store)};
}
module.exports={humanPerson,requestActor};
