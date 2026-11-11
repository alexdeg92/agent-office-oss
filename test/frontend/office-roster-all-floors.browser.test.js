import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url);
const {projectTeamFixture}=require('../helpers/project-team-fixture.cjs');
const shots=join(process.env.AO_TEST_SHOTS_DIR||tmpdir(),'office-roster-all-floors');

// Owner contract: "Teams and agents" lists every team (whole) and every unteamed agent whatever floor is selected,
// the selected floor's teams first; the map and floor counts stay per floor.
for(const width of [1440,390])for(const theme of ['light','dark'])test(`Office roster lists every team from floor 2 ${width} ${theme}`,{skip:browserSkipReason(),timeout:120000},async()=>{
 let h,b;
 try{
  b=await openLayoutBrowser({theme,touch:width===390,apiVersion:width===390?2:3,apiProxy:async publicUrl=>{
   h=await projectTeamFixture({publicUrl,theme:theme==='dark'?'night':'day',twoTeams:true,separateLeads:true,memberCount:5,
    memberNames:['Atlas','Domaine worker','VCE worker','Review agent','Review worker'],primaryFloorId:'3',memberFloorIds:{4:'2'}});return h.base;
  }});
  const {page}=b;await page.setViewportSize({width,height:width===390?844:900});
  const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  const office=(await h.get('/api/v3/views/office')).json.data;
  const floor=office.rosterFloors.find(row=>row.id==='2');
  const teams=floor.agentGroups.filter(group=>group.kind==='team');
  assert.deepEqual(teams.map(group=>group.label.params?.text),['Synchronisation des espaces','Domaine Kildare'],'both teams on floor 2, its own first');
  assert.deepEqual(floor.teamGroups.map(group=>group.id),[teams[0].id],'the map team panel of floor 2 holds only its own team');
  const url=new URL('/bureau',b.origin);url.searchParams.set('etage','2');
  await page.goto(url.href,{waitUntil:'domcontentloaded'});await page.locator('.ao-bureau__stage').waitFor({state:'visible'});
  const selector=width===390?'.ao-mobile-team-preview[data-floor-agent-group]':'[data-roster-floor="2"] .ao-floor-roster__agent-group[data-floor-agent-group]';
  await page.locator(selector).first().waitFor({state:'visible'});
  assert.deepEqual(await page.locator(selector).evaluateAll(nodes=>nodes.map(node=>node.dataset.floorAgentGroup)),floor.agentGroups.map(group=>group.id),
   'every team and the no-team group render in the VM order for floor 2');
  if(width!==390)assert.equal(await page.locator('.ao-floor-roster__agent-group').count(),floor.agentGroups.length,'the roster is rendered once');
  const other=page.locator(`${selector}[data-floor-agent-group="${teams[1].id}"] [data-floor-agent-group-floors]`);
  assert.equal(await other.innerText(),'Étage 1','the team seated elsewhere names its floor');
  assert.equal(await page.locator(`${selector}[data-floor-agent-group="${teams[0].id}"] [data-floor-agent-group-floors]`).count(),0,'a team on the selected floor does not repeat it');
  if(width!==390){
   const primary=office.occupants.find(row=>row.role==='primary');
   assert.equal(await page.locator(`[data-member-floor="${primary.id}"]`).innerText(),'Étage 3','an unteamed agent on another floor shows its floor');
  }
  assert.equal(await page.locator('[data-team-pod-zone]').count(),1,'the map draws only the pod of the team seated on floor 2');
  await page.evaluate(async()=>{await document.fonts.ready;});
  await mkdir(shots,{recursive:true});
  await page.screenshot({path:join(shots,`roster-floor2-${width}-${theme}.png`),fullPage:false,animations:'disabled'});
 }finally{await b?.close();await h?.close();}
});
