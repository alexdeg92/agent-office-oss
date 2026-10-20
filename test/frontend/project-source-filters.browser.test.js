import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{projectTeamFixture}=require('../helpers/project-team-fixture.cjs');
const OUT='design/reports/project-source-filters-170';

for(const width of [1440,390])for(const theme of ['light','dark'])for(const locale of ['fr','en'])
test(`canonical source filters ${width} ${theme} ${locale}`,{skip:browserSkipReason(),timeout:60000},async()=>{
 let h,b;
 try {
  b=await openLayoutBrowser({apiVersion:width===390?2:3,theme,touch:width===390,apiProxy:async publicUrl=>{h=await projectTeamFixture({publicUrl});return h.base;}});
  const {page}=b;await page.context().addInitScript(locale=>localStorage.setItem('ao.locale',locale),locale);
  const connectorOf=h.viewEngine.connectorOf;
  const mark=require('../../src/adapters/openclaw').setup.capabilities.brand;
  // Adapter-owned canonical fixture metadata, never a UI inference.
  h.viewEngine.connectorOf=key=>['worker-3','worker-4'].includes(key)?{id:'fixture-gateway',adapter:'openclaw',name:'OpenClaw',mark}:connectorOf(key);
  h.viewEngine.sessionGroups=()=>[{id:'fixture-source-group',name:'Exports des échanges',sessionKeys:['worker-3']}];
  const expected=[];
  for(let n=0;n<3;n++) {
   const response=await h.post('/api/v3/projects',{name:'Conversation de projet '+(n+1),sources:[
    {kind:'sessionGroup',ref:n===0?{by:'group',groupId:'fixture-source-group',name:'Exports des échanges'}:{by:'keys',sessionKeys:['worker-3']}},
    ...(n===2?[{kind:'sessionGroup',ref:{by:'keys',sessionKeys:['worker-4']}}]:[]),
   ]});
   assert.equal(response.status,200,response.text);expected.push(response.json.data.vm.id);
  }
  h.api.topics.invalidate();
  let source;
  for(const version of [2,3]){
   const response=await h.get(`/api/v${version}/views/projects`);assert.equal(response.status,200,response.text);
   const rows=response.json.data.sourceFilters.filter(row=>row.source.runtime==='openclaw');
   assert.equal(rows.length,1,'one filter for all conversation projects from the same connector');
   source=rows[0];assert.equal(source.count,3,'projects count once despite multiple links');
   assert.deepEqual(source.label,{key:'project.source.label',params:{label:'OpenClaw'}});
   const selected=await h.get(`/api/v${version}/views/projects?source=${encodeURIComponent(source.id)}`);
   assert.equal(selected.status,200,selected.text);
   assert.deepEqual(selected.json.data.columns.flatMap(column=>column.cards).map(card=>card.id).sort(),[...expected].sort());
  }
  const height=width===390?844:900;await page.setViewportSize({width,height});
  const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(b.origin+'/projets',{waitUntil:'domcontentloaded'});
  const chip=page.locator(`[data-project-source="${source.id}"]`);await chip.waitFor();
  assert.equal(await chip.locator('.bu-count').textContent(),'3');assert.ok((await chip.textContent()).includes('OpenClaw'));
  assert.equal(await page.locator('[data-project-source]').filter({hasText:/Other \(|Autre \(/}).count(),0,'no missing-label fallback');
  assert.deepEqual(await page.evaluate(()=>[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight,scrollY]),[width,height,0]);
  await chip.scrollIntoViewIfNeeded();await mkdir(OUT,{recursive:true});await page.screenshot({path:OUT+`/${width}-${theme}-${locale}-all.png`,animations:'disabled'});
  await chip.click();await page.waitForFunction(expected=>{
   const ids=[...document.querySelectorAll('[data-card]')].map(card=>card.dataset.card).sort();
   return JSON.stringify(ids)===JSON.stringify(expected);
  },[...expected].sort());
  assert.equal(await chip.getAttribute('aria-pressed'),'true');
  await page.screenshot({path:OUT+`/${width}-${theme}-${locale}-selected.png`,animations:'disabled'});
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.__AO_VM_ISSUES||[]),[]);
  await writeFile(OUT+`/${width}-${theme}-${locale}.json`,JSON.stringify({source:process.env.AO_SOURCE_SHA||null,filter:source,projectIds:expected,locale},null,2)+'\n');
 }finally{await b?.close();await h?.close();}
});
