import {agentRows,agentRow,agentAction,agentEditor,agentConnector} from './helpers/settings-agent-browser.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { browserPath,openLayoutBrowser as openSharedBrowser,visit } from './helpers/layout-browser.js';
async function openLayoutBrowser() {
  const h=await openSharedBrowser(),issues=[],close=h.close;
  h.page.on('console',event=>{if(event.type()==='error' && event.text().startsWith('[vm]'))issues.push(event.text());});
  h.close=async()=>{await close();assert.deepEqual(issues,[],'Settings responses satisfy the shared server schema');};
  return h;
}
const skip=!browserPath();
const tabs=['diagnostic','agents','connexion','instance','apparence','compte'];
const save=page=>page.locator('.ao-settings__footer button[type=submit], [data-testid=settings-integration-apply]');
const cancel=page=>page.getByRole('button',{name:'Annuler',exact:true});
const tab=async(page,id)=>{if(id==='integrations'){await page.evaluate(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);services.router.setQuery({onglet:'integrations',connecteur:null,runtime:null,section:null});});await page.waitForFunction(()=>new URL(location.href).searchParams.get('onglet')==='connexion'&&new URL(location.href).searchParams.get('section')==='integrations');await page.locator('#settings-tab-connexion[aria-selected=true]').waitFor();return;}await page.locator('#settings-tab-'+id).click();await page.locator('#settings-tab-'+id+'[aria-selected=true]').waitFor();};
const idle=page=>page.waitForFunction(()=>document.querySelector('#settings-section-form')?.getAttribute('aria-busy')==='false');
const screenshot=async(page,name)=>{if(process.env.SETTINGS_SCREENSHOTS==='1')await page.screenshot({path:'design/reports/settings-1/'+name+'.png',animations:'disabled'});};
const reauth=async page=>{await screenshot(page,'current-password-confirmation');await page.locator('#settings-current-password').fill('fixture password only');await page.locator('button[form=settings-reauth-form]').click();await page.locator('#settings-current-password').waitFor({state:'hidden'});await idle(page);};

test('Settings: every tab/theme at desktop and both mobile sizes has one scrolling body and anchored footer',{skip,timeout:120000},async()=>{
  const h=await openLayoutBrowser();const errors=[],shots=[];h.page.on('pageerror',e=>errors.push(e.message));
  try {
    for(const [width,height] of [[1440,900],[390,844],[375,667]]) {
      await h.page.setViewportSize({width,height});await visit(h.page,h.origin,'/parametres','#settings-section-form');
      for(const theme of ['light','dark']) {
        await h.page.evaluate(async theme=>{const m=await import('/theme.js?v='+document.querySelector('meta[name=ao-build]').content);m.setTheme(theme);},theme);
        for(const id of tabs){await tab(h.page,id);
          const geometry=await h.page.evaluate(()=>{
            const frame=document.querySelector('.ao-settings'),body=frame.querySelector('.ao-frame__body'),footer=frame.querySelector('.ao-frame__foot');
            return {height:document.scrollingElement.scrollHeight,width:document.scrollingElement.scrollWidth,vh:innerHeight,vw:innerWidth,
              frame:frame.getBoundingClientRect().toJSON(),footer:footer.getBoundingClientRect().toJSON(),body:body.getBoundingClientRect().toJSON(),
              tabs:[...frame.querySelectorAll('[role=tab]')].map(e=>e.getBoundingClientRect().toJSON()),
              active:frame.querySelector('[role=tab][aria-selected=true]').getBoundingClientRect().toJSON(),
              tablist:frame.querySelector('[role=tablist]').getBoundingClientRect().toJSON(),
              tabOverflow:frame.querySelector('[role=tablist]').scrollWidth>frame.querySelector('[role=tablist]').clientWidth,
              footerHidden:getComputedStyle(footer).display==='none',scroll:getComputedStyle(body).overflowY,
              root:getComputedStyle(document.documentElement).overscrollBehavior,footPosition:getComputedStyle(footer).position,
              title:[...document.querySelectorAll('h1')].filter(e=>e.getBoundingClientRect().height).length};
          });
          assert.ok(geometry.height<=height && geometry.width<=width,id+' document bounds');
          assert.ok(Math.abs(geometry.body.bottom-geometry.frame.bottom)<1,id+' body fills frame without an idle footer');
          assert.ok(!/Autre \(/.test(await h.page.locator('.ao-settings').innerText()));
          assert.equal(geometry.scroll,'auto');assert.equal(geometry.root,'none');assert.equal(geometry.title,1);
          assert.ok(!['fixed','sticky'].includes(geometry.footPosition));
          assert.ok(geometry.tabs.every(r=>r.width>0&&Math.abs(r.top-geometry.tabs[0].top)<1&&r.bottom<=geometry.body.top),id+' one tab row');
          assert.ok(geometry.active.left>=geometry.tablist.left-1 && geometry.active.right<=geometry.tablist.right+1,id+' active tab in view');
          assert.equal(geometry.footerHidden,true,id+' idle footer is absent');
          if(width<821)assert.equal(geometry.tabOverflow,true,id+' tabs scroll horizontally');
          if(id==='agents')assert.ok(await h.page.locator('#settings-agent-runtime').evaluate(e=>e.getBoundingClientRect().width<200),'compact runtime selector');
          if(id==='diagnostic'){
            const detected=await h.page.locator('[data-testid="diagnostic-runtime:codex"]').innerText();
            assert.ok(detected.includes('Codex'));assert.ok(detected.includes('détecté, pas encore connecté'));
            await h.page.locator('[data-testid="diagnostic-runtime:codex"] summary').click();
            const detail=await h.page.locator('[data-testid="diagnostic-runtime:codex"] .ao-settings__details > p').innerText();
            assert.ok(detail.includes('Configurez ce moteur depuis Connecteurs'));
            await h.page.locator('[data-testid="diagnostic-runtime:codex"] summary').click();
          }
          assert.equal(await save(h.page).count(),0);
          if(process.env.SETTINGS_SCREENSHOTS==='1'){
            const name=id+'-'+width+'-'+theme+'.png';await mkdir('design/reports/settings-1',{recursive:true});
            await h.page.screenshot({path:'design/reports/settings-1/'+name});shots.push({name,id,width,height,theme});
          }
          if(id==='agents'&&width===375&&theme==='light'){
            await h.page.locator('#settings-agent-runtime').scrollIntoViewIfNeeded();
            await screenshot(h.page,'compact-runtime-selector');
            await h.page.locator('.ao-settings > .ao-frame__body').evaluate(e=>{e.scrollTop=0;});
          }
          const before=await h.page.locator('.ao-settings__tabs').boundingBox();
          await h.page.locator('.ao-settings > .ao-frame__body').evaluate(body=>{
            const child=body.firstElementChild;for(let i=0;i<5;i++)body.append(child.cloneNode(true));body.scrollTop=body.scrollHeight;
          });
          assert.deepEqual(await h.page.locator('.ao-settings__tabs').boundingBox(),before,JSON.stringify(await h.page.evaluate(()=>({innerWidth,docWidth:document.documentElement.scrollWidth,main:document.querySelector('.ao-main').getBoundingClientRect().toJSON(),frame:document.querySelector('.ao-settings').getBoundingClientRect().toJSON(),body:document.querySelector('.ao-settings > .ao-frame__body').getBoundingClientRect().toJSON()}))));
          await h.page.locator('.ao-settings > .ao-frame__body').evaluate(body=>{while(body.children.length>1)body.lastElementChild.remove();body.scrollTop=0;});
        }
        // A genuine draft still mounts an anchored, working footer in every theme/viewport.
        await tab(h.page,'instance');const original=await h.page.locator('#settings-instance-name').inputValue();
        await h.page.locator('#settings-instance-name').fill(original+' draft');
        assert.equal(await save(h.page).isEnabled(),true);assert.equal(await save(h.page).evaluate(e=>e.form?.id),'settings-section-form');
        const draftShape=await h.page.evaluate(()=>{const frame=document.querySelector('.ao-settings'),foot=frame.querySelector('.ao-frame__foot'),status=frame.querySelector('.ao-settings__dirty'),actions=frame.querySelector('.bu-btn-group');return{frame:frame.getBoundingClientRect().toJSON(),foot:foot.getBoundingClientRect().toJSON(),status:status.getBoundingClientRect().toJSON(),actions:actions.getBoundingClientRect().toJSON()};});
        assert.ok(Math.abs(draftShape.frame.bottom-draftShape.foot.bottom)<1,'draft footer stays anchored');
        assert.ok(Math.abs((draftShape.status.top+draftShape.status.bottom)/2-(draftShape.actions.top+draftShape.actions.bottom)/2)<1,'draft status and actions share one row');
        assert.ok(draftShape.status.right<=draftShape.actions.left && draftShape.actions.right<=draftShape.foot.right,'draft footer fits');
        await cancel(h.page).click();assert.equal(await h.page.locator('#settings-instance-name').inputValue(),original);assert.equal(await save(h.page).count(),0);
      }
    }
    await h.page.setViewportSize({width:1440,height:900});await tab(h.page,'compte');
    await h.page.setViewportSize({width:375,height:667});
    await h.page.waitForFunction(()=>{const e=document.querySelector('#settings-tab-compte'),r=e.getBoundingClientRect(),row=e.parentElement.getBoundingClientRect();return r.left>=row.left&&r.right<=row.right+1;});
    await h.page.locator('#settings-tab-compte').focus();await h.page.keyboard.press('Home');
    await h.page.locator('#settings-tab-diagnostic[aria-selected=true]').waitFor();
    assert.equal(await h.page.evaluate(()=>document.activeElement.id),'settings-tab-diagnostic');
    await h.page.keyboard.press('End');await h.page.locator('#settings-tab-compte[aria-selected=true]').waitFor();
    assert.ok(await h.page.locator('#settings-tab-compte').evaluate(e=>{const r=e.getBoundingClientRect(),row=e.parentElement.getBoundingClientRect();return r.left>=row.left&&r.right<=row.right+1;}),'keyboard selection scrolls active tab into view');
    await h.page.evaluate(async()=>{const m=await import('/lang.js?v='+document.querySelector('meta[name=ao-build]').content);await m.chooseLang('en');});
    for(const id of tabs){await tab(h.page,id);assert.ok(!/Autre \(|Other \(|settings\./.test(await h.page.locator('.ao-settings').innerText()),id+' English labels');}
    assert.deepEqual(errors,[]);
    if(shots.length)await writeFile('design/reports/settings-1/screenshots.json',JSON.stringify(shots,null,2)+'\n');
  }finally{await h.close();}
});

test('Settings: agent edits, cancel, detect, missing-agent registration, safe look link and dirty navigation',{skip,timeout:45000},async()=>{
  const h=await openLayoutBrowser();const p=h.page;
  try{
    await visit(p,h.origin,'/parametres?onglet=agents','#settings-section-form');
    await agentConnector(p,'openclaw');
    await agentRows(p).first().getByRole('button',{name:/^Actions/}).click();
    assert.equal(await p.getByRole('menuitem',{name:'Changer l’apparence',exact:true}).getAttribute('href'),'/boutique?onglet=personnages&agent=primary&mock=1');await p.keyboard.press('Escape');
    await agentEditor(p,agentRows(p).first());await p.locator('#settings-agent-name-0').fill('Atlas renamed');assert.equal(await save(p).isEnabled(),true);
    await tab(p,'compte');
    assert.ok((await p.locator('.ao-settings__pending').innerText()).includes('Runtimes et agents'));
    assert.ok((await p.locator('.ao-settings__pending').innerText()).includes('Modifications non enregistrées'));
    assert.ok((await p.locator('.ao-settings__pending').getAttribute('title')).includes('Runtimes et agents'));
    assert.equal(await save(p).isDisabled(),true);
    await p.setViewportSize({width:375,height:667});await screenshot(p,'other-section-dirty');
    assert.ok(await p.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth && document.scrollingElement.scrollHeight<=innerHeight));
    await p.setViewportSize({width:1440,height:900});
    await p.locator('#settings-owner-displayName').fill('Account draft');await cancel(p).click();
    assert.ok((await p.locator('.ao-settings__pending').innerText()).includes('Runtimes et agents'));
    await p.locator('.bu-nav a[href*="/sante"]').click();await p.locator('[role=dialog]').waitFor();
    await p.getByRole('button',{name:'Rester ici',exact:true}).click();
    await tab(p,'agents');await agentEditor(p,agentRows(p).first());assert.equal(await p.locator('#settings-agent-name-0').inputValue(),'Atlas renamed');
    await cancel(p).click();assert.equal(await p.locator('#settings-agent-name-0').inputValue(),'Atlas');
    await p.getByRole('button',{name:'Relancer la détection',exact:true}).click();await idle(p);
    await p.locator('[data-testid="settings-unconfigured-agent-scribe"] button').click();await p.locator('#settings-agent-name-1').fill('Scribe');
    await save(p).click();await idle(p);assert.equal(await save(p).count(),0);
    await agentAction(p,agentRows(p).nth(1),'primary');
    await agentAction(p,agentRows(p).first(),'hide');
    await agentEditor(p,agentRows(p).first());await p.locator('#settings-agent-name-0').fill('');
    await save(p).click();await idle(p);
    assert.equal(await agentRows(p).nth(1).locator('.ao-settings__role').count(),1);
    assert.ok((await agentRows(p).first().innerText()).includes('Masqué'));
    assert.equal(await p.locator('#settings-agent-name-0').inputValue(),'');
    assert.ok((await p.locator('[data-testid="settings-agent-row-0"]').innerText()).includes('Nom à choisir'));
    await agentAction(p,agentRows(p).first(),'remove');
    assert.ok((await p.locator('[data-testid="settings-unconfigured-agent-atlas"]').innerText()).includes('Retrait en attente'));
    await save(p).click();await idle(p);assert.equal(await agentRows(p).count(),1);
    await agentEditor(p,agentRows(p).first());await p.locator('#settings-agent-name-0').fill('Unsaved');
    await p.locator('.bu-nav a[href*="/sante"]').click();await p.locator('[role=dialog]').waitFor();
    await p.getByRole('button',{name:'Rester ici',exact:true}).click();assert.ok(p.url().includes('/parametres'));
    assert.equal(await p.locator('#settings-agent-name-0').inputValue(),'Unsaved');
    await save(p).click();await idle(p);assert.equal(await save(p).count(),0);
  }finally{await h.close();}
});

test('Settings: SSE refreshes clean values; dirty revisions retain drafts through conflict and explicit reload; mobile Plus entry works',{skip,timeout:30000},async()=>{
  const h=await openLayoutBrowser();const p=h.page;
  try{
    await visit(p,h.origin,'/parametres?onglet=instance','#settings-section-form');
    const remote=async name=>p.evaluate(async name=>{
      const api=await import('/api.js?v='+document.querySelector('meta[name=ao-build]').content);
      const vm=await api.get('/api/v3/settings',{quiet:true,apiVersion:3});
      await api.put('/api/v3/settings/instance',{expectedRevision:vm.data.revision,name},{quiet:true,apiVersion:3});
    },name);
    await remote('Other tab name');await p.waitForFunction(()=>document.querySelector('#settings-instance-name').value==='Other tab name');
    await p.locator('#settings-instance-name').fill('Unsaved local name');await remote('New remote name');
    await p.getByRole('button',{name:'Actualiser les paramètres',exact:true}).waitFor();
    await screenshot(p,'external-change-dirty');
    assert.equal(await p.locator('#settings-instance-name').inputValue(),'Unsaved local name');
    await save(p).click();await idle(p);await p.locator('.ao-settings [role=alert]').waitFor();
    assert.equal(await p.locator('#settings-instance-name').inputValue(),'Unsaved local name');
    await p.locator('.ao-settings [role=alert]').getByRole('button',{name:'Actualiser les paramètres',exact:true}).click();await p.locator('[role=dialog]').waitFor();
    await p.locator('[role=dialog]').getByRole('button',{name:'Actualiser les paramètres',exact:true}).click();await idle(p);
    assert.equal(await p.locator('#settings-instance-name').inputValue(),'New remote name');
    await p.setViewportSize({width:375,height:667});await p.locator('.bu-bottombar a[href*="/plus"]').click();
    await p.locator('.bu-morelist a[href*="/parametres"]').click();await p.locator('#settings-section-form').waitFor();
  }finally{await h.close();}
});

test('Settings: replaced token is tested before save, incorrect current password stays local, edits invalidate test',{skip,timeout:45000},async()=>{
  const h=await openLayoutBrowser();const p=h.page;
  try{
    await visit(p,h.origin,'/parametres?onglet=connexion&connecteur=openclaw','#settings-section-form');
    assert.equal(await p.locator('#settings-runtime-openclaw-token').count(),0);
    await p.getByRole('button',{name:/^Remplacer/}).click();
    await p.locator('#settings-runtime-openclaw-token').fill('fixture new token');
    assert.equal(await save(p).isDisabled(),true);await p.locator('#settings-check-openclaw').click();
    await p.locator('#settings-current-password').fill('wrong fixture');await p.locator('button[form=settings-reauth-form]').click();
    await p.locator('#settings-reauth-error').waitFor();assert.ok(p.url().includes('/parametres'));assert.equal(await p.locator('#settings-current-password').inputValue(),'');
    await reauth(p);assert.equal(await save(p).isEnabled(),true);
    await p.locator('#settings-runtime-openclaw-token').fill('fixture rejected token');await p.locator('#settings-check-openclaw').click();await idle(p);
    assert.equal(await save(p).isDisabled(),true);
    await p.locator('#settings-runtime-openclaw-token').fill('fixture new token');
    await p.locator('#settings-runtime-openclaw-gatewayUrl').fill('wss://fixture.changed.test');assert.equal(await save(p).isDisabled(),true);
    await p.locator('#settings-check-openclaw').click();await idle(p);await save(p).click();await idle(p);
    assert.equal(await p.locator('#settings-runtime-openclaw-token').count(),0);
    assert.ok(!(await p.locator('body').innerText()).includes('fixture new token'));
    assert.ok(!(await p.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).includes('fixture new token'));
  }finally{await h.close();}
});

test('Settings: reviewed integrations, combined instance/network save and account password confirmation',{skip,timeout:45000},async()=>{
  const h=await openLayoutBrowser();const p=h.page;
  try{
    await visit(p,h.origin,'/parametres?onglet=integrations','#settings-section-form');
    await p.locator('#settings-plan').click();await p.locator('#settings-plan-confirm').waitFor();assert.equal(await save(p).isDisabled(),true);
    await screenshot(p,'integration-plan-review');
    assert.ok((await p.locator('.ao-settings__plan').innerText()).includes('/fixture/agents/scribe/AGENTS.md'));
    await p.locator('#settings-plan-confirm').check();await save(p).click();await reauth(p);assert.equal(await p.locator('#settings-plan-confirm').count(),0);
    await tab(p,'instance');await p.locator('#settings-instance-name').fill('Atelier neuf');await p.locator('#settings-network-port').fill('3031');
    await save(p).click();await idle(p);assert.equal(await save(p).count(),0);
    await screenshot(p,'network-restart-required');
    assert.ok((await p.locator('.ao-settings').innerText()).includes('redémarrage'));
    await tab(p,'compte');await p.locator('#settings-password').fill('fixture new password');await p.locator('#settings-confirmation').fill('fixture new password');
    await save(p).click();await idle(p);assert.equal(await p.locator('#settings-password').inputValue(),'');
    await p.locator('#settings-owner-email').fill('new@example.test');await save(p).click();await p.locator('#settings-current-password').waitFor();
    await p.locator('[role=dialog]').getByRole('button',{name:'Annuler',exact:true}).click();await idle(p);
    assert.equal(await p.locator('#settings-owner-email').inputValue(),'new@example.test');
  }finally{await h.close();}
});

test('Settings: read-only and environment overrides show their reasons and disable mutation',{skip,timeout:30000},async()=>{
  const h=await openLayoutBrowser();const p=h.page;
  try{
    await visit(p,h.origin,'/parametres?onglet=connexion&connecteur=openclaw&mock=settings-env','#settings-section-form');
    assert.equal(await p.locator('#settings-runtime-openclaw-gatewayUrl').isDisabled(),true);
    assert.ok((await p.locator('.ao-settings').innerText()).includes('OC_GATEWAY_URL'));
    await screenshot(p,'environment-overrides');
    await visit(p,h.origin,'/parametres?onglet=instance&mock=settings-readonly','#settings-section-form');
    assert.equal(await p.locator('#settings-instance-name').isDisabled(),true);assert.equal(await save(p).count(),0);
    assert.ok((await p.locator('.ao-settings').innerText()).includes('lecture seule'));
    assert.equal(await p.locator('.ao-settings__banner .bu-banner__text').innerText(),'Cette instance est en lecture seule. Les changements sont désactivés.');
    await screenshot(p,'read-only-instance');
  }finally{await h.close();}
});

test('Settings: integration diagnostics name the action and distinguish healthy configured agents',{skip,timeout:30000},async()=>{
  const h=await openLayoutBrowser(),p=h.page;
  try{
    await p.route('**/mock/examples/settings/settings-vm.json',async route=>{
      const response=await route.fetch({url:new URL('settings-integrations-vm.json',route.request().url()).href});
      await route.fulfill({response});
    });
    await visit(p,h.origin,'/parametres','#settings-section-form');
    const actions={runner:'Intégration à installer',editor:'Intégration à mettre à jour',reviewer:'Intégration à vérifier'};
    for(const [id,title] of Object.entries(actions)){
      const row=p.locator('[data-testid="diagnostic-agent:openclaw:'+id+'"]');
      assert.ok((await row.locator('.ao-settings__diagnostic-cause').innerText()).includes(title));
      await row.locator('summary').click();
      assert.ok((await row.locator('.ao-settings__details > p').innerText()).includes('projet'));
      assert.equal(await row.getByRole('img',{name:'À vérifier',exact:true}).count(),1);
      await row.getByRole('button',{name:new RegExp('^'+{runner:'Installer',editor:'Mettre à jour',reviewer:'Vérifier'}[id])}).click();
      await p.locator('#settings-tab-connexion[aria-selected=true]').waitFor();await tab(p,'diagnostic');
    }
    const unsupported=p.locator('[data-testid="diagnostic-agent:openclaw:observer"]');
    assert.ok((await unsupported.locator('.ao-settings__diagnostic-cause').innerText()).includes('Intégration non prise en charge'));
    await unsupported.locator('summary').click();
    assert.ok((await unsupported.locator('.ao-settings__details > p').innerText()).includes('projet'));
    assert.equal(await unsupported.getByRole('img',{name:'Information',exact:true}).count(),1);
    assert.equal(await unsupported.getByRole('button').count(),0,'informational unsupported integrations have no actionable fix');
    await p.locator('.ao-settings__healthy > summary').click();
    const healthy=p.locator('[data-testid="diagnostic-agent:openclaw:atlas"]');
    assert.ok((await healthy.innerText()).includes('Agent configuré'));
    assert.equal(await healthy.getByRole('img',{name:'En ordre',exact:true}).count(),1);
    assert.equal(await healthy.getByRole('button').count(),0);
    await p.locator('.ao-settings > .ao-frame__body').evaluate(body=>{const row=body.querySelector('[data-testid="diagnostic-agent:openclaw:runner"]');body.scrollTop+=row.getBoundingClientRect().top-body.getBoundingClientRect().top;});
    await screenshot(p,'diagnostic-integration-actions-desktop');
    await p.setViewportSize({width:375,height:667});
    await p.locator('[data-testid="diagnostic-agent:openclaw:runner"]').scrollIntoViewIfNeeded();
    await screenshot(p,'diagnostic-integration-actions-mobile');
    await p.evaluate(async()=>{const {chooseLang}=await import('/lang.js?v='+document.querySelector('meta[name=ao-build]').content);await chooseLang('en');});
    assert.ok((await p.locator('[data-testid="diagnostic-agent:openclaw:runner"] .ao-settings__diagnostic-cause').innerText()).includes('Integration needs installing'));
  }finally{await h.close();}
});

test('Settings: plan absence and conflict labels retain the review vocabulary and protect conflicts',{skip,timeout:20000},async()=>{
  const h=await openLayoutBrowser();const p=h.page;
  try{
    await p.route('**/mock/examples/settings/integration-plan-result.json',async route=>{
      const response=await route.fetch();const data=await response.json();
      data.data.result.agents.push({id:'protected',status:'conflict',files:['/fixture/protected/AGENTS.md'],uninstallFiles:[]});
      await route.fulfill({response,json:data});
    });
    await visit(p,h.origin,'/parametres?onglet=integrations','#settings-section-form');
    await p.locator('#settings-plan').click();await p.locator('#settings-plan-confirm').waitFor();
    const absent=p.locator('[data-testid="settings-plan-agent-scribe"]'),conflict=p.locator('[data-testid="settings-plan-agent-protected"]');
    assert.equal(await absent.isChecked(),true);
    assert.ok((await absent.locator('..').innerText()).includes('Absente'));
    assert.ok(!(await absent.locator('..').innerText()).includes('Manquante'));
    assert.equal(await conflict.isChecked(),false);assert.equal(await conflict.isDisabled(),true);
    assert.ok((await conflict.locator('..').innerText()).includes('Conflit — fichiers à préserver'));
    assert.ok(!(await conflict.locator('..').innerText()).includes('Modifiée'));
    await p.setViewportSize({width:375,height:667});await conflict.scrollIntoViewIfNeeded();await screenshot(p,'integration-plan-conflict');
  }finally{await h.close();}
});

test('Setup and Settings present the same translated network-mode options',{skip,timeout:20000},async()=>{
  const h=await openLayoutBrowser();const p=h.page;
  try{
    await visit(p,h.origin,'/parametres?onglet=instance','#settings-section-form');
    for(const lang of ['fr','en']){
      const options=await p.evaluate(async lang=>{
        const query='?v='+document.querySelector('meta[name=ao-build]').content;
        const {chooseLang}=await import('/lang.js'+query);await chooseLang(lang);
        const {html,render}=await import('/lib.js'+query);
        const {NetworkStep}=await import('/pages/setup-onboarding.js'+query);
        const node=document.createElement('div');node.hidden=true;document.body.append(node);
        render(html`<${NetworkStep} s=${{network:{mode:'local',port:18789,publicUrl:''}}} set=${()=>{}} />`,node);
        const values=selector=>[...document.querySelector(selector).options].map(o=>({value:o.value,label:o.textContent}));
        const result={setup:values('#setup-network-mode'),settings:values('#settings-network-mode')};
        render(null,node);node.remove();return result;
      },lang);
      assert.deepEqual(options.settings,options.setup);
      assert.deepEqual(options.settings.map(o=>o.value),['local','lan','tailnet','public','tunnel']);
      assert.equal(options.settings[2].label,'Tailscale / tailnet');
    }
  }finally{await h.close();}
});

test('unreachable gateway preserves read-only Chat and links Office to connection settings',{skip,timeout:15000},async()=>{
  const h=await openLayoutBrowser();
  try{
    await visit(h.page,h.origin,'/discuter?mock=panne','#chat-texte');
    assert.equal(await h.page.locator('#chat-texte').isDisabled(),true);
    await h.page.getByText('Vous pouvez lire cette discussion. L’envoi est indisponible.',{exact:true}).waitFor();
    for(const [path,ready,banner] of [['/bureau?mock=panne','.ao-bureau__stage','.ao-bureau']]){
      await visit(h.page,h.origin,path,ready);
      const link=h.page.locator(banner+' a[href*="/parametres"]').first();assert.ok((await link.getAttribute('href')).includes('onglet=connexion'));
      await link.click();await h.page.locator('#settings-tab-connexion[aria-selected=true]').waitFor();
    }
  }finally{await h.close();}
});
