import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{projectSourceProvenanceFixture}=require('../helpers/project-source-provenance-fixture.cjs');
const OUT='design/reports/project-source-provenance-174';
for(const width of [1440,390])for(const theme of ['light','dark'])for(const locale of ['fr','en'])test(`Purged legacy project source ${width} ${theme} ${locale}`,{skip:browserSkipReason(),timeout:60000},async()=>{
 let b,h;
 try{
  b=await openLayoutBrowser({apiVersion:width===390?2:3,theme,touch:width===390,apiProxy:async publicUrl=>{h=await projectSourceProvenanceFixture(publicUrl);return h.base;}});
  const p=b.page,height=width===390?844:900,errors=[];p.on('pageerror',error=>errors.push(error.message));
  await p.context().addInitScript(locale=>localStorage.setItem('ao.locale',locale),locale);await p.setViewportSize({width,height});
  const split=h.cookie.indexOf('=');await p.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  assert.equal(h.viewEngine.sessions().length,0,'no original session remains to infer ownership');
  for(const version of [2,3]){
   const board=await h.get(`/api/v${version}/views/projects`);assert.equal(board.status,200,board.text);
   assert.equal(board.json.data.sourceFilters.find(row=>row.id==='source:sessionGroup:legacy')?.count,7);
   assert.equal(board.json.data.sourceFilters.find(row=>row.id==='source:sessionGroup')?.count,1,'later unowned link remains generic');
   const selected=await h.get(`/api/v${version}/views/projects?source=${encodeURIComponent('source:sessionGroup:legacy')}`);assert.equal(selected.status,200,selected.text);
   assert.deepEqual(selected.json.data.columns.flatMap(column=>column.cards).map(row=>row.id).sort(),[...h.projectIds].sort());
   for(const id of h.projectIds){const detail=await h.get(`/api/v${version}/views/projects/${id}`);assert.equal(detail.status,200,detail.text);assert.equal(detail.json.data.sourceDescriptors[0].runtime,'openclaw');assert.equal(JSON.stringify(detail.json.data).includes('connectorIds'),false);}
  }
  await p.goto(b.origin+'/projets',{waitUntil:'domcontentloaded'});
  const chip=p.locator('[data-project-source="source:sessionGroup:legacy"]');await chip.waitFor();assert.ok((await chip.textContent()).includes('OpenClaw'));assert.equal(await chip.locator('.bu-count').textContent(),'7');
  await p.waitForFunction(()=>[...document.querySelectorAll('.bu-live')].some(el=>el.textContent==='En direct'||el.textContent==='Live'));
  await p.evaluate(()=>document.fonts.ready);await mkdir(OUT,{recursive:true});
  const capture=async state=>{assert.deepEqual(await p.evaluate(()=>[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight,scrollY]),[width,height,0]);await p.screenshot({path:`${OUT}/${width}-${theme}-${locale}-${state}.png`,animations:'disabled'});};
  await capture('all');await chip.click();await p.waitForFunction(ids=>JSON.stringify([...document.querySelectorAll('[data-card]')].map(row=>row.dataset.card).sort())===JSON.stringify(ids),[...h.projectIds].sort());
  assert.equal(await chip.getAttribute('aria-pressed'),'true');await capture('selected');
  assert.deepEqual(errors,[]);assert.deepEqual(await p.evaluate(()=>window.__AO_VM_ISSUES||[]),[]);
  await writeFile(`${OUT}/${width}-${theme}-${locale}.json`,JSON.stringify({source:process.env.AO_SOURCE_SHA,projectIds:h.projectIds,purgedSessionCount:h.viewEngine.sessions().length},null,2)+'\n');
 }finally{await b?.close();await h?.close();}
});
