// Synthetic T-0076 external-access endpoints for local UI review only.
const DEFAULT={mode:'local',apiPublicUrl:null,uiOrigins:[],domain:null,proxy:'caddy',security:{accessTokenMinutes:10,refreshIdleHours:12,refreshAbsoluteDays:7,partitionedCookie:false}};
const modes=['local','lan','private','public-same-origin','public-split-origin','tunnel'];
const hostname=value=>typeof value==='string'&&/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value);
const httpsBase=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&(u.origin===value||u.origin+u.pathname===value);}catch{return false;}};
const httpsOrigin=value=>{try{const u=new URL(value);return u.protocol==='https:'&&u.origin===value;}catch{return false;}};
const invalidDraft=draft=>{
 if(!draft||!modes.includes(draft.mode)||!['caddy','traefik','cloudflare','manual'].includes(draft.proxy)||!Array.isArray(draft.uiOrigins))return 'Draft invalid.';
 const publicMode=['public-same-origin','public-split-origin','tunnel'].includes(draft.mode);
 if(['local','lan','private'].includes(draft.mode)&&(draft.apiPublicUrl!=null||draft.domain!=null||draft.uiOrigins.length))return 'Local and private modes cannot retain public origins.';
 if(publicMode&&(!httpsBase(draft.apiPublicUrl)||!hostname(draft.domain)))return 'A public HTTPS API and bare domain are required.';
 if(draft.mode==='public-split-origin'&&(!draft.uiOrigins.length||draft.uiOrigins.length>16||!draft.uiOrigins.every(httpsOrigin)))return 'Exact hosted UI origins are required.';
 if(draft.mode!=='public-split-origin'&&draft.uiOrigins.length)return 'This mode cannot retain split origins.';
 return null;
};
const checksFor=draft=>{
 const checks=[];
 if(draft.mode==='public-same-origin'||draft.mode==='public-split-origin')checks.push({kind:'dns',target:draft.domain||'',perspective:'server',state:'idle',observedAt:null,elapsedMs:0,expiresAt:null,reason:null,fix:null,evidence:null,retryAfterMs:null},{kind:'tls',target:draft.apiPublicUrl||'',perspective:'server',state:'idle',observedAt:null,elapsedMs:0,expiresAt:null,reason:null,fix:null,evidence:null,retryAfterMs:null},{kind:'cors',target:draft.uiOrigins?.[0]||draft.apiPublicUrl||'',perspective:'server',state:'idle',observedAt:null,elapsedMs:0,expiresAt:null,reason:null,fix:null,evidence:null,retryAfterMs:null});
 return checks;
};
const ok=data=>({status:200,body:{data:{...data,revision:null,vm:null},meta:{modelVersion:1,generatedAt:Date.now(),stale:[]}}});
const bad=(status,code,message,details)=>({status,body:{error:{code,message,details,requestId:'req_external_mock'}}});
export function createExternalAccessMock({setupCode='AO-7Q2K-91MX',readonly=false,unavailable=false}={}){
 let revision=0,settingsRevision=0,activeRevision=0,configured=false,staged=false,draft={...DEFAULT,security:{...DEFAULT.security}},saved=null,active=null,plan=null,job=null,lastVerification=null;
 const vm=(setup=false)=>({state:readonly?'readonly':configured?'configured':'open',settingsRevision:setup?null:settingsRevision,savedRevision:revision||null,activeRevision:activeRevision||null,saved,active,draft,fields:Object.fromEntries(['mode','apiPublicUrl','uiOrigins','domain','proxy','security'].map(field=>[field,{source:configured?'config':'default',editable:!readonly,reason:null}])),choices:{modes:modes.map(id=>({id,labelKey:`access.mode.${id}`,descriptionKey:`access.mode.${id}.help`})),proxies:['caddy','traefik','cloudflare','manual'].map(id=>({id,labelKey:`access.proxy.${id}`})),dnsProviders:[{id:'unknown',labelKey:'access.provider.unknown',consoleUrl:null,nsSuffixes:[],nsPatterns:[],records:['A','AAAA','CNAME'],api:'none'}]},securityDefaults:DEFAULT.security,securityHeaders:{mandatory:['content-security-policy','x-frame-options','strict-transport-security'],editableConnectOrigins:draft.mode==='public-split-origin'?draft.uiOrigins:[]},lastVerification,pendingActivation:revision>activeRevision,restartRequired:revision>activeRevision,staged});
 return async(method,path,body={})=>{
  const u=new URL(path,'http://mock'),p=u.pathname;
  if(unavailable)return bad(404,'not_found','Not found.');
  const setup=p.startsWith('/api/v3/setup/access');
  if(setup&&body.setupCode!==setupCode)return bad(403,'forbidden','Setup code invalid.',[{field:'setupCode',issue:'invalid'}]);
  if(!setup&&readonly&&method!=='GET')return bad(403,'readonly','Read only.');
  if(method==='GET'&&p==='/api/v3/settings/access')return ok(vm(false));
  if(method==='POST'&&p==='/api/v3/setup/access/state')return ok(vm(true));
  if(method==='POST'&&/\/access\/plan$/.test(p)){
   if(body.settingsRevision!==(setup?null:settingsRevision))return bad(409,'conflict','Settings changed.');
   const issue=invalidDraft(body.draft);if(issue)return bad(400,'validation_failed',issue);
   draft={...body.draft,security:{...DEFAULT.security,...body.draft.security},uiOrigins:[...body.draft.uiOrigins]};
   plan={planId:'mock-access-plan',baseRevision:body.settingsRevision,expiresAt:Date.now()+900000,configDigest:'a'.repeat(64),draft,domains:draft.domain?[{hostname:draft.domain,observedAt:Date.now(),provider:{id:'unknown',confidence:'unknown',evidence:[]},resolvers:[],records:[],proposals:[]}]:[],checks:checksFor(draft),proxy:{detected:null,state:'unknown'},artifacts:[],securitySummary:draft.security,writes:[{target:'config',field:'access.mode',current:saved?.draft?.mode||'local',proposed:draft.mode,source:'config',editable:!readonly,requiresRestart:true}],externalActions:(draft.mode==='public-same-origin'||draft.mode==='public-split-origin')?[{kind:'dns',labelKey:'access.action.createDnsRecord',required:true,state:'pending',details:{domain:draft.domain||''}}]:[],environmentImposed:[],restartRequired:true};
   return ok({ok:true,result:plan});
  }
  if(method==='POST'&&/\/access\/checks$/.test(p)){
   const selected=(plan?.checks||[]).filter(check=>body.checks?.includes(check.kind)).map(check=>({...check,state:'running'}));
   job={jobId:'mock-access-job',planId:body.planId,state:'running',elapsedMs:50,pollAfterMs:20,checks:selected};return ok({ok:true,result:job});
  }
  if(method==='POST'&&/\/access\/checks\/status$/.test(p)){
   if(!job||body.jobId!==job.jobId)return bad(404,'not_found','Job unavailable.');
   job={...job,state:'unknown',elapsedMs:120,checks:job.checks.map(check=>({...check,state:'unknown',elapsedMs:120,observedAt:Date.now(),reason:{key:'check.capacity-limited'}}))};return ok({ok:true,result:job});
  }
  if(method==='POST'&&/\/access\/checks\/cancel$/.test(p)){if(job)job={...job,state:'unknown'};return ok({ok:true,result:{cancelled:true}});}
  if(method==='POST'&&/\/access\/apply$/.test(p)){
   if(!plan||body.planId!==plan.planId||body.settingsRevision!==(setup?null:settingsRevision)||plan.baseRevision!==body.settingsRevision||body.confirmation?.configDigest!==plan.configDigest)return bad(409,'conflict','Plan expired or changed.');
   draft=plan.draft;
   if(setup){staged=true;return ok({ok:true,result:{staged:true,draft}});}
   revision++;settingsRevision++;saved={revision,draft};if(!active&&plan.restartRequired===false){activeRevision=revision;active=saved;}
   configured=true;return ok({ok:true,result:{changed:true,restartRequired:activeRevision<revision,vm:vm(false)}});
  }
  if(method==='POST'&&/\/access\/verify$/.test(p)){lastVerification={revision:activeRevision,origin:draft.uiOrigins?.[0]||draft.apiPublicUrl,checkedAt:Date.now(),expiresAt:Date.now()+300000,state:'waiting',checks:[],browser:{state:'waiting'}};return ok({ok:true,result:lastVerification});}
  return bad(404,'not_found','Route not found.');
 };
}
