import test from 'node:test';
import assert from 'node:assert/strict';
import {openLayoutBrowser,visit,browserSkipReason} from './helpers/layout-browser.js';
import {agentConnector} from './helpers/settings-agent-browser.js';
test('Settings agent portraits use lightweight pack thumbnails without hydrating packs',{skip:browserSkipReason(),timeout:30000},async()=>{
 const h=await openLayoutBrowser(),p=h.page,packRequests=[];
 p.on('request',r=>{if(/\/manifest\.json(?:\?|$)/.test(r.url()))packRequests.push(r.url());});
 try{
  await visit(p,h.origin,'/parametres?mock=1','#settings-section-form');
  await p.locator('#settings-tab-agents').click();
  await agentConnector(p,'openclaw');
  await p.waitForFunction(async()=>{const {services}=await import('/services.js');return !!services.stream._topics.get('layout')?.state.data;});
  await p.evaluate(async()=>{
   const api=await import('/api.js'),{services}=await import('/services.js');
   const {data:vm}=await api.get('/api/v2/office/layout');
   vm.layout.data.agents[0]={...vm.layout.data.agents[0],character:'fen',variant:'moss',accessories:[]};
   await api.put('/api/v2/office/layout',{expectedRevision:vm.layout.revision,data:vm.layout.data});
   services.stream.retry('layout');
  });
  const row=p.locator('[data-testid=settings-agent-row-0]');
  await p.waitForFunction(()=>document.querySelector('[data-testid=settings-agent-row-0] img[src*="fen/moss/t.webp"]')?.naturalWidth>0);
  assert.equal(await row.locator('img').getAttribute('alt'),'');
  assert.equal(await row.locator('.ao-settings__role').count(),1);
  await row.getByRole('button',{name:/^Actions/}).click();
  assert.equal(await p.getByRole('menuitem',{name:'Changer l’apparence',exact:true}).getAttribute('href'),'/boutique?onglet=personnages&agent=primary&mock=1');
  assert.deepEqual(packRequests,[],'avatar reads the layout summary; no full pack metadata request');
 }finally{await h.close();}
});
