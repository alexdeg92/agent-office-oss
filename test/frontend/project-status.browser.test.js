import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{projectTeamFixture}=require('../helpers/project-team-fixture.cjs');
const OUT='design/reports/project-sources-133';
const ref=text=>({key:'project.source.label',params:{label:text}});

// Decorate the mounted service's canonical producer, never a browser response.
// A restricted destination and non-enum labels catch frontend reconstruction.
for(const width of [1440,390])for(const theme of ['light','dark'])test(`supplied project status actions ${width} ${theme}`,{skip:browserSkipReason(),timeout:60000},async t=>{
 let h,b;
 try {
  b=await openLayoutBrowser({apiVersion:2,theme,touch:width===390,apiProxy:async publicUrl=>{h=await projectTeamFixture({publicUrl});return h.base;}});
  t.after(async()=>{await b.close();await h.close();});
  const created=await h.post('/api/v3/projects',{name:'Préparation des accès',summary:'Validation des destinations fournies.'});
  assert.equal(created.status,200,created.text);const id=created.json.data.vm.id;
  let available=true,returnAllowed=true;
  const project=h.api.projects.service.views.project,setStatus=h.api.projects.service.commands.setStatus;
  const supplied=vm=>vm.id!==id?vm:{...vm,statusLabel:ref(vm.status==='idea'?'À préparer':'Prêt à commencer'),
   statusTransitions:available?(vm.status==='idea'?[{id:'todo',label:ref('Commencer')}]:returnAllowed?[{id:'idea',label:ref('Revenir à la préparation')}]:[]):[]};
  h.api.projects.service.views.project=input=>supplied(project(input));
  h.api.projects.service.commands.setStatus=input=>{const result=setStatus(input);return {...result,vm:supplied(result.vm)};};
  h.api.topics.invalidate();
  const page=b.page;await page.setViewportSize({width,height:width===390?844:900});
  const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  const badge=page.locator('.ao-project__chips .bu-pstatus');
  await page.goto(b.origin+'/projets/'+id,{waitUntil:'domcontentloaded'});
  await badge.getByText('À préparer',{exact:true}).waitFor();
  let capturedChoices=false;
  const shot=async name=>{await mkdir(OUT,{recursive:true});await page.screenshot({path:OUT+`/${width}-${theme}-status-${name}.png`,animations:'disabled'});};
  const choose=async()=>{
   if(width===390){
    const trigger=page.locator('.ao-project-status');assert.match(await trigger.getAttribute('aria-label'),/^À préparer : /);
    await trigger.click();const choices=page.locator('.ao-projects-mobile__destinations button');
    assert.deepEqual(await choices.allTextContents(),['Commencer']);
    if(!capturedChoices){await shot('choices');const box=await page.getByRole('dialog').boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=844,'status sheet is visible and contained');capturedChoices=true;}
    await choices.first().click();
   }else{
    assert.deepEqual(await page.locator('#move-to option[value]:not([value=""])').allTextContents(),['Commencer']);
    assert.deepEqual(await page.locator('#move-to option[value]:not([value=""])').evaluateAll(options=>options.map(option=>option.value)),['todo']);
    if(!capturedChoices){await shot('choices');capturedChoices=true;}await page.locator('#move-to').selectOption('todo');
   }
  };
  const statusResponse=()=>page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname.endsWith('/projects/'+id+'/status'));
  let response=statusResponse();await choose();let moved=await response;assert.equal(moved.status(),200);
  assert.equal(moved.request().postDataJSON().status,'todo');assert.equal((await moved.json()).data.vm.statusLabel.params.label,'Prêt à commencer');
  await page.locator('.bu-toast__text').getByText('Projet déplacé vers Prêt à commencer',{exact:false}).waitFor();
  await badge.getByText('Prêt à commencer',{exact:true}).waitFor();await shot('moved');
  const undo=page.locator('.bu-toast').filter({hasText:'Projet déplacé vers Prêt à commencer'}).getByRole('button',{name:'Annuler',exact:true});
  response=statusResponse();await undo.click();moved=await response;assert.equal(moved.status(),200);assert.equal(moved.request().postDataJSON().status,'idea');
  await page.locator('.bu-toast__text').filter({hasText:'Revenir à la préparation'}).waitFor();await badge.getByText('À préparer',{exact:true}).waitFor();
  // Returned transitions also control whether undo exists: no inferred reverse.
  returnAllowed=false;response=statusResponse();await choose();moved=await response;assert.equal(moved.status(),200);
  const noUndo=page.locator('.bu-toast').filter({hasText:'Projet déplacé vers Prêt à commencer'});await noUndo.waitFor();
  assert.equal(await noUndo.getByRole('button',{name:'Annuler',exact:true}).count(),0);
  available=false;h.api.topics.invalidate();await page.reload({waitUntil:'domcontentloaded'});await badge.getByText('Prêt à commencer',{exact:true}).waitFor();
  assert.equal(await page.locator(width===390?'.ao-project-status':'#move-to').isDisabled(),true);
  if(width!==390)assert.equal(await page.locator('#move-to option[value]:not([value=""])').count(),0);
  assert.deepEqual(await page.evaluate(()=>({height:document.scrollingElement.scrollHeight,viewport:innerHeight})),{height:width===390?844:900,viewport:width===390?844:900});
  await writeFile(OUT+`/${width}-${theme}-status.json`,JSON.stringify({source:process.env.AO_SOURCE_SHA||null,choices:['todo'],labels:['À préparer','Commencer','Prêt à commencer','Revenir à la préparation'],undo:'idea',emptyDisabled:true},null,2)+'\n');
 }catch(error){await b?.page.screenshot({path:OUT+`/${width}-${theme}-status-failed.png`}).catch(()=>{});throw error;}
 finally{if(!b)await h?.close();}
});
