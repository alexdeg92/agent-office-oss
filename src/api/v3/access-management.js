'use strict';
const {ApiError,invalid}=require('../v2/errors');
const {okBody}=require('../v2/envelope');
function object(value,allowed) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalid(null,'invalid-body');
  for(const key of Object.keys(value))if(!allowed.includes(key))throw invalid(null,'unexpected-field');
  return value;
}
function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
function namedConfirmation(body,{action,target,name}) {
  const value=body.confirmation;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['action','target','name','revision','changes'].includes(key)))throw new ApiError('forbidden',{details:[{issue:'confirmation-required'}]});
  const changes=Object.fromEntries(Object.entries(body).filter(([key])=>!['confirmation','expectedRevision'].includes(key)));
  if(value.action!==action||value.target!==target||value.name!==name||value.revision!==body.expectedRevision
    ||JSON.stringify(canonical(value.changes))!==JSON.stringify(canonical(changes)))throw new ApiError('forbidden',{details:[{issue:'confirmation-required'}]});
}
function mapError(error) {
  if(error instanceof ApiError)return error;
  const code=error.code||'';
  if(code==='not-found')return new ApiError('not_found');
  if(['user-revision','role-revision','email-in-use'].includes(code)||error.message==='last-active-admin'||error.message?.startsWith('UNIQUE constraint failed: users.email'))return new ApiError('conflict',{details:[{issue:['user-revision','role-revision','email-in-use'].includes(code)?code:error.message==='last-active-admin'?'last-active-admin':'email-in-use'}]});
  if(['permission-denied','unauthorized','external-account','admin-immutable','builtin-role','role-in-use'].includes(code))return new ApiError(code==='unauthorized'?'unauthorized':'forbidden',{details:[{issue:code}]});
  if(['revision-required','invalid-name','invalid-email','invalid-role','invalid-status','invalid-permissions','invalid-resource','invitation-required','builtin-reset-only','invalid-page'].includes(code))return invalid(null,code);
  return new ApiError('internal');
}
function page(query) {
  object(query,['offset','limit']);
  const integer=(value,fallback,max)=>{if(value===undefined)return fallback;if(typeof value!=='string'||!/^\d{1,7}$/.test(value)||Number(value)>max)throw invalid(null,'invalid-page');return Number(value);};
  const offset=integer(query.offset,0,1000000),limit=integer(query.limit,50,100);if(limit<1)throw invalid(null,'invalid-page');return {offset,limit};
}
function mountAccessManagement({r,store,reauthentication,readonly=()=>false}) {
  if(!reauthentication)throw new Error('shared reauthentication required');
  const api=store.userManagement;
  const publicRole=row=>({id:row.id,slug:row.slug,name:row.name,builtin:!!row.builtin,revision:row.revision,permissions:row.permissions});
  const version=(req,res,next)=>req.apiVersion===3?next():next(new ApiError('not_found'));
  const send=(res,value)=>res.json(okBody(value));
  const read=(fn)=>(req,res,next)=>{try{req.authorize();send(res,fn(req));}catch(error){next(mapError(error));}};
  const paged=(items,{offset,limit})=>({items:items.slice(offset,offset+limit),nextOffset:offset+limit<items.length?offset+limit:null});
  r.get('/users',version,read(req=>{const p=page(req.query),items=api.list({offset:p.offset,limit:p.limit}),more=api.list({offset:p.offset+p.limit,limit:1});return {items,nextOffset:more.length?p.offset+p.limit:null};}));
  r.get('/users/:id',version,read(req=>{object(req.query,[]);return api.user(req.params.id);}));
  r.get('/roles',version,read(req=>paged(api.roles().map(publicRole),page(req.query))));
  r.get('/permissions/resources',version,read(req=>{object(req.query,[]);return {revision:store.rbac.state().registry_revision,items:store.db.prepare('SELECT key,parent,namespace,active FROM permission_resources ORDER BY key').all().map(({active,...row})=>{
    const descriptor=store.registry.get(row.key);return {...row,labelKey:descriptor?.labelKey||'permissions.'+row.key,privileged:descriptor?descriptor.privileged:null,available:!!active&&!!descriptor};
  })};}));
  function mutation(method,path,fields,targetOf,call,{create=false}={}) {
    r[method](path,version,(req,res,next)=>{
      try {
        req.authorize();if(readonly())throw new ApiError('readonly');
        const proof=reauthentication.requireRecent(req),body=object(req.body,[...fields,'expectedRevision','confirmation']);
        if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<(create?0:1)||create&&body.expectedRevision!==0)throw invalid('expectedRevision','required');
        const target=targetOf(req,body);
        namedConfirmation(body,{action:req.routePolicy.command,...target});
        const payload=Object.fromEntries(Object.entries(body).filter(([key])=>key!=='confirmation'));
        if(method==='patch'&&!fields.some(key=>Object.hasOwn(payload,key)))throw invalid(null,'empty-change');
        const ctx={userId:proof.userId,authGeneration:proof.generation,requestId:req.requestId,authorize:()=>{req.authorize();reauthentication.requireRecent(req);}};
        // Repository checks the live authority again inside its transaction and records its own audit.
        // A synchronous committed command may invalidate its caller; return only that accepted operation's result.
        const result=call(req,payload,ctx);req.managementAudited=true;
        send(res,{ok:true,result});
      }catch(error){next(mapError(error));}
    });
  }
  const userTarget=req=>{const user=api.user(req.params.id);return {target:user.id,name:user.name};};
  const roleTarget=req=>{const role=store.rbac.role(req.params.id);if(!role)throw new ApiError('not_found');return {target:role.id,name:role.name};};
  mutation('post','/users/invitations',['email','name','roleId'],(req,b)=>({target:typeof b.email==='string'?b.email.trim().toLowerCase():null,name:b.name}),(req,b,ctx)=>api.invite(b,ctx),{create:true});
  mutation('post','/users/:id/invitation',[],userTarget,(req,b,ctx)=>api.resendInvitation(req.params.id,b,ctx));
  mutation('patch','/users/:id',['roleId','status','name'],userTarget,(req,b,ctx)=>api.editUser(req.params.id,b,ctx));
  mutation('put','/users/:id/overrides',['permissions'],userTarget,(req,b,ctx)=>api.overrides(req.params.id,b,ctx));
  mutation('post','/users/:id/password-reset',[],userTarget,(req,b,ctx)=>api.resetPassword(req.params.id,b,ctx));
  mutation('post','/users/:id/revoke-sessions',[],userTarget,(req,b,ctx)=>api.revoke(req.params.id,b,ctx));
  mutation('delete','/users/:id',[],userTarget,(req,b,ctx)=>api.deleteUser(req.params.id,b,ctx));
  mutation('post','/roles',['name','permissions'],(req,b)=>({target:'new-role',name:b.name}),(req,b,ctx)=>publicRole(api.createRole(b,ctx)),{create:true});
  mutation('put','/roles/:id',['name','permissions'],roleTarget,(req,b,ctx)=>publicRole(api.editRole(req.params.id,b,ctx)));
  mutation('delete','/roles/:id',[],roleTarget,(req,b,ctx)=>api.deleteRole(req.params.id,b,ctx));
  mutation('post','/roles/:id/reset',[],roleTarget,(req,b,ctx)=>publicRole(api.resetRole(req.params.id,b,ctx)));
}
module.exports={mountAccessManagement,namedConfirmation,mapError};
