'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {createAccessBoundary,canonicalApiBase,allowedOrigins,createCorsRouteIndex,createCorsGate}=require('../../src/security/access-boundary');
const ORIGIN='https://office.example.invalid';
function policy(origins=[ORIGIN],apiPublicUrl='https://api.example.invalid/backend') {return createAccessBoundary({installationId:'synthetic-installation',apiPublicUrl,origins});}
test('split boundary accepts only bounded canonical HTTPS origins and a trusted prefix-aware API audience',()=>{
  const p=policy();assert.equal(p.audience,'synthetic-installation@https://api.example.invalid/backend');assert.equal(p.apiOrigin,'https://api.example.invalid');assert.equal(p.allows(ORIGIN),true);assert.equal(Object.isFrozen(p),true);assert.equal(Object.isFrozen(p.origins),true);
  assert.deepEqual(allowedOrigins(JSON.stringify([ORIGIN])),[ORIGIN]);assert.deepEqual(allowedOrigins([]),[]);
  for(const origin of [null,undefined,'null','*','https://*.example.invalid','http://office.example.invalid',ORIGIN+'/',ORIGIN+'/path',ORIGIN+'?x=1','https://u:p@office.example.invalid','https://OFFICE.example.invalid','https://office.example.invalid:443','https://office.example.invalid#x',ORIGIN+', '+ORIGIN,' https://office.example.invalid'])assert.equal(p.allows(origin),false,origin);
  for(const origins of [null,'not-json','null','"'+ORIGIN+'"',['*'],['https://*.example.invalid'],[ORIGIN,ORIGIN],Array.from({length:17},(_,i)=>'https://h'+i+'.example.invalid')])assert.throws(()=>policy(origins),/origin/);
  for(const url of ['https://*.example.invalid','https://api.example.invalid/','http://api.example.invalid','https://api.example.invalid/backend/','https://api.example.invalid/a/../backend','https://api.example.invalid/%62ackend','https://u:p@api.example.invalid/backend','https://api.example.invalid/backend?x=1','https://api.example.invalid/backend#x'])assert.throws(()=>canonicalApiBase(url),/API base/,url);
  assert.equal(canonicalApiBase('https://api.example.invalid'),'https://api.example.invalid');assert.equal(canonicalApiBase('https://api.example.invalid:8443/ao/backend'),'https://api.example.invalid:8443/ao/backend');
});
async function fixture(t) {
  let active=policy(),handlers=0,parsers=0;
  const rows=[{method:'GET',path:'/api/v2/projects/:id'},{method:'PATCH',path:'/api/v2/projects/:id'},{method:'GET',path:'/api/v3/projects/:id'},{method:'POST',path:'/api/auth/refresh'},{method:'GET',path:'/api/v3/stream'},{method:'GET',path:'/.*/'}],methodsFor=createCorsRouteIndex(rows);
  const app=express();app.use(createCorsGate({current:()=>active,methodsFor}));app.use((req,res,next)=>{parsers++;next();});app.use(express.json());
  app.use((req,res)=>{handlers++;res.status(200).json({authorization:!!req.headers.authorization});});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  return {fetch:(path,options={})=>fetch('http://127.0.0.1:'+server.address().port+path,options),methodsFor,setPolicy:value=>{active=value;},counts:()=>({handlers,parsers})};
}
function preflight(method='GET',headers='authorization') {return {method:'OPTIONS',headers:{origin:ORIGIN,'access-control-request-method':method,'access-control-request-headers':headers}};}
test('declared preflights precede parser/auth, advertise exact methods/headers and credential refresh only',async t=>{
  const f=await fixture(t);
  const ordinary=await f.fetch('/api/v2/projects/per_fixture',preflight('PATCH','Authorization, Content-Type, X-AO-Request'));
  assert.equal(ordinary.status,204);assert.equal(ordinary.headers.get('access-control-allow-origin'),ORIGIN);assert.equal(ordinary.headers.get('access-control-allow-methods'),'GET, HEAD, PATCH');assert.equal(ordinary.headers.get('access-control-allow-headers'),'authorization, content-type, x-ao-request');assert.equal(ordinary.headers.get('access-control-allow-credentials'),null);assert.equal(ordinary.headers.get('access-control-max-age'),'300');
  assert.deepEqual(new Set(ordinary.headers.get('vary').split(', ')),new Set(['Origin','Access-Control-Request-Method','Access-Control-Request-Headers']));
  const refresh=await f.fetch('/API/AUTH/REFRESH/',preflight('POST','Content-Type,X-AO-CSRF,X-AO-Request'));assert.equal(refresh.status,204);assert.equal(refresh.headers.get('access-control-allow-methods'),'POST');assert.equal(refresh.headers.get('access-control-allow-credentials'),'true');
  assert.equal((await f.fetch('/api/v3/stream',preflight('GET','Last-Event-ID'))).status,204);assert.deepEqual(f.counts(),{handlers:0,parsers:0});assert.deepEqual(f.methodsFor('/api/v3/projects/x/'),['GET','HEAD']);assert.deepEqual(f.methodsFor('/unknown'),[]);assert.deepEqual(f.methodsFor('/api/v3/projects/%FF'),[]);
});
test('forbidden origin/method/header/unknown preflights carry no allow headers and do no parsing',async t=>{
  const f=await fixture(t);
  for(const [path,options] of [
    ['/api/v2/projects/x',preflight('DELETE')],['/unknown',preflight()],['/api/v3/stream',preflight('GET','cookie')],['/api/v3/stream',preflight('GET','authorization, authorization')],['/api/v3/stream',preflight('GET','x-evil')],['/api/v3/stream',preflight('GET','x'.repeat(1025))],['/api/v3/stream',{...preflight(),headers:{...preflight().headers,origin:'null'}}],['/api/v3/stream',{method:'OPTIONS',headers:{'access-control-request-method':'GET'}}],['/api/v3/stream',{...preflight(),headers:{...preflight().headers,origin:'https://evil.example.invalid'}}]
  ]) {
    const res=await f.fetch(path,options);assert.equal(res.status,403,path);for(const header of ['access-control-allow-origin','access-control-allow-methods','access-control-allow-headers','access-control-allow-credentials','access-control-max-age'])assert.equal(res.headers.get(header),null,header);
  }
  assert.deepEqual(f.counts(),{handlers:0,parsers:0});
});
test('actual browser bearer requests always recheck the live origin; refresh never permits a missing Origin',async t=>{
  const f=await fixture(t),headers={origin:ORIGIN,authorization:'Bearer ao_at_synthetic'};
  let res=await f.fetch('/api/v3/projects/x',{headers});assert.equal(res.status,200);assert.equal(res.headers.get('access-control-allow-origin'),ORIGIN);assert.equal(res.headers.get('access-control-allow-credentials'),null);assert.equal(res.headers.get('access-control-expose-headers'),'X-Request-Id, Retry-After');assert.equal(res.headers.get('referrer-policy'),'no-referrer');
  const refresh=await f.fetch('/api/auth/refresh',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:'{}'});assert.equal(refresh.status,200);assert.equal(refresh.headers.get('access-control-allow-credentials'),'true');
  const before=f.counts();f.setPolicy(policy([]));res=await f.fetch('/api/v3/projects/x',{headers});assert.equal(res.status,403);assert.equal(res.headers.get('access-control-allow-origin'),null);assert.deepEqual(f.counts(),before);
  assert.equal((await f.fetch('/api/auth/refresh',{method:'POST',headers:{'content-type':'application/json'},body:'{broken'})).status,403);assert.deepEqual(f.counts(),before);
  assert.equal((await f.fetch('/api/v3/projects/x',{headers:{authorization:'Bearer ao_at_synthetic'}})).status,200,'non-browser absence alone is not a CORS credential decision');
});
