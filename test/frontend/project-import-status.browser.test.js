import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{projectTeamFixture}=require('../helpers/project-team-fixture.cjs');
const OUT='design/reports/project-sources-133';
for(const width of [1440,390])for(const theme of ['light','dark'])test(`import renders supplied initial status choices ${width} ${theme}`,{skip:browserSkipReason(),timeout:60000},async t=>{
 let h,b;
 try {
  b=await openLayoutBrowser({apiVersion:3,theme,touch:width===390,apiProxy:async publicUrl=>{h=await projectTeamFixture({publicUrl});return h.base;}});
  t.after(async()=>{await b.close();await h.close();});
  h.viewEngine.sessionGroups=()=>[{id:'fixture-import',name:'Échanges à organiser',sessionKeys:['worker-1'],lastActivityAt:h.clock.value}];
  const build=h.api.projects.service.views.candidates,initial=await build();
  const candidate=initial.candidates.find(row=>row.sources.some(source=>source.kind==='sessionGroup'&&source.ref.groupId==='fixture-import'));
  assert.ok(candidate,'real discovery produces the synthetic session-group candidate');
  const target=candidate.suggestedStatus==='todo'?'idea':'todo';let available=true;
  const options=[{id:candidate.suggestedStatus,label:{key:'project.source.label',params:{label:'Suggestion du service'}}},
   {id:target,label:{key:'project.source.label',params:{label:'Préparer cet import'}}}];
  h.api.projects.service.views.candidates=async input=>{
   const vm=await build(input);return {...vm,candidates:vm.candidates.filter(row=>row.key===candidate.key),statusOptions:available?options:[]};
  };
  const page=b.page;await page.setViewportSize({width,height:width===390?844:900});
  const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  await page.goto(b.origin+'/projets/importer',{waitUntil:'domcontentloaded'});
  const select=page.locator('.ao-cand__status select');await select.waitFor();
  assert.deepEqual(await select.locator('option').allTextContents(),options.map(option=>option.label.params.label));
  assert.equal(await select.inputValue(),candidate.suggestedStatus);
  await select.selectOption(target);assert.equal(await select.inputValue(),target);
  await mkdir(OUT,{recursive:true});await page.screenshot({path:OUT+`/${width}-${theme}-import-status.png`,animations:'disabled'});
  available=false;await page.getByRole('button',{name:'Actualiser',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.ao-cand__status select')?.disabled);
  assert.equal(await select.locator('option').count(),0);
  available=true;await page.getByRole('button',{name:'Actualiser',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.ao-cand__status select option').length===2);
  await select.selectOption(target);
  const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/projects/import'));
  await page.getByRole('button',{name:'Importer un projet',exact:true}).click();const imported=await response;
  assert.equal(imported.status(),200);assert.deepEqual(imported.request().postDataJSON().keys,[candidate.key]);
  assert.equal(imported.request().postDataJSON().overrides[candidate.key].status,target);
  const result=(await imported.json()).data.result;assert.equal(result.created.length,1);assert.equal(result.skipped.length,0);
  const detail=await h.get('/api/v3/views/projects/'+result.created[0].id);assert.equal(detail.status,200,detail.text);assert.equal(detail.json.data.status,target);
  await writeFile(OUT+`/${width}-${theme}-import.json`,JSON.stringify({source:process.env.AO_SOURCE_SHA||null,options,submitted:target,emptyDisabled:true},null,2)+'\n');
 }finally{if(!b)await h?.close();}
});
