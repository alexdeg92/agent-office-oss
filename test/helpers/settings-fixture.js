'use strict';
require('./scratch-home.cjs').refuseEntry(__filename);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)
// Reusable real HTTP Settings service + FakeGateway. All runtime paths and detector
// inputs are fixtures; no host/network guide/real binary/real runtime home is probed.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { loadScenario, makeFakeGateway } = require('./scenario');
const { makeIdentity, testServerPath, waitFor } = require('./harness');
const { seed, TOKEN } = require('./onboarding-fixture');
const IC = require('../../src/instance-config');
const { tryLoadConfig, openclawPaths } = require('../../src/config');
const { openStore } = require('../../src/store');
const { createAuth } = require('../../src/auth');
const { hashPassword } = require('../../src/security/password');
const { createRuntimeController } = require('../../src/runtime-controller');
const { createSettings } = require('../../src/settings/service');
const { createApp } = require('../../src/api/http');
const { createCsrfGuard } = require('../../src/api/csrf');
const { auditMiddleware } = require('../../src/api/audit');
const { mountV2, writeClassOf } = require('../../src/api/v2/routes');
const { createLoginThrottle } = require('../../src/security/login-throttle');
const PASSWORD = 'settings-fixture-password', EMAIL = 'owner@example.test';
async function settingsFixture(options = {}) {
 const tmp = options.tmp || fs.mkdtempSync(path.join(os.tmpdir(),'settings-fixture-'));
 const fake = options.fake || makeFakeGateway(loadScenario('foreign-instance'), options.handlers); if(!options.fake) fake.token = TOKEN;
 let store,controller,api,server,closed=false;
 const close = async () => {
  if(closed)return;closed=true;
  api?.close();controller?.close();store?.close();server?.closeAllConnections();
  if(server?.listening)await new Promise(resolve=>server.close(resolve));
  if(!options.fake) await fake.stop();if(!options.tmp) fs.rmSync(tmp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 };
 try {
 const gw = await fake.start();
 const local = options.reuse ? JSON.parse(fs.readFileSync(path.join(tmp,'.openclaw','openclaw.json'),'utf8')).agents.list : (options.seed || seed)(tmp,{gateway:gw});
 const env = { HOME:tmp,PATH:testServerPath(),AO_ENV:'test',AO_DATA_DIR:path.join(tmp,'data'),AO_PROJECTS_DISCOVERY:'0',OC_IDENTITY:makeIdentity(tmp),OC_STATE_DB:path.join(tmp,'none.sqlite'),OC_CONFIG:path.join(tmp,'.openclaw','openclaw.json'),OC_BIN:path.join(__dirname,'../bin/openclaw'),FAKE_OC_SCENARIO:'foreign-instance',FAKE_OC_FIXTURES:path.join(__dirname,'../fixtures'),FAKE_OC_LOG:path.join(tmp,'cli.jsonl'),FAKE_OC_AGENTS:JSON.stringify(local), ...(typeof options.env === 'function' ? options.env(gw) : options.env || {}) };
 fs.writeFileSync(env.FAKE_OC_LOG,'');
 const config = {version:2,instance:{name:'Atelier',locale:'fr',timeZone:'Europe/Paris'},owner:{displayName:'Camille',email:EMAIL,authSource:'database'},runtime:{adapter:'openclaw',openclaw:{gatewayUrl:gw.url}},agents:{primary:'atlas',looks:{},names:{openclaw:{atlas:'Atlas'}}},network:{mode:'local',host:'127.0.0.1',port:18789,publicUrl:null,cookieSecure:false}};
 if (options.config && !options.reuse) options.config(config,{tmp,gw,env});
 const paths = IC.configPaths(env); const secrets = {version:2,sessionSecret:crypto.randomBytes(32).toString('hex'),runtimeToken:TOKEN};
 if(!options.reuse) IC.writeInstanceConfig(paths,config,secrets);
 const files = IC.readInstanceConfig(env), cfg = {...tryLoadConfig(IC.effectiveEnv(env,files)),instanceName:files.config.instance.name,configured:true,...(options.bootId ? {bootId:options.bootId} : {})};
 store = openStore({dir:cfg.dataDir,instance:'test',ownerName:'Camille',log:()=>{},deferRegistrySync:!!options.enforceAuthorization});
 if(!options.reuse) { store.setup.amendOwner({displayName:'Camille',email:EMAIL,passwordHash:await hashPassword(PASSWORD),layout:require('../../src/ops/setup-layout').setupLayout({primary:'atlas',looks:{}})});store.setup.prepare(config);store.setup.configured(); }
 if (options.effectiveV3 || files.config.version === 3) {
  const effective = {...files,...IC.upgradeV2(files.config,files.secrets)};
  store.runtimeReferences.migrate(require('../../src/ops/config-publisher').digest(files.config));
  store.runtimeReferences.bind(effective.config.runtimes);
  cfg.runtimeInstances = IC.runtimeInstances(cfg,effective,env);
  cfg.primaryAgent = effective.config.agents.primary;
 }
 controller = createRuntimeController({cfg,store,cliEnv:env,authorization:!!options.enforceAuthorization}); const {engine,runtime}=controller; store.bindEngine(engine);
 const clock = { elapsed:0,now:Date.now() }; const events = [];
 if(options.enforceAuthorization&&IC.completeEnvLogin(env))store.users.ensureEnv({email:cfg.loginEmail,personId:store.owner.id,fingerprint:crypto.createHmac('sha256',cfg.sessionSecret).update(JSON.stringify([cfg.loginEmail,cfg.loginPassword,cfg.passwordHash])).digest('hex')});
 const throttle = createLoginThrottle({now:()=>clock.now});
 const auth = createAuth({...(options.enforceAuthorization?{identity:{users:store.users,state:store.rbac.state},allowMultiUser:true}:{}),secret:cfg.sessionSecret,ttlMs:3600000,email:cfg.loginEmail,password:cfg.loginPassword,passwordHash:cfg.passwordHash,credential:cfg.authDatabase ? email=>email==null?store.users.owner():store.users.credential(email) : null,credentialGeneration:()=>store.users.authGeneration(),throttle,revocations:store.sessions});
 let detectCalls = 0;
 const detection = async () => {
  detectCalls++;
  // A completed fixture scan must explicitly report negative results too. The
  // remaining registered detectors inspect only this temporary HOME, no PATH.
  const other = (await require('../../src/adapters/detection').detectRuntimes({env:{...env,PATH:''}})).filter(d=>!['openclaw','codex'].includes(d.runtime));
  return [
   {runtime:'openclaw',name:'OpenClaw',found:true,confidence:'config',checkedPaths:[env.OC_CONFIG],connection:{gatewayUrl:gw.url,tokenSet:true},secret:TOKEN,agents:local.map(a=>({...a,name:a.id==='atlas'?'Orion':null,nameSource:a.id==='atlas'?'IDENTITY.md':null}))},
   {runtime:'codex',name:'Codex',found:true,confidence:'presence',checkedPaths:[path.join(tmp,'.codex')],agents:[],connection:null},
   ...other,
  ];
 };
 const orchestratorTeams = typeof options.orchestratorTeams === 'function' ? options.orchestratorTeams({tmp,env,gw,engine,runtime}) : options.orchestratorTeams || null;
 const settings = createSettings({env,files,cfg:controller.cfg,engine,store,auth,controller,paths:openclawPaths(env),orchestratorTeams,detect: Object.hasOwn(options,'detect') ? options.detect : detection,probe:options.probe,derivePassword:options.derivePassword,supervisor:options.supervisor,bootId:options.bootId,elapsed:()=>clock.elapsed,now:()=>clock.now,readBuild:()=>({buildId:'fixture-build'}),changed:frame=>{events.push(frame);api?.topics.invalidate();for(const hub of Object.values(api?.hubs||{}))hub.broadcastSettings(frame);}});
 const tokenGate=require('../../src/api/agent-token').createAgentTokenGate({tokens:store.tokens,audit:row=>store.audit.append(row),allowedAgent:()=>engine.primaryAgent()?.id,personOf:id=>store.persons.ensureAgent(id,id).person.id});
 const app = createApp({readonly:cfg.readonly,readonlyStore:cfg.readonlyStore,apiOnly:true,tokenGate,publicDir:path.join(__dirname,'../../public'),csrf:createCsrfGuard({publicUrl:options.publicUrl}),writeClassOf,audit:auditMiddleware({store,sessionOf:req=>auth.sessionOf(req)}),mountRoutes:app=>{auth.mountRoutes(app,{isGwConnected:()=>engine.gateway().connected});api=mountV2(app,{auth,engine:options.viewEngine ?? engine,cfg:controller.cfg,store,runtime,settings,orchestratorTeams,sourcePrincipalFor:options.sourcePrincipalFor,sessionsReadable:options.sessionsReadable,enforceAuthorization:!!options.enforceAuthorization,reauthenticationElapsed:()=>clock.elapsed,...(options.now ? {now:options.now} : {})});}});
 server = app.listen(options.listenDesired ? cfg.port : 0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base = 'http://127.0.0.1:'+server.address().port;
 let cookie='';
 const request = async(method,route,value,extra={})=>{
  const result=await fetch(base+route,{method,headers:{'content-type':'application/json','x-ao-request':'1',...(cookie?{cookie}:{}),...extra},body:value===undefined?undefined:JSON.stringify(value)});
  const text=await result.text();let json;try{json=JSON.parse(text);}catch{}
  const fresh=result.headers.get('set-cookie');if(fresh)cookie=fresh.split(';')[0];
  return {status:result.status,json,text,headers:result.headers};
 };
 async function login(password=PASSWORD,email=EMAIL){return request('POST','/api/login',{email,password});}
 await login();
 // Start only the fake runtime, never host-metric/network probes.
 controller.start(({runtime,engine})=>{runtime.start(engine);return {close(){}};});
 await waitFor(()=>engine.gateway().connected&&engine.agents().length>0);
 if(options.automaticDetection) await settings.startDetection(options.detectionSchedule);
 return {tmp,base,app,api,auth,engine,runtime,controller,settings,store,env,paths,clock,events,gw,fake,password:PASSWORD,email:EMAIL,
  get cookie(){return cookie;},set cookie(value){cookie=value;},get detectCalls(){return detectCalls;},orchestratorTeams,request,login,
  get:route=>request('GET',route),post:(route,value={})=>request('POST',route,value),put:(route,value)=>request('PUT',route,value),
  reauth:()=>request('POST','/api/v3/settings/reauth',{password:PASSWORD}),
  close,
 };
 } catch(error) { await close(); throw error; }
}
module.exports = {settingsFixture,PASSWORD,EMAIL};
