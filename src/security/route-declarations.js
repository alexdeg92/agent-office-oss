'use strict';
// Exact registrations only. Adding a new route/action requires a reviewed declaration.
const {PROJECT_CONTEXT_READS}=require('./comment-provenance');
const ROUTES=new Map(),COMMANDS=new Map();
function add(method,path,{kind='permissions',resource=null,level='read',command=null,writeClass=null,agent=false,sensitive=false,audit=command?'middleware':'none',reason=resource||kind,requirements=resource?[{resource,level}]:[]}={}) {
  const key=method+' '+path;if(ROUTES.has(key))throw new Error('duplicate route declaration');
  const spec=Object.freeze({kind,requirements,command,writeClass,agent,sensitive,audit,reason});
  ROUTES.set(key,spec);
  if(command) {
    const old=COMMANDS.get(command);
    if(old&&JSON.stringify(old.requirements)!==JSON.stringify(spec.requirements))throw new Error('command policy mismatch');
    COMMANDS.set(command,spec);
  }
}
for(const [path,resource] of [
  ['/views/office','office'],['/views/office/characters','office'],['/views/chat','chat'],['/views/flows','flows'],['/views/flows/:jobId','flows'],
  ['/orchestrators','orchestrators'],['/teams','teams'],
  ['/views/logs','logs'],['/views/sessions/:key','logs'],['/views/interlocutors/:id','logs'],['/views/access','access'],
  ['/views/skills','skills'],['/views/skills/:name','skills'],['/views/health','health'],
  ['/views/projects','projects'],['/views/projects/:id','projects'],['/views/projects/:id/history','projects'],
  ['/views/projects/:id/comments','projects'],['/views/project-candidates','projects'],['/project-covers/:file','projects'],['/shots/:file','projects'],
  ['/office/layout','store'],['/office/layout/revisions/:rev','store'],['/prefs','store'],
])add('GET',path,{resource});
add('GET','/views/office/palette',{requirements:[{resource:'office',level:'read'}],reason:'office'});
add('GET','/views/office/store',{requirements:[{resource:'store',level:'read'},{resource:'office',level:'read'}],reason:'store'});
for(const [method,path,resource,command,writeClass,agent] of [
  ['POST','/flows','flows.create','flows.create','openclaw'],['PATCH','/flows/:jobId','flows.edit','flows.edit','openclaw'],
  ['PUT','/flows/:jobId/enabled','flows.enable','flows.setEnabled','openclaw'],['POST','/flows/:jobId/runs','flows.run','flows.run','openclaw'],['DELETE','/flows/:jobId','flows.delete','flows.delete','openclaw'],
  ['PUT','/skills/:name/enabled','skills','skills.setEnabled','openclaw'],['POST','/gateway/restart','gateway.restart','gateway.restart','openclaw'],['POST','/chat/messages','chat','chat.send','openclaw'],
  ['PUT','/health/issues/:id/muted','health','health.mute','store'],['PUT','/office/layout','store','office.saveLayout','store'],['PUT','/office/layout/theme','store','office.setTheme','store'],['PATCH','/prefs','store','prefs.update','store'],
  ['POST','/health/checks/:id/fix','health','health.fix','store'],['POST','/health/fix-all','health','health.fixAll','store'],
  ['POST','/projects','projects','projects.create','store'],['POST','/projects/import','projects','projects.import','store'],
  ['PATCH','/projects/:id','projects','projects.edit','store',true],['PUT','/projects/:id/status','projects','projects.setStatus','store',true],['PUT','/projects/:id/archived','projects','projects.setArchived','store'],
  ['POST','/projects/:id/flags','projects','projects.addFlag','store',true],['DELETE','/projects/:id/flags/:kind/:key','projects','projects.removeFlag','store'],['PUT','/projects/:id/flags/risk/:key/ack','projects','projects.ackRisk','store'],
  ['POST','/projects/:id/sources','projects','projects.linkSource','store'],['DELETE','/projects/:id/sources/:sourceId','projects','projects.unlinkSource','store'],['PUT','/projects/:id/people/:personId','projects','projects.setPersonOverride','store'],['POST','/projects/:id/history','projects','projects.appendHistory','store',true],
  ['POST','/projects/:id/cover/regenerate','projects.regenerate','projects.regenerateCover','store'],['PUT','/projects/:id/cover','projects','projects.uploadCover','store'],['POST','/projects/:id/summary/regenerate','projects.regenerate','projects.regenerateSummary','openclaw'],
  ['POST','/projects/:id/comments','projects.comment','projects.comment','store'],['POST','/projects/:id/comments/:cid/retry','projects.comment','projects.retryComment','openclaw'],['PATCH','/projects/:id/comments/:cid','projects.comment','projects.editComment','store'],['DELETE','/projects/:id/comments/:cid','projects.comment','projects.deleteComment','store'],
])add(method,path,{resource,level:'write',command,writeClass,agent:!!agent,sensitive:resource==='gateway.restart',requirements:[{resource,level:'write'},...(['projects.regenerateSummary','projects.retryComment','projects.import','projects.regenerateCover'].includes(command)?PROJECT_CONTEXT_READS:[])]});
add('GET','/meta',{kind:'public',reason:'redacted bootstrap or permission-projected human metadata'});
add('GET','/me',{kind:'self',reason:'current authenticated identity'});
add('GET','/design-system/access',{kind:'self',reason:'owner-only access decision for the design-system gallery'});
add('GET','/settings',{kind:'self',reason:'independently projected settings groups'});
for(const [method,path,resource,command,sensitive] of [
  ['POST','restart','settings.restart','settings.restart',true],['POST','check','settings.runtimes','settings.check'],['POST','detect','settings.runtimes','settings.detect'],['POST','herdr/check','settings.runtimes','settings.herdrCheck'],
  ['POST','fix-all','health','settings.fixAll',true],
  ['PUT','agents','settings.runtimes','settings.agents'],['PUT','auto-add','settings.runtimes','settings.autoAdd'],['PUT','runtime','settings.runtimes','settings.runtime'],['PUT','runtimes','settings.runtimes','settings.runtimes',true],
  ['PUT','instance','settings.instance','settings.instance'],['PUT','network','settings.network','settings.network',true],
  ['POST','integrations/plan','settings.integrations','settings.integrations.plan'],['POST','integrations/apply','settings.integrations','settings.integrations.apply',true],
])add(method,'/settings/'+path,{resource,level:'write',command,writeClass:'store',sensitive:!!sensitive});
add('GET','/settings/access',{resource:'settings.network',level:'read',reason:'read-only external access configuration'});
for(const [path,command,sensitive] of [
  ['plan','settings.access.plan',false],['checks','settings.access.checks',false],['checks/status','settings.access.checkStatus',false],
  ['checks/cancel','settings.access.cancelCheck',false],['apply','settings.access.apply',true],
])add('POST','/settings/access/'+path,{resource:'settings.network',level:'write',command,writeClass:path==='apply'?'store':null,sensitive,reason:'external access plan and publication'});
for(const [method,path,command,sensitive] of [['POST','reauth','settings.reauth',false],['PUT','owner','settings.owner',true],['POST','password','settings.password',true]])
  add(method,'/settings/'+path,{kind:'self',reason:'current-user credential/profile operation',command,writeClass:'store',sensitive});
for(const path of ['/users','/users/:id','/roles','/permissions/resources'])add('GET',path,{resource:'users'});
for(const [method,path,command] of [
  ['POST','/users/invitations','users.invite'],['POST','/users/:id/invitation','users.resendInvitation'],
  ['PATCH','/users/:id','users.edit'],['PUT','/users/:id/overrides','users.overrides'],['POST','/users/:id/password-reset','users.passwordReset'],
  ['POST','/users/:id/revoke-sessions','users.revokeSessions'],['DELETE','/users/:id','users.delete'],
  ['POST','/roles','roles.create'],['PUT','/roles/:id','roles.edit'],['DELETE','/roles/:id','roles.delete'],['POST','/roles/:id/reset','roles.reset'],
])add(method,path,{resource:'users',level:'write',command,writeClass:'store',sensitive:true,audit:'transaction'});
add('GET','/stream',{kind:'transport',reason:'authenticated stream admission and per-topic policy',writeClass:'transport'});
add('POST','/stream/ticket',{kind:'transport',reason:'single-use topic-bound stream ticket authenticated by current human authority',writeClass:'transport'});
for(const path of ['/stream/:streamId/topics','/stream/:streamId/resync'])add('POST',path,{kind:'transport',reason:'session-owned transport plus per-topic policy',writeClass:'transport'});
for(const [method,path] of [['GET','/setup'],['GET','/setup/catalog'],['POST','/setup/resume'],['POST','/setup/owner'],['POST','/setup/detect'],['POST','/setup/integrations/plan'],['POST','/setup/integrations/apply'],['POST','/setup/network'],['POST','/setup/check'],['POST','/setup/discover'],['POST','/setup/access/state'],['POST','/setup/access/plan'],['POST','/setup/access/checks'],['POST','/setup/access/checks/status'],['POST','/setup/access/checks/cancel'],['POST','/setup/access/apply'],['PUT','/setup']])
  add(method,path,{kind:'setup',reason:'one-time setup code or explicitly redacted locked/bootstrap response'});
const TOPICS=new Map([
  ['office','office'],['office-scope','office'],['orchestrators','orchestrators'],['teams','teams'],['chat','chat'],['flows','flows'],['flow','flows'],['logs','logs'],['session','logs'],['interlocutor','logs'],['access','access'],['skills','skills'],['skill','skills'],['health','health'],['layout','store'],['prefs','store'],['projects','projects'],['project','projects'],['comments','projects'],
].map(([name,resource])=>[name,Object.freeze({resource,level:'read'})]));
const CREDENTIAL_LINK_ROUTES=new Map([
  ['/api/auth/invitations/accept','users.acceptInvitation'],['/api/auth/password-reset/accept','users.acceptReset'],
].map(([path,command])=>['POST '+path,Object.freeze({kind:'public',requirements:[],command,writeClass:'store',agent:false,sensitive:false,audit:'transaction',reason:'single-use purpose-bound credential link; shared login admission before parsing'})]));
const exception=(kind,reason)=>Object.freeze({kind,requirements:[],command:null,writeClass:null,agent:false,sensitive:false,audit:'none',reason});
const APP_ROUTES=new Map([
  ...['/healthz','/healthz/proxy','/readyz'].map(path=>['GET '+path,exception('public','minimal operational probe; closed statuses only')]),
  ['POST /api/auth/refresh',Object.freeze({...exception('public','bounded Origin/purpose-bound human login/refresh/logout protocol'),writeClass:'transport'})],
  ['OPTIONS /api/auth/access-diagnostic',exception('public','bounded preflight for credentialless installation identity diagnostic')],
  ['POST /api/auth/access-diagnostic',exception('public','single-use plan-bound installation identity diagnostic; exact live Origin only')],
  ['POST /api/login',exception('public','bounded login with shared throttle and credential verification')],
  ['POST /api/logout',exception('public','revoke only the verified current session')],
  ['GET /api/me',exception('self','verified current account compatibility response')],
  ...['/','/index.html','/index','/sw.js'].map(path=>['GET '+path,exception('static','public frontend entry or service worker')]),
  ['GET /.*/',exception('fallback','public frontend shell for canonical extensionless UI routes')],
  ...CREDENTIAL_LINK_ROUTES,
]);
const MIDDLEWARE=new Map([
  ['http.requestId','public','bounded request identifier only'],
  ['http.splitTransportSecurity','public','refuse split-origin credentials unless the socket or configured trusted proxy verifies HTTPS'],
  ['http.cors','public','declared preflight and live split-Origin refusal before credentials/parsing'],
  ['http.humanAdmission','public','bounded human auth transport admission/refusals before parsing'],
  ['http.credentialAdmission','public','bounded public credential-link admission and refusals only'],
  ['http.tokenAuthentication','public','machine credential classification or refusal; no resource response'],
  ['http.csrf','public','media/origin validation or refusal before parsing'],
  ['http.json','public','bounded JSON parser or input refusal; no resource response'],
  ['http.loginParserError','public','category-only parser refusals; login throttle instrumentation'],
  ['http.tokenScope','public','machine scope validation or refusal; no resource response'],
  ['http.readonly','public','write-class backstop or refusal; no resource response'],
  ['http.apiFallback','fallback','API-only not-found response'],
  ['http.securityHeaders','static','public frontend security headers only'],
  ['http.shell','static','canonical public shell/config/build responses; no backend instance data'],
  ['http.static','static','public frontend files under canonical UI root only'],
  ['http.designSystem','static','owner-authenticated design-system gallery shell and example assets'],
  ['http.canonical','static','canonical UI path or malformed-path refusal'],
  ['http.redirect','fallback','public UI redirect for non-API GET only'],
  ['http.audit','audit','audit instrumentation only; always yields next(router)'],
  ['api.version','public','API version and no-store headers only'],
  ['api.notFound','fallback','category-only API not-found refusal'],
  ['api.projectionError','fallback','current-policy projection of declared conflict data or refusal'],
  ['api.error','fallback','typed API error response; no stack or runtime fallback'],
  ['setup.notConfigured','setup','unconfigured API refusal after setup routes'],
].map(([id,kind,reason])=>[id,exception(kind,reason)]));
const OPTIONS_EXCEPTION=exception('public','framework automatic OPTIONS lists registered methods only');
for(const spec of CREDENTIAL_LINK_ROUTES.values())COMMANDS.set(spec.command,spec);
module.exports={ROUTES,COMMANDS,TOPICS,CREDENTIAL_LINK_ROUTES,APP_ROUTES,MIDDLEWARE,OPTIONS_EXCEPTION,add};
