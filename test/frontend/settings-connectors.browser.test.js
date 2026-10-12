import test from 'node:test';
import assert from 'node:assert/strict';
import { openLayoutBrowser,visit,browserSkipReason } from './helpers/layout-browser.js';
import { installConnectorFixture } from './helpers/settings-connectors-fixture.js';
const skip=browserSkipReason();
const idle=p=>p.waitForFunction(()=>document.querySelector('#settings-section-form')?.getAttribute('aria-busy')==='false');
const reauth=async p=>{await p.locator('#settings-current-password').fill('fixture password only');await p.locator('button[form=settings-reauth-form]').click();await p.locator('#settings-current-password').waitFor({state:'hidden'});await idle(p);};
const save=p=>p.locator('.ao-settings__footer button[type=submit]');
test('herdr provider uses its official logo and dedicated source page; tests and saved opt-out preserve runtime drafts',{skip,timeout:40000},async()=>{
 for(const theme of ['dark','light']){
 const h=await openLayoutBrowser({theme}),p=h.page;
 try{
  await installConnectorFixture(p,{herdr:{found:true,enabled:true,active:true,status:'available',checkedAt:Date.parse('2026-10-12T00:00:00Z')}});
  await visit(p,h.origin,'/parametres?onglet=connexion&mock=settings-fixall','[data-provider]');
  await p.waitForFunction(()=>document.querySelector('[data-provider="herdr"] img')?.naturalWidth>0);
  assert.ok((await p.locator('[data-provider="herdr"] img').getAttribute('src')).endsWith('assets/connectors/herdr.svg'));
  assert.equal(await p.locator('[data-provider="herdr"] .ao-settings__provider-badge').innerText(),'Connecté');
  await p.locator('[data-provider="openclaw"]').click();await p.locator('#settings-label-openclaw').fill('Synthetic gateway draft');
  await p.locator('[data-connector-back]').click();await p.locator('[data-provider="herdr"]').click();
  await p.locator('#settings-provider-title').waitFor();assert.equal(await p.locator('#settings-provider-title').innerText(),'herdr');
  assert.equal(await p.locator('[data-runtime-connection]').count(),1);assert.equal(await p.locator('#settings-enabled-herdr').isChecked(),true);
  assert.equal(await p.locator('[data-testid="settings-herdr-detection"]').innerText(),'herdr est disponible.');
  for(const [width,height] of [[1440,900],[390,844],[390,667]]){
   await p.setViewportSize({width,height});await p.evaluate(()=>document.fonts.ready);
   assert.ok(await p.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth));
   assert.equal(await p.getByTestId('settings-herdr-test').evaluate(button=>{
    const box=button.getBoundingClientRect(),footer=document.querySelector('.ao-settings > .ao-frame__foot').getBoundingClientRect();
    const edge=footer.height?footer.top:document.querySelector('.ao-settings').getBoundingClientRect().bottom;
    return box.top>=0&&box.bottom<=edge&&document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)?.closest('button')===button;
   }),true,`${theme} ${width}x${height}: test button is above the footer and receives taps`);
  }
  await p.locator('[data-testid="settings-herdr-test"]').click();await idle(p);
  assert.ok((await p.locator('[data-testid="settings-herdr-detection"]').innerText()).includes('3 présence(s)'));
  await p.locator('#settings-enabled-herdr').click();
  await p.locator('[data-connector-back]').click();assert.equal(await p.locator('[data-provider="herdr"] .ao-settings__provider-badge').innerText(),'Connecté','an unsaved disable keeps the saved badge');
  await save(p).click();await p.locator('#settings-current-password').waitFor();await reauth(p);await idle(p);
  assert.equal(await p.locator('[data-provider="herdr"] .ao-settings__provider-badge').innerText(),'Détecté');
  await p.locator('[data-provider="openclaw"]').click();assert.equal(await p.locator('#settings-label-openclaw').inputValue(),'Synthetic gateway draft');
  await p.locator('[data-connector-back]').click();await p.locator('[data-provider="herdr"]').click();assert.equal(await p.locator('#settings-enabled-herdr').isChecked(),false);
 }finally{await h.close();}
 }
});
test('detected herdr diagnostic action opens its highlighted provider page without changing activation',{skip,timeout:25000},async()=>{
 const h=await openLayoutBrowser(),p=h.page;
 try{
  await installConnectorFixture(p,{herdrDetected:true});await visit(p,h.origin,'/parametres?onglet=diagnostic&mock=settings-fixall','[data-testid="diagnostic-orchestrator:detected"]');
  const row=p.locator('[data-testid="diagnostic-orchestrator:detected"]');
  assert.match(await row.innerText(),/herdr détecté/i);assert.equal(await row.getByRole('button',{name:/^Activer/}).count(),1);
  await row.getByRole('button',{name:/^Activer/}).click();
  await p.waitForFunction(()=>location.search.includes('onglet=connexion')&&location.search.includes('orchestrateur=herdr'));
  const card=p.locator('[data-testid="settings-herdr-card"]');await card.waitFor();
  assert.ok((await card.getAttribute('class')).includes('ao-settings__group--detected'));
  assert.equal(await p.locator('.ao-settings__provider-heading .ao-settings__provider-badge').innerText(),'Détecté');
  assert.equal(await p.locator('#settings-enabled-herdr').isChecked(),false,'navigation never enables a read-only host source');
  await p.waitForFunction(()=>document.activeElement?.id==='settings-connection-herdr');
 }finally{await h.close();}
});
test('provider cards show registry logos and saved badges; desktop grid becomes a mobile list in both themes',{skip,timeout:60000},async()=>{
 for(const theme of ['dark','light']){
  const h=await openLayoutBrowser({theme}),p=h.page,errors=[];p.on('pageerror',e=>errors.push(e.message));
  try{
   await installConnectorFixture(p);await visit(p,h.origin,'/parametres?onglet=connexion&mock=settings-fixall','[data-provider]');
   assert.equal(await p.locator('[data-provider]').count(),6);
   assert.equal(await p.locator('[data-runtime-connection]').count(),0,'provider overview contains no connector controls');
   assert.ok(await p.locator('[data-provider="herdr"]').isVisible());
   assert.equal(await p.locator('[data-provider="claude-code"] strong').innerText(),'Claude Code');
   assert.equal(await p.locator('[data-provider="openclaw"] .ao-settings__provider-badge').innerText(),'Connecté');
   assert.equal(await p.locator('[data-provider="codex"] .ao-settings__provider-badge').innerText(),'Détecté');
   assert.equal(await p.locator('[data-provider="opencode"] .ao-settings__provider-badge').innerText(),'Non détecté');
   await p.waitForFunction(()=>document.querySelectorAll('.ao-settings__provider .ao-brand-mark--with-logo').length===6 && [...document.querySelectorAll('.ao-settings__provider img')].every(i=>i.complete&&i.naturalWidth>0));
   for(const width of [1440,900,390,375]){
    await p.setViewportSize({width,height:width>600?900:844});
    const g=await p.evaluate(()=>({columns:getComputedStyle(document.querySelector('.ao-settings__providers')).gridTemplateColumns.split(' ').length,
      logo:document.querySelector('.ao-settings__provider-logo').getBoundingClientRect().width,doc:document.scrollingElement.scrollWidth,view:innerWidth}));
    assert.equal(g.columns,width===1440?3:width===900?2:1);assert.equal(g.logo,width>600?80:64);assert.ok(g.doc<=g.view);
   }
   await p.locator('[data-provider="claude-code"]').focus();await p.keyboard.press('Enter');await p.locator('#settings-provider-title').waitFor();
   assert.ok(new URL(p.url()).searchParams.get('connecteur')==='claude-code');
   await p.waitForFunction(()=>document.activeElement?.id==='settings-provider-title');
   assert.equal(await p.locator('[data-runtime-connection]').count(),2,'provider details contain only that provider’s runtime forms');
   assert.ok(await p.locator('#settings-provider-title').evaluate(el=>el.getBoundingClientRect().width>200),'mobile provider heading has room for its name');
   assert.equal(await p.locator('#settings-runtime-openclaw-gatewayUrl').count(),0);
   await p.locator('[data-connector-back]').click();await p.locator('[data-provider="claude-code"]').waitFor();
   await p.waitForFunction(()=>document.activeElement?.dataset.provider==='claude-code');
   assert.deepEqual(errors,[]);
  }finally{await h.close();}
 }
});
test('connector routes preserve drafts, secret replacements, checks and independent added instances across back navigation',{skip,timeout:40000},async()=>{
 const h=await openLayoutBrowser(),p=h.page;
 try{
  await installConnectorFixture(p);await visit(p,h.origin,'/parametres?onglet=connexion&connecteur=openclaw&mock=settings-fixall','#settings-provider-title');
  await p.locator('#settings-label-openclaw').fill('Synthetic Team');
  await p.getByRole('button',{name:/^Remplacer/}).click();await p.locator('#settings-runtime-openclaw-token').fill('synthetic-replacement');
  await p.locator('#settings-check-openclaw').click();await p.locator('#settings-current-password').waitFor();await reauth(p);
  await p.locator('[data-connector-back]').click();await p.locator('[data-provider="openclaw"]').click();
  assert.equal(await p.locator('#settings-label-openclaw').inputValue(),'Synthetic Team');
  assert.equal(await p.locator('#settings-runtime-openclaw-token').inputValue(),'synthetic-replacement');
  assert.equal(await save(p).isEnabled(),true);
  await save(p).click();await idle(p);
  assert.equal(await p.locator('#settings-runtime-openclaw-token').count(),0,'saved secret is never echoed');
  assert.ok(!(await p.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).includes('synthetic-replacement'));
  await p.locator('[data-testid="settings-add-runtime-openclaw"]').click();await p.locator('[data-runtime-connection="openclaw-2"]').waitFor();
  await p.locator('[data-connector-back]').click();await p.locator('[data-provider="openclaw"]').waitFor();assert.equal(await p.locator('[data-provider="openclaw"]').count(),1);
  await p.locator('[data-provider="openclaw"]').click();await p.locator('[data-runtime-connection="openclaw-2"]').waitFor();assert.equal(await p.locator('[data-runtime-connection]').count(),2);
  await p.goBack();await p.locator('[data-provider]').first().waitFor();await p.goForward();await p.locator('[data-runtime-connection="openclaw-2"]').waitFor();
  await p.goto(h.origin+'/parametres?onglet=connexion&connecteur=missing&mock=settings-fixall');await p.locator('[data-connector-back]').waitFor();
  assert.equal(await p.locator('[data-runtime-connection]').count(),0,'unknown routes never edit a fallback runtime');
 }finally{await h.close();}
});
test('project chips use descriptor controls; automatic discovery is immediate and disconnect uses the existing save bar',{skip,timeout:40000},async()=>{
 const h=await openLayoutBrowser(),p=h.page;
 try{
  await installConnectorFixture(p);await visit(p,h.origin,'/parametres?onglet=connexion&connecteur=claude-local&mock=settings-fixall','#settings-provider-title');
  assert.equal(await p.locator('.ao-settings__chip-list').innerText().then(x=>x.includes('demo-project')),true);
  await p.locator('#settings-runtime-claude-local-include').fill('second-project');await p.locator('#settings-runtime-claude-local-include').press('Enter');
  assert.equal(await p.locator('.ao-settings__chip-list li').count(),2);
  await p.getByRole('button',{name:'Retirer le projet demo-project',exact:true}).click();assert.equal(await p.locator('.ao-settings__chip-list li').count(),1);
  await p.locator('#settings-auto-add-claude-local').click();await p.waitForFunction(()=>document.querySelector('#settings-auto-add-claude-local')?.checked===false);await idle(p);assert.equal(await p.locator('#settings-auto-add-claude-local').isChecked(),false);
  assert.equal(await p.locator('.ao-settings__chip-list li').innerText().then(x=>x.includes('second-project')),true,'immediate policy updates retain unsaved filters');
  await p.locator('#settings-check-claude-local').click();await p.locator('#settings-current-password').waitFor();await reauth(p);
  await save(p).click();await idle(p);
  await p.locator('[data-runtime-connection="claude-local"] .ao-settings__instance-options > summary').click();
  await p.locator('[data-runtime-connection="claude-local"]').getByRole('button',{name:'Déconnecter cette instance',exact:true}).click();
  await p.locator('[data-connector-back]').click();await p.locator('[data-provider="claude-code"]').waitFor();assert.equal(await p.locator('[data-provider="claude-code"] .ao-settings__provider-badge').innerText(),'Connecté','pending disable remains a saved connection');
  await save(p).click();await idle(p);assert.equal(await p.locator('[data-provider="claude-code"] .ao-settings__provider-badge').innerText(),'Détecté');
 }finally{await h.close();}
});
test('read-only and environment-controlled fields remain locked on provider routes',{skip,timeout:25000},async()=>{
 for(const scenario of ['settings-readonly','settings-env']){
  const h=await openLayoutBrowser(),p=h.page;
  try{
   await visit(p,h.origin,'/parametres?onglet=connexion&connecteur=openclaw&mock='+scenario,'[data-runtime-connection]');
   assert.equal(await p.locator('#settings-runtime-openclaw-gatewayUrl').isDisabled(),true);
   if(scenario==='settings-readonly'){
    assert.equal(await p.locator('#settings-enabled-openclaw').isDisabled(),true);
    assert.equal(await p.locator('#settings-check-openclaw').isDisabled(),true);
    assert.equal(await p.locator('[data-testid="settings-add-runtime-openclaw"]').isDisabled(),true);
   }
   await p.locator('[data-connector-back]').click();await p.locator('[data-provider="openclaw"]').waitFor();
   assert.ok((await p.locator('[data-provider="openclaw"]').getAttribute('href')).includes('connecteur=openclaw'));
  }finally{await h.close();}
 }
});

test('detectable providers without registered brands use the prepared official Hermes and herdr assets',{skip,timeout:20000},async()=>{
 const h=await openLayoutBrowser({theme:'dark'}),p=h.page;
 try{
  await installConnectorFixture(p,{extraProviders:true});await visit(p,h.origin,'/parametres?onglet=connexion&mock=settings-fixall','[data-provider]');
  for(const id of ['hermes','herdr']){
   await p.waitForFunction(id=>document.querySelector('[data-provider="'+id+'"] img')?.naturalWidth>0,id);
   assert.ok((await p.locator('[data-provider="'+id+'"] img').getAttribute('src')).endsWith('assets/connectors/'+id+'.svg'));
  }
  assert.equal(await p.locator('[data-provider]').count(),7,'the catalog never creates cards absent from SettingsVM');
 }finally{await h.close();}
});
