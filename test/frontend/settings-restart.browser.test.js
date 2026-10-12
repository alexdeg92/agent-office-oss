import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import diagnosticBuilder from '../../src/settings/diagnostics.js';
import {openLayoutBrowser,visit,browserPath} from './helpers/layout-browser.js';
const skip=!browserPath();
const fixture=()=>JSON.parse(readFileSync(new URL('../../docs/architecture/examples/settings/settings-vm.json',import.meta.url)));

test('restart required offers the config-owning service action in the banner and Diagnostic',{skip,timeout:20000},async()=>{
 const b=await openLayoutBrowser(process.env.SETTINGS_BEFORE_ROOT?{root:process.env.SETTINGS_BEFORE_ROOT}:{}),p=b.page;
 try{
  await p.route('**/mock/examples/settings/settings-vm.json',route=>{
   const body=fixture();body.data.network.restartRequired=true;body.data.network.port.value=18801;
   // Exercise the backend's declared restart diagnostic, including its v2 severity/fix contract.
   const restart=diagnosticBuilder.diagnostics({runtimes:[],agents:[],permissionOk:true,stale:false,restartRequired:true,readonly:false}).find(row=>row.id==='restart');
   body.data.diagnostics=body.data.diagnostics.filter(row=>row.id!=='restart');
   body.data.diagnostics.push(restart);
   if(process.env.SETTINGS_BEFORE_ROOT)delete body.data.restart;
   return route.fulfill({json:body});
  });
  await visit(p,b.origin,'/parametres','#settings-section-form');
  assert.equal(await p.getByRole('button',{name:'Redémarrer Agent Office',exact:true}).count(),2,'restart action is available in banner and Diagnostic');
  await p.getByRole('button',{name:'Redémarrer Agent Office',exact:true}).first().click();
  const dialog=p.locator('[role=dialog]');assert.ok((await dialog.innerText()).includes('service qui gère les paramètres'));
  await dialog.getByRole('button',{name:'Rester ici',exact:true}).click();assert.equal(await p.locator('#settings-current-password').count(),0);
 }finally{await b.close();}
});

test('standalone restart exposes the manual command as text in French and English, with mobile frame intact',{skip,timeout:20000},async()=>{
 const b=await openLayoutBrowser(),p=b.page;
 try{
  await p.route('**/mock/examples/settings/settings-vm.json',route=>{
   const body=fixture();body.data.network.restartRequired=true;body.data.restart={supported:false,command:'agent-office --api-only',reason:{key:'settings.restart.unsupervised'}};
   return route.fulfill({json:body});
  });
  await p.setViewportSize({width:375,height:667});await visit(p,b.origin,'/parametres','#settings-section-form');
  assert.equal(await p.getByRole('button',{name:'Redémarrer Agent Office',exact:true}).count(),0);assert.ok((await p.locator('.ao-settings__restart').first().innerText()).includes('agent-office --api-only'));
  if(process.env.SETTINGS_SCREENSHOTS==='1')await p.screenshot({path:'design/reports/settings-2/restart-manual-mobile.png'});
  await p.evaluate(async()=>{const {chooseLang}=await import('/lang.js?v='+document.querySelector('meta[name=ao-build]').content);await chooseLang('en');});
  assert.ok((await p.locator('.ao-settings__restart').first().innerText()).includes('Restart the Agent Office service with this command'));
  assert.ok(await p.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth && document.scrollingElement.scrollHeight<=innerHeight));
 }finally{await b.close();}
});
