import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdir,writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { openLayoutBrowser,browserSkipReason } from './helpers/layout-browser.js';
const skip=browserSkipReason();
async function fixture(p,origin){
 const body=await readFile(new URL('./fixtures/bureau-tabs.html',import.meta.url),'utf8');
 await p.route('**/__bureau-tabs.html',r=>r.fulfill({contentType:'text/html',body}));
 await p.goto(`${origin}/__bureau-tabs.html`,{waitUntil:'networkidle'});
 await p.getByRole('tab',{name:'Diagnostic',exact:true}).waitFor();await p.evaluate(()=>document.fonts.ready);
}

test('TabButton: native tab attrs/events, parent-owned roving keyboard and keyed focus, no form submit',{skip,timeout:15000},async()=>{
 const b=await openLayoutBrowser();const p=b.page;
 try{
  await fixture(p,b.origin);const active=p.getByRole('tab',{name:'Diagnostic',exact:true});
  assert.deepEqual(await active.evaluate(e=>({tag:e.tagName,type:e.type,role:e.getAttribute('role'),selected:e.getAttribute('aria-selected'),controls:e.getAttribute('aria-controls'),tabIndex:e.tabIndex})),
   {tag:'BUTTON',type:'button',role:'tab',selected:'true',controls:'settings-panel',tabIndex:0});
  assert.equal(await p.getByRole('tab',{name:'Compte',exact:true}).isDisabled(),true);
  await active.focus();await p.keyboard.press('ArrowRight');
  const connection=p.getByRole('tab',{name:'Connexion',exact:true});
  assert.equal(await connection.evaluate(e=>document.activeElement===e),true);assert.equal(await connection.getAttribute('aria-selected'),'true');
  assert.equal(await active.getAttribute('tabindex'),'-1');assert.equal(await p.getByRole('tabpanel').getAttribute('aria-labelledby'),'tab-connection');
  assert.ok((await p.evaluate(()=>window.bureauTabs.state.events)).some(e=>e.type==='keydown'&&e.id==='tab-diagnostic'&&e.key==='ArrowRight'));
  await p.keyboard.press('End');assert.equal(await p.getByRole('tab',{name:'Apparence',exact:true}).getAttribute('aria-selected'),'true');
  await p.keyboard.press('ArrowRight');assert.equal(await active.getAttribute('aria-selected'),'true');
  await p.keyboard.press('ArrowLeft');await p.keyboard.press('Home');assert.equal(await active.getAttribute('aria-selected'),'true');
  await p.getByRole('tab',{name:'Agents',exact:true}).click();
  assert.equal(await p.getByRole('tab',{name:'Agents',exact:true}).getAttribute('aria-selected'),'true');
  assert.equal(await p.evaluate(()=>window.bureauTabs.state.submits),0);
  await p.getByRole('tab',{name:'Agents',exact:true}).evaluate(e=>window.retainedTab=e);
  await p.evaluate(()=>{window.bureauTabs.state.reverse=true;window.bureauTabs.draw();});
  assert.equal(await p.evaluate(()=>window.retainedTab===document.querySelector('#tab-agents')&&document.activeElement===window.retainedTab),true);
  assert.ok((await p.evaluate(()=>window.bureauTabs.state.events)).some(e=>e.type==='focus'&&e.id==='tab-agents'));
  assert.ok((await p.evaluate(()=>window.bureauTabs.state.events)).some(e=>e.type==='blur'));
 }finally{await b.close();}
});

test('TabButton: mobile touch and parent active-tab scroll stay in the horizontal region',{skip,timeout:15000},async()=>{
 const b=await openLayoutBrowser({touch:true});const p=b.page;
 try{
  await p.setViewportSize({width:375,height:667});await fixture(p,b.origin);
  await p.getByRole('tab',{name:'Connexion',exact:true}).tap();
  assert.equal(await p.getByRole('tab',{name:'Connexion',exact:true}).getAttribute('aria-selected'),'true');
  await p.keyboard.press('End');const target=p.getByRole('tab',{name:'Apparence',exact:true});
  assert.equal(await target.evaluate(e=>document.activeElement===e),true);
  const rect=await target.boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=375);
  assert.equal(await p.locator('.tabs-list').evaluate(e=>getComputedStyle(e).overscrollBehaviorX),'contain');
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),375);
 }finally{await b.close();}
});

test('TabButton: native light/dark responsive selected/focus/long-label evidence',{skip,timeout:45000},async()=>{
 const b=await openLayoutBrowser();const p=b.page,records=[];
 const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 try{
  await fixture(p,b.origin);await p.emulateMedia({reducedMotion:'reduce'});
  for(const[width,height]of[[1440,900],[390,844],[375,667]])for(const theme of['light','dark'])for(const scenario of['default','focus','long-en']){
   await p.setViewportSize({width,height});
   await p.evaluate(({theme,scenario})=>{document.documentElement.dataset.theme=theme;Object.assign(window.bureauTabs.state,{active:'diagnostic',english:scenario==='long-en',long:scenario==='long-en',reverse:false});window.bureauTabs.draw();document.activeElement.blur();document.querySelector('.tabs-list').scrollLeft=0;},{theme,scenario});
   if(scenario==='focus'){await p.locator('#tab-diagnostic').focus();await p.keyboard.press('ArrowRight');}
   const geometry=await p.evaluate(()=>({root:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},targets:[...document.querySelectorAll('[role=tab]')].map(e=>({height:e.getBoundingClientRect().height,minWidth:parseFloat(getComputedStyle(e).minWidth)})),focus:getComputedStyle(document.querySelector('#tab-connection')).outlineStyle,selected:[...document.querySelectorAll('[role=tab][aria-selected=true]')].length}));
   assert.ok(geometry.root.width<=width&&geometry.root.height<=height);assert.equal(geometry.selected,1);
   assert.ok(geometry.targets.every(e=>e.height>=(width<=820?44:40)&&e.minWidth>=(width<=820?44:40)));
   if(scenario==='focus')assert.equal(geometry.focus,'solid');
   if(process.env.BUREAU_SCREENSHOTS==='1'){const dir='design/reports/bureau-components-checkpoint-5',filename=`tabs-${width}-${theme}-${scenario}.png`;await mkdir(dir,{recursive:true});await p.screenshot({path:`${dir}/${filename}`});records.push({filename,revision,width,height,theme,scenario,geometry});}
  }
  if(records.length)await writeFile('design/reports/bureau-components-checkpoint-5/captures.json',JSON.stringify(records,null,2)+'\n');
 }finally{await b.close();}
});
