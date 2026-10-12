import {agentRows,agentRow,agentAction,agentEditor,agentConnector} from './helpers/settings-agent-browser.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openLive,skip,save,tab,idle,confirm,reloadSettings,applyPlan,openConnector} from './helpers/settings-live-browser.js';
import {realisticOptions} from './helpers/settings-real-home.js';
const getVM=async b=>{const r=await b.h.get('/api/v3/settings');assert.equal(r.status,200);return r.json.data;};
const connectionId=async b=>(await getVM(b)).runtimes.find(r=>r.enabled || r.selected).id;
const integrationStatus=(vm,id='atlas')=>vm.agents.find(a=>a.agentId===id).integrations[0].status;
const shot=async(p,name)=>{if(process.env.SETTINGS_SCREENSHOTS==='1')await p.screenshot({path:'design/reports/settings-2/'+name+'.png',animations:'disabled'});};

test('real round-trip: integration install updates immediately and remains installed after page reload',{skip,timeout:45000},async()=>{
 const b=await openLive(realisticOptions),p=b.page;
 try{
  assert.equal(integrationStatus(await getVM(b)),'missing');await applyPlan(b);
  assert.ok(fs.existsSync(path.join(b.h.tmp,'.openclaw/workspace/skills/projet/projet.js')),'actual adapter installed to the realistic workspace');
  assert.equal(integrationStatus(await getVM(b)),'installed','status reader agrees with installer without a prior detection');
  assert.equal(await p.locator('.ao-settings__section .bu-list-row__title .bu-caption').filter({hasText:'Installée'}).count(),2,'both installation targets update without reload');
  await p.setViewportSize({width:1440,height:900});await shot(p,'integrations-installed-desktop');
  assert.equal(integrationStatus(await reloadSettings(b,'integrations')),'installed');
  await applyPlan(b,'uninstall');assert.equal(integrationStatus(await reloadSettings(b,'integrations')),'missing');
 }finally{await b.close();}
});

test('real round-trip: applying multiple integration targets produces one replaceable result banner',{skip,timeout:45000},async()=>{
 const b=await openLive(realisticOptions),p=b.page;
 try{
  await tab(p,'agents');await p.getByRole('button',{name:'Relancer la détection',exact:true}).click();await idle(p);
  await applyPlan(b);
  assert.equal(await p.locator('.ao-settings .bu-banner__text').filter({hasText:'Plan appliqué.'}).count(),1,'one result for the entire application');
  assert.equal(await p.locator('.ao-settings .bu-banner__text').filter({hasText:'Modifications enregistrées.'}).count(),0,'no additional generic save result');
  await applyPlan(b,'uninstall');
  assert.equal(await p.locator('[data-settings-result]').count(),1,'new result replaces the previous result');
  assert.equal(integrationStatus(await reloadSettings(b,'integrations')),'missing');
 }finally{await b.close();}
});

async function submit(b,route,password=b.h.password){
 const p=b.page;const response=p.waitForResponse(r=>r.request().method()!=='GET' && new URL(r.url()).pathname.endsWith('/api/v3/settings/'+route));
 await save(p).click();
 await p.waitForFunction(()=>document.querySelector('#settings-current-password') || document.querySelector('#settings-section-form')?.getAttribute('aria-busy')==='false');
 if(await p.locator('#settings-current-password').count())await confirm(p,password);
 const result=await response;assert.equal(result.status(),200,await result.text());await idle(p);
}
const agent=(vm,id)=>vm.agents.find(a=>a.agentId===id);
const row=agentRow;

test('real round-trip: detect observes actual temporary runtime presence, refreshes and reverses after reload',{skip,timeout:30000},async()=>{
 const b=await openLive(realisticOptions),p=b.page;
 try{
  fs.rmSync(path.join(b.h.tmp,'.codex'),{recursive:true});await tab(p,'agents');
  const detect=async()=>{await p.getByRole('button',{name:'Relancer la détection',exact:true}).click();await idle(p);return reloadSettings(b,'agents');};
  let vm=await detect();assert.equal(vm.runtimes.find(r=>r.id==='codex').found,false);
  fs.mkdirSync(path.join(b.h.tmp,'.codex'));vm=await detect();assert.equal(vm.runtimes.find(r=>r.id==='codex').found,true);
  assert.ok((await p.locator('[data-testid=settings-runtime-codex]').innerText()).includes('Détecté'));
  assert.equal(agent(vm,'atlas').detectedName,'Orion');
  fs.rmSync(path.join(b.h.tmp,'.codex'),{recursive:true});vm=await detect();assert.equal(vm.runtimes.find(r=>r.id==='codex').found,false);
 }finally{await b.close();}
});

for(const action of ['rename','clear','primary','hide','remove','re-add'])test('real round-trip: agent '+action+' persists after reload and reverses',{skip,timeout:35000},async()=>{
 const b=await openLive(realisticOptions),p=b.page;
 try{
  await tab(p,'agents');
  await agentConnector(p,'legacy');
  const change=async value=>{
   if(action==='rename'||action==='clear')await (await agentEditor(p,await row(p,'atlas'))).locator('input[id^=settings-agent-name-]').fill(value);
   if(action==='primary')await agentAction(p,await row(p,value),'primary');
   if(action==='hide')await agentAction(p,await row(p,'scribe'),value?'hide':'show');
   if(action==='remove'||action==='re-add'){
    if(value)await p.locator('[data-testid="settings-unconfigured-agent-scribe"] button').click();
    else await agentAction(p,await row(p,'scribe'),'remove');
   }
   await submit(b,'agents');return reloadSettings(b,'agents');
  };
  if(action==='re-add'){await change(false);assert.equal(agent(await getVM(b),'scribe').configured,false);}
  const value=action==='rename'?'Atlas renamed':action==='clear'?'':action==='primary'?'scribe':action==='hide'?true:action==='re-add';
  let vm=await change(value);
  if(action==='rename'||action==='clear'){assert.equal(agent(vm,'atlas').name,value||null);assert.equal(await (await agentEditor(p,await row(p,'atlas'))).locator('input[id^=settings-agent-name-]').inputValue(),value);}
  if(action==='primary')assert.equal(agent(vm,'scribe').isPrimary,true);
  if(action==='hide')assert.equal(agent(vm,'scribe').hidden,true);
  if(action==='remove'||action==='re-add')assert.equal(agent(vm,'scribe').configured,value);
  vm=await change(action==='rename'||action==='clear'?'Atlas':action==='primary'?'atlas':action==='hide'?false:!value);
  if(action==='rename'||action==='clear')assert.equal(agent(vm,'atlas').name,'Atlas');
  if(action==='primary')assert.equal(agent(vm,'atlas').isPrimary,true);
  if(action==='hide')assert.equal(agent(vm,'scribe').hidden,false);
  if(action==='remove'||action==='re-add')assert.equal(agent(vm,'scribe').configured,!value);
 }finally{await b.close();}
});

for(const [key,changed,original] of [['name','Scratch Office','Atelier'],['locale','en','fr'],['timeZone','America/Montreal','Europe/Paris']])test('real round-trip: instance '+key+' persists after reload and reverses',{skip,timeout:35000},async()=>{
 const b=await openLive(realisticOptions),p=b.page;
 try{
  await tab(p,'instance');
  for(const value of [changed,original]){
   const input=p.locator('#settings-instance-'+key);if(key==='locale')await input.selectOption(value);else await input.fill(value);
   await submit(b,'instance');const vm=await reloadSettings(b,'instance');assert.equal(vm.instance[key].value,value);assert.equal(await p.locator('#settings-instance-'+key).inputValue(),value);
  }
 }finally{await b.close();}
});

for(const [key,value,original] of [['port','18801','18789'],['mode','lan','local'],['publicUrl','http://scratch.example.test','']])test('real round-trip: network '+key+' records desired state, offers restart and reverses',{skip,timeout:40000},async()=>{
 const b=await openLive(realisticOptions),p=b.page;
 try{
  await tab(p,'instance');
  if(key!=='port'){await p.locator('#settings-network-mode').selectOption('lan');await p.locator('#settings-network-publicUrl').fill('http://scratch.example.test');}
  else await p.locator('#settings-network-port').fill(value);
  await submit(b,'network');let vm=await reloadSettings(b,'instance');
  assert.equal(String(vm.network[key].value),value);assert.equal(vm.network.restartRequired,true);assert.equal(vm.network.active.port,18789);assert.equal(vm.network.active.mode,'local');
  assert.ok((await p.locator('.ao-settings').innerText()).includes('redémarrage'));
  await p.locator('#settings-network-mode').selectOption('local');await p.locator('#settings-network-publicUrl').fill('');await p.locator('#settings-network-port').fill('18789');
  await submit(b,'network');vm=await reloadSettings(b,'instance');assert.equal(String(vm.network[key].value??''),original);assert.equal(vm.network.restartRequired,false);
 }finally{await b.close();}
});

for(const [key,value,original] of [['displayName','Scratch Owner','Camille'],['email','next@example.test','owner@example.test']])test('real round-trip: account '+key+' persists after reload and reverses',{skip,timeout:35000},async()=>{
 const b=await openLive(realisticOptions),p=b.page;
 try{
  await tab(p,'compte');for(const next of [value,original]){
   await p.locator('#settings-owner-'+key).fill(next);await submit(b,'owner');const vm=await reloadSettings(b,'compte');assert.equal(vm.owner[key].value,next);assert.equal(await p.locator('#settings-owner-'+key).inputValue(),next);
  }
 }finally{await b.close();}
});

test('real round-trip: password replacement survives reload, authenticates and reverses',{skip,timeout:40000},async()=>{
 const b=await openLive(realisticOptions),p=b.page;const next='replacement-scratch-password';
 const login=async password=>(await fetch(b.h.base+'/api/login',{method:'POST',headers:{'content-type':'application/json','x-ao-request':'1'},body:JSON.stringify({email:b.h.email,password})})).status;
 try{
  await tab(p,'compte');
  for(const [password,current] of [[next,b.h.password],[b.h.password,next]]){
   await p.locator('#settings-password').fill(password);await p.locator('#settings-confirmation').fill(password);await submit(b,'password',current);
   await reloadSettings(b,'compte');assert.equal(await p.locator('#settings-password').inputValue(),'');assert.equal(await login(password),200);assert.equal(await login(current),401);
  }
 }finally{await b.close();}
});

test('real round-trip: connection check records success and refused credential then recovers after reload',{skip,timeout:35000},async()=>{
 const b=await openLive(realisticOptions),p=b.page;
 try{
  await tab(p,'connexion');await openConnector(p,'openclaw');await p.locator('#settings-check-'+await connectionId(b)).click();await idle(p);let vm=await reloadSettings(b,'connexion');assert.equal(vm.runtimes.find(r=>r.selected).connection.status,'connected');
  const original=b.h.fake.token;b.h.fake.token='changed-synthetic-token';
  await openConnector(p,'openclaw');await p.locator('#settings-check-'+await connectionId(b)).click();await idle(p);vm=await reloadSettings(b,'connexion');assert.equal(vm.runtimes.find(r=>r.selected).connection.status,'unauthorized');
  b.h.fake.token=original;await openConnector(p,'openclaw');await p.locator('#settings-check-'+await connectionId(b)).click();await idle(p);vm=await reloadSettings(b,'connexion');assert.equal(vm.runtimes.find(r=>r.selected).connection.status,'connected');
 }finally{await b.close();}
});

test('real round-trip: connection URL and token replacement persists privately and reverses',{skip,timeout:50000},async()=>{
 const b=await openLive(realisticOptions),p=b.page;
 try{
  const original=b.h.gw.url,token=b.h.fake.token;
  for(const [url,secret] of [[original+'/replacement','replacement-synthetic-token'],[original,token]]){
   b.h.fake.token=secret;await tab(p,'connexion');await openConnector(p,'openclaw');await p.locator('#settings-runtime-'+await connectionId(b)+'-gatewayUrl').fill(url);await p.getByRole('button',{name:/^Remplacer/}).click();await openConnector(p,'openclaw');await p.locator('#settings-runtime-'+await connectionId(b)+'-token').fill(secret);
   await openConnector(p,'openclaw');await p.locator('#settings-check-'+await connectionId(b)).click();await p.waitForFunction(()=>document.querySelector('#settings-current-password') || document.querySelector('#settings-section-form')?.getAttribute('aria-busy')==='false');
   if(await p.locator('#settings-current-password').count())await confirm(p,b.h.password);await idle(p);await submit(b,'runtimes');
   const vm=await reloadSettings(b,'connexion'),runtime=vm.runtimes.find(r=>r.selected);assert.equal(runtime.values.gatewayUrl.value,url);assert.equal(runtime.values.token.value,null);assert.equal(runtime.values.token.tokenSet,true);assert.equal(await p.locator('#settings-runtime-'+await connectionId(b)+'-token').count(),0);
   const secrets=JSON.parse(fs.readFileSync(b.h.paths.secrets,'utf8'));assert.equal(secrets.runtimes.legacy.runtimeToken,secret);assert.ok(!(await p.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).includes(secret));
  }
 }finally{await b.close();}
});

test('real round-trip: integration repair fixes an outdated owned skill and remains installed after reload',{skip,timeout:45000},async()=>{
 const b=await openLive(realisticOptions),p=b.page;
 try{
  await applyPlan(b);const file=path.join(b.h.tmp,'.openclaw/workspace/skills/projet/SKILL.md'),installed=fs.readFileSync(file,'utf8');fs.appendFileSync(file,'\nOld Agent Office version\n');
  assert.equal(integrationStatus(await reloadSettings(b,'integrations')),'outdated');await applyPlan(b);assert.equal(fs.readFileSync(file,'utf8'),installed);assert.equal(integrationStatus(await reloadSettings(b,'integrations')),'installed');
  await applyPlan(b,'uninstall');assert.equal(integrationStatus(await reloadSettings(b,'integrations')),'missing');assert.ok(fs.readFileSync(path.join(b.h.tmp,'.openclaw/workspace/AGENTS.md'),'utf8').includes('Preserve these owner instructions.'));
 }finally{await b.close();}
});

test('real round-trip: integration uninstall reports absence after reload and can reinstall',{skip,timeout:45000},async()=>{
 const b=await openLive(realisticOptions);
 try{await applyPlan(b);await applyPlan(b,'uninstall');assert.equal(integrationStatus(await reloadSettings(b,'integrations')),'missing');assert.equal(fs.existsSync(path.join(b.h.tmp,'.openclaw/workspace/skills/projet/projet.js')),false);await applyPlan(b);assert.equal(integrationStatus(await reloadSettings(b,'integrations')),'installed');}
 finally{await b.close();}
});


test('real process round-trip: confirmed restart boots a new API, reloads and activates saved network settings',{skip,timeout:65000},async()=>{
 const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);
 const {settingsProcessFixture,freePort}=require('../helpers/settings-process-fixture');
 const b=await openLive({fixtureFactory:settingsProcessFixture}),p=b.page;
 try{
  const initial=(await b.h.get('/api/v2/meta')).json.data.bootId;assert.ok(initial);
  const original=(await getVM(b)).network.port.value,next=await freePort();
  await tab(p,'instance');await p.locator('#settings-network-port').fill(String(next));await submit(b,'network');
  const before=await reloadSettings(b,'instance');assert.equal(before.network.restartRequired,true);assert.equal(before.network.active.port,original);
  await p.setViewportSize({width:375,height:667});await shot(p,'restart-offered-mobile');
  await p.getByRole('button',{name:'Redémarrer Agent Office',exact:true}).click();
  await p.locator('[role=dialog]').getByRole('button',{name:'Redémarrer',exact:true}).click();
  const reloaded=p.waitForEvent('domcontentloaded');await reloaded;await p.locator('#settings-section-form').waitFor();await tab(p,'instance');
  const after=await getVM(b),meta=(await b.h.get('/api/v2/meta')).json.data;
  assert.notEqual(meta.bootId,initial);assert.equal(b.h.boots,2);assert.equal(after.network.active.port,next);assert.equal(after.network.restartRequired,false);assert.equal(await p.locator('#settings-network-port').inputValue(),String(next));
  assert.deepEqual(b.h.restartExits,[75],'the actual supervisor shutdown preserves the dedicated restart exit status');
  assert.equal(b.requests.filter(r=>r.method==='POST' && r.path.endsWith('/settings/restart')).length,1,'one restart POST even if the flushed response races process exit');
  await shot(p,'restart-returned-mobile');
  await p.locator('#settings-network-port').fill(String(original));await submit(b,'network');assert.equal((await reloadSettings(b,'instance')).network.port.value,original);
 }finally{await b.close();}
});

test('real restart policy: systemd presence without a declaration shows a manual command after network save and reload',{skip,timeout:35000},async()=>{
 const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);
 const {createHostSupervisor}=require('../../src/ops/host-supervisor');
 const supervisor=createHostSupervisor({env:{INVOCATION_ID:'scratch-systemd'},argv:['node','/scratch/server.js'],execPath:'/scratch/node',shutdown(){throw Error('presence alone must never exit');}});
 const b=await openLive({...realisticOptions,supervisor}),p=b.page;
 try{
  await tab(p,'instance');await p.locator('#settings-network-port').fill('18801');await submit(b,'network');
  const vm=await reloadSettings(b,'instance');assert.equal(vm.network.restartRequired,true);assert.equal(vm.restart.supported,false);
  assert.equal(await p.getByRole('button',{name:'Redémarrer Agent Office',exact:true}).count(),0);
  assert.ok((await p.locator('.ao-settings__restart').first().innerText()).includes('/scratch/server.js'));
  await tab(p,'diagnostic');assert.equal(await p.getByRole('button',{name:'Redémarrer Agent Office',exact:true}).count(),0);
  assert.equal(b.requests.filter(r=>r.method==='POST' && r.path.endsWith('/settings/restart')).length,0);
  await tab(p,'instance');await p.locator('#settings-network-port').fill('18789');await submit(b,'network');
  assert.equal((await reloadSettings(b,'instance')).network.restartRequired,false);
 }finally{await b.close();}
});

test('real round-trip: Diagnostic refresh reads changed integration files and reflects their restoration',{skip,timeout:35000},async()=>{
 const b=await openLive(realisticOptions),p=b.page;
 try{
  await applyPlan(b);await tab(p,'diagnostic');const file=path.join(b.h.tmp,'.openclaw/workspace/skills/projet/SKILL.md'),original=fs.readFileSync(file,'utf8');
  for(const [content,status,label] of [[original+'\nOld Agent Office\n','outdated','Intégration à mettre à jour'],[original,'installed','Agent configuré']]){
   fs.writeFileSync(file,content);await p.getByRole('button',{name:'Options du diagnostic',exact:true}).click();await p.getByRole('menuitem',{name:'Actualiser le diagnostic',exact:true}).click();await idle(p);
   if(status==='installed')await p.locator('.ao-settings__healthy > summary').click();assert.ok((await p.locator('[data-testid="diagnostic-agent:rt:legacy:agent:YXRsYXM"]').innerText()).includes(label));assert.equal(integrationStatus(await reloadSettings(b,'diagnostic')),status);
  }
 }finally{await b.close();}
});

test('real live refresh: integration apply updates a second clean browser tab through Settings SSE',{skip,timeout:45000},async()=>{
 const b=await openLive(realisticOptions),p=b.page;let other;
 try{
  other=await p.context().newPage();await other.goto(b.origin+'/parametres?onglet=integrations');await other.locator('#settings-section-form').waitFor();
  await other.waitForFunction(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);return services.stream.status.get().conn==='open';});
  await applyPlan(b);
  await other.waitForFunction(()=>[...document.querySelectorAll('.ao-settings__section .bu-list-row__title .bu-caption')].filter(e=>e.textContent==='Installée').length===2);
  assert.equal(await other.getByRole('button',{name:'Actualiser les paramètres',exact:true}).count(),0);
  await applyPlan(b,'uninstall');await other.waitForFunction(()=>[...document.querySelectorAll('.ao-settings__section li.bu-list-row')].filter(e=>/^(Atlas|Scribe)/.test(e.textContent.trim()) && e.querySelector('.bu-caption')?.textContent==='Manquante').length===2);
  assert.equal(integrationStatus(await reloadSettings(b,'integrations')),'missing');
 }finally{await other?.close();await b.close();}
});

test('real Settings frame: every tab, viewport and theme fits after contract integration',{skip,timeout:60000},async()=>{
 const b=await openLive(realisticOptions),p=b.page;
 try{
  for(const [width,height] of [[1440,900],[390,844],[375,667]]){
   await p.setViewportSize({width,height});
   for(const theme of ['light','dark']){
    await p.evaluate(async theme=>{const m=await import('/theme.js?v='+document.querySelector('meta[name=ao-build]').content);m.setTheme(theme);},theme);
    for(const id of ['diagnostic','agents','connexion','instance','compte']){
     await tab(p,id);const geometry=await p.evaluate(()=>{const frame=document.querySelector('.ao-settings'),body=frame.querySelector('.ao-frame__body'),footer=frame.querySelector('.ao-frame__foot');body.scrollTop=body.scrollHeight;return{width:document.scrollingElement.scrollWidth,height:document.scrollingElement.scrollHeight,vw:innerWidth,vh:innerHeight,frameBottom:frame.getBoundingClientRect().bottom,footerBottom:body.getBoundingClientRect().bottom,footerHidden:getComputedStyle(footer).display==='none'};});
     assert.ok(geometry.width<=geometry.vw&&geometry.height<=geometry.vh,id+' document bounds');assert.ok(Math.abs(geometry.frameBottom-geometry.footerBottom)<1,id+' body fills frame without idle footer');assert.equal(geometry.footerHidden,true);
     await p.locator('.ao-settings > .ao-frame__body').evaluate(e=>e.scrollTop=0);await shot(p,id+'-'+width+'-'+theme);
    }
   }
  }
 }finally{await b.close();}
});

test('real round-trip: implicit main workspace installs and stays installed without Detect or agents.list config',{skip,timeout:35000},async()=>{
 const options={...realisticOptions,env:{FAKE_OC_FAIL:'agents list'},
  seed(tmp,context){const rows=realisticOptions.seed(tmp,context),file=path.join(tmp,'.openclaw/openclaw.json'),config=JSON.parse(fs.readFileSync(file,'utf8'));config.agents={defaults:{workspace:rows[0].workspace}};fs.writeFileSync(file,JSON.stringify(config));return[{id:'main',workspace:rows[0].workspace,default:true}];},
  config(config){config.agents={primary:'main',configured:{openclaw:['main']},looks:{},names:{openclaw:{main:'Atlas'}}};},
  handlers:{'agents.list':()=>({defaultId:'main',agents:[{id:'main',name:'Atlas'}]})}
 };
 const b=await openLive(options);
 try{assert.equal(integrationStatus(await getVM(b),'main'),'missing');await applyPlan(b);assert.equal(integrationStatus(await reloadSettings(b,'integrations'),'main'),'installed');await applyPlan(b,'uninstall');assert.equal(integrationStatus(await reloadSettings(b,'integrations'),'main'),'missing');}
 finally{await b.close();}
});
