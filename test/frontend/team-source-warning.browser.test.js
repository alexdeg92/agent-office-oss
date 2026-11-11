import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{projectTeamFixture}=require('../helpers/project-team-fixture.cjs');
const OUT='design/reports/t0255-floor-groups';

for(const width of [1440,390])for(const sourceState of ['failed','stale','cached-failed'])test(`Bureau preserves ${sourceState} team-source status on group-free floor ${width}`,{skip:browserSkipReason(),timeout:120000},async()=>{
 let h,b;
 try{
  b=await openLayoutBrowser({theme:'dark',touch:width===390,apiVersion:3,apiProxy:async publicUrl=>{
   h=await projectTeamFixture({publicUrl,theme:'night',twoTeams:true,memberCount:5,memberNames:['Atlas','Domaine worker','VCE worker','Review agent','Unassigned worker'],primaryFloorId:'3'});return h.base;
  }});
  const {page}=b;await page.setViewportSize({width,height:width===390?844:900});
  const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  const office=(await h.get('/api/v3/views/office')).json.data;
  const floor=office.rosterFloors.find(row=>row.id==='3');assert.ok(floor,'fixture has floor 3');
  assert.equal(floor.showTeamPanel,false,'floor 3 has no team membership panel');
  let failRefresh=false,resolveInitialTeams;
  const initialTeams=sourceState==='cached-failed'?new Promise(resolve=>{resolveInitialTeams=resolve;}):null;
  if(sourceState==='failed')await page.route('**/backend/api/v3/teams*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'upstream_unavailable',message:'synthetic source outage'}})}));
  else if(sourceState==='cached-failed')await page.route('**/backend/api/v3/teams*',async route=>{
   if(failRefresh)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'upstream_unavailable',message:'synthetic refresh outage'}})});
   const response=await route.fetch();resolveInitialTeams();return route.fulfill({response});
  });
  else await page.route('**/backend/api/v3/teams*',async route=>{
   const response=await route.fetch(),body=await response.json();
   body.data.team.status='stale';
   await route.fulfill({response,json:body});
  });
  const url=new URL('/bureau',b.origin);url.searchParams.set('etage','3');
  const streamRequest=sourceState==='cached-failed'?page.waitForRequest(request=>request.url().includes('/api/v3/stream')):null;
  await page.goto(url.href,{waitUntil:'domcontentloaded'});await page.locator('.ao-bureau--ready').waitFor({state:'visible'});
  if(sourceState==='cached-failed'){
   await initialTeams;await streamRequest;
   failRefresh=true;
   const current=h.source.getSnapshot();h.setSnapshot({...current,revision:current.revision+1,observedAt:Date.now()});
  }
  const expected=sourceState==='failed'?'Impossible d’actualiser l’équipe':sourceState==='stale'?'Équipe · En retard':'La connexion est interrompue';
  const warning=page.getByRole('status').filter({hasText:expected});
  await warning.waitFor({state:'visible'});
  assert.match(await warning.innerText(),new RegExp(expected),'source health warning remains explicit on a floor with no team groups');
  const margins=await warning.evaluate(node=>({start:getComputedStyle(node).marginInlineStart,end:getComputedStyle(node).marginInlineEnd}));
  assert.deepEqual(margins,{start:'0px',end:'0px'},`source warning aligns with the team rail: ${JSON.stringify(margins)}`);
  await warning.scrollIntoViewIfNeeded();
  assert.equal(await page.locator('[data-testid="team-panel-members"], [data-testid="team-panel-board"]').count(),0,
    'only source health status remains; healthy global team contents stay hidden');
  await mkdir(OUT,{recursive:true});await page.screenshot({path:`${OUT}/${width}-dark-floor-3-source-${sourceState}.png`,animations:'disabled'});
  assert.deepEqual(await page.evaluate(()=>[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight]),
    [width,width===390?844:900],'the warning does not create viewport overflow');
 }finally{await b?.close();await h?.close();}
});
