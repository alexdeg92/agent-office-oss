'use strict';
const {ApiError}=require('../api/v2/errors');
const {recoveryRouteAllowed}=require('./recovery-policy');
const DECLARATION=Symbol('route-policy'),MOUNT=Symbol('route-mount'),EXCEPTION=Symbol('middleware-exception');
// The exported marker is diagnostic metadata, never proof that a handler enforces policy.
const GUARDS=new WeakMap();
const KINDS=new Set(['permissions','public','setup','self','transport','static','fallback','audit']);
const METHODS=['get','post','put','patch','delete','head','options'];
function validateDeclaration(spec,registry) {
  if(!spec||!KINDS.has(spec.kind)||typeof spec.reason!=='string'||!spec.reason.trim()||spec.reason.length>200)throw new Error('invalid route policy');
  if(!Array.isArray(spec.requirements)||spec.requirements.length>16)throw new Error('invalid route requirements');
  const seen=new Set();
  for(const r of spec.requirements) {
    if(!r||!registry.has(r.resource)||!['read','write'].includes(r.level)||seen.has(r.resource))throw new Error('invalid route requirement');
    seen.add(r.resource);
  }
  if(spec.kind==='permissions'&&!spec.requirements.length||spec.kind!=='permissions'&&spec.requirements.length)throw new Error('invalid route exception');
  if(typeof spec.agent!=='boolean'||spec.agent&&spec.kind!=='permissions')throw new Error('invalid route principal');
  if(![null,'transport','store','openclaw'].includes(spec.writeClass)||typeof spec.sensitive!=='boolean')throw new Error('invalid route write policy');
  if(spec.command!==null&&(typeof spec.command!=='string'||!/^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)+$/.test(spec.command)))throw new Error('invalid route command');
  if(!['none','middleware','transaction'].includes(spec.audit))throw new Error('invalid route audit policy');
  return Object.freeze({...spec,requirements:Object.freeze(spec.requirements.map(r=>Object.freeze({...r})))});
}
function createRouteGuard(spec,{auth,store}) {
  const guard=(req,res,next)=>{
    req.routePolicy=spec;
    if(['public','setup','static','fallback','audit'].includes(spec.kind))return next();
    // A ticket is minted and consumed only by the human-token gate. It can admit
    // exactly the native EventSource stream route; topic authorization and live
    // revision checks remain in stream-policy for every frame.
    const ticket=req.humanStreamTicket;
    const ticketPath=(req.baseUrl||'')+req.path;
    if(ticket&&spec.kind==='transport'&&req.method==='GET'&&/^\/api\/v[23]\/stream\/?$/i.test(ticketPath)) {
      const user=store.users.byId(ticket.userId),valid=()=>user?.status==='active'&&store.rbac.fingerprint(user.id)===ticket.fingerprint
        &&store.humanTokens.validFamilySession({familyId:ticket.familyId,sessionId:ticket.sessionId,userId:ticket.userId,generation:ticket.generation,origin:ticket.origin,audience:ticket.audience});
      if(!valid())return next(new ApiError('unauthorized'));
      req.session={userId:ticket.userId,authGeneration:ticket.generation,sid:ticket.sessionId,familyId:ticket.familyId,origin:ticket.origin,audience:ticket.audience,exp:ticket.expiresAt};req.user=user;
      req.authorize=()=>{if(!valid())throw new ApiError('unauthorized');};return next();
    }
    // Machine scopes were already checked by the existing token gate. No human/cookie fallback.
    if(req.principal?.kind==='agent')return spec.agent ? next() : next(new ApiError('forbidden',{details:[{issue:'token-scope'}]}));
    const session=auth.sessionOf(req),user=session&&store.users.byId(session.userId);
    if(!session||!user||user.status!=='active'||(session.authGeneration??0)!==user.auth_generation)return next(new ApiError('unauthorized'));
    if(session.recoveryOnly&&!recoveryRouteAllowed(req))return next(new ApiError('forbidden',{details:[{issue:'recovery-only'}]}));
    req.session=session;req.user=user;
    if(!spec.requirements.every(r=>store.policy.can(user,r.resource,r.level)))return next(new ApiError('forbidden',{details:[{issue:'permission-denied'}]}));
    auth.upgradeLegacySession?.(req,res,session);
    // Services call this again immediately before dispatch after asynchronous work.
    req.authorize=()=>{
      const current=auth.sessionOf(req);
      const active=current&&store.users.byId(current.userId);
      if(!current||current.userId!==user.id||current.recoveryOnly!==session.recoveryOnly||active?.status!=='active'||(current.authGeneration??0)!==active.auth_generation||active.auth_generation!==user.auth_generation)throw new ApiError('unauthorized');
      if(current.recoveryOnly&&!recoveryRouteAllowed(req))throw new ApiError('forbidden',{details:[{issue:'recovery-only'}]});
      if(!spec.requirements.every(r=>store.policy.can(user,r.resource,r.level)))throw new ApiError('forbidden',{details:[{issue:'permission-denied'}]});
    };
    return next();
  };
  Object.defineProperty(guard,DECLARATION,{value:spec});GUARDS.set(guard,{spec,auth,store});return guard;
}
function declareRoute(router,method,path,spec,deps,...handlers) {
  if(!METHODS.includes(method))throw new Error('unsupported route method');
  const validated=validateDeclaration(spec,deps.store.registry);
  router[method](path,createRouteGuard(validated,deps),...handlers);
  return router;
}
// Registration decorators require an exact declaration for the literal method/path.
// They never infer a new action from a parent, path prefix or HTTP verb.
function decorateRouter(router,declarations,deps) {
  for(const method of METHODS) {
    const original=router[method].bind(router);
    router[method]=(path,...handlers)=>{
      if(!handlers.length && typeof router.set==='function' && method==='get')return original(path);
      const specs=(Array.isArray(path)?path:[path]).map(p=>{
        const spec=declarations.get(method.toUpperCase()+' '+p);
        if(!spec)throw new Error('undeclared route '+method.toUpperCase()+' '+p);return spec;
      });
      if(!specs.length||specs.some(spec=>JSON.stringify(spec)!==JSON.stringify(specs[0])))throw new Error('route alias policy mismatch');
      const validated=validateDeclaration(specs[0],deps.store.registry);
      const guard=GUARDS.get(handlers[0]);
      if(guard) {
        if(guard.auth!==deps.auth||guard.store!==deps.store||JSON.stringify(guard.spec)!==JSON.stringify(validated))throw new Error('route declaration mismatch');
        return original(path,...handlers);
      }
      return original(path,createRouteGuard(validated,deps),...handlers);
    };
  }
  return router;
}
function trackMounts(router) {
  if(router[MOUNT])return router;
  const use=router.use.bind(router);
  Object.defineProperty(router,MOUNT,{value:[]});
  router.use=(...args)=>{
    const first=args[0];
    if(first instanceof RegExp||Array.isArray(first)&&first.some(p=>p instanceof RegExp))throw new Error('nonliteral middleware mount requires an explicit reviewed wrapper');
    const paths=typeof first==='string'||Array.isArray(first)&&first.every(p=>typeof p==='string')?args.shift():'';
    const from=router.stack?.length ?? router.router?.stack.length ?? 0;
    const result=use(...(paths ? [paths,...args] : args));
    const stack=router.stack||router.router.stack;
    for(const layer of stack.slice(from))Object.defineProperty(layer,MOUNT,{value:Array.isArray(paths)?paths:[paths]});
    return result;
  };
  return router;
}
function enumerateRoutes(router,prefix='') {
  const out=[];
  for(const layer of router.stack||router.router?.stack||[]) {
    if(layer.route) {
      const paths=Array.isArray(layer.route.path)?layer.route.path:[layer.route.path];
      for(const method of Object.keys(layer.route.methods)) {
        for(const path of paths) {
          const handlers=layer.route.stack.filter(h=>!h.method||h.method===method);
          const declarations=handlers.filter(h=>GUARDS.has(h.handle)).map(h=>GUARDS.get(h.handle).spec);
          const policyFirst=!!handlers[0]&&GUARDS.has(handlers[0].handle);
          out.push({method:method.toUpperCase(),path:prefix+path,declarations,policyFirst});
          if(method==='get'&&!layer.route.methods.head)out.push({method:'HEAD',path:prefix+path,declarations,policyFirst});
        }
      }
    } else if(layer.handle?.stack) {
      if(!layer[MOUNT])throw new Error('untracked router mount');
      for(const path of layer[MOUNT])out.push(...enumerateRoutes(layer.handle,prefix+path));
    }
  }
  return out;
}
function assertRouteCoverage(router,registry) {
  const rows=enumerateRoutes(router);
  for(const row of rows) {
    if(row.declarations.length!==1)throw new Error('missing or duplicate route policy '+row.method+' '+row.path);
    if(!row.policyFirst)throw new Error('route policy must precede handlers '+row.method+' '+row.path);
    validateDeclaration(row.declarations[0],registry);
  }
  return rows;
}
function exceptionMiddleware(id,handler) {
  const spec=require('./route-declarations').MIDDLEWARE.get(id);
  if(!spec||typeof handler!=='function')throw new Error('unknown middleware exception '+id);
  // An explicit, closed declaration; no arity/name/source-text inference about termination.
  const current=handler[EXCEPTION];if(current&&current.id!==id)throw new Error('middleware exception mismatch');
  if(!current)Object.defineProperty(handler,EXCEPTION,{value:{id,spec}});
  return handler;
}
function assertCompleteCoverage(router,registry) {
  const rows=assertRouteCoverage(router,registry);
  function visit(router,prefix='') {
    for(const layer of router.stack||router.router?.stack||[]) {
      if(layer.route)continue;
      if(!layer[MOUNT])throw new Error('untracked middleware mount '+prefix);
      for(const path of layer[MOUNT]) {
        if(layer.handle?.stack)visit(layer.handle,prefix+path);
        else {
          const declaration=layer.handle[EXCEPTION];
          if(!declaration)throw new Error('undeclared middleware '+prefix+path);
          const spec=validateDeclaration(declaration.spec,registry);
          rows.push({method:'USE',path:prefix+path,id:declaration.id,declarations:[spec],policyFirst:true});
        }
      }
    }
  }
  visit(router);
  // Express synthesizes method discovery when no explicit OPTIONS handler terminates first.
  const paths=new Set(rows.filter(r=>r.method!=='USE'&&r.method!=='OPTIONS').map(r=>r.path));
  for(const path of paths)if(!rows.some(r=>r.path===path&&r.method==='OPTIONS'))rows.push({method:'OPTIONS',path,implicit:true,declarations:[validateDeclaration(require('./route-declarations').OPTIONS_EXCEPTION,registry)],policyFirst:true});
  return rows;
}
module.exports={DECLARATION,MOUNT,validateDeclaration,createRouteGuard,declareRoute,decorateRouter,trackMounts,enumerateRoutes,assertRouteCoverage,exceptionMiddleware,assertCompleteCoverage};
