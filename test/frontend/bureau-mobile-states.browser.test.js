import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {openLayoutBrowser,visit,browserSkipReason} from './helpers/layout-browser.js';
const skip=browserSkipReason();
async function capture(p,name) {
 if(process.env.BUREAU_SCREENSHOTS!=='1')return;
 await mkdir('design/reports/bureau-mobile-1/product',{recursive:true});
 await p.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
 await p.screenshot({path:'design/reports/bureau-mobile-1/product/'+name+'.png',animations:'disabled'});
}
// Feed contract-shaped snapshots through the real stream seam; the production page, scene and drawers render them.
async function fixture(p,kind) {
 return p.evaluate(async kind=>{
  const {services}=await import('/services.js');
  const stream=services.stream,vm=structuredClone(stream._topics.get('office').state.data),lay=structuredClone(stream._topics.get('layout').state.data);
  stream.stop();stream.status.set({conn:'open'});
  // This fixture supplies a fresh snapshot; an earlier mock GET may mark cli.skills stale.
  stream._topics.get('office').meta=null;
  if(kind==='empty') {
   vm.occupants=[];vm.journal=[];vm.queue=[];lay.agentsSeen=[];
   vm.rosterSummary={count:0,activeCount:0};
   for(const k of vm.kpis)if(['active','runs','subagents'].includes(k.id))k.value=0;
  } else {
   const main=vm.occupants.find(o=>o.role==='main'),peer=vm.occupants.find(o=>o.role!=='main');
   main.name=main.sourceName='Atlas Documentation';main.title=null;
   peer.name=peer.sourceName='Scribe Vérifications';peer.title=null;
  }
  stream.applyVM('layout',lay);stream.applyVM('office',vm);
  return vm.occupants.map(o=>({id:o.id,name:o.name}));
 },kind);
}

test('actual mobile empty, error and long-name views preserve hierarchy and full selected identities', {skip,timeout:120000},async()=>{
 for(const width of [390,375])for(const theme of ['light','dark']) {
  const h=await openLayoutBrowser({theme,touch:true}),p=h.page,errors=[];p.on('pageerror',e=>errors.push(e.message));
  try {
   await p.setViewportSize({width,height:width===390?844:667});
   await visit(p,h.origin,'/bureau?mock=foule','.ao-bureau__stage');
   const occupants=await fixture(p,'long'),main=occupants.find(o=>o.name==='Atlas Documentation'),peer=occupants.find(o=>o.name==='Scribe Vérifications');
   await p.getByText(main.name,{exact:true}).first().waitFor();
   assert.equal(await p.locator('.ao-mobile-roster [data-mobile-agent]').count(),5);
   await capture(p,`long-names-${theme}-${width}`);
   for(const [kind,agent] of [['primary',main],['peer',peer]]) {
    const row=p.locator(`.ao-mobile-roster [data-mobile-agent="${agent.id}"]`);await row.click();
    await p.locator('#ao-drawer-title').waitFor();assert.equal(await p.locator('#ao-drawer-title').innerText(),agent.name);
    const title=await p.locator('#ao-drawer-title').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));assert.ok(title.scroll<=title.width);
    await capture(p,`long-${kind}-selection-${theme}-${width}`);
    await p.getByRole('button',{name:'Fermer',exact:true}).click();
   }
   await fixture(p,'empty');
   await p.waitForFunction(()=>document.querySelectorAll('.ao-mobile-roster [data-mobile-agent]').length===0);
   await p.waitForFunction(()=>document.querySelectorAll('.ao-bureau__stage .ao-char').length===0);
   assert.equal(await p.locator('[data-mobile-annex]').count(),0);
   await p.waitForFunction(()=>document.querySelector('.ao-mobile-summary summary').innerText.includes('0 en activité')).catch(async error=>{
    const state=await p.evaluate(async()=>{const {services}=await import('/services.js');const e=services.stream._topics.get('office');return {summary:document.querySelector('.ao-mobile-summary summary').innerText,status:services.stream.status.get(),connection:e.state.data.connection,kpis:e.state.data.kpis,meta:e.meta};});
    assert.fail(`${width}/${theme}: ${error.message}; ${JSON.stringify(state)}`);
   });
   assert.ok((await p.locator('.ao-mobile-roster').innerText()).length>0);
   await capture(p,`empty-${theme}-${width}`);
   const activity=p.locator('.ao-mobile-activity');assert.equal(await activity.getAttribute('open'),null);await activity.locator('summary').click();
   assert.equal(await activity.locator('.ao-carnet__entry').count(),0);assert.ok((await activity.innerText()).includes('Rien à signaler'));
   await capture(p,`activity-empty-${theme}-${width}`);
   await activity.getByRole('button',{name:/Tâches planifiées/}).click();assert.equal(await activity.locator('.ao-bureau__queue').count(),0);
   await capture(p,`activity-scheduled-empty-${theme}-${width}`);
   await visit(p,h.origin,'/bureau?mock=erreur','.ao-bureau [role=alert]');
   assert.equal(await p.getByRole('button',{name:'Réessayer',exact:true}).isVisible(),true);
   assert.equal(await p.locator('.ao-bureau__kpis').count(),0);
   await capture(p,`error-${theme}-${width}`);
   assert.deepEqual(errors,[]);
   const geometry=await p.evaluate(()=>({doc:[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight],view:[innerWidth,innerHeight]}));assert.ok(geometry.doc.every((n,i)=>n<=geometry.view[i]));
  }finally{await h.close();}
 }
});
