'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),express=require('express');
const {createApp}=require('../../src/api/http'),{createSetup}=require('../../src/api/v2/setup'),{createCsrfGuard}=require('../../src/api/csrf');
const {createResourceRegistry}=require('../../src/security/resources'),{ROUTES}=require('../../src/security/route-declarations');
const {trackMounts,decorateRouter,exceptionMiddleware:except,assertCompleteCoverage}=require('../../src/security/route-policy');
const {mountHealth}=require('../../src/ops/health'),{apiVersionOf}=require('../../src/api/v2/routes');
const {buildMetaVM,buildMetaVM3}=require('../../src/api/v2/vm/meta'),{okBody}=require('../../src/api/v2/envelope');
const {ApiError,sendError,errorMiddleware}=require('../../src/api/v2/errors');
test('complete actual setup/recovery registration covers both aliases, setup-code gates, API-only/static and fallback middleware',async t=>{
  for(const recovery of [false,true])for(const apiOnly of [false,true]) {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-setup-route-coverage-'));
    const env={HOME:dir,...(recovery?{PORTAL_EMAIL:'prior@example.invalid'}:{})};
    const files={config:null,secrets:null,paths:{dir,file:path.join(dir,'config.json'),secrets:path.join(dir,'secrets.json')}};
    const setup=createSetup({env,files,paths:{},dataDir:dir,instance:'test',recovery,log:()=>{}});
    const deps={store:{registry:createResourceRegistry()},auth:{sessionOf:()=>null}};
    const notConfigured=(req,res)=>sendError(req,res,new ApiError('upstream_unavailable',{details:[{issue:'not-configured'}]}));
    const app=createApp({readonly:false,apiOnly,publicDir:dir,routeSecurity:deps,csrf:createCsrfGuard(),mountRoutes:a=>{
      mountHealth(a,()=>({mode:'setup'}));
      const r=trackMounts(express.Router());decorateRouter(r,ROUTES,deps);
      r.use(except('api.version',(req,res,next)=>{req.apiVersion=apiVersionOf(req);res.setHeader('Cache-Control','no-store');next();}));
      setup.mount(r);
      r.get('/meta',(req,res)=>res.json(okBody((req.apiVersion===3?buildMetaVM3:buildMetaVM)({instance:'test',configured:false},{locale:'fr'}))));
      r.use(except('setup.notConfigured',notConfigured));r.use(except('api.error',errorMiddleware()));
      a.use(['/api/v2','/api/v3'],r);a.use('/api',except('setup.notConfigured',notConfigured));
    }});
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    t.after(async()=>{setup.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
    const rows=assertCompleteCoverage(app,deps.store.registry);assert.ok(rows.some(r=>r.id==='setup.notConfigured'));
    const base='http://127.0.0.1:'+server.address().port;
    for(const version of [2,3]) {
      assert.ok(rows.some(r=>r.path==='/api/v'+version+'/setup/owner'&&r.declarations[0].kind==='setup'));
      const state=await fetch(base+'/api/v'+version+'/setup');assert.equal(state.status,200);assert.equal((await state.json()).data.state,'open');
      const denied=await fetch(base+'/api/v'+version+'/setup/detect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({setupCode:'invalid'})});assert.equal(denied.status,403);
      const missing=await fetch(base+'/api/v'+version+'/views/logs');assert.equal(missing.status,503);
      const head=await fetch(base+'/api/v'+version+'/meta',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
    }
    app.use('/api/forgotten',(req,res)=>res.json({secret:true}));assert.throws(()=>assertCompleteCoverage(app,deps.store.registry),/undeclared middleware/);
  }
});
