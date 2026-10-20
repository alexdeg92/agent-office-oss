import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{projectTeamFixture}=require('../helpers/project-team-fixture.cjs');

for(const width of [1440,390])for(const theme of ['light','dark'])test(`Mounted team project tasks, parent rows and portraits ${width} ${theme}`,{skip:browserSkipReason(),timeout:90000},async()=>{
 let b,h;
 try{
  b=await openLayoutBrowser({theme,touch:width===390,apiVersion:width===390?2:3,apiProxy:async publicUrl=>{h=await projectTeamFixture({publicUrl});return h.base;}});
  const {page}=b,errors=[],requests=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>requests.push(new URL(request.url()).pathname));
  const height=width===390?844:900;await page.setViewportSize({width,height});
  const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  await page.goto(b.origin+'/projets/'+encodeURIComponent(h.projectId),{waitUntil:'domcontentloaded'});
  const frame=page.locator('.ao-team-project');await frame.waitFor();
  await page.evaluate(()=>document.fonts.ready);
  assert.deepEqual(await frame.locator('[data-task-column]').evaluateAll(columns=>columns.map(column=>({id:column.dataset.taskColumn,count:Number(column.querySelector('.bu-count').textContent),tasks:[...column.querySelectorAll('[data-team-task]')].map(task=>task.dataset.teamTask)}))),h.detail.teamProject.columns.map(column=>({id:column.id,count:column.count,tasks:column.tasks.map(task=>task.id)})));
  assert.equal(await frame.getByRole('button',{name:'Modifier',exact:true}).count(),0);assert.equal(await frame.locator('select,input,textarea').count(),0,'read-only team detail has no write affordances');
  assert.ok(requests.some(path=>path.endsWith('/api/v3/views/projects/'+h.projectId)),'new detail GET is pinned to v3 even with a v2 shell');
  await page.waitForFunction(()=>[...document.querySelectorAll('.bu-live')].some(el=>el.textContent.includes('En direct')));
  const bounded=async()=>assert.deepEqual(await page.evaluate(()=>[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight,scrollY]),[width,height,0]);
  await bounded();await mkdir('design/reports/project-team-133',{recursive:true});
  const capture=async state=>page.screenshot({path:`design/reports/project-team-133/${width}-${theme}-${state}.png`,animations:'disabled'});
  await capture('tasks');const header=await frame.locator(':scope > .ao-frame__head').boundingBox();
  await frame.getByRole('button',{name:/Personnes/}).click();const people=page.getByRole('dialog',{name:'Personnes impliquées',exact:true});await people.waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('[data-member-id] [data-avatar-ready="true"]').length===6);
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-member-id] .ao-brand-mark')].every(mark=>mark.classList.contains('ao-brand-mark--ready')));
  assert.deepEqual(await people.locator('[data-member-id]').evaluateAll(rows=>rows.map(row=>({id:row.dataset.memberId,parentId:row.dataset.parentId||null,depth:Number(row.dataset.memberDepth),name:row.querySelector('strong').textContent}))),h.detail.teamProject.roster.members.map(member=>({id:member.id,parentId:member.parentId,depth:member.rosterDepth,name:member.identity.name})));
  for(const id of h.memberIds){const avatar=people.locator(`[data-member-id="${id}"] .ao-character-avatar`);assert.equal(await avatar.getAttribute('data-avatar-ready'),'true');assert.ok(await avatar.locator('img').evaluate(img=>img.complete&&img.naturalWidth>0));}
  await capture('people');await people.locator(':scope > .ao-frame__body').evaluate(el=>el.scrollTop=el.scrollHeight);await capture('end');await bounded();
  await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);
  assert.deepEqual(await frame.locator(':scope > .ao-frame__head').boundingBox(),header,'detail header stays anchored while the dialog scrolls');
  h.renameTask('task:atelier-1','Normalisation terminée — mise à jour en direct');
  await frame.locator('[data-team-task="task:atelier-1"]').getByRole('heading',{name:'Normalisation terminée — mise à jour en direct',exact:true}).waitFor({state:'attached'});
  const updatedBoard=await h.get('/api/v3/views/projects');
  assert.equal(updatedBoard.status,200,updatedBoard.text);
  const updatedCard=updatedBoard.json.data.columns.flatMap(column=>column.cards).find(card=>card.id===h.projectId);
  assert.ok(updatedCard,'team remains in the healthy board after a source update');
  assert.equal(updatedCard.teamProject.taskCount,h.detail.teamProject.taskCount);
  const updatedDetail=await h.get('/api/v3/views/projects/'+encodeURIComponent(h.projectId));
  assert.equal(updatedDetail.status,200,updatedDetail.text);
  assert.equal(updatedDetail.json.data.teamProject.columns.flatMap(column=>column.tasks).find(task=>task.id==='task:atelier-1').title,'Normalisation terminée — mise à jour en direct');
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
  h.renameTask('task:atelier-1','Reprise après restauration de la page');
  const resumedDetail=await h.get('/api/v3/views/projects/'+encodeURIComponent(h.projectId));
  assert.equal(resumedDetail.status,200,resumedDetail.text);
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await frame.locator('[data-team-task="task:atelier-1"]').getByRole('heading',{name:'Reprise après restauration de la page',exact:true}).waitFor({state:'attached'});
  assert.ok(requests.some(path=>path.endsWith('/api/v3/stream')),'project stream is pinned to v3');
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.__AO_VM_ISSUES||[]),[]);
 }finally{await b?.close();await h?.close();}
});
