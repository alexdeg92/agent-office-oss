import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync} from 'node:fs';
import {browserSkipReason,openLayoutBrowser,visit} from './helpers/layout-browser.js';
import {connectorFixture} from './helpers/settings-connectors-fixture.js';
const skip=browserSkipReason()||false;
const apply=p=>p.getByTestId('settings-integration-apply');
const section=p=>p.locator('#settings-provider-integrations');
async function planReceivesPointer(p){
 return p.locator('#settings-plan').evaluate(button=>{
  const box=button.getBoundingClientRect(),body=document.querySelector('.ao-settings > .ao-frame__body').getBoundingClientRect();
  return box.top>=body.top&&box.bottom<=body.bottom&&document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)?.closest('button')===button;
 });
}
async function fixture(p,{remotePlan=false}={}){
 const example=await connectorFixture({herdrDetected:true}),vm=example.data;
 const local=vm.runtimes.find(r=>r.id==='openclaw'),remote={...structuredClone(local),id:'openclaw-remote',name:'Bureau distant',enabled:false,selected:false};
 vm.runtimes.push(remote);vm.agents.push({...structuredClone(vm.agents.find(a=>a.runtime==='openclaw')),id:'remote-agent',runtime:remote.id,agentId:'remote',name:'Remote fixture',integrations:[{id:'projet',status:'missing'}]});
 await p.route('**/mock/examples/settings/settings-fixall-vm.json',route=>route.fulfill({json:example}));
 if(remotePlan){
  const example=JSON.parse(readFileSync(new URL('../../public/v2/mock/examples/settings/integration-plan-result.json',import.meta.url),'utf8'));
  example.data.result.agents=[{id:'remote',status:'absent',files:['/fixture/remote/skills/projet/SKILL.md','/fixture/remote/AGENTS.md'],uninstallFiles:['/fixture/remote/skills/projet/SKILL.md']}];
  await p.route('**/mock/examples/settings/integration-plan-result.json',route=>route.fulfill({json:example}));
 }
 return vm;
}
async function permissions(p,values){await p.evaluate(async values=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);services.me={...services.me,permissions:values};window.dispatchEvent(new CustomEvent('agent-office:me',{detail:services.me}));},values);}

test('provider integration sections scope instances, preserve plans and drafts, and require review before apply',{skip,timeout:45000},async()=>{
 const h=await openLayoutBrowser(),p=h.page;
 try{
  await fixture(p,{remotePlan:true});await visit(p,h.origin,'/parametres?onglet=connexion&connecteur=openclaw&mock=settings-fixall','#settings-provider-integrations');
  assert.equal(await p.locator('#settings-tab-integrations').count(),0);
  assert.deepEqual(await section(p).locator('#settings-integration-runtime option').evaluateAll(es=>es.map(e=>e.value)),['openclaw','openclaw-remote']);
  await p.locator('#settings-integration-runtime').selectOption('openclaw-remote');
  assert.ok((await section(p).innerText()).includes('Remote fixture'));assert.ok(!(await section(p).innerText()).includes('Runner'));
  await p.locator('#settings-plan').click();await p.locator('#settings-plan-confirm').waitFor();
  assert.equal(await apply(p).isDisabled(),true);assert.equal(await p.locator('#settings-current-password').count(),0);
  await p.locator('#settings-plan-confirm').check();assert.equal(await apply(p).isEnabled(),true);
  await p.locator('#settings-label-openclaw').fill('Connection draft retained');
  await p.waitForFunction(()=>new URL(location.href).searchParams.get('section')===null);
  assert.equal(new URL(p.url()).searchParams.get('section'),null,'editing connection fields restores the connection save action');
  assert.equal(await apply(p).count(),0);assert.equal(await p.locator('#settings-plan-confirm').isChecked(),true);
  await p.locator('[data-connector-back]').click();await p.locator('[data-provider="claude-code"]').click();
  assert.equal(await p.locator('#settings-integration-runtime').count(),0,'a single provider instance has no global runtime picker');
  assert.ok(!(await section(p).innerText()).includes('Remote fixture'));
  await p.locator('#settings-plan').click();await p.locator('[role=dialog]').waitFor();
  await p.getByRole('button',{name:'Rester ici',exact:true}).click();
  assert.equal(await p.locator('#settings-plan-confirm').count(),0,'cancelled replacement does not display another provider’s plan');
  await p.locator('[data-connector-back]').click();await p.locator('[data-provider="openclaw"]').click();
  assert.equal(await p.locator('#settings-integration-runtime').inputValue(),'openclaw-remote');
  assert.equal(await p.locator('#settings-plan-confirm').isChecked(),true);assert.equal(await p.locator('#settings-label-openclaw').inputValue(),'Connection draft retained');
  await p.locator('[data-connector-back]').click();await p.locator('[data-provider="herdr"]').click();
  assert.equal(await section(p).getByRole('button').count(),0);assert.ok((await section(p).innerText()).includes('Aucune intégration installable'));
 }finally{await h.close();}
});

test('runtime and integration permissions remain independent within one provider page',{skip,timeout:30000},async()=>{
 const h=await openLayoutBrowser(),p=h.page;
 try{
  await fixture(p);await visit(p,h.origin,'/parametres?onglet=connexion&connecteur=openclaw&mock=settings-fixall','#settings-provider-integrations');
  await permissions(p,{'settings.runtimes':'write'});
  await section(p).getByText('Votre rôle ne permet pas de consulter les intégrations de ce fournisseur.').waitFor();
  assert.equal(await p.locator('#settings-label-openclaw').isEnabled(),true);assert.equal(await p.locator('#settings-plan').count(),0);
  await permissions(p,{'settings.runtimes':'read','settings.integrations':'read'});
  assert.equal(await p.locator('#settings-plan').isDisabled(),true);assert.equal(await p.locator('#settings-label-openclaw').isDisabled(),true);
  await permissions(p,{'settings.integrations':'write'});
  assert.equal(await p.locator('#settings-plan').isEnabled(),true);assert.equal(await p.locator('#settings-label-openclaw').isDisabled(),true);
  await p.locator('#settings-plan').click();await p.locator('#settings-plan-confirm').waitFor();await p.locator('#settings-plan-confirm').check();
  assert.equal(await apply(p).isEnabled(),true);
  await permissions(p,{'settings.integrations':'read'});assert.equal(await apply(p).isDisabled(),true,'a permission downgrade blocks the prepared plan');
  assert.equal(await p.locator('#settings-plan-confirm').isDisabled(),true);
 }finally{await h.close();}
});

test('mobile Plan receives taps above a long status list and stays clear of the review footer',{skip,timeout:45000},async()=>{
 for(const theme of ['light','dark']){
  const h=await openLayoutBrowser({theme,touch:true}),p=h.page;
  try{
   const vm=await fixture(p,{remotePlan:true}),sample=vm.agents.find(a=>a.runtime==='openclaw-remote');
   for(let n=0;n<12;n++)vm.agents.push({...structuredClone(sample),id:'remote-extra-'+n,agentId:'extra-'+n,name:'Synthetic target '+n,isPrimary:false});
   for(const height of [844,667]){
    await p.setViewportSize({width:390,height});
    await visit(p,h.origin,'/parametres?onglet=integrations&connecteur=openclaw-remote&mock=settings-fixall','#settings-plan');
    await p.waitForFunction(()=>document.activeElement?.id==='settings-provider-integrations-title');
    assert.equal(await planReceivesPointer(p),true,`${theme} 390x${height}: Plan is inside the scrolling body and receives taps`);
    await p.locator('#settings-plan').tap();await p.locator('#settings-plan-confirm').waitFor();
    assert.equal(await p.getByTestId('settings-integration-apply').isDisabled(),true,'review still requires explicit confirmation');
    assert.equal(await planReceivesPointer(p),true,`${theme} 390x${height}: the new footer does not cover Plan`);
    await p.locator('#settings-plan').tap();await p.locator('#settings-plan-confirm').waitFor();
   }
  }finally{await h.close();}
 }
});

test('legacy integration links resolve to provider sections and fit desktop/mobile in both languages and themes',{skip,timeout:60000},async()=>{
 const h=await openLayoutBrowser(),p=h.page;
 try{
  await fixture(p,{remotePlan:true});
  for(const theme of ['light','dark'])for(const lang of ['fr','en'])for(const width of [1440,390]){
   await p.setViewportSize({width,height:width===1440?900:844});
   await visit(p,h.origin,'/parametres?onglet=integrations&connecteur=openclaw-remote&mock=settings-fixall','#settings-provider-integrations');
   await p.evaluate(async({theme,lang})=>{const build=document.querySelector('meta[name=ao-build]').content;const [{setTheme},{setLang}]=await Promise.all([import('/theme.js?v='+build),import('/i18n.js?v='+build)]);setTheme(theme);setLang(lang);},{theme,lang});
   await p.waitForFunction(()=>new URL(location.href).searchParams.get('onglet')==='connexion');
   const query=new URL(p.url()).searchParams;assert.equal(query.get('connecteur'),'openclaw');assert.equal(query.get('runtime'),'openclaw-remote');assert.equal(query.get('section'),'integrations');
   assert.equal(await p.locator('#settings-tab-integrations').count(),0);
   await p.locator('#settings-plan').click();await p.locator('#settings-plan-confirm').waitFor();
   const footer=await p.locator('.ao-settings > .ao-frame__foot').boundingBox();
   await section(p).evaluate(e=>e.scrollIntoView({block:'start'}));
   assert.equal(Math.round((await p.locator('.ao-settings > .ao-frame__foot').boundingBox()).y),Math.round(footer.y));
   const bounds=await p.evaluate(()=>({width:document.documentElement.scrollWidth,overflow:getComputedStyle(document.querySelector('.ao-settings > .ao-frame__body')).overflowY,text:document.querySelector('#settings-provider-integrations').innerText}));
   assert.ok(bounds.width<=width+1);assert.equal(bounds.overflow,'auto');assert.ok(!bounds.text.includes('Texte indisponible'));
   if(process.env.INTEGRATION_SCREENSHOTS==='1'){
    mkdirSync('design/reports/integrations-t0088',{recursive:true});await p.screenshot({path:`design/reports/integrations-t0088/review-${lang}-${theme}-${width}.png`,animations:'disabled'});
    await p.locator('.ao-settings > .ao-frame__body').evaluate(e=>e.scrollTop=0);await p.screenshot({path:`design/reports/integrations-t0088/provider-${lang}-${theme}-${width}.png`,animations:'disabled'});
   }
  }
 }finally{await h.close();}
});
