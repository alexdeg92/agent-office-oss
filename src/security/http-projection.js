'use strict';
const {ApiError}=require('../api/v2/errors');
const {COMMANDS}=require('./route-declarations');
// Embedded views follow the exact declared command. Unknown commands never guess a schema.
const COMMAND_VIEWS=new Map([
  ...[...COMMANDS.keys()].filter(name=>name.startsWith('projects.')&&!['projects.comment','projects.retryComment','projects.editComment','projects.deleteComment'].includes(name)).map(name=>[name,'project']),
  ['office.saveLayout','layout'],['office.setTheme','layout'],
  ...[...COMMANDS.keys()].filter(name=>name.startsWith('settings.')).map(name=>[name,'settings']),
]);
function createHttpProjection({store,projector,reauthentication=null}) {
  function withConfirmation(req,name,value) {
    if(name==='settings'&&reauthentication)value.reauth={...value.reauth,expiresAt:reauthentication.expiresAt(req)};
    return value;
  }
  function current(req) {
    req.authorize();
    const user=store.users.byId(req.user.id);
    if(user?.status!=='active'||user.auth_generation!==req.user.auth_generation)throw new ApiError('unauthorized');
    return user;
  }
  function commandView(req,vm) {
    const name=COMMAND_VIEWS.get(req.routePolicy?.command);
    if(!name)throw new Error('undeclared command view');
    return withConfirmation(req,name,projector.project(current(req),name,vm,{version:req.apiVersion}));
  }
  function data(req,raw,{name,topic}={}) {
    const user=current(req),options={version:req.apiVersion};
    if(name||topic)return withConfirmation(req,name||topic,projector.project(user,name||topic,raw,options));
    if(!req.routePolicy?.command)throw new Error('undeclared response projection');
    const value=structuredClone(raw);
    if(value.vm!=null)value.vm=commandView(req,value.vm);
    if(value.result?.comment) {
      const view=projector.project(user,'comments',{projectId:req.params.id,items:[value.result.comment],nextCursor:null,mentionable:[],canComment:true,canMention:true,session:null},options);
      value.result.comment=view.items[0];
    }
    // Settings detection duplicates inventories in result; reuse the already filtered view.
    if(req.routePolicy.command==='settings.detect'&&value.vm&&value.result) {
      value.result.runtimes=value.vm.runtimes;value.result.agents=value.vm.agents;
    }
    return value;
  }
  function revision(req,topic,vm,version) {
    return projector.revision(current(req),topic,vm,version);
  }
  function error(err,req,res,next) {
    try {
      // Existing agent scopes remain a separate principal path, checked by the route guard.
      if(req.principal?.kind==='agent')return next(err);
      if(err.current) {
        // A stale caller must not receive a cached conflict body after revocation.
        current(req);
        const keys=Object.keys(err.current);
        if(keys.some(key=>!['revision','vm'].includes(key)))throw new Error('undeclared conflict fields');
        const copy=new ApiError(err.code,{status:err.status,message:err.publicMessage,details:err.details});
        copy.current={...err.current,...(err.current.vm!=null?{vm:commandView(req,err.current.vm)}:{})};
        return next(copy);
      }
      return next(err);
    } catch(failure) {return next(failure);}
  }
  return {data,error,revision,mayExposeSources:req=>projector.mayExposeSources(current(req))};
}
module.exports={createHttpProjection,COMMAND_VIEWS};
