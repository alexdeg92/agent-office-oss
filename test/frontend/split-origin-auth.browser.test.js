import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { browserPath, browserSkipReason } from './helpers/layout-browser.js';

const require=createRequire(import.meta.url);
const {startServer,TEST_EMAIL,TEST_PASSWORD}=require('../helpers/harness');
const {loadScenario}=require('../helpers/scenario');
const {createFrontendServer}=require('../../scripts/serve-frontend');
const ROOT=resolve(import.meta.dirname,'../..'),SCENARIO=loadScenario('foreign-instance');
const skip=browserSkipReason();

async function freePort(){const s=createHttpServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function listen(server){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return server.address().port;}
function proxy(tls,upstreamPort,{stripPrefix=null,observe=()=>{},redirect=()=>null}={}){
  return createHttpsServer(tls,(req,res)=>{
    let path=req.url||'/';if(stripPrefix&&path.startsWith(stripPrefix))path=path.slice(stripPrefix.length)||'/';
    const headers={...req.headers,host:`127.0.0.1:${upstreamPort}`,'x-forwarded-proto':'https','x-forwarded-for':req.socket.remoteAddress||''};
    const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
      const body=Buffer.concat(chunks).toString();
      observe({method:req.method,path,origin:req.headers.origin||null});
      const location=redirect({method:req.method,path,origin:req.headers.origin||null,body});
      if(location){res.writeHead(307,{location,'access-control-allow-origin':req.headers.origin||'null','access-control-allow-credentials':'true','access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type,x-ao-request,x-ao-csrf,authorization','vary':'Origin'});res.end();return;}
      const upstream=httpRequest({host:'127.0.0.1',port:upstreamPort,path,method:req.method,headers},response=>{
        res.writeHead(response.statusCode||502,response.headers);response.pipe(res);
        response.on('aborted',()=>res.destroy());response.on('error',()=>res.destroy());
      });
      upstream.on('error',()=>{if(!res.headersSent){res.writeHead(502);res.end();}else res.destroy();});
      res.on('close',()=>{if(!res.writableFinished)upstream.destroy();});upstream.end(body);
    });
  });
}

test('split-origin HTTPS browser: login, refresh rotation, live SSE and unlisted-origin CORS refusal',
  {skip:!!skip,timeout:90000},async t=>{
  for(const apiVersion of [2,3]){
    const temp=mkdtempSync(join(tmpdir(),'ao-split-origin-browser-'));
    const keyPath=join(temp,'key.pem'),certPath=join(temp,'cert.pem');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost'],{stdio:'ignore'});
    const tls={key:readFileSync(keyPath),cert:readFileSync(certPath)};
    let h,browser,front,apiProxy,evil;
    const redirectState={target:null};
    const apiPort=await freePort(),apiOrigin=`https://api.other.invalid:${apiPort}`,apiBase=apiOrigin+'/backend';
    const frontHttp=createFrontendServer({root:join(ROOT,'public/v2'),apiBase,apiVersion,trustProxy:'loopback'});
    const frontHttpPort=await listen(frontHttp);
    const frontProxy=proxy(tls,frontHttpPort);
    const frontPort=await listen(frontProxy),frontOrigin=`https://office.example.invalid:${frontPort}`;
    const seen=[];
    try{
      h=await startServer(SCENARIO,{loginEnv:true,demo:true,env:{AO_ENV:'production',AO_RBAC_ENABLED:'1',AO_SPLIT_AUTH_ENABLED:'1',AO_API_ONLY:'1',AO_TRUST_PROXY:'loopback',AO_API_PUBLIC_URL:apiBase,AO_ALLOWED_ORIGINS:JSON.stringify([frontOrigin])}});
      apiProxy=proxy(tls,Number(new URL(h.base).port),{stripPrefix:'/backend',observe:row=>seen.push(row),redirect:row=>{
        if(!redirectState.target||row.method!=='POST')return null;
        let payload={};try{payload=JSON.parse(row.body);}catch{}
        const match=redirectState.target==='login'&&row.path==='/api/auth/refresh'&&payload.operation==='login'
          ||redirectState.target==='refresh'&&row.path==='/api/auth/refresh'&&payload.operation==='challenge'&&payload.purpose==='refresh'
          ||redirectState.target==='logout'&&row.path==='/api/auth/refresh'&&payload.operation==='challenge'&&payload.purpose==='logout'
          ||redirectState.target==='ticket'&&row.path===`/api/v${apiVersion}/stream/ticket`;
        return match?`${redirectState.collectorOrigin}/collect`:null;
      }});
      apiProxy.listen(apiPort,'127.0.0.1');
      const collected=[];
      evil=createHttpsServer(tls,(req,res)=>{const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
        collected.push({method:req.method,body:Buffer.concat(chunks).toString()});
        const headers={'access-control-allow-origin':frontOrigin,'access-control-allow-credentials':'true','access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type,x-ao-request,x-ao-csrf,authorization','vary':'Origin','cache-control':'no-store'};
        if(req.method==='OPTIONS'){res.writeHead(204,headers);res.end();return;}
        res.writeHead(200,{...headers,'content-type':'text/plain'});res.end('collected');
      });});
      const evilPort=await listen(evil),evilOrigin=`https://evil.attacker.invalid:${evilPort}`;
      redirectState.collectorOrigin=evilOrigin;
      browser=await chromium.launch({executablePath:browserPath(),headless:true,args:['--no-sandbox','--disable-background-networking','--host-resolver-rules=MAP office.example.invalid 127.0.0.1,MAP api.other.invalid 127.0.0.1,MAP evil.attacker.invalid 127.0.0.1']});
      const context=await browser.newContext({ignoreHTTPSErrors:true,locale:'en-US'}),page=await context.newPage();
      page.setDefaultTimeout(15000);
      const loginReq=page.waitForRequest(request=>request.url()===apiOrigin+'/backend/api/auth/refresh'&&request.method()==='POST'&&request.postDataJSON()?.operation==='login');
      const meResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/backend/api/v3/me'&&response.status()===200);
      const ticketResponse=page.waitForResponse(response=>new URL(response.url()).pathname===`/backend/api/v${apiVersion}/stream/ticket`&&response.status()===200);
      const streamResponse=page.waitForResponse(response=>{const u=new URL(response.url());return u.pathname===`/backend/api/v${apiVersion}/stream`&&u.searchParams.has('ticket')&&response.status()===200;});
      await page.goto(frontOrigin+'/connexion',{waitUntil:'domcontentloaded'});
      const originalDocument=await page.evaluate(()=>performance.timeOrigin);
      await page.locator('#login-email').fill(TEST_EMAIL);await page.locator('#login-password').fill(TEST_PASSWORD);
      await page.locator('button[type=submit]').click();
      await loginReq;await meResponse;await ticketResponse;await streamResponse;
      await page.waitForFunction(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);return services.stream.status.get().conn==='open';});
      const snapshotResponse=page.waitForResponse(response=>new URL(response.url()).pathname===`/backend/api/v${apiVersion}/views/health`&&response.status()===200);
      const topicsUpdate=page.waitForRequest(request=>request.method()==='POST'&&new RegExp(`/backend/api/v${apiVersion}/stream/[^/]+/topics$`).test(new URL(request.url()).pathname));
      await page.evaluate(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);window.__aoHealthSnapshots=[];services.stream.subscribe('health','/api/v2/views/health',state=>{if(state.data!==undefined&&Number.isInteger(state.rev))window.__aoHealthSnapshots.push(state.rev);});});
      await snapshotResponse;await topicsUpdate;
      await page.waitForFunction(()=>window.__aoHealthSnapshots?.length>0);
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(()=>performance.timeOrigin),originalDocument,'the stream hello matches the selected contract and does not trigger a reload');
      const snapshotCount=await page.evaluate(()=>window.__aoHealthSnapshots.length);
      const resyncRequest=page.waitForRequest(request=>request.method()==='POST'&&new RegExp(`/backend/api/v${apiVersion}/stream/[^/]+/resync$`).test(new URL(request.url()).pathname));
      const resyncResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new RegExp(`/backend/api/v${apiVersion}/stream/[^/]+/resync$`).test(new URL(response.url()).pathname)&&response.status()===200);
      await page.evaluate(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);services.stream.resync('health');});
      await resyncRequest;await resyncResponse;
      await page.waitForFunction(count=>window.__aoHealthSnapshots?.length>count,snapshotCount);
      assert.notEqual(new URL(page.url()).pathname,'/connexion','the real sign-in flow enters the authenticated app');
      const firstCookies=await context.cookies(apiOrigin+'/backend/api/auth/refresh');
      const firstCookie=firstCookies.find(c=>c.name==='__Secure-ao_refresh');assert.ok(firstCookie,'login installed the API-path-scoped refresh cookie');

      const refreshRequest=page.waitForRequest(request=>request.url()===apiOrigin+'/backend/api/auth/refresh'&&request.method()==='POST'&&request.postDataJSON()?.operation==='refresh');
      const refreshedMe=page.waitForResponse(response=>new URL(response.url()).pathname==='/backend/api/v3/me'&&response.status()===200);
      const reloadedTicket=page.waitForResponse(response=>new URL(response.url()).pathname===`/backend/api/v${apiVersion}/stream/ticket`&&response.status()===200);
      const ticketsBefore=seen.filter(row=>row.method==='POST'&&row.path===`/api/v${apiVersion}/stream/ticket`).length;
      await page.reload({waitUntil:'domcontentloaded'});
      await refreshRequest;await refreshedMe;await reloadedTicket;
      await page.waitForFunction(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);return services.stream.status.get().conn==='open';});
      const secondCookie=(await context.cookies(apiOrigin+'/backend/api/auth/refresh')).find(c=>c.name==='__Secure-ao_refresh');
      assert.ok(secondCookie&&secondCookie.value!==firstCookie.value,'reload rotates the refresh family cookie');
      assert.ok(seen.filter(row=>row.method==='POST'&&row.path===`/api/v${apiVersion}/stream/ticket`).length>ticketsBefore,`reload obtains a fresh v${apiVersion} SSE ticket (${ticketsBefore} → ${seen.filter(row=>row.method==='POST'&&row.path===`/api/v${apiVersion}/stream/ticket`).length})`);

      const redirectChecks=[];
      assert.equal(await page.evaluate(async()=>{const {refreshHumanAccess}=await import('/api.js?v='+document.querySelector('meta[name=ao-build]').content);return refreshHumanAccess();}),true,'the isolated API module has a live bearer token for redirect checks');
      for(const operation of ['login','logout','ticket','refresh']){
        redirectState.target=operation;
        const outcome=await page.evaluate(async({operation,apiVersion})=>{
          const {login,refreshHumanAccess,logout,post}=await import('/api.js?v='+document.querySelector('meta[name=ao-build]').content);
          try{
            if(operation==='login')await login('redirect-test@example.invalid','redirect-test-password');
            else if(operation==='refresh')await refreshHumanAccess();
            else if(operation==='logout')await logout();
            else await post(`/api/v${apiVersion}/stream/ticket`,{topics:['office']},{apiVersion,quiet:true});
            return 'resolved';
          }catch(error){return error.code||error.name;}
        },{operation,apiVersion});
        assert.equal(outcome,'network',`${operation} rejects an API 307 redirect`);
        redirectChecks.push(operation);
      }
      redirectState.target=null;
      assert.deepEqual(collected,[],'no credentialed request or bearer ticket request is forwarded to the foreign redirect origin');
      assert.equal(redirectChecks.length,4);

      await page.goto(evilOrigin,{waitUntil:'domcontentloaded'});
      const cors=await page.evaluate(async api=>{try{const r=await fetch(api+'/backend/api/v3/me',{headers:{authorization:'Bearer synthetic-invalid-token'}});return {resolved:true,status:r.status,allow:r.headers.get('access-control-allow-origin')};}catch(error){return {resolved:false,name:error.name};}},apiOrigin);
      assert.deepEqual(cors,{resolved:false,name:'TypeError'},'an unlisted HTTPS origin cannot read the API response');
      assert.ok(seen.some(row=>row.method==='OPTIONS'&&row.path==='/api/v3/me'&&row.origin===evilOrigin),'browser CORS preflight from the unlisted origin reached the API boundary');
    }finally{
      await browser?.close();for(const server of [evil,apiProxy,frontProxy,frontHttp])if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(()=>resolve()));}
      await h?.stop();rmSync(temp,{recursive:true,force:true});
    }
  }
  });
