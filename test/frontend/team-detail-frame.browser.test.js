import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{projectTeamFixture}=require('../helpers/project-team-fixture.cjs');
const OUT='design/reports/team-detail-167';
for(const width of [1440,1024,390])for(const theme of ['light','dark'])test(`Team detail horizontal kanban/dialogs ${width} ${theme}`,{skip:browserSkipReason(),timeout:90000},async()=>{
 let b,h;
 try{
  b=await openLayoutBrowser({theme,touch:width===390,apiVersion:width===390?2:3,apiProxy:async publicUrl=>{h=await projectTeamFixture({publicUrl,taskCopies:35});return h.base;}});
  const p=b.page,height=width===390?844:900,errors=[],shots=[];p.on('pageerror',error=>errors.push(error.message));await p.setViewportSize({width,height});
  const split=h.cookie.indexOf('=');await p.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  await p.goto(b.origin+'/projets/'+encodeURIComponent(h.projectId),{waitUntil:'domcontentloaded'});
  const frame=p.locator('.ao-team-project--kanban'),board=frame.locator('.ao-team-kanban');await frame.waitFor();
  await p.waitForFunction(()=>[...document.querySelectorAll('.bu-live')].some(el=>el.textContent==='En direct'));await p.evaluate(()=>document.fonts.ready);
  const header=await frame.locator(':scope > .ao-frame__head').boundingBox();
  const fixed=async()=>{
   assert.deepEqual(await p.evaluate(()=>[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight,scrollY]),[width,height,0]);
   assert.deepEqual(await frame.locator(':scope > .ao-frame__head').boundingBox(),header);
   assert.deepEqual(await frame.locator(':scope > .ao-frame__body').evaluate(el=>[el.scrollTop,el.scrollLeft]),[0,0]);
  };
  const capture=async state=>{await fixed();await mkdir(OUT,{recursive:true});const path=`${OUT}/${width}-${theme}-${state}.png`;await p.screenshot({path,animations:'disabled'});shots.push(path);};
  assert.equal(h.detail.teamProject.taskCount,175);assert.equal(await frame.locator('.ao-team-readonly-banner,.ao-team-overview').count(),0,'notice and summary are compact header metadata');
  assert.deepEqual(await board.locator('[data-task-column]').evaluateAll(cols=>cols.map(col=>({id:col.dataset.taskColumn,count:Number(col.querySelector('.bu-count').textContent),ids:[...col.querySelectorAll('[data-team-task]')].map(row=>row.dataset.teamTask)}))),h.detail.teamProject.columns.map(col=>({id:col.id,count:col.count,ids:col.tasks.map(row=>row.id)})));
  const tops=await board.locator('[data-task-column]').evaluateAll(cols=>cols.map(col=>col.getBoundingClientRect().top));assert.equal(new Set(tops).size,1,'stages are side by side');
  assert.equal(await board.evaluate(el=>el.scrollWidth>el.clientWidth&&el.scrollHeight===el.clientHeight),true,'horizontal rail only');
  if(width===390){
   assert.equal(await board.evaluate(el=>getComputedStyle(el).scrollSnapType),'x mandatory');
   const col=board.locator('[data-task-column]').first();assert.ok(Math.abs((await col.boundingBox()).width-(await board.boundingBox()).width)<1);
   await p.waitForFunction(id=>document.querySelector('.ao-team-kanban')?.dataset.visibleColumn===id,h.detail.teamProject.defaultColumnId);
   const expected=h.detail.teamProject.defaultColumnId,initial=board.locator(`[data-task-column="${expected}"]`);
   assert.ok(Math.abs((await initial.boundingBox()).x-(await board.boundingBox()).x)<2,'phone opens on the supplied default, not an empty first stage');
   const mobileLabel=await p.evaluate(async ref=>{const i18n=await import('/i18n.js?v='+document.querySelector('meta[name=ao-build]').content);return i18n.label(ref);},h.detail.teamProject.mobilePeopleLabel);
   const peopleButton=frame.getByRole('button',{name:mobileLabel,exact:true});assert.equal(await peopleButton.count(),1);
   assert.deepEqual(await frame.locator('[data-stage-choice]').evaluateAll(rows=>rows.map(row=>({id:row.dataset.stageChoice,count:Number(row.parentElement.querySelector('.bu-count').textContent)}))),h.detail.teamProject.columns.map(col=>({id:col.id,count:col.count})));
  }
  await capture('board');
  const working=board.locator('[data-task-column="in-progress"]'),scroll=working.locator('[data-team-column-scroll]');
  if(width===390){await frame.getByTestId('team-stage:in-progress').click();await p.waitForFunction(()=>document.querySelector('.ao-team-kanban')?.dataset.visibleColumn==='in-progress');await p.waitForFunction(()=>{const board=document.querySelector('.ao-team-kanban'),col=board.querySelector('[data-task-column="in-progress"]');return Math.abs(board.getBoundingClientRect().left-col.getBoundingClientRect().left)<2;});}
  else await working.scrollIntoViewIfNeeded();
  const others=async()=>board.locator('[data-team-column-scroll]').evaluateAll(els=>els.filter(el=>el.closest('[data-task-column]').dataset.taskColumn!=='in-progress').map(el=>el.scrollTop));
  const initialOthers=await others();assert.equal(await scroll.evaluate(el=>el.scrollHeight>el.clientHeight),true);await capture('many-tasks');
  await scroll.evaluate(el=>el.scrollTop=el.scrollHeight);assert.deepEqual(await others(),initialOthers);await capture('many-tasks-end');
  const finalTask=h.detail.teamProject.columns.find(col=>col.id==='in-progress').tasks.at(-1).id;
  const lastBox=await working.locator(`[data-team-task="${finalTask}"]`).boundingBox(),scrollBox=await scroll.boundingBox();assert.ok(lastBox.y+lastBox.height<=scrollBox.y+scrollBox.height+1,'last task is reachable without moving the page');
  const accessButton=frame.getByRole('button',{name:'Accès de la source',exact:true}),peopleButton=frame.getByRole('button',{name:/Personnes/});
  const labels=await p.evaluate(async rows=>{const i18n=await import('/i18n.js?v='+document.querySelector('meta[name=ao-build]').content);return rows.map(row=>({id:row.id,label:i18n.label(row.label),value:i18n.label(row.valueLabel)}));},h.detail.capabilityRows);
  const assertRows=async panel=>assert.deepEqual(await panel.locator('[data-capability-row]').evaluateAll(rows=>rows.map(row=>({id:row.dataset.capabilityRow,label:row.querySelector('dt').textContent,value:row.querySelector('dd').textContent}))),labels);
  if(width!==390){
   await accessButton.hover();const preview=p.getByRole('tooltip');await preview.waitFor();await assertRows(preview);const box=await preview.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height);await capture('access-preview');
   await p.mouse.move(2,2);await p.keyboard.press('Escape');await peopleButton.focus();await p.getByRole('tooltip').waitFor();await capture('people-preview');
  }
  await accessButton.click();let modal=p.getByRole('dialog',{name:'Accès de la source',exact:true});await modal.waitFor();await assertRows(modal);await capture('access-dialog');
  const modalBox=await modal.boundingBox();assert.ok(modalBox.x>=0&&modalBox.y>=0&&modalBox.x+modalBox.width<=width&&modalBox.y+modalBox.height<=height);
  await p.keyboard.press('Escape');assert.equal(await p.getByRole('dialog').count(),0);assert.equal(await accessButton.evaluate(el=>document.activeElement===el),true,'dialog restores focus');
  await peopleButton.click();modal=p.getByRole('dialog',{name:'Personnes impliquées',exact:true});await modal.waitFor();
  await p.waitForFunction(()=>document.querySelectorAll('[data-member-id] [data-avatar-ready=true]').length===6);
  await p.waitForFunction(()=>[...document.querySelectorAll('[data-member-id] .ao-brand-mark')].every(el=>el.classList.contains('ao-brand-mark--ready')));
  assert.deepEqual(await modal.locator('[data-member-id]').evaluateAll(rows=>rows.map(row=>({id:row.dataset.memberId,parentId:row.dataset.parentId||null,depth:Number(row.dataset.memberDepth)}))),h.detail.teamProject.roster.members.map(member=>({id:member.id,parentId:member.parentId,depth:member.rosterDepth})));
  await capture('people-dialog');await modal.locator(':scope > .ao-frame__body').evaluate(el=>el.scrollTop=el.scrollHeight);await capture('people-end');
  await p.keyboard.press('Escape');assert.equal(await peopleButton.evaluate(el=>document.activeElement===el),true);await fixed();
  assert.deepEqual(errors,[]);assert.deepEqual(await p.evaluate(()=>window.__AO_VM_ISSUES||[]),[]);
  await writeFile(`${OUT}/${width}-${theme}.json`,JSON.stringify({source:process.env.AO_SOURCE_SHA,taskCount:h.detail.teamProject.taskCount,defaultColumnId:h.detail.teamProject.defaultColumnId,mobilePeopleLabel:h.detail.teamProject.mobilePeopleLabel,columns:h.detail.teamProject.columns.map(col=>({id:col.id,count:col.count})),roster:h.detail.teamProject.roster,capabilityRows:h.detail.capabilityRows,shots},null,2)+'\n');
 }catch(error){await mkdir(OUT,{recursive:true});await b?.page.screenshot({path:`${OUT}/${width}-${theme}-failed.png`}).catch(()=>{});throw error;}finally{await b?.close();await h?.close();}
});
