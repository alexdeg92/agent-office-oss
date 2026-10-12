import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {openLayoutBrowser,visit,browserSkipReason} from './helpers/layout-browser.js';
const skip=browserSkipReason();
async function capture(p,name){if(process.env.BUREAU_SCREENSHOTS==='1'){await mkdir('design/reports/bureau-mobile-1/product',{recursive:true});await p.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});await p.screenshot({path:'design/reports/bureau-mobile-1/product/'+name+'.png',animations:'disabled'});}}

for(const width of [390,375])for(const theme of ['light','dark'])test(`mobile Bureau starts with the scene, expands KPIs, moves options into a modal and reaches overflow occupants (${theme}, ${width}px)`, {skip,timeout:60000},async()=>{
  const h=await openLayoutBrowser({theme,touch:true}),p=h.page,errors=[];p.on('pageerror',e=>errors.push(e.message));
  try{
   await p.setViewportSize({width,height:width===390?844:667});await visit(p,h.origin,'/bureau?mock=foule','.ao-bureau__stage');
   assert.equal(await p.locator('.ao-bureau__top').isVisible(),false);
   assert.equal(await p.locator('.ao-bureau__stage .bu-stage__controls').isVisible(),false);
   const stage=await p.locator('.ao-bureau__stage').boundingBox();assert.ok(stage.y<100);assert.ok(stage.y+stage.height<500);
   assert.equal(await p.locator('.ao-mobile-summary').getAttribute('open'),null);
   assert.equal(await p.locator('.bu-kpi').count(),6,'one authoritative KPI set on mobile');
   assert.equal(await p.locator('.ao-mobile-peer[data-mobile-agent]').count(),4);
   const geometry=await p.evaluate(()=>({doc:[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight],view:[innerWidth,innerHeight]}));assert.ok(geometry.doc.every((n,i)=>n<=geometry.view[i]));
   const planned=await p.evaluate(async()=>{
    const {services}=await import('/services.js');
    const vm=services.stream._topics.get('office').state.data;
    return {floors:vm.rosterFloors.map(f=>({id:f.id,title:f.id,ids:f.occupantIds})),active:vm.kpis.find(k=>k.id==='active').value};
   });
   assert.ok(planned.floors.some(f=>f.id==='2'));assert.equal(await p.locator('[data-mobile-annex]').count(),0);
   assert.equal(await p.locator('.ao-bureau__annexstage').count(),0);
   await p.waitForFunction(async()=>{const {services}=await import('/services.js');const active=services.stream._topics.get('office').state.data.kpis.find(k=>k.id==='active').value;return document.querySelector('.ao-mobile-summary summary').innerText.includes(`${active} en activité`);});
   const plates=p.locator('.ao-bureau__stage .ao-plate');
   await plates.first().waitFor({state:'attached'});
   assert.equal(await plates.filter({visible:true}).count(),0,'QA projection supplies an empty shortlist, never client-generated priority');
   for(const plate of await p.locator('.ao-bureau__stage .ao-plate:not([data-role=main])').all()) {
    assert.ok(await plate.getAttribute('aria-label'));assert.equal(await plate.locator('.ao-plate__name').isVisible(),false);
   }
   const activity=p.locator('.ao-mobile-activity');assert.equal(await activity.getAttribute('open'),null);
   await capture(p,`office-${theme}-${width}`);
   await activity.evaluate(el=>{const body=el.closest('.ao-frame__body');body.scrollTop+=el.getBoundingClientRect().top-body.getBoundingClientRect().top-16;});
   await capture(p,`activity-closed-${theme}-${width}`);
   await activity.locator('summary').click();
   assert.equal(await activity.locator('.ao-bureau__fresh').count(),0);
   assert.ok(await activity.locator('.ao-carnet__entry').count());
   assert.ok(await activity.locator('.ao-carnet__entry').evaluateAll(rows=>rows.every(row=>{
    const time=row.querySelector('time').getBoundingClientRect(),text=row.querySelector('.bu-event__text').getBoundingClientRect();
    return time.x<text.x&&Math.abs(time.y-text.y)<10;
   })));
   await activity.evaluate(el=>{const body=el.closest('.ao-frame__body');body.scrollTop+=el.getBoundingClientRect().top-body.getBoundingClientRect().top-16;});
   await capture(p,`activity-populated-${theme}-${width}`);
   await activity.getByRole('button',{name:/Tâches planifiées/}).click();assert.ok(await activity.locator('.ao-bureau__queue').count());
   await capture(p,`activity-scheduled-${theme}-${width}`);
   await activity.getByRole('button',{name:'Journal',exact:true}).click();await activity.locator('summary').click();
   await activity.evaluate(el=>{el.closest('.ao-frame__body').scrollTop=0;});
   await p.locator('.ao-mobile-summary summary').click();assert.equal(await p.locator('.ao-mobile-summary [role=listitem]').count(),6);assert.ok(await p.locator('.ao-mobile-summary .bu-kpi__label').evaluateAll(els=>els.every(el=>parseFloat(getComputedStyle(el).fontSize)>=11)));await capture(p,`kpis-${theme}-${width}`);await p.locator('.ao-mobile-summary summary').click();
   const options=p.getByRole('button',{name:'Options du bureau',exact:true});await options.click();
   assert.equal(await p.getByRole('dialog',{name:'Options du bureau',exact:true}).isVisible(),true);
   assert.equal(await p.locator('[role=dialog]').getByText('Animations surprises',{exact:true}).count(),0);
   assert.equal(await p.locator('[role=dialog] .bu-segmented__opt').count(),3);
   assert.equal(await p.locator('#ao-mobile-theme-label').count(),1);
   assert.equal(await p.locator('[role=dialog] .bu-segmented').getAttribute('aria-labelledby'),'ao-mobile-theme-label');
   await p.locator('[role=dialog]').getByRole('button',{name:'Nuit',exact:true}).click();
   await p.waitForFunction(()=>document.querySelector('[role=dialog] .bu-segmented__opt[aria-pressed=true]')?.textContent.trim()==='Nuit');
   await p.locator('[role=dialog]').getByRole('button',{name:'Automatique',exact:true}).click();
   await p.waitForFunction(()=>document.querySelector('[role=dialog] .bu-segmented__opt[aria-pressed=true]')?.textContent.trim()==='Automatique');
   await capture(p,`options-${theme}-${width}`);
   await p.keyboard.press('Shift+Tab');assert.equal(await p.locator('[role=dialog]').evaluate(el=>el.contains(document.activeElement)),true);
   await p.keyboard.press('Escape');await p.waitForFunction(()=>document.activeElement?.classList.contains('ao-mobile-options'));
   const visible=await p.locator('[data-mobile-agent]').evaluateAll(els=>els.map(e=>e.dataset.mobileAgent));
   const overflow=Number(await p.locator('[data-overflow-count]').getAttribute('data-overflow-count'));
   await p.locator('[data-overflow-count]').click();const rows=p.locator('[role=dialog] [data-occupant]');assert.equal(await rows.count(),visible.length+overflow);
   await capture(p,`roster-${theme}-${width}`);
   const hidden=planned.floors.find(f=>f.id==='2').ids[0];assert.ok(!visible.includes(hidden));
   const index=await rows.evaluateAll((els,id)=>els.findIndex(el=>el.dataset.occupant===id),hidden);const name=await rows.nth(index).locator('.ao-agentcard__name').innerText();await rows.nth(index).click();
   await p.locator('#ao-drawer-title').waitFor();assert.equal(await p.locator('#ao-drawer-title').innerText(),name);assert.equal(await p.locator('.bu-kv__row').filter({has:p.getByText('Poste',{exact:true})}).locator('dd').innerText(),'Attribué');await capture(p,`hidden-selection-${theme}-${width}`);
   await p.getByRole('button',{name:'Fermer',exact:true}).click();
   await p.waitForFunction(()=>document.querySelector('.ao-bureau__stage')?.dataset.floor==='2');
   await p.waitForFunction(()=>new URL(location.href).searchParams.get('etage')==='2');
   assert.equal(await p.locator('.ao-bureau__stage').count(),1);assert.equal(await p.locator('.ao-bureau__annexstage').count(),0);
   await capture(p,`floor-2-${theme}-${width}`);
   await p.locator('[data-overflow-count]').click();
   await p.locator('[role=dialog] [data-occupant="'+hidden+'"]').click();
   await p.locator('#ao-drawer-title').waitFor();await p.getByRole('button',{name:'Fermer',exact:true}).click();
   await p.setViewportSize({width:900,height:900});await p.locator('.ao-floor-picker [data-floor="2"]').waitFor();
   assert.equal(await p.locator('[data-mobile-annex]').count(),0);
   assert.equal(await p.locator('.ao-bureau__stage').getAttribute('data-plates-primary'),null);
   assert.deepEqual(errors,[]);
  }finally{await h.close();}
});

test('desktop Bureau keeps its full roster, counters and theme controls', {skip,timeout:30000},async()=>{
 for(const theme of ['light','dark']) {
  const h=await openLayoutBrowser({theme}),p=h.page;
  try {
   await p.setViewportSize({width:1440,height:900});await visit(p,h.origin,'/bureau?mock=foule','.ao-bureau__stage');
   assert.equal(await p.locator('.ao-bureau__top').isVisible(),true);
   assert.equal(await p.locator('.ao-bureau__top [role=listitem]').count(),6);
   assert.equal(await p.locator('.ao-bureau__side').isVisible(),true);
   assert.equal(await p.locator('.ao-mobile-options').isVisible(),false);
   assert.equal(await p.locator('.ao-mobile-summary').count(),0);assert.equal(await p.locator('.bu-kpi').count(),6,'one authoritative KPI set on desktop');
   assert.equal(await p.locator('.ao-mobile-roster').count(),0);
   assert.equal(await p.locator('.ao-bureau__top .bu-segmented__opt').count(),3);
   assert.equal(await p.locator('.ao-mobile-activity').count(),0);
   await capture(p,`office-${theme}-1440`);
   const plannedId=await p.evaluate(async()=>{
    const {services}=await import('/services.js');
    const vm=services.stream._topics.get('office').state.data;
    const placed=vm.occupants.find(o=>o.id===vm.rosterFloors.find(f=>f.id==='2').occupantIds[0]);
    if(!placed?.stationUid)throw new Error('Floor fixture has no assigned station');return placed.id;
   });
   await p.locator('.ao-floor-picker [data-floor="2"]').click();await p.waitForFunction(()=>document.querySelector('.ao-bureau__stage')?.dataset.floor==='2');
   const plate=p.locator('.ao-bureau__stage .ao-plate').first();await plate.waitFor();const name=await plate.locator('.ao-plate__name').innerText();await plate.click();
   await p.locator('#ao-drawer-title').waitFor();assert.equal(new URL(p.url()).searchParams.get('agent'),plannedId);
   assert.equal(await p.locator('#ao-drawer-title').innerText(),name);
   assert.equal(await p.locator('.bu-kv__row').filter({has:p.getByText('Poste',{exact:true})}).locator('dd').innerText(),'Attribué');
   await capture(p,`hidden-selection-${theme}-1440`);
  }finally {await h.close();}
 }
});

test('mobile loading and disconnected states keep the compact hierarchy and truthful feedback', {skip,timeout:60000},async()=>{
 for(const width of [390,375])for(const theme of ['light','dark']) {
  const h=await openLayoutBrowser({theme,touch:true}),p=h.page;
  try {
   await p.setViewportSize({width,height:width===390?844:667});
   await visit(p,h.origin,'/bureau?mock=lent','.ao-bureau[aria-busy=true]');
   assert.equal(await p.locator('.ao-bureau__kpis').isVisible(),false);
   assert.equal(await p.locator('.ao-bureau__side').isVisible(),false);
   const skeleton=await p.locator('.ao-bureau__stage').boundingBox();assert.ok(skeleton.y<100);
   await capture(p,`loading-${theme}-${width}`);
   await visit(p,h.origin,'/bureau?mock=panne','.ao-mobile-roster [data-mobile-agent="main"] .bu-state');
   assert.equal(await p.locator('.ao-bureau .bu-banner--warning').isVisible(),true);
   assert.equal(await p.locator('.ao-mobile-roster [data-mobile-agent="main"] .bu-state').getAttribute('data-agent-state'),'offline');
   assert.ok((await p.locator('.ao-mobile-roster [data-mobile-agent="main"] .bu-state').getAttribute('title')).endsWith('au dernier relevé.'));
   await capture(p,`disconnected-${theme}-${width}`);
  } finally {await h.close();}
 }
});

test('mobile stale primary and selected details report the last observation rather than a live duration', {skip,timeout:60000},async()=>{
 for(const width of [390,375])for(const theme of ['light','dark']) {
  const h=await openLayoutBrowser({theme,touch:true}),p=h.page;
  try {
   await p.setViewportSize({width,height:width===390?844:667});await visit(p,h.origin,'/bureau?mock=foule','.ao-mobile-roster');
   await p.evaluate(async()=>{const {services}=await import('/services.js');services.stream.stop();const office=services.stream._topics.get('office');services.stream._handleFrame('snapshot',JSON.stringify({topic:'office',rev:(office.state.rev??0)+1,data:office.state.data,meta:{generatedAt:Date.now(),stale:['cli.skills']}}));services.stream.status.set({conn:'retrying',lastFrameAt:Date.now()});});
   await p.locator('.ao-bureau--last').waitFor();
   assert.equal(await p.locator('.ao-bureau__stage').getAttribute('data-plates-primary'),'');
   assert.equal(await p.locator('.ao-bureau__stage').evaluate(el=>el.classList.contains('ao-office')),true);
   assert.ok(await p.locator('.ao-bureau__stage .ao-plate:not([data-role=main]) .ao-plate__name').evaluateAll(els=>els.length>0&&els.every(el=>getComputedStyle(el).display!=='none')));
   const title=await p.locator('.ao-mobile-roster [data-mobile-agent="main"] .bu-state').getAttribute('title');assert.ok(title.endsWith('au dernier relevé.'));assert.doesNotMatch(title,/depuis|minute/);
   assert.equal(await p.locator('.ao-roster__state--live').count(),0);
   assert.ok((await p.locator('.ao-mobile-summary summary').innerText()).startsWith('Dernier état'));
   await capture(p,`stale-${theme}-${width}`);
   await p.locator('.ao-mobile-roster [data-mobile-agent="main"]').click();await p.locator('#ao-drawer-title').waitFor();
   assert.ok((await p.locator('.ao-drawer__state').innerText()).endsWith('au dernier relevé.'));
   await capture(p,`stale-selection-${theme}-${width}`);
   // The title paints before the drawer effect installs its Escape listener.
   await p.waitForFunction(()=>document.activeElement?.closest('.bu-drawer'));await p.keyboard.press('Escape');await p.locator('#ao-drawer-title').waitFor({state:'hidden'});
   await p.evaluate(async()=>{const {services}=await import('/services.js');services.stream.status.set({conn:'open'});});
   await p.locator('.ao-bureau--last').waitFor({state:'detached'});
   assert.equal(await p.locator('.ao-mobile-roster [data-mobile-agent="main"] .bu-state').getAttribute('title').then(t=>t.endsWith('au dernier relevé.')),true,
    'the stale primary retains its last-observation marker after the stream reconnects');
   await p.locator('.ao-mobile-roster [data-mobile-agent="main"]').click();await p.locator('#ao-drawer-title').waitFor();
   assert.equal(await p.locator('.ao-drawer__state').getAttribute('data-source-stale'),'true');
   assert.ok((await p.locator('.ao-drawer__state').innerText()).endsWith('au dernier relevé.'),
    'selected details retain the agent source freshness after the stream reconnects');
   // A real recovery includes a newer snapshot. Its revision also defeats any late initial GET.
   await p.evaluate(async()=>{const {services}=await import('/services.js');const office=services.stream._topics.get('office');services.stream._handleFrame('snapshot',JSON.stringify({topic:'office',rev:office.state.rev+1,data:office.state.data,meta:{generatedAt:Date.now(),stale:[]}}));});
   await p.locator('.ao-bureau--last').waitFor({state:'hidden'});
   await p.locator('.ao-drawer__state[data-source-stale]').waitFor({state:'detached'});
   assert.equal(await p.locator('.ao-bureau__stage').evaluate(el=>el.classList.contains('ao-office')&&el.hasAttribute('data-plates-primary')),true);
   assert.ok(await p.locator('.ao-bureau__stage .ao-plate:not([data-role=main]) .ao-plate__name').evaluateAll(els=>els.length>0&&els.every(el=>getComputedStyle(el).display!=='none')));
  }finally{await h.close();}
 }
});
