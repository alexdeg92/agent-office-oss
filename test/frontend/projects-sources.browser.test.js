import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{projectTeamFixture}=require('../helpers/project-team-fixture.cjs');
const OUT='design/reports/project-sources-133';
const projection=vm=>vm.columns.map(column=>({id:column.id,label:column.label,count:column.count,cards:column.cards.map(card=>card.id)}));
async function board(h,query='') {const response=await h.get('/api/v3/views/projects'+query);assert.equal(response.status,200,response.text);return response.json.data;}
async function assertBoard(p,vm) {
  await p.waitForFunction(expected=>{
    const columns=[...document.querySelectorAll('[data-column]')];
    return document.querySelector('#project-stage')?.value===expected.stage &&
      document.querySelector('[data-project-source][aria-pressed=true]')?.dataset.projectSource===(expected.source||'all') &&
      columns.length===expected.columns.length && expected.columns.every((column,index)=>columns[index].dataset.column===column.id &&
      Number(columns[index].querySelector('[data-column-count]').dataset.columnCount)===column.count &&
      JSON.stringify([...columns[index].querySelectorAll('[data-card]')].map(card=>card.dataset.card))===JSON.stringify(column.cards));
  },{columns:projection(vm),stage:vm.controls.stage.selected,source:vm.sourceFilterId});
  for(const column of vm.columns)assert.equal(await p.locator(`[data-column="${column.id}"] h3`).textContent(),await p.evaluate(async label=>{
    const i18n=await import('/i18n.js?v='+document.querySelector('meta[name=ao-build]').content);return i18n.label(label);
  },column.label));
}
async function capture(p,name) {
  await p.waitForFunction(()=>[...document.querySelectorAll('.bu-live')].some(el=>el.textContent==='En direct'));
  await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelectorAll('.ao-brand-mark img,.ao-character-avatar img')].map(img=>img.decode()));});
  await mkdir(OUT,{recursive:true});const file=OUT+'/'+name+'.png';await p.screenshot({path:file,animations:'disabled'});return file;
}
for(const width of [1440,390])for(const theme of ['light','dark'])test(`Projects server controls and canonical portraits ${width} ${theme}`,{skip:browserSkipReason(),timeout:120000},async()=>{
 let h,b;
 try{
  b=await openLayoutBrowser({theme,touch:width===390,apiVersion:width===390?2:3,apiProxy:async publicUrl=>{h=await projectTeamFixture({publicUrl,theme:theme==='light'?'day':'night'});return h.base;}});
  const p=b.page,errors=[],requests=[],shots=[];let browserDetail=null;p.on('pageerror',error=>errors.push(error.message));p.on('request',request=>requests.push(new URL(request.url()).pathname));
  p.on('response',async response=>{try{const path=new URL(response.url()).pathname;if(path.includes('/api/v3/views/projects/')&&path.endsWith(encodeURIComponent(h.projectId)))browserDetail=(await response.json()).data;}catch{}});
  const height=width===390?844:900;await p.setViewportSize({width,height});
  const split=h.cookie.indexOf('=');await p.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  const created=await h.post('/api/v3/projects',{name:'Revue des accès',status:'todo',priority:'P1',summary:'Rassembler les décisions de l’équipe.'});assert.equal(created.status,200,created.text);
  const ordinary=created.json.data.vm;
  await p.goto(b.origin+'/projets',{waitUntil:'domcontentloaded'});const initial=await board(h);await assertBoard(p,initial);
  assert.equal(await p.locator('html').getAttribute('data-theme'),theme);
  const bounded=async()=>assert.deepEqual(await p.evaluate(()=>[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight,scrollY]),[width,height,0]);await bounded();
  assert.deepEqual(await p.locator('[data-project-source]:not([data-project-source="all"])').evaluateAll(buttons=>buttons.map(button=>({id:button.dataset.projectSource,count:Number(button.querySelector('.bu-count').textContent),selected:button.getAttribute('aria-pressed')==='true'}))),initial.sourceFilters.map(source=>({id:source.id,count:source.count,selected:source.selected})));
  const suppliedLabels=await p.evaluate(async labels=>{
    const i18n=await import('/i18n.js?v='+document.querySelector('meta[name=ao-build]').content);return labels.map(i18n.label);
  },initial.controls.stage.options.map(option=>option.label));
  assert.deepEqual(await p.locator('#project-stage option').allTextContents(),suppliedLabels,'stage options display supplied labels without duplicate count suffixes');
  const teamCard=p.locator(`[data-card="${h.projectId}"]`),sourceLabel=await p.evaluate(async ref=>{
    const i18n=await import('/i18n.js?v='+document.querySelector('meta[name=ao-build]').content);return i18n.label(ref);
  },h.detail.sourceDescriptors[0].label);
  assert.equal(await teamCard.locator('.ao-project-sources li').textContent(),sourceLabel,'the distinct adapter-declared source label renders unchanged');
  assert.notEqual(sourceLabel,h.detail.name,'source identity and project title stay separate');
  shots.push(await capture(p,`${width}-${theme}-board`));
  const trigger=p.getByTestId('project-move:'+ordinary.id).getByRole('button');
  assert.equal(await trigger.textContent(),'Déplacer');await trigger.click();
  const menu=p.getByRole('menu');await menu.waitFor();
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(),await p.evaluate(async labels=>{
    const i18n=await import('/i18n.js?v='+document.querySelector('meta[name=ao-build]').content);return labels.map(i18n.label);
  },initial.columns.map(column=>column.label)));
  const menuBox=await menu.boundingBox();assert.ok(menuBox.x>=0&&menuBox.y>=0&&menuBox.x+menuBox.width<=width&&menuBox.y+menuBox.height<=height,'move menu is fully contained at desktop and phone');
  shots.push(await capture(p,`${width}-${theme}-board-move`));await p.keyboard.press('Escape');assert.equal(await menu.count(),0);await bounded();
  const selected=initial.sourceFilters.find(source=>source.source.runtime==='codex');assert.ok(selected,'registered adapter-contributed source');
  await p.locator(`[data-project-source="${selected.id}"]`).click();const filtered=await board(h,'?source='+encodeURIComponent(selected.id));await assertBoard(p,filtered);
  assert.equal(await p.locator(`[data-project-source="${selected.id}"]`).getAttribute('aria-pressed'),'true');shots.push(await capture(p,`${width}-${theme}-source`));
  await p.locator('[data-project-source="all"]').click();await assertBoard(p,initial);
  await p.locator('.ao-projects-server input[type=search]').fill('Guide');
  const searched=await board(h,'?search=Guide');await assertBoard(p,searched);
  assert.equal(await p.locator('.ao-projects-server input[type=search]').evaluate(el=>document.activeElement===el),true,'search stays focused through the server query refresh');
  const stage=searched.controls.stage.options.find(option=>option.id==='in-progress');
  await p.locator('#project-stage').selectOption(stage.id);const staged=await board(h,'?search=Guide&stage='+stage.id);await assertBoard(p,staged);
  assert.equal(await p.locator('#project-stage').inputValue(),staged.controls.stage.selected);shots.push(await capture(p,`${width}-${theme}-search-stage`));await bounded();
  await p.goto(b.origin+'/projets/'+encodeURIComponent(h.projectId),{waitUntil:'domcontentloaded'});const team=p.locator('.ao-team-project');await team.waitFor();assert.deepEqual(h.detail.statusTransitions,[],'team stages supply no writable detail transitions');
  await p.waitForFunction(()=>document.querySelector('.ao-team-project'));
  for(let attempt=0;attempt<20&&!browserDetail;attempt++)await new Promise(resolve=>setTimeout(resolve,25));
  assert.ok(browserDetail,'browser receives its ProjectVM detail');
  shots.push(await capture(p,`${width}-${theme}-team-tasks`));
  await team.getByRole('button',{name:/Personnes/}).click();const people=p.getByRole('dialog',{name:'Personnes impliquées',exact:true});await people.waitFor();
  const memberRows=(width===390?h.detailV2:h.detail).teamProject.roster.members;
  assert.deepEqual(browserDetail.teamProject.roster.members.map(member=>member.portrait.look),h.detail.teamProject.roster.members.map(member=>member.portrait.look),'browser consumes the same authoritative v3 roster as the mounted API');
  const expectedMembers=h.expectedLooksByVersion[width===390?2:3];
  await p.waitForFunction(expected=>document.querySelectorAll('[data-member-id] [data-avatar-ready=true]').length===expected,memberRows.length);
  assert.deepEqual(memberRows.map(member=>member.portrait.look),expectedMembers,'exact stored Office descriptors resolve through backend member/session links');
  const portraitKeys=memberRows.map(member=>JSON.stringify(member.portrait.look));
  assert.equal(new Set(portraitKeys).size,portraitKeys.length,`every synthetic team member has a distinct Bureau character: ${JSON.stringify(memberRows.map(member=>({id:member.id,name:member.identity.name,look:member.portrait.look})))}`);
  assert.ok(memberRows.every(member=>member.portrait.look.character!=='timmy'),'no team member inherits the main agent character');
  const portraitSources=await people.locator('[data-member-id] .ao-character-avatar img').evaluateAll(images=>images.map(image=>image.currentSrc));
  assert.equal(portraitSources.length,memberRows.length,'every roster member renders its supplied Bureau portrait');
  assert.equal(new Set(portraitSources).size,portraitSources.length,`no two members render the same portrait asset: ${JSON.stringify({sources:portraitSources,looks:memberRows.map(member=>({id:member.id,name:member.identity.name,look:member.portrait.look})),expected:expectedMembers})}`);
  for(const member of memberRows){
    if(['pm','designer'].includes(member.identity.name))assert.equal(member.roleLabel,null,`${member.identity.name} role label is omitted when it repeats the name`);
    if(member.roleLabel)assert.notEqual(member.roleLabel.trim().toLocaleLowerCase('en'),member.identity.name.trim().toLocaleLowerCase('en'));
    const row=people.locator(`[data-member-id="${member.id}"]`),role=row.locator('.ao-project-member__role');
    if(['pm','designer'].includes(member.identity.name))assert.equal(await role.count(),0,`${member.identity.name} has no duplicate role line on the rendered People sheet`);
    else if(member.roleLabel)assert.notEqual((await role.innerText()).trim().toLocaleLowerCase('en'),member.identity.name.trim().toLocaleLowerCase('en'));
  }
  assert.deepEqual(await people.locator('[data-member-id]').evaluateAll(rows=>rows.map(row=>({id:row.dataset.memberId,parentId:row.dataset.parentId||null,depth:Number(row.dataset.memberDepth)}))),memberRows.map(member=>({id:member.id,parentId:member.parentId,depth:member.rosterDepth})));
  shots.push(await capture(p,`${width}-${theme}-team-people`));await bounded();
  if(width===390){
    const sheetBody=people.locator(':scope > .ao-frame__body');
    await sheetBody.evaluate(el=>el.scrollTop=el.scrollHeight);
    const bounds=await sheetBody.evaluate(el=>{
      const rows=el.querySelectorAll('[data-member-id]'),row=rows[rows.length-1],rowRect=row.getBoundingClientRect(),bodyRect=el.getBoundingClientRect();
      return {scrollTop:el.scrollTop,maxScroll:el.scrollHeight-el.clientHeight,paddingBottom:parseFloat(getComputedStyle(el).paddingBottom),rowBottom:rowRect.bottom,bodyBottom:bodyRect.bottom};
    });
    assert.ok(bounds.paddingBottom>0,'the scroll body reserves bottom inset/padding');
    assert.ok(bounds.rowBottom<=bounds.bodyBottom-bounds.paddingBottom+1,`last member is fully reachable above bottom padding: ${JSON.stringify(bounds)}`);
    shots.push(await capture(p,`${width}-${theme}-team-people-bottom`));await bounded();
  }
  await people.locator(':scope > .ao-frame__body').evaluate(el=>el.scrollTop=el.scrollHeight);
  shots.push(await capture(p,`${width}-${theme}-team-hierarchy`));await bounded();await p.keyboard.press('Escape');
  const runtimeCard=initial.columns.flatMap(column=>column.cards).find(card=>card.sourceDescriptors.some(source=>source.runtime==='claude-code'));assert.ok(runtimeCard);
  const detail=await h.get('/api/v3/views/projects/'+runtimeCard.id);assert.equal(detail.status,200,detail.text);
  await p.goto(b.origin+'/projets/'+runtimeCard.id,{waitUntil:'domcontentloaded'});const runtime=p.locator('.ao-source-project');await runtime.waitFor();
  assert.equal(await runtime.locator('input,select,textarea').count(),0);assert.equal(await runtime.getByRole('button',{name:'Modifier',exact:true}).count(),0);
  for(const [key,value] of Object.entries(detail.json.data.counts))assert.equal(await runtime.locator(`[data-project-count="${key}"]`).textContent(),String(value??'—'));
  shots.push(await capture(p,`${width}-${theme}-connector-detail`));await bounded();
  await p.goto(b.origin+'/projets/'+ordinary.id,{waitUntil:'domcontentloaded'});await p.getByRole('heading',{name:ordinary.name,exact:true}).waitFor();shots.push(await capture(p,`${width}-${theme}-project-detail`));await bounded();
  assert.ok(requests.includes('/backend/api/v3/views/projects')||requests.includes('/api/v3/views/projects'),'board pins v3 even under v2 shell');assert.deepEqual(errors,[]);
  await writeFile(OUT+`/${width}-${theme}.json`,JSON.stringify({source:process.env.AO_SOURCE_SHA||null,initial:projection(initial),filtered:projection(filtered),searched:projection(searched),staged:projection(staged),looks:h.expectedLooks,shots},null,2)+'\n');
 }catch(error){await mkdir(OUT,{recursive:true});await b?.page.screenshot({path:OUT+`/${width}-${theme}-failed.png`}).catch(()=>{});throw error;}finally{await b?.close();await h?.close();}
});

for(const theme of ['light','dark'])test(`People sheet reaches the end of a 15-member roster 390 ${theme}`,{skip:browserSkipReason(),timeout:120000},async t=>{
 let h,b;
 try{
  b=await openLayoutBrowser({theme,touch:true,apiVersion:2,apiProxy:async publicUrl=>{h=await projectTeamFixture({publicUrl,theme:theme==='light'?'day':'night',memberCount:15,exactLooks:false});return h.base;}});
  const p=b.page;await p.setViewportSize({width:390,height:844});
  const split=h.cookie.indexOf('=');await p.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  await p.goto(b.origin+'/projets/'+encodeURIComponent(h.projectId),{waitUntil:'domcontentloaded'});
  const team=p.locator('.ao-team-project');await team.waitFor();
  await team.getByRole('button',{name:/Personnes/}).click();
  const people=p.getByRole('dialog',{name:'Personnes impliquées',exact:true});await people.waitFor();
  assert.equal(await people.locator('[data-member-id]').count(),15,'overflow fixture renders all fifteen backend-provided members');
  const sheetBody=people.locator(':scope > .ao-frame__body');
  await sheetBody.evaluate(el=>el.scrollTop=0);
  const maxScroll=await sheetBody.evaluate(el=>el.scrollHeight-el.clientHeight);
  assert.ok(maxScroll>0,`fifteen members create a real scroll range (maxScroll=${maxScroll})`);
  await sheetBody.evaluate(el=>el.scrollTop=el.scrollHeight);
  const bounds=await sheetBody.evaluate(el=>{
    const rows=el.querySelectorAll('[data-member-id]'),row=rows[rows.length-1],rowRect=row.getBoundingClientRect(),bodyRect=el.getBoundingClientRect();
    return {scrollTop:el.scrollTop,maxScroll:el.scrollHeight-el.clientHeight,paddingBottom:parseFloat(getComputedStyle(el).paddingBottom),rowBottom:rowRect.bottom,bodyBottom:bodyRect.bottom};
  });
  assert.ok(bounds.scrollTop>=bounds.maxScroll-1,'the overflow roster scrolls to its end');
  assert.ok(bounds.paddingBottom>0,'the scroll body reserves bottom inset/padding');
  assert.ok(bounds.rowBottom<=bounds.bodyBottom-bounds.paddingBottom+1,`the last of fifteen members is reachable above bottom padding: ${JSON.stringify(bounds)}`);
 }finally{await b?.close();await h?.close();}
});
