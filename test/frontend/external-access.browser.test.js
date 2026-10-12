import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import { browserSkipReason,openLayoutBrowser,visit } from './helpers/layout-browser.js';

test('access mode cards separate title/help and navigation remains anchored in both themes and languages',{skip:browserSkipReason()||false,timeout:45000},async()=>{
 const h=await openLayoutBrowser(),p=h.page;
 try{
  await visit(p,h.origin,'/parametres?onglet=access','[data-step=mode]');
  for(const theme of ['light','dark'])for(const lang of ['fr','en'])for(const width of [1440,390]){
   await p.setViewportSize({width,height:width===1440?900:844});
   await p.evaluate(async({theme,lang})=>{const build=document.querySelector('meta[name=ao-build]').content;const [{setTheme},{setLang}]=await Promise.all([import('/theme.js?v='+build),import('/i18n.js?v='+build)]);setTheme(theme);setLang(lang);},{theme,lang});
   const flow=p.locator('[data-external-access=settings]'),foot=p.locator('.ao-settings > .ao-frame__foot');
   await flow.getByRole('heading',{name:lang==='fr'?'Accès externe':'External access',exact:true}).waitFor();
   assert.equal(await flow.getByRole('heading',{name:lang==='fr'?'Accès externe':'External access',exact:true}).count(),1);
   assert.equal(await flow.getByRole('radio').count(),6);
   assert.equal(await foot.getByRole('button').count(),1,'step 1 has Continue only');
   const geometry=await p.evaluate(()=>{
    const cards=[...document.querySelectorAll('.ao-external__mode')].map(el=>{
     const title=el.querySelector('strong').getBoundingClientRect(),help=el.querySelector('small').getBoundingClientRect(),svg=el.querySelector('svg');
     return {separate:help.top>=title.bottom,icon:svg.getBBox().width>0,height:el.getBoundingClientRect().height};
    });
    return {cards,width:document.documentElement.scrollWidth,footer:document.querySelector('.ao-settings > .ao-frame__foot').getBoundingClientRect().toJSON()};
   });
   assert.ok(geometry.cards.every(c=>c.separate&&c.icon),'title/help have separate lines and every icon is visible');
   assert.ok(geometry.cards.every(c=>c.height<130),'cards stay compact');assert.ok(geometry.width<=width+1);
   await p.locator('.ao-settings > .ao-frame__body').evaluate(el=>el.scrollTop=el.scrollHeight);
   const after=await foot.boundingBox();assert.equal(Math.round(after.y),Math.round(geometry.footer.top));
   if(process.env.ACCESS_SCREENSHOTS==='1'){
    mkdirSync('design/reports/access-t0089',{recursive:true});await p.locator('.ao-settings > .ao-frame__body').evaluate(el=>el.scrollTop=0);
    await p.screenshot({path:`design/reports/access-t0089/settings-${lang}-${theme}-${width}.png`,animations:'disabled'});
   }
  }
  await p.locator('#external-access-mode-lan').check();
  await p.locator('.ao-settings > .ao-frame__foot').getByRole('button',{name:'Continue',exact:true}).click();
  await p.locator('[data-step=network]').waitFor();
  assert.equal(await p.locator('.ao-external__step.is-current[aria-current=step]').count(),1);
  assert.equal(await p.locator('.ao-external__step.is-done svg').count(),1,'completed step has a check');
  assert.ok(await p.locator('.ao-external__step.is-upcoming').count()>0);
  await p.locator('.ao-settings > .ao-frame__foot').getByRole('button',{name:'Back',exact:true}).click();
  assert.equal(await p.locator('#external-access-mode-lan').isChecked(),true,'native radio selection survives back navigation');
 }finally{await h.close();}
});

test('external access: Settings review/check/publish and setup staging use the shared contract UI', {skip:browserSkipReason()||false,timeout:90000},async()=>{
 const h=await openLayoutBrowser();const {page}=h;const failures=[];page.on('pageerror',e=>failures.push(e.message));
 try{
  await visit(page,h.origin,'/parametres?onglet=access','#settings-section-form');
  await page.locator('[data-external-access=settings]').waitFor();
  await page.getByText('Interface hébergée',{exact:true}).click();
  await page.getByRole('button',{name:'Continuer',exact:true}).click();
  await page.locator('#external-access-domain').fill('api.example.org');
  await page.locator('#external-access-api').fill('https://api.example.org/backend');
  await page.getByRole('button',{name:'Continuer',exact:true}).click();
  await page.locator('#external-access-ui-origin').fill('https://office.example.org');
  await page.getByRole('button',{name:'Continuer',exact:true}).click();
  await page.getByRole('button',{name:'Continuer',exact:true}).click();
  await page.locator('[data-step=review]').getByRole('button',{name:'Préparer le résumé'}).click();
  await page.locator('[data-step=review] .ao-external__card').first().waitFor();
  await page.locator('[data-step=review]').getByRole('button',{name:'Lancer les contrôles serveur'}).click();
  await page.locator('[data-step=verify]').waitFor();
  await page.getByRole('button',{name:'Retour',exact:true}).click();
  await page.getByLabel('Je confirme les changements Agent Office présentés. Les actions DNS/proxy restent séparées.').check();
  await page.locator('[data-step=review]').getByRole('button',{name:'Enregistrer cette configuration'}).click();
  await page.locator('#settings-current-password').fill('fixture password only');
  await page.locator('button[form=settings-reauth-form]').click();
  await page.locator('[data-step=verify]').waitFor();
  await page.getByRole('button',{name:'Vérifier la configuration publiée'}).click();
  await page.getByText('Révision enregistrée 1',{exact:true}).waitFor();
  const settingState=await page.locator('[data-step=verify]').innerText();
  assert.match(settingState,/activation en attente/);assert.match(settingState,/vérification navigateur reste en attente/i);
  for(const width of [1440,390,375]){
   await page.setViewportSize({width,height:width===1440?900:width===390?844:667});
   const bounds=await page.evaluate(()=>({doc:document.documentElement.getBoundingClientRect().toJSON(),width:document.documentElement.scrollWidth,innerWidth,frame:document.querySelector('.ao-settings').getBoundingClientRect().toJSON()}));
   assert.ok(bounds.width<=width+1,`no horizontal overflow at ${width}`);assert.ok(bounds.frame.width<=width+1);
  }
  await page.evaluate(async()=>{
   const build=document.querySelector('meta[name=ao-build]').content;
   const [{render,h},{ExternalAccessFlow}]=await Promise.all([import('/lib.js?v='+build),import('/pages/external-access.js?v='+build)]);
   const root=document.createElement('div');root.id='external-access-setup-test';root.style.cssText='position:fixed;inset:0;z-index:99999;overflow:auto;background:var(--bu-surface,white);padding:24px';document.body.append(root);
   window.__accessStaged=null;
   render(h(ExternalAccessFlow,{context:'setup',setupCode:'AO-7Q2K-91MX',onStaged:draft=>window.__accessStaged=draft}),root);
  });
  await page.locator('[data-external-access=setup]').waitFor();
  await page.locator('[data-external-access=setup] [data-step=mode]').waitFor();
  await page.locator('[data-external-access=setup]').getByRole('button',{name:'Continuer',exact:true}).click();
  await page.locator('[data-external-access=setup] [data-step=security]').waitFor();
  await page.locator('[data-external-access=setup]').getByRole('button',{name:'Continuer',exact:true}).click();
  await page.locator('[data-external-access=setup] [data-step=review]').getByRole('button',{name:'Préparer le résumé'}).click();
  await page.locator('[data-external-access=setup] [data-step=review]').getByRole('checkbox').check();
  await page.locator('[data-external-access=setup] [data-step=review]').getByRole('button',{name:'Préparer pour la publication finale'}).click();
  await page.waitForFunction(()=>window.__accessStaged?.mode==='local');
  assert.deepEqual(failures,[]);
 }finally{await h.close();}
});

test('external access 404: Settings and setup show localized unavailable copy without crashing', {skip:browserSkipReason()||false,timeout:30000},async()=>{
 const h=await openLayoutBrowser();const {page}=h;const failures=[];page.on('pageerror',e=>failures.push(e.message));
 try{
  await visit(page,h.origin,'/parametres?mock=external-access-unavailable&onglet=access','#settings-section-form');
  const settingsAlert=page.locator('[data-external-access=settings] [role=alert]');
  await settingsAlert.waitFor();assert.equal(await settingsAlert.innerText(),'Accès indisponible sur cette version.');
  await page.evaluate(async()=>{
   const build=document.querySelector('meta[name=ao-build]').content;
   const [{render,h},{ExternalAccessFlow}]=await Promise.all([import('/lib.js?v='+build),import('/pages/external-access.js?v='+build)]);
   const root=document.createElement('div');root.id='external-access-setup-404';root.style.cssText='position:fixed;inset:0;z-index:99999;overflow:auto;background:var(--bu-surface,white);padding:24px';document.body.append(root);
   const props={context:'setup',setupCode:'AO-7Q2K-91MX'};
   window.__access404={root,props,render,h,ExternalAccessFlow};render(h(ExternalAccessFlow,props),root);
  });
  const setupAlert=page.locator('[data-external-access=setup] [role=alert]');
  await setupAlert.waitFor();assert.equal(await setupAlert.innerText(),'Accès indisponible sur cette version.');
  assert.equal(await page.locator('[data-external-access=setup]').getByRole('button',{name:'Continuer sans accès externe',exact:true}).count(),1);
  assert.equal(await page.locator('[data-external-access=settings]').getByRole('button',{name:'Continuer sans accès externe',exact:true}).count(),0);
  await page.evaluate(async()=>{
   const build=document.querySelector('meta[name=ao-build]').content;
   const {setLang}=await import('/i18n.js?v='+build);setLang('en');
   window.__access404.render(window.__access404.h(window.__access404.ExternalAccessFlow,window.__access404.props),window.__access404.root);
  });
  await page.getByText('External access is unavailable on this version.',{exact:true}).first().waitFor();
  assert.equal(await page.locator('[data-external-access=settings] [role=alert]').innerText(),'External access is unavailable on this version.');
  assert.equal(await page.locator('[data-external-access=setup] [role=alert]').innerText(),'External access is unavailable on this version.');
  assert.deepEqual(failures,[]);
 }finally{await h.close();}
});

test('external access mode changes clear incompatible origins and tunnel collects its API URL', {skip:browserSkipReason()||false,timeout:30000},async()=>{
 const h=await openLayoutBrowser();const {page}=h;
 try{
  await visit(page,h.origin,'/parametres?onglet=access','#settings-section-form');
  const flow=page.locator('[data-external-access=settings]'),nav=page.locator('.ao-settings > .ao-frame__foot');await flow.locator('[data-step=mode]').waitFor();
  await page.getByText('Interface hébergée',{exact:true}).click();await nav.getByRole('button',{name:'Continuer',exact:true}).click();
  await page.locator('#external-access-domain').fill('api.example.org');await page.locator('#external-access-api').fill('https://api.example.org/backend');
  await nav.getByRole('button',{name:'Continuer',exact:true}).click();await page.locator('#external-access-ui-origin').fill('https://office.example.org');
  await nav.getByRole('button',{name:'Retour',exact:true}).click();await nav.getByRole('button',{name:'Retour',exact:true}).click();
  await page.getByText('Cet appareil',{exact:true}).click();await nav.getByRole('button',{name:'Continuer',exact:true}).click();
  await flow.locator('[data-step=security]').waitFor();await nav.getByRole('button',{name:'Retour',exact:true}).click();
  await page.getByText('Interface hébergée',{exact:true}).click();await nav.getByRole('button',{name:'Continuer',exact:true}).click();
  assert.equal(await page.locator('#external-access-domain').inputValue(),'');assert.equal(await page.locator('#external-access-api').inputValue(),'');
  await nav.getByRole('button',{name:'Continuer',exact:true}).click();assert.equal(await page.locator('#external-access-ui-origin').inputValue(),'');
  await nav.getByRole('button',{name:'Retour',exact:true}).click();await nav.getByRole('button',{name:'Retour',exact:true}).click();await page.getByText('Tunnel',{exact:true}).click();
  await nav.getByRole('button',{name:'Continuer',exact:true}).click();
  assert.equal(await page.locator('#external-access-api').count(),1,'tunnel requires an explicit API HTTPS base');
  await page.locator('#external-access-domain').fill('office.example.org');await page.locator('#external-access-api').fill('https://office.example.org');
  await nav.getByRole('button',{name:'Continuer',exact:true}).click();await nav.getByRole('button',{name:'Continuer',exact:true}).click();
  await flow.locator('[data-step=review]').getByRole('button',{name:'Préparer le résumé'}).click();
  await flow.locator('[data-step=review] .ao-external__card').first().waitFor();
 }finally{await h.close();}
});
