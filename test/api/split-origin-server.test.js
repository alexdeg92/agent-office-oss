'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {startServer,TEST_EMAIL,TEST_PASSWORD}=require('../helpers/harness');
const {loadScenario}=require('../helpers/scenario');
const {hashPassword}=require('../../src/security/password');
const ORIGIN='https://office.example.invalid',API='https://api.example.invalid/backend';
const sc=loadScenario('foreign-instance');
const headers=(extra={})=>({'origin':ORIGIN,'content-type':'application/json','x-ao-request':'1','x-forwarded-proto':'https',...extra});
async function post(base,body,{cookie,csrf}={}) {
  const extra={};if(cookie)extra.cookie=cookie;if(csrf)extra['x-ao-csrf']=csrf;
  return fetch(base+'/api/auth/refresh',{method:'POST',headers:headers(extra),body:JSON.stringify(body)});
}
test('opt-in split-origin server mounts live bearer, refresh cookie and exact CORS boundary',async t=>{
 const h=await startServer(sc,{loginEnv:true,demo:true,env:{AO_ENV:'production',AO_RBAC_ENABLED:'1',AO_SPLIT_AUTH_ENABLED:'1',AO_API_ONLY:'1',AO_TRUST_PROXY:'loopback',AO_API_PUBLIC_URL:API,AO_ALLOWED_ORIGINS:JSON.stringify([ORIGIN])}});t.after(()=>h.stop());
 for(const path of ['/healthz','/readyz'])assert.equal((await fetch(h.base+path)).status,200,'plain loopback health probe remains available');
 assert.equal((await fetch(h.base+'/healthz',{method:'POST'})).status,403,'only read-only health probes use plaintext exception');
 const plaintext=await fetch(h.base+'/api/auth/refresh',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json','x-ao-request':'1'},body:JSON.stringify({operation:'challenge',purpose:'login'})});assert.equal(plaintext.status,403);assert.equal((await plaintext.json()).error.details[0].issue,'https-required');
 const challengeResponse=await post(h.base,{operation:'challenge',purpose:'login'});assert.equal(challengeResponse.status,200);assert.equal(challengeResponse.headers.get('access-control-allow-credentials'),'true');assert.equal(challengeResponse.headers.get('strict-transport-security'),'max-age=31536000');
 const challenge=await challengeResponse.json(),login=await post(h.base,{operation:'login',email:TEST_EMAIL,password:TEST_PASSWORD},{csrf:challenge.csrfToken});
 assert.equal(login.status,200);assert.equal(login.headers.get('access-control-allow-origin'),ORIGIN);assert.match(login.headers.get('set-cookie'),/^__Secure-ao_refresh=ao_rt_/);assert.ok(login.headers.get('set-cookie').includes('Partitioned'),'cross-site deployments need a partitioned refresh cookie');
 const result=await login.json(),bearer=headers({'authorization':'Bearer '+result.accessToken});
 const me=await fetch(h.base+'/api/v3/me',{headers:bearer});assert.equal(me.status,200);assert.equal((await me.json()).data.email,TEST_EMAIL);
 for(const [path,credential] of [['/healthz',{authorization:'Bearer '+result.accessToken}],['/readyz',{cookie:login.headers.get('set-cookie').split(';')[0]}]])assert.equal((await fetch(h.base+path,{headers:credential})).status,403,'plaintext public probe cannot carry credentials');
 const now=Date.now(),readerHash=await hashPassword(TEST_PASSWORD);h.withStore(db=>{db.prepare("INSERT INTO persons(id,kind,name,is_owner,agent_id,created_at,updated_at) VALUES (?,'human','Synthetic Reader',0,NULL,?,?)").run('per_split_reader',now,now);db.prepare("INSERT INTO users(id,person_id,email,password_hash,role_id,status,credential_source,auth_generation,permission_revision,created_at,updated_at) VALUES (?,'per_split_reader','reader@example.invalid',?,'rol_reader','active','database',0,1,?,?)").run('usr_split_reader',readerHash,now,now);});
 const readerChallenge=await post(h.base,{operation:'challenge',purpose:'login'}),readerNonce=await readerChallenge.json(),readerLogin=await post(h.base,{operation:'login',email:'reader@example.invalid',password:TEST_PASSWORD},{csrf:readerNonce.csrfToken});assert.equal(readerLogin.status,200);const readerResult=await readerLogin.json(),readerBearer=headers({authorization:'Bearer '+readerResult.accessToken}),readerMe=await fetch(h.base+'/api/v3/me',{headers:readerBearer}),readerProjection=(await readerMe.json()).data;
 assert.equal(readerMe.status,200);assert.equal(readerResult.me.user.id,'usr_split_reader');assert.equal(readerResult.me.displayName,'Synthetic Reader');assert.deepEqual(readerResult.me.permissions,readerProjection.permissions);assert.equal(readerResult.me.capabilities.openclawWrites,false);assert.equal(readerResult.me.capabilities.storeWrites,false);
 const cookieOnly=await fetch(h.base+'/api/v3/me',{headers:headers({cookie:login.headers.get('set-cookie').split(';')[0]})});assert.equal(cookieOnly.status,401,'cross-origin refresh cookie does not authenticate ordinary API calls');
 const preflight=await fetch(h.base+'/api/v3/me',{method:'OPTIONS',headers:headers({'access-control-request-method':'GET','access-control-request-headers':'authorization'})});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),ORIGIN);assert.equal(preflight.headers.get('access-control-allow-headers'),'authorization');
 const refused=await fetch(h.base+'/api/v3/me',{method:'OPTIONS',headers:headers({origin:'https://evil.example.invalid','access-control-request-method':'GET','access-control-request-headers':'authorization'})});assert.equal(refused.status,403);assert.equal(refused.headers.get('access-control-allow-origin'),null);
 const refreshChallenge=await post(h.base,{operation:'challenge',purpose:'refresh'},{cookie:login.headers.get('set-cookie').split(';')[0]});assert.equal(refreshChallenge.status,200);
 const refreshNonce=await refreshChallenge.json(),refresh=await post(h.base,{operation:'refresh'},{cookie:login.headers.get('set-cookie').split(';')[0],csrf:refreshNonce.csrfToken});assert.equal(refresh.status,200);
 const rotated=await refresh.json();assert.notEqual(rotated.accessToken,result.accessToken);assert.equal((await fetch(h.base+'/api/v3/me',{headers:{...bearer,authorization:'Bearer '+rotated.accessToken}})).status,200);
 assert.equal((await fetch(h.base+'/api/v3/me',{headers:bearer})).status,200,'the prior short-lived access token remains valid until expiry after refresh rotation');
 const rotatedCookie=refresh.headers.get('set-cookie').split(';')[0],logoutChallenge=await post(h.base,{operation:'challenge',purpose:'logout'},{cookie:rotatedCookie});assert.equal(logoutChallenge.status,200);
 const logoutNonce=await logoutChallenge.json(),logout=await post(h.base,{operation:'logout'},{cookie:rotatedCookie,csrf:logoutNonce.csrfToken});assert.equal(logout.status,200);
 assert.equal((await fetch(h.base+'/api/v3/me',{headers:{...bearer,authorization:'Bearer '+rotated.accessToken}})).status,401,'logout revokes the entire token family');
});

test('split-origin auth config is opt-in and rejects incomplete or non-HTTPS topology',()=>{
 const {tryLoadConfig}=require('../../src/config'),base={AO_ENV:'test',AO_DATA_DIR:'/tmp/ao-split-config',HOME:'/tmp',PORTAL_EMAIL:TEST_EMAIL,PORTAL_PASSWORD:TEST_PASSWORD,PORTAL_SECRET:'synthetic-split-auth-secret-0123456789'};
 assert.equal(tryLoadConfig(base).splitAuthEnabled,false);
 const enabled={...base,AO_RBAC_ENABLED:'1',AO_API_ONLY:'1',AO_SPLIT_AUTH_ENABLED:'1',AO_TRUST_PROXY:'loopback',AO_API_PUBLIC_URL:API,AO_ALLOWED_ORIGINS:JSON.stringify([ORIGIN])};
 const cfg=tryLoadConfig(enabled);assert.equal(cfg.splitAuthEnabled,true);assert.equal(cfg.apiPublicUrl,API);assert.deepEqual(cfg.allowedOrigins,[ORIGIN]);
 for(const invalid of [
  {...enabled,AO_RBAC_ENABLED:'0'}, {...enabled,AO_API_ONLY:'0'}, {...enabled,AO_TRUST_PROXY:undefined}, {...enabled,AO_API_PUBLIC_URL:'http://api.example.invalid/backend'},
  {...enabled,AO_ALLOWED_ORIGINS:'*'}, {...enabled,AO_ALLOWED_ORIGINS:JSON.stringify(['https://*.example.invalid'])},
  {...enabled,AO_ALLOWED_ORIGINS:'[]'}, {...enabled,AO_SPLIT_AUTH_ENABLED:'maybe'},
 ])assert.throws(()=>tryLoadConfig(invalid));
});
