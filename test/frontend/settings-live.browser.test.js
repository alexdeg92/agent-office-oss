import {agentRows,agentRow,agentAction,agentEditor,agentConnector} from './helpers/settings-agent-browser.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { browserPath } from './helpers/layout-browser.js';
const require=createRequire(import.meta.url);
const {settingsFixture}=require('../helpers/settings-fixture');
const {scopedId}=require('../../src/runtime-ids');
const {waitFor}=require('../helpers/harness');
const primaryDiagnostic='[data-testid="diagnostic-agent:'+scopedId('legacy','agent','atlas')+'"]';
const {createFrontendServer}=require('../../scripts/serve-frontend');
const skip=!browserPath();
const save=p=>p.locator('.ao-settings__footer button[type=submit], [data-testid=settings-integration-apply]');
const tab=async(p,id)=>{if(id==='integrations'){await p.evaluate(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);services.router.setQuery({onglet:'integrations',connecteur:null,runtime:null,section:null});});await p.waitForFunction(()=>new URL(location.href).searchParams.get('onglet')==='connexion'&&new URL(location.href).searchParams.get('section')==='integrations');await p.locator('#settings-tab-connexion[aria-selected=true]').waitFor();return;}await p.locator('#settings-tab-'+id).click();await p.locator('#settings-tab-'+id+'[aria-selected=true]').waitFor();};
// Since T-0074 (7ff11dc2) Connexion is a gallery of provider cards; a connector's form lives on its focused page.
const openConnector=async(p,provider)=>{
  if(await p.locator('[data-connector-back]').count()&&await p.locator(`[data-provider="${provider}"]`).count()===0)return;
  await p.locator(`[data-provider="${provider}"]`).click();await p.locator('[data-connector-back]').waitFor();
};
const switchConnector=async(p,provider)=>{await p.locator('[data-connector-back]').click();await p.locator(`[data-provider="${provider}"]`).waitFor();await openConnector(p,provider);};
const idle=p=>p.waitForFunction(()=>document.querySelector('#settings-section-form')?.getAttribute('aria-busy')==='false');
async function openLive(options={}) {
  let frontend,h,browser;
  const server=createServer((req,res)=>{
    if (!frontend) { res.writeHead(503);res.end();return; }
    frontend.emit('request',req,res);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  const close=async()=>{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await h?.close();};
  try {
    h=await settingsFixture({...options,publicUrl:origin});
    frontend=createFrontendServer({root:resolve('public/v2'),apiBase:'/backend',apiVersion:2,apiProxy:h.base});
    browser=await chromium.launch({executablePath:browserPath(),headless:true,args:['--no-sandbox','--disable-background-networking']});
    const context=await browser.newContext();
    const split=h.cookie.indexOf('=');
    await context.addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:origin,httpOnly:true,sameSite:'Lax'}]);
    await context.addInitScript(()=>{localStorage.setItem('ao.locale','fr');localStorage.setItem('ao.uiTheme','light');});
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    const page=await context.newPage();page.setDefaultTimeout(10000);
    const errors=[],requests=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',e=>{if(e.type()==='error'&&e.text().startsWith('[vm]'))errors.push(e.text());});
    page.on('request',r=>{if(new URL(r.url()).pathname.includes('/settings'))requests.push({path:new URL(r.url()).pathname,method:r.method()});});
    await page.goto(origin+'/parametres',{waitUntil:'domcontentloaded'});
    await page.locator('#settings-section-form').waitFor();
    return {page,h,origin,requests,close:async()=>{await close();assert.deepEqual(errors,[],'live responses and browser execution are valid');}};
  } catch(e){await close();throw e;}
}
const confirm=async(p,password)=>{
  await p.locator('#settings-current-password').fill(password);
  await p.locator('button[form=settings-reauth-form]').click();
  await p.locator('#settings-current-password').waitFor({state:'hidden'});await idle(p);
};
const capture=async(p,name)=>{if(process.env.SETTINGS_SCREENSHOTS==='1')await p.screenshot({path:'design/reports/settings-1/'+name+'.png',animations:'disabled'});};

test('S36-01 live owner metadata survives login/rename and clears on logout/expiry despite a late language response',{skip,timeout:45000},async()=>{
 const b=await openLive({effectiveV3:true}),p=b.page,h=b.h,fs=require('node:fs'),path=require('node:path');
 try{
  const home=path.join(h.tmp,'.claude'),dir=path.join(home,'projects','private-key');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'session.jsonl'),JSON.stringify({type:'user',uuid:'event',sessionId:'session',cwd:'/srv/synthetic/PRIVATE_BROWSER_PROJECT',timestamp:new Date().toISOString(),message:{role:'user',content:'Synthetic'}})+'\n');
  await h.reauth();assert.equal((await h.put('/api/v3/settings/runtimes',{expectedRevision:1,runtimes:[{id:'legacy',adapter:'openclaw',enabled:true,gatewayUrl:h.gw.url},{id:'claude',adapter:'claude-code',enabled:true,home}]})).status,200);
  await waitFor(()=>h.engine.agents().some(a=>a.name==='PRIVATE_BROWSER_PROJECT'));
  const local=require('../../src/runtime-ids').parseId(h.engine.agents().find(a=>a.name==='PRIVATE_BROWSER_PROJECT').id).local;
  const rename=async name=>{const vm=(await h.get('/api/v3/settings')).json.data;assert.equal((await h.put('/api/v3/settings/agents',{expectedRevision:vm.revision,runtime:'claude',primary:local,agents:[{id:local,name,hidden:false}]})).status,200);};
  await rename(null);await p.reload({waitUntil:'domcontentloaded'});await p.locator('#settings-section-form').waitFor();
  const name=()=>p.evaluate(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);return services.meta.primaryAgent?.name;});
  assert.equal(await name(),'PRIVATE_BROWSER_PROJECT');
  await p.waitForFunction(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);return services.stream.status.get().conn==='open';});
  await rename('PRIVATE_BROWSER_RENAMED');await p.waitForFunction(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);return services.meta.primaryAgent?.name==='PRIVATE_BROWSER_RENAMED';});
  await p.evaluate(()=>{
   const original=window.fetch;window.restoreMetaFetch=()=>window.fetch=original;
   window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).endsWith('/api/v2/meta?locale=en')&&!window.metadataHeld){window.metadataHeld=true;await new Promise(r=>window.releaseMeta=r);}return response;};
   window.pendingMeta=import('/lang.js?v='+document.querySelector('meta[name=ao-build]').content).then(m=>m.chooseLang('en'));
  });await p.waitForFunction(()=>window.metadataHeld);
  await p.getByRole('button',{name:'Sign out',exact:true}).click();await p.locator('#login-email').waitFor();
  assert.equal(await name(),undefined);await p.evaluate(async()=>{window.releaseMeta();await window.pendingMeta;window.restoreMetaFetch();});
  assert.ok(await p.evaluate(async()=>{const build=document.querySelector('meta[name=ao-build]').content,{services}=await import('/services.js?v='+build),i18n=await import('/i18n.js?v='+build);return !JSON.stringify(services.meta).includes('PRIVATE_BROWSER')&&!i18n.agentName().includes('PRIVATE_BROWSER');}));
  assert.ok(!(await p.locator('body').innerText()).includes('PRIVATE_BROWSER'));
  await p.locator('#login-email').fill(h.email);await p.locator('#login-password').fill(h.password);await p.locator('button[type=submit]').click();await p.locator('#settings-section-form').waitFor();assert.equal(await name(),'PRIVATE_BROWSER_RENAMED');
  await p.context().clearCookies();await p.evaluate(async()=>{const api=await import('/api.js?v='+document.querySelector('meta[name=ao-build]').content);await api.get('/api/v3/settings',{quiet:true}).catch(()=>{});});await p.locator('#login-email').waitFor();assert.equal(await name(),undefined);
 }finally{await b.close();}
});

test('live Settings: owner frame, detection/agents, v2 settings SSE, revision conflict and credential testing',{skip,timeout:60000},async()=>{
  const b=await openLive();const p=b.page,h=b.h;
  try {
    assert.equal(await p.locator('[data-testid="diagnostic-runtime:demo"]').count(),0,'inactive unfound adapters are not diagnostic issues');
    for(const [width,height] of [[1440,900],[390,844],[375,667]]){
      await p.setViewportSize({width,height});
      for(const id of ['diagnostic','agents','connexion','instance','compte']){
        await tab(p,id);
        assert.ok(!/Autre \(|settings\./.test(await p.locator('.ao-settings').innerText()),id+' translated live labels');
        assert.ok(await p.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth && document.scrollingElement.scrollHeight<=innerHeight));
      }
    }
    await p.setViewportSize({width:1440,height:900});await tab(p,'agents');
    await agentConnector(p,'openclaw');
    await p.getByRole('button',{name:'Relancer la détection',exact:true}).click();await idle(p);
    assert.equal(h.detectCalls,1);assert.ok((await p.locator('.ao-settings').innerText()).includes('Codex'));
    await p.locator('[data-testid="settings-unconfigured-agent-scribe"] button').click();await p.locator('#settings-agent-name-1').fill('Lyra');
    await agentEditor(p,agentRows(p).first());await p.locator('#settings-agent-name-0').fill('Orion');await save(p).click();await idle(p);
    assert.equal(h.engine.primaryAgent().name,'Orion');assert.equal((await h.get('/api/v3/settings')).json.data.agents.find(a=>a.agentId==='scribe').configured,true);
    await tab(p,'instance');
    await p.waitForFunction(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);return services.stream.status.get().conn==='open';});
    const remote=async name=>{const vm=(await h.get('/api/v3/settings')).json.data;const r=await h.put('/api/v3/settings/instance',{expectedRevision:vm.revision,name});assert.equal(r.status,200);};
    await remote('Remote instance');await p.waitForFunction(()=>document.querySelector('#settings-instance-name').value==='Remote instance');
    await p.locator('#settings-instance-name').fill('Local draft');await remote('New remote instance');
    await p.getByRole('button',{name:'Actualiser les paramètres',exact:true}).waitFor();
    await save(p).click();await idle(p);await p.locator('.ao-settings [role=alert]').waitFor();
    assert.equal(await p.locator('#settings-instance-name').inputValue(),'Local draft');
    // The external-change notice and the conflict alert both offer a refresh; use the notice's
    await p.getByRole('status').filter({hasText:'Les paramètres ont changé.'}).getByRole('button',{name:'Actualiser les paramètres',exact:true}).click();
    await p.locator('[role=dialog]').getByRole('button',{name:'Actualiser les paramètres',exact:true}).click();await idle(p);
    assert.equal(await p.locator('#settings-instance-name').inputValue(),'New remote instance');
    await tab(p,'connexion');await openConnector(p,'openclaw');await p.locator('[data-runtime-connection=legacy]').getByRole('button',{name:/^Remplacer/}).click();
    await p.locator('#settings-runtime-legacy-token').fill(h.fake.token);await p.locator('#settings-check-legacy').click();
    await p.locator('#settings-current-password').fill('wrong-fixture-password');await p.locator('button[form=settings-reauth-form]').click();
    await p.locator('#settings-reauth-error').waitFor();assert.ok(p.url().includes('/parametres'));
    await confirm(p,h.password);assert.equal(await save(p).isEnabled(),true);
    await save(p).click();await idle(p);assert.equal(await p.locator('#settings-runtime-legacy-token').count(),0);
    assert.ok(!(await p.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).includes(h.fake.token));
    await tab(p,'diagnostic');
    await p.locator('.ao-settings__healthy > summary').click();
    assert.ok((await p.locator('[data-testid="diagnostic-runtime:legacy"]').innerText()).includes('OpenClaw'));
    assert.ok((await p.locator(primaryDiagnostic).innerText()).includes('Orion'));
    const integration=p.locator(primaryDiagnostic);
    assert.ok((await integration.locator('.ao-settings__diagnostic-cause').innerText()).includes('Intégration'),'configured agent warning names its integration issue');
    assert.ok(!(await integration.locator('.ao-settings__diagnostic-cause').innerText()).includes('Agent configuré'));
    assert.ok((await integration.locator('.ao-settings__diagnostic-cause').innerText()).length>0,'warning explains the corrective action');
    await p.locator('[data-testid="diagnostic-runtime:codex"] summary').click();
    const detected=await p.locator('[data-testid="diagnostic-runtime:codex"]').innerText();
    assert.ok(detected.includes('Codex') && detected.includes('détecté, pas encore connecté'));
    assert.ok(detected.includes('Configurez ce moteur depuis Connecteurs'));
    await capture(p,'live-diagnostic-desktop');
    await p.evaluate(async()=>{const {chooseLang}=await import('/lang.js?v='+document.querySelector('meta[name=ao-build]').content);await chooseLang('en');});
    await p.waitForFunction(()=>document.querySelector('[data-testid="diagnostic-runtime:legacy"]').textContent.includes('Connected'));
    assert.ok((await p.locator(primaryDiagnostic).innerText()).includes('Orion'));
    await p.evaluate(async()=>{const {chooseLang}=await import('/lang.js?v='+document.querySelector('meta[name=ao-build]').content);await chooseLang('fr');});
    await p.waitForFunction(()=>document.querySelector('[data-testid="diagnostic-runtime:legacy"]').textContent.includes('Connexion établie'));
    assert.ok(b.requests.some(r=>r.path==='/backend/api/v3/settings' && r.method==='GET'));
    assert.ok(b.requests.every(r=>!r.path.startsWith('/backend/api/v2/settings')));
    const detectedName=(await h.get('/api/v3/settings')).json.data.agents.find(a=>a.agentId==='atlas').detectedName;
    await tab(p,'agents');
    await agentConnector(p,'openclaw');
    const atlasRow=await agentEditor(p,await agentRow(p,'atlas')),atlasName=atlasRow.locator('input[id^=settings-agent-name-]');
    assert.equal(await atlasRow.locator('.ao-settings__role').count(),1,'runtime replacement retains the configured primary in the returned VM');
    await atlasName.fill('');assert.equal(await save(p).isEnabled(),true);
    const clearing=p.waitForResponse(r=>r.request().method()==='PUT' && new URL(r.url()).pathname.endsWith('/api/v3/settings/agents'));
    await save(p).click();const cleared=await clearing;
    assert.equal(cleared.status(),200,JSON.stringify(await cleared.json()));await idle(p);
    const unnamed=(await h.get('/api/v3/settings')).json.data.agents.find(a=>a.agentId==='atlas');
    assert.equal(unnamed.name,null,'explicitly cleared name remains null after save and GET');
    assert.equal(unnamed.detectedName,detectedName,'discovered identity remains separate');
    assert.equal(await atlasName.inputValue(),'');
  } finally{await b.close();}
});

test('live Settings: reviewed integrations, combined instance/network writes and password rotation',{skip,timeout:45000},async()=>{
  const b=await openLive();const p=b.page,h=b.h;
  try{
    await tab(p,'agents');await p.getByRole('button',{name:'Relancer la détection',exact:true}).click();await idle(p);
    await tab(p,'integrations');await p.locator('#settings-plan').click();await p.locator('#settings-plan-confirm').waitFor();
    assert.ok((await p.locator('.ao-settings__plan').innerText()).includes(h.tmp));
    await p.setViewportSize({width:375,height:667});await p.locator('#settings-plan-confirm').scrollIntoViewIfNeeded();await capture(p,'live-plan-mobile');
    await p.locator('#settings-plan-confirm').check();await save(p).click();await confirm(p,h.password);
    assert.equal(await p.locator('#settings-plan-confirm').count(),0);
    assert.ok((await h.get('/api/v3/settings')).json.data.agents.some(a=>a.integrations.some(i=>i.status==='installed')));
    await tab(p,'diagnostic');
    const current=(await h.get('/api/v3/settings')).json.data,atlas=current.agents.find(a=>a.agentId==='atlas');
    assert.ok(atlas.configured && atlas.integrations.every(i=>i.status==='installed'));
    await p.locator('.ao-settings__healthy > summary').click();
    const healthy=p.locator('[data-testid="diagnostic-agent:'+atlas.id+'"]');
    assert.ok((await healthy.innerText()).includes('Agent configuré'));
    assert.equal(await healthy.getByRole('img',{name:'En ordre',exact:true}).count(),1);
    await tab(p,'instance');await p.locator('#settings-instance-name').fill('Live instance');await p.locator('#settings-network-port').fill('18801');
    await save(p).click();await idle(p);assert.equal(await save(p).count(),0);
    const vm=(await h.get('/api/v3/settings')).json.data;
    assert.equal(vm.instance.name.value,'Live instance');assert.equal(vm.network.port.value,18801);assert.equal(vm.network.active.port,18789);assert.equal(vm.network.restartRequired,true);
    await capture(p,'live-restart-mobile');
    await tab(p,'compte');await p.locator('#settings-owner-displayName').fill('Live owner');
    await p.locator('#settings-password').fill('replacement-fixture-password');await p.locator('#settings-confirmation').fill('replacement-fixture-password');
    await save(p).click();await idle(p);assert.equal(await p.locator('#settings-password').inputValue(),'');
    assert.equal(h.store.owner.name,'Live owner');
    await p.locator('#settings-owner-email').fill('next@example.test');await save(p).click();await p.locator('#settings-current-password').waitFor();
    await p.locator('[role=dialog]').getByRole('button',{name:'Annuler',exact:true}).click();await idle(p);
    assert.equal(await p.locator('#settings-owner-email').inputValue(),'next@example.test');
  }finally{await b.close();}
});

test('live Settings: environment and read-only reasons disable the actual service forms',{skip,timeout:30000},async()=>{
  for(const env of [{AO_INSTANCE_NAME:'Env instance'},{PORTAL_READONLY:'1'}]){
    const b=await openLive({env});const p=b.page;
    try{
      await tab(p,'instance');assert.equal(await p.locator('#settings-instance-name').isDisabled(),true);
      assert.equal(await save(p).count(),0);
      assert.ok((await p.locator('.ao-settings').innerText()).includes(env.AO_INSTANCE_NAME?'AO_INSTANCE_NAME':'lecture seule'));
      if(env.PORTAL_READONLY){
        assert.equal(await p.locator('.ao-settings__banner .bu-banner__text').innerText(),'Cette instance est en lecture seule. Les changements sont désactivés.');
        await p.setViewportSize({width:375,height:667});await capture(p,'live-read-only-mobile');
        await p.evaluate(async()=>{const {chooseLang}=await import('/lang.js?v='+document.querySelector('meta[name=ao-build]').content);await chooseLang('en');});
        await p.waitForFunction(()=>document.querySelector('.ao-settings__banner .bu-banner__text').textContent==='This instance is read-only. Changes are disabled.');
      }
    }finally{await b.close();}
  }
});

test('live multi-runtime: enable Claude, choose its primary, add another instance and capture framed FR/EN forms',{skip,timeout:90000},async t=>{
  const {loadScenario,gatewayHandlers}=require('../helpers/scenario'),baseHandlers=gatewayHandlers(loadScenario('foreign-instance'));
  const fixtureNow=Date.now();
  const b=await openLive({handlers:{
    'sessions.list':()=>{const result=structuredClone(baseHandlers['sessions.list']());result.sessions.forEach((s,n)=>{s.updatedAt=fixtureNow-n*1000;});return result;},
    'sessions.get':params=>params.key==='agent:atlas:telegram:direct:foreign-user'?baseHandlers['sessions.get'](params):{messages:[]},
  }}), p=b.page, h=b.h, fs=require('node:fs'), path=require('node:path');
  const output='design/reports/multi-runtime-1';
  const shot=async name=>{if(process.env.MULTI_RUNTIME_CAPTURES==='1'){fs.mkdirSync(output,{recursive:true});await p.screenshot({path:output+'/'+name+'.png',animations:'disabled'});}};
  try {
    assert.equal((await h.put('/api/v3/settings/instance',{expectedRevision:1,name:'Synthetic multi-runtime office'})).status,200);
    const home=path.join(h.tmp,'.claude');
    for(let n=0;n<12;n++) {
      const sessionId='session-'+n,at=new Date(fixtureNow-2000-n*1000).toISOString(),dir=path.join(home,'projects','synthetic-project-'+n);
      fs.mkdirSync(dir,{recursive:true});
      const records=['attachment','mode','permission-mode','atis-latch','last-prompt','ai-title','queue-operation'].map((type,i)=>({type,sessionId,uuid:'metadata-'+n+'-'+i,timestamp:at,futureKey:'synthetic ignored metadata'}));
      records.push({type:'assistant',sessionId,session_id:sessionId,uuid:'assistant-'+n,timestamp:at,parentUuid:null,isSidechain:false,
        cwd:'/srv/synthetic-private-workspaces/agent-office-project-'+n,version:'1.0.0',gitBranch:'synthetic-branch',requestId:'synthetic-request',
        message:{role:'assistant',type:'message',model:'synthetic-model',content:[{type:'thinking',thinking:'Synthetic private reasoning'},
          {type:'tool_use',id:'tool-'+n,name:'Read',input:{file_path:'/synthetic/private/file.txt'}},{type:'future-rich-block',payload:'ignored'},
          {type:'text',text:'Synthetic assistant response'}],stop_reason:'end_turn',usage:{input_tokens:2,output_tokens:3},futureMessageKey:true}});
      records.push({type:'system',sessionId,uuid:'system-'+n,timestamp:at,parentUuid:'assistant-'+n,
        message:{role:'system',content:[{type:'text',text:'Synthetic system notice'}]}});
      records.push({type:'user',session_id:sessionId,uuid:'user-'+n,timestamp:at,parentUuid:'system-'+n,isSidechain:true,
        cwd:'/srv/synthetic-private-workspaces/agent-office-project-'+n,message:{role:'user',content:[
          {type:'tool_result',tool_use_id:'tool-'+n,content:[{type:'text',text:'Synthetic tool result'},{type:'image',source:{data:'synthetic'}}]},
          {type:'text',text:'Synthetic browser evidence'}]}});
      fs.writeFileSync(path.join(dir,sessionId+'.jsonl'),records.map(record=>JSON.stringify(record)).join('\n')+'\n');
    }
    await p.reload({waitUntil:'domcontentloaded'});await p.locator('#settings-section-form').waitFor();await tab(p,'agents');
    await p.getByRole('button',{name:'Relancer la détection',exact:true}).click();await idle(p);await tab(p,'connexion');
    const claude=p.locator('[data-runtime-connection="claude-code"]');
    assert.equal(await p.locator('#settings-check-demo').count(),0,'inactive optional runtime hides its connection form');
    await openConnector(p,'openclaw');
    assert.ok(!(await p.locator('[data-runtime-connection=legacy]').innerText()).split('\n').includes('legacy'),'internal migration ID is absent from the card');
    await p.locator('[data-connector-back]').click();await p.locator('[data-provider="claude-code"]').waitFor();await openConnector(p,'claude-code');
    assert.equal(await p.locator('#settings-runtime-claude-code-home').inputValue(),home,'detection prefills the candidate from its checked ~/.claude path');
    await p.locator('#settings-enabled-claude-code').check();await p.locator('#settings-label-claude-code').fill('Claude Code · Projets');
    // include/exclude are one-per-line project lists shown as chips since ca9dc859 (adapter field control: 'chips')
    assert.equal(await p.locator('#settings-runtime-claude-code-include').evaluate(e=>!!e.closest('.ao-settings__field--chips')),true);
    await p.locator('#settings-check-claude-code').click();await confirm(p,h.password);assert.match(await p.locator('[data-runtime-connection=claude-code]').innerText(),/12 projets Claude détectés/);assert.equal(await save(p).isEnabled(),true);
    const saving=p.waitForResponse(r=>r.request().method()==='PUT' && r.url().endsWith('/api/v3/settings/runtimes'));await save(p).click();const saved=await saving;assert.equal(saved.status(),200,JSON.stringify(await saved.json()));await idle(p);
    await p.waitForFunction(async()=>{const r=await fetch('/backend/api/v3/settings');const vm=(await r.json()).data;return vm.agents.filter(a=>a.runtime==='claude-code').length===12;});
    // Discovery is already available in Settings while the independent live
    // connector is still indexing. Verify its publication separately.
    await waitFor(()=>h.engine.agents().filter(a=>a.id.startsWith('rt:claude-code:')).length===12);
    assert.equal(h.engine.agents().filter(a=>a.id.startsWith('rt:claude-code:')).length,12);
    await waitFor(()=>h.engine.agents().filter(a=>a.id.startsWith('rt:claude-code:')).every(a=>/^agent-office-project-\d+$/.test(a.name)));
    const detected=(await h.get('/api/v3/settings')).json.data.agents.filter(a=>a.runtime==='claude-code');
    assert.ok(detected.every(a=>/^agent-office-project-\d+$/.test(a.detectedName)), 'Settings detects real project basenames before synthetic chosen names');
    assert.ok(h.engine.agents().some(a=>a.id.startsWith('rt:legacy:')));
    assert.equal(h.engine.runtimes().find(r=>r.id==='claude-code').name,'Claude Code · Projets');
    const agents=h.engine.agents().filter(a=>a.id.startsWith('rt:claude-code:')).sort((a,b)=>a.id.localeCompare(b.id)).map((a,n)=>({id:require('../../src/runtime-ids').parseId(a.id).local,name:'Claude Code · Projet '+String(n+1).padStart(2,'0'),hidden:false}));
    const gatewayRevision=(await h.get('/api/v3/settings')).json.data.revision;
    assert.equal((await h.put('/api/v3/settings/agents',{expectedRevision:gatewayRevision,runtime:'legacy',primary:'atlas',agents:[{id:'atlas',name:'OpenClaw · Atlas',hidden:false},{id:'scribe',name:'OpenClaw · Scribe',hidden:false}]})).status,200);
    const revision=(await h.get('/api/v3/settings')).json.data.revision;
    assert.equal((await h.put('/api/v3/settings/agents',{expectedRevision:revision,runtime:'claude-code',primary:null,agents})).status,200);
    await waitFor(()=>h.engine.instances.find(i=>i.id==='claude-code').runtime.files.rows().every(r=>r.initialized));
    // Append after bootstrap: this is observed activity, never a fabricated running/completed run.
    fs.appendFileSync(path.join(home,'projects','synthetic-project-0','session-0.jsonl'),JSON.stringify({type:'user',uuid:'live-event',sessionId:'session-0',timestamp:new Date().toISOString(),message:{role:'user',content:'Synthetic live update'}})+'\n');
    await h.engine.instances.find(i=>i.id==='claude-code').runtime.cycle();
    await waitFor(()=>h.engine.sessions().some(s=>s.key.startsWith('rt:claude-code:') && h.engine.activity(s.key)?.kind==='working'));
    const logs=(await h.get('/api/v3/views/logs')).json.data.items;
    assert.equal(logs.filter(r=>r.id.startsWith('rt:claude-code:session:')).length,12);
    // T-0049/T-0058: a session with its own first prompt is titled by it; the others by their (owner-renamed) agent
    { const claude=logs.filter(r=>r.id.startsWith('rt:claude-code:session:')); assert.ok(claude.every(r=>/^Claude Code · Projet /.test(r.label)||r.label==='Synthetic live update'),JSON.stringify(claude.map(r=>r.label))); assert.ok(claude.filter(r=>/^Claude Code · Projet /.test(r.label)).length>=11); }
    assert.ok(logs.some(r=>r.id.startsWith('rt:claude-code:') && r.live));
    // f97e0af1/d7e9b6ba: live adapter activity is observed run evidence with a bounded expiry; only the working session runs
    { const claude=h.engine.sessions().filter(s=>s.key.startsWith('rt:claude-code:')), working=s=>h.engine.activity(s.key)?.kind==='working';
      assert.ok(claude.filter(working).length>=1);
      assert.ok(claude.filter(working).every(s=>s.run.status==='running' && s.run.evidenceLevel==='observed' && s.run.expiresAt>s.run.observedAt));
      assert.ok(claude.filter(s=>!working(s)).every(s=>s.run.status==='idle')); }
    const office=(await h.get('/api/v3/views/office')).json.data;
    assert.equal(office.occupants.filter(o=>o.id.startsWith('agent:rt:claude-code:')).length,12);
    assert.ok(office.occupants.some(o=>o.role==='primary' && o.name==='OpenClaw · Atlas'));
    assert.ok(office.occupants.some(o=>o.id=== 'agent:'+scopedId('legacy','agent','scribe')));
    assert.equal(office.kpis.find(k=>k.id==='active').value,office.occupants.filter(o=>!['idle','offline'].includes(o.state)).length);
    assert.equal(office.occupants.filter(o=>o.id.startsWith('agent:rt:claude-code:') && o.state==='working').length,1);
    for(const [url,ready,prefix] of [['/bureau','.ao-bureau__stage','office-mixed'],['/journaux','.ao-logs:not([aria-busy=true])','logs-mixed']]) {
      await p.goto(b.origin+url,{waitUntil:'domcontentloaded'});await p.locator(ready).waitFor();
      if(url==='/bureau') {
        // T-0051: occupants beyond the first floor's desks sit on upper floors and the stage shows one floor at a time,
        // so the evidence is gathered floor by floor (each floor's scene and roster), then checked as one set.
        await p.locator('.ao-floor-picker__floor').first().waitFor();
        const floorIds=await p.evaluate(()=>[...new Set([...document.querySelectorAll('.ao-floor-picker__floor[data-floor]')].map(e=>e.dataset.floor))].filter(id=>/^\d+$/.test(id)));
        const stateEvidence=[];
        for(const floor of floorIds.length?floorIds:['1']) {
          await p.goto(b.origin+'/bureau?etage='+floor,{waitUntil:'domcontentloaded'});await p.locator(ready).waitFor();
          await p.waitForFunction(()=>document.querySelector('.ao-bureau__stage')?.aoScene);
          while(await p.locator('.ao-roster-group:not([open]) summary').count())await p.locator('.ao-roster-group:not([open]) summary').first().click();
          await p.waitForFunction(()=>{const sc=document.querySelector('.ao-bureau__stage')?.aoScene,n=sc?.chars?.size||0,seen=window.__aoFloorChars;window.__aoFloorChars=n;return n>0&&n===seen;},null,{polling:400});
          stateEvidence.push(...await p.evaluate(expected=>[...document.querySelectorAll('.ao-char[data-occupant^="agent:rt:claude-code:"]')].map(el=>{
            const o=expected.find(o=>o.id===el.dataset.occupant), sc=document.querySelector('.ao-bureau__stage').aoScene, c=sc.chars.get(o.id);
            const card=[...document.querySelectorAll('.ao-roster__name')].find(e=>e.textContent===o.name);
            return {name:o.name,state:el.dataset.state,serverState:o.state,
              wanted:c && !c.walking?sc._currentPose(c):null,seatMode:c?.seatMode,
              typing:!!c?.poseEl?._frameTimer,motion:el.dataset.motion,
              group:card?.closest('[data-group]')?.dataset.group,
              rosterState:card?.closest('button')?.querySelector('.ao-roster__state')?.dataset.agentState};
          }),office.occupants));
        }
        assert.equal(stateEvidence.length,12);
        assert.equal(stateEvidence.filter(c=>c.state==='working').length,1);
        // a floor's roster is grouped by state only past 12 agents; where it is grouped, the group follows the state
        assert.ok(stateEvidence.every(c=>c.state===c.serverState && c.state===c.rosterState && (c.group===undefined || c.group===(c.state==='idle'?'inactive':'active'))),JSON.stringify(stateEvidence));
        const idleSeated=stateEvidence.filter(c=>c.state==='idle' && c.seatMode==='desk');
        assert.ok(idleSeated.length>0,'idle agents can remain seated at their assigned desks');
        assert.ok(idleSeated.every(c=>!c.typing && !/^type/.test(c.motion) && ['seated-ne','seated-turn-sw'].includes(c.wanted)),JSON.stringify(idleSeated));
        assert.equal(await p.locator('.bu-kpi').filter({has:p.getByText('En activité',{exact:true})}).locator('.bu-kpi__value').innerText(),String(office.kpis.find(k=>k.id==='active').value));
        t.diagnostic(JSON.stringify({stateEvidence,activeKpi:office.kpis.find(k=>k.id==='active').value}));
      }
      await p.setViewportSize({width:1440,height:900});
      await p.getByText('Claude Code · Projet 01',{exact:true}).filter({visible:true}).first().waitFor();
      for(const [width,height] of [[1440,900],[390,844],[375,667]]) {
        await p.setViewportSize({width,height});
        assert.ok(await p.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth && document.scrollingElement.scrollHeight<=innerHeight));
        assert.equal(await p.locator('h1:visible').count(),1);
        if(url==='/bureau')await p.locator('.ao-bureau__stage--last').waitFor({state:'hidden'});
        await shot(prefix+'-'+width);
      }
    }
    await p.goto(b.origin+'/parametres?onglet=connexion',{waitUntil:'domcontentloaded'});await p.locator('#settings-section-form').waitFor();await tab(p,'connexion');
    await tab(p,'agents');await p.getByRole('button',{name:'Relancer la détection',exact:true}).click();await idle(p);await tab(p,'connexion');await openConnector(p,'claude-code');
    for(const [width,height] of [[1440,900],[390,844],[375,667]]) {
      await p.setViewportSize({width,height});await claude.scrollIntoViewIfNeeded();
      const shape=await p.evaluate(()=>({doc:document.scrollingElement.scrollHeight,viewport:innerHeight,width:document.scrollingElement.scrollWidth,vw:innerWidth,title:[...document.querySelectorAll('h1')].filter(e=>e.getBoundingClientRect().height>0).length,overflow:getComputedStyle(document.querySelector('.ao-settings .ao-frame__body')).overflowY,foot:document.querySelector('.ao-settings .ao-frame__body').getBoundingClientRect().toJSON(),idleFooter:!!document.querySelector('.ao-settings__footer')}));
      assert.ok(shape.doc<=shape.viewport && shape.width<=shape.vw);assert.equal(shape.title,1);assert.equal(shape.overflow,'auto');assert.ok(shape.foot.bottom<=height && shape.foot.height>0);
      await shot('claude-fr-'+width);
      await switchConnector(p,'codex');
      const codex=p.locator('[data-runtime-connection=codex]');await codex.scrollIntoViewIfNeeded();assert.equal(await p.locator('#settings-enabled-codex').isDisabled(),false);assert.equal(await p.locator('#settings-runtime-codex-home').count(),1,'detected Codex has a real setup form');await switchConnector(p,'cursor-cli');assert.ok((await p.locator('[data-runtime-connection=cursor-cli]').innerText()).includes('Non détecté · connecteur à venir'));await shot('presence-fr-'+width);
      await switchConnector(p,'claude-code');
    }
    await p.setViewportSize({width:1440,height:900});await switchConnector(p,'codex');await p.evaluate(async()=>{const {chooseLang}=await import('/lang.js?v='+document.querySelector('meta[name=ao-build]').content);await chooseLang('en');});
    await p.waitForFunction(()=>document.querySelector('#settings-runtime-codex-home') && document.body.innerText.includes('Codex sessions directory'));assert.equal(await p.locator('#settings-enabled-codex').isDisabled(),false);await shot('presence-en-desktop');
    await switchConnector(p,'claude-code');await claude.scrollIntoViewIfNeeded();await p.locator('[data-testid="settings-add-runtime-claude-code"]').click();await p.locator('[data-runtime-connection="claude-code-2"]').waitFor();
    assert.equal(await p.locator('#settings-runtime-claude-code-2-home').inputValue(),home);assert.equal(await save(p).isDisabled(),true);await p.locator('#settings-check-claude-code-2').click();await idle(p);await save(p).click();await idle(p);
    assert.ok(h.engine.runtimes().some(r=>r.id==='claude-code-2' && r.enabled));
    await tab(p,'agents');await p.locator('#settings-agent-runtime').selectOption('claude-code');if(await p.locator('[data-testid^="settings-unconfigured-agent-"]').count())await p.locator('[data-testid^="settings-unconfigured-agent-"]').first().getByRole('button').click();
    await agentAction(p,agentRows(p).first(),'primary');await agentEditor(p,agentRows(p).first());await p.locator('#settings-agent-name-0').fill('Synthetic Claude primary');await save(p).click();await idle(p);
    assert.ok(h.engine.primaryAgent().id.startsWith('rt:claude-code:agent:'));assert.equal((await h.post('/api/v3/chat/messages',{text:'Do not execute'})).status,404);
    await tab(p,'connexion');await openConnector(p,'openclaw');await p.locator('#settings-enabled-legacy').uncheck();await save(p).click();await idle(p);
    assert.equal(h.engine.runtimes().find(r=>r.id==='legacy').enabled,false);assert.equal(h.engine.runtimes().filter(r=>r.id.startsWith('claude-code') && r.enabled).length,2);
    assert.ok(!(await p.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).includes(h.fake.token));
  } finally {await b.close();}
});

test('Claude Settings explains an unsupported synthetic transcript by redacted reason and file count',{skip,timeout:60000},async()=>{
  const b=await openLive({effectiveV3:true}),p=b.page,h=b.h,fs=require('node:fs'),path=require('node:path');
  try {
    const home=path.join(h.tmp,'.claude'),project=path.join(home,'projects','synthetic-unknown-project');fs.mkdirSync(project,{recursive:true});
    fs.writeFileSync(path.join(project,'synthetic-unknown-session.jsonl'),[
      {type:'mode',privateValue:'SYNTHETIC_PRIVATE_SENTINEL'},
      {type:'future-line-type',privateValue:'SYNTHETIC_PRIVATE_SENTINEL'},
    ].map(row=>JSON.stringify(row)).join('\n')+'\n');
    await tab(p,'agents');await p.getByRole('button',{name:'Relancer la détection',exact:true}).click();await idle(p);await tab(p,'connexion');await openConnector(p,'claude-code');
    const claude=p.locator('[data-runtime-connection="claude-code"]');
    assert.equal(await p.locator('#settings-runtime-claude-code-home').inputValue(),home);
    await p.locator('#settings-check-claude-code').click();await confirm(p,h.password);await idle(p);
    let text=await claude.innerText();assert.ok(text.includes('Aucun message de conversation reconnu dans 1 fichier examiné.'),text);
    assert.equal(text.includes('no-recognizable-session-lines'),false);assert.equal(text.includes('fichier(s)'),false);assert.equal(text.includes('SYNTHETIC_PRIVATE_SENTINEL'),false);
    for(let n=0;n<33;n++)fs.writeFileSync(path.join(project,`synthetic-unknown-${n}.jsonl`),JSON.stringify({type:'future-line-type',privateValue:'SYNTHETIC_PRIVATE_SENTINEL'})+'\n');
    await p.locator('#settings-check-claude-code').click();await idle(p);
    text=await claude.innerText();assert.ok(text.includes('Vérification incomplète : la limite de fichiers est atteinte · 32 fichiers examinés.'),text);
    assert.equal(text.includes('probe-file-limit'),false);assert.equal(text.includes('fichier(s)'),false);assert.equal(text.includes('SYNTHETIC_PRIVATE_SENTINEL'),false);
  } finally {await b.close();}
});
