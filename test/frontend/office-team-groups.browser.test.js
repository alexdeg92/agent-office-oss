import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{projectTeamFixture}=require('../helpers/project-team-fixture.cjs');
const {officeSceneFixture}=require('../helpers/office-scene-fixture.cjs');
const OUT='design/reports/t0255-floor-groups';
const waitForTeamEndpoints=(page,width)=>width===390?[]:['/backend/api/v3/teams','/backend/api/v3/orchestrators'].map(path=>page.waitForResponse(response=>new URL(response.url()).pathname===path));

for(const width of [1440,390])for(const theme of ['light','dark'])test(`Bureau renders backend team groups ${width} ${theme}`,{skip:browserSkipReason(),timeout:120000},async()=>{
 let h,b;
 try{
  b=await openLayoutBrowser({theme,touch:width===390,apiVersion:width===390?2:3,apiProxy:async publicUrl=>{
   h=await projectTeamFixture({publicUrl,theme:theme==='light'?'day':'night',twoTeams:true,memberCount:5,memberNames:['Mira','Scribe','Nox','Beacon','Lumen']});return h.base;
  }});
  const {page}=b,errors=[],badResponses=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&!message.text().startsWith('Failed to load resource:'))errors.push(message.text());});page.on('response',response=>{if(response.status()>=400)badResponses.push({status:response.status(),url:new URL(response.url()).pathname});});
  await page.setViewportSize({width,height:width===390?844:900});
  const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  const office=(await h.get('/api/v3/views/office')).json.data;
  assert.ok(Array.isArray(office.teamGroups)&&office.teamGroups.length,'fixture supplies canonical server team groups');
  assert.equal(office.teamGroups.length,2,'the visual fixture contains the two approved project teams');
  const group=office.teamGroups[0],floor=office.rosterFloors.find(row=>row.id===group.floorId);
  assert.ok(office.teamGroups.every(row=>row.members.length===3),'both server groups render three membership rows');
  assert.ok(office.teamGroups.some(row=>row.sharedLeadLinks?.length),'the backend fixture projects the shared lead connector');
  assert.equal(new Set(office.teamGroups.map(row=>row.leadOccupantId)).size,1,'both teams point to the same canonical shared lead occupant');
  const sharedLeadId=office.teamGroups[0].leadOccupantId;
  const homeGroup=office.teamGroups.find(row=>row.sharedLeadLinks?.length);
  assert.ok(homeGroup.pod.seats.some(row=>row.occupantId===sharedLeadId),'the backend-selected home pod owns the shared lead seat');
  for(const row of office.teamGroups){
   const members=new Set(row.members.map(member=>member.occupantId)),seats=row.pod.seats.map(seat=>seat.occupantId);
   assert.ok(seats.every(id=>members.has(id)),`the ${row.id} floor zone is built only from its backend member seats: ${JSON.stringify(seats)}`);
   if(row.id!==homeGroup.id)assert.equal(seats.includes(sharedLeadId),false,`the non-home ${row.id} zone does not duplicate the shared lead seat`);
  }
  assert.ok(floor,'team group references a backend-provided roster floor');
  assert.ok(floor.items.some(row=>row.kind==='occupant'),'ordinary occupant roster remains present beside the additive team groups');
  assert.equal(floor.items.some(row=>row.kind==='team-group'),false,'team groups are not injected into the canonical floor roster');
  assert.ok(floor.agentGroups.some(row=>row.id===group.id&&row.kind==='team'),'the selected floor supplies its team group directly');
  assert.ok(floor.agentGroups.every(row=>row.occupantIds.every(id=>floor.occupantIds.includes(id))),'the floor VM never references agents seated elsewhere');
  const legacyOffice=await h.get('/api/v2/views/office');
  assert.equal(legacyOffice.status,200,`v2 Office projection is healthy: ${legacyOffice.text.slice(0,2400)}`);
  const layoutResponse=await h.get('/api/v2/office/layout');
  assert.equal(layoutResponse.status,200,`v2 Office layout endpoint is healthy: ${layoutResponse.text.slice(0,2400)}`);
  const url=new URL('/bureau',b.origin);url.searchParams.set('agent','Atlas');url.searchParams.set('etage',group.floorId);
  const sourceResponses=waitForTeamEndpoints(page,width);
  await page.goto(url.href,{waitUntil:'domcontentloaded'});
  await page.locator('.ao-bureau__stage').waitFor({state:'visible'});
  assert.ok(office.teamGroups.every(row=>['violet','teal','amber','rose','sky','lime'].includes(row.accentToken)),`team accents use the backend palette: ${JSON.stringify(office.teamGroups.map(row=>[row.id,row.accentToken]))}`);
  assert.equal(new Set(office.teamGroups.map(row=>row.accentToken)).size,office.teamGroups.length,'team accents are distinct when the palette has capacity');
  assert.deepEqual(errors,[],'Bureau modules load before team UI is measured');
  try{await page.waitForFunction(()=>document.querySelector('.ao-bureau__side .ao-bureau__roster')||document.querySelector('.ao-mobile-roster'));}catch{
   const debug=await page.evaluate(()=>({url:location.href,bodyText:document.body.innerText.slice(-1000),bureau:document.querySelector('.ao-bureau')?.outerHTML.slice(0,4000),classes:[...document.querySelectorAll('.ao-bureau *')].map(node=>String(node.className?.baseVal??node.className??'')).filter(Boolean).slice(-80)}));
   assert.fail(`roster did not render; browser errors=${JSON.stringify(errors)}; bad responses=${JSON.stringify(badResponses)}; page=${JSON.stringify(debug)}`);
  }
  await Promise.all(sourceResponses);
  const browserOffice=await page.evaluate(async()=>{
   const response=await fetch('/backend/api/v2/views/office',{credentials:'same-origin'});
   return {status:response.status,body:await response.json()};
  });
  assert.deepEqual(browserOffice.body?.data?.teamGroups?.map(row=>row.id),office.teamGroups.map(row=>row.id),`mounted v2 OfficeVM matches the server fixture: ${JSON.stringify({status:browserOffice.status,apiError:browserOffice.body?.error,groups:browserOffice.body?.data?.teamGroups?.map(row=>row.id),expected:office.teamGroups.map(row=>row.id)})}`);
  const mountedFloor=browserOffice.body.data.rosterFloors.find(row=>row.id===group.floorId);
  assert.ok(mountedFloor?.items.some(row=>row.kind==='occupant'),`mounted v2 keeps ordinary floor roster entries: ${JSON.stringify(mountedFloor?.items)}`);
  assert.equal(mountedFloor.items.some(row=>row.kind==='team-group'),false,'mounted v2 keeps teamGroups additive instead of rewriting floor items');
  await page.locator(`[data-floor-agent-group="${group.id}"]`).first().waitFor({state:'visible'});
  await page.evaluate(async()=>{
   await document.fonts.ready;
   await Promise.all([...document.querySelectorAll('.ao-character-avatar img,.ao-brand-mark img')].map(image=>image.decode().catch(()=>{})));
  });
  await mkdir(OUT,{recursive:true});
  await page.screenshot({path:`${OUT}/${width}-${theme}-team-groups.png`,animations:'disabled'});
  assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
  const expectedIds=group.members.map(member=>member.occupantId).filter(id=>office.occupants.some(occupant=>occupant.id===id));
  const renderedGroup=page.locator(`[data-floor-agent-group="${group.id}"]`).first();
  assert.ok((await renderedGroup.innerText()).includes(office.teamGroups.find(row=>row.id===group.id).label.params.text),
    'the floor group heading renders its backend team LabelRef');
  if(width===1440){
   const renderedIds=await renderedGroup.locator('[data-occupant]').evaluateAll(rows=>rows.map(row=>row.dataset.occupant));
   assert.deepEqual(renderedIds,expectedIds,'desktop floor roster renders the server-provided member order');
  }else{
   const renderedIds=await renderedGroup.locator('[data-floor-agent-occupant]').evaluateAll(rows=>rows.map(row=>row.dataset.floorAgentOccupant));
   assert.deepEqual(renderedIds,expectedIds.slice(0,2),'mobile preview renders the first server-ordered floor members');
  }
  assert.deepEqual(await page.evaluate(()=>[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight]),[width,width===390?844:900],'the app shell stays within the fixed viewport');

  const stage=page.locator('.ao-bureau__stage'),stageBox=await stage.boundingBox();
  const expectedLegend=office.teamLegend;
  assert.ok(Array.isArray(expectedLegend),'OfficeVM supplies the team legend');
  assert.deepEqual(expectedLegend.map(row=>[row.teamId,row.accentToken]),office.teamGroups.map(row=>[row.id,row.accentToken]),'legend order and accents come directly from teamGroups in the VM');
  const legend=page.locator('.ao-team-legend'),legendItems=legend.locator('[data-team-legend]');
  await legend.waitFor({state:'visible'});
  const renderedLegend=await legendItems.evaluateAll(nodes=>nodes.map(node=>[node.dataset.teamLegend,node.dataset.teamAccent,node.textContent.trim()]));
  assert.deepEqual(renderedLegend.map(([id,accent])=>[id,accent]),expectedLegend.map(row=>[row.teamId,row.accentToken]),'legend chip count, order and accents match the backend VM');
  assert.ok(renderedLegend.every(([, ,text])=>text.length>0&&!/^(?:label\.)?team\./i.test(text)),'legend labels render as readable localized text');
  const legendBox=await legend.boundingBox();
  assert.ok(legendBox.y>=stageBox.y+stageBox.height-1,'legend sits in card chrome below the room and never overlays the art');
  assert.ok(legendBox.x>=0&&legendBox.x+legendBox.width<=width,'legend stays within the viewport');
  const expectedZones=office.teamGroups.filter(row=>row.floorId===group.floorId&&row.pod?.zone?.polygon?.length>=3).length;
  assert.ok(expectedZones>0,'the fixture includes projected team pod zones');
  assert.equal(await page.locator('.ao-team-pod-zone').count(),expectedZones,'colored pod zones use server-provided floor polygons');
  const expectedLinks=office.teamGroups.flatMap(row=>(row.sharedLeadLinks||[]).map(link=>({groupId:row.id,link}))).filter(row=>row.link.fromPoint&&row.link.toPoint);
  assert.ok(expectedLinks.length>0,'the backend supplies shared-lead connector endpoints');
  assert.equal(await page.locator('.ao-team-links line[data-shared-lead]').count(),expectedLinks.length,'shared-lead dashed links use server-provided zone endpoints');
  assert.deepEqual(await page.locator('.ao-team-links line[data-shared-lead]').evaluateAll(nodes=>nodes.map(node=>node.dataset.sharedLead)),expectedLinks.map(row=>`${row.groupId}:${row.link.teamId}`),'shared-lead line identity comes from the VM');
  assert.equal(await page.locator('.ao-team-links').evaluate(node=>node.querySelectorAll('line').length>0),expectedLinks.length>0,'shared-lead connector visibility follows the backend link geometry');
  const expectedEndpointTeams=expectedLinks.flatMap(({groupId,link})=>[
   [`${groupId}:${link.teamId}:from`,groupId], [`${groupId}:${link.teamId}:to`,link.teamId],
  ]).sort(([a],[b])=>a.localeCompare(b));
  const renderedEndpointTeams=await page.locator('.ao-team-links circle[data-shared-lead-endpoint]').evaluateAll(nodes=>nodes.map(node=>[node.dataset.sharedLeadEndpoint,node.dataset.teamGroup]).sort(([a],[b])=>a.localeCompare(b)));
  assert.deepEqual(renderedEndpointTeams,expectedEndpointTeams,'each connector endpoint is associated with its backend source or destination team');
  const endpointAlignment=await page.locator('.ao-team-links line[data-shared-lead]').evaluateAll(lines=>lines.map(line=>{
   const id=line.dataset.sharedLead,markers=[...line.ownerSVGElement.querySelectorAll('circle[data-shared-lead-endpoint]')],from=markers.find(node=>node.dataset.sharedLeadEndpoint===`${id}:from`),to=markers.find(node=>node.dataset.sharedLeadEndpoint===`${id}:to`);
   return {from:from&&[from.getAttribute('cx'),from.getAttribute('cy')],lineFrom:[line.getAttribute('x1'),line.getAttribute('y1')],to:to&&[to.getAttribute('cx'),to.getAttribute('cy')],lineTo:[line.getAttribute('x2'),line.getAttribute('y2')]};
  }));
  assert.ok(endpointAlignment.every(row=>JSON.stringify(row.from)===JSON.stringify(row.lineFrom)&&JSON.stringify(row.to)===JSON.stringify(row.lineTo)),`endpoint markers land exactly on their VM-projected connector ends: ${JSON.stringify(endpointAlignment)}`);
  const stageNames=(await page.locator('.ao-plate__name').allTextContents()).map(name=>name.trim()).filter(Boolean);
  assert.equal(new Set(stageNames).size,stageNames.length,`the stage shows one nameplate per person; fixture names do not alias the primary: ${JSON.stringify(stageNames)}`);
  const zoneStyles=await page.locator('.ao-team-pod-zone').evaluateAll(nodes=>nodes.map(node=>{
   const legend=document.querySelector(`[data-team-legend="${CSS.escape(node.dataset.teamPodZone)}"] .ao-team-legend__dot`),shape=node.querySelector('polygon');
   return {team:node.dataset.teamPodZone,stroke:getComputedStyle(shape).stroke,dot:legend?getComputedStyle(legend).backgroundColor:null,width:parseFloat(getComputedStyle(shape).strokeWidth),fill:getComputedStyle(shape).fill,opacity:Number(getComputedStyle(shape).opacity)};
  }));
  assert.ok(zoneStyles.length&&zoneStyles.every(row=>row.stroke===row.dot&&row.width>=(width===390?4.5:3.5)&&row.opacity===1&&row.fill!=='rgba(0, 0, 0, 0)'),`team zones use their legend accent with a visible outline and floor tint: ${JSON.stringify(zoneStyles)}`);
  if(width===390){
   const zoneFilters=await page.locator('.ao-team-pod-zone polygon').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).filter));
   assert.ok(zoneFilters.every(filter=>filter!=='none'),`phone team zones have a surface-aware contrast edge: ${JSON.stringify(zoneFilters)}`);
  }
  const linkStyles=await page.locator('.ao-team-links line[data-shared-lead]').evaluateAll(nodes=>nodes.map(node=>{
   const legend=document.querySelector(`[data-team-legend="${CSS.escape(node.dataset.teamGroup)}"] .ao-team-legend__dot`);
   const rect=node.getBoundingClientRect(),svg=node.ownerSVGElement.getBoundingClientRect();
   return {team:node.dataset.teamGroup,accent:node.dataset.teamAccent,stroke:getComputedStyle(node).stroke,dot:legend?getComputedStyle(legend).backgroundColor:null,width:parseFloat(getComputedStyle(node).strokeWidth),dash:getComputedStyle(node).strokeDasharray,visibleLength:Math.hypot(rect.width,rect.height),intersects:rect.right>=svg.left&&rect.left<=svg.right&&rect.bottom>=svg.top&&rect.top<=svg.bottom};
  }));
  assert.ok(linkStyles.length&&linkStyles.every(row=>row.stroke===row.dot&&row.width>=3&&row.dash!=='none'&&row.visibleLength>12&&row.intersects),`shared-lead links use their team accent and are visibly drawn across the room: ${JSON.stringify(linkStyles)}`);
  assert.equal(await page.locator('.ao-team-links circle[data-shared-lead-endpoint]').count(),expectedLinks.length*2,'each shared-lead link visibly marks both backend-provided endpoints');
  assert.ok(await page.locator('.ao-team-links circle[data-shared-lead-endpoint]').evaluateAll(nodes=>nodes.every(node=>Number(node.getAttribute('r'))>=4&&getComputedStyle(node).fill===getComputedStyle(document.querySelector(`[data-team-legend="${CSS.escape(node.dataset.teamGroup)}"] .ao-team-legend__dot`)).backgroundColor)),'shared-lead endpoint markers use the corresponding team accent');

  if(width===390){
   assert.equal(await page.locator('.ao-mobile-team-preview').count(),floor.agentGroups.length,'the mobile roster shows only the selected floor groups');
   assert.equal(await page.locator('.ao-mobile-team-header:visible').count(),1,'phone shows exactly one project-team section heading');
   assert.equal(await page.locator('.ao-bureau__side[hidden]').evaluate(node=>getComputedStyle(node).display),'none','the desktop roster/sidebar is actually hidden on phone, preventing a duplicate team list');
   const mobileGroups=page.locator('.ao-mobile-team-preview');
   for(let index=0;index<await mobileGroups.count();index++){const box=await mobileGroups.nth(index).boundingBox();assert.ok(box.x>=8&&box.x+box.width<=width-8,`expanded team card has safe mobile gutters: ${JSON.stringify(box)}`);}
   await mkdir(OUT,{recursive:true});await page.screenshot({path:`${OUT}/${width}-${theme}-team-groups.png`,animations:'disabled'});
   await mobileGroups.last().scrollIntoViewIfNeeded();
   const bottomRoster=await page.evaluate(()=>{
    const body=document.querySelector('.ao-bureau > .ao-frame__body');
    const last=document.querySelector('.ao-mobile-team-preview:last-child');
    const nav=document.querySelector('.bu-bottombar');
    const row=last?.getBoundingClientRect(),bar=nav?.getBoundingClientRect();
    return {scrollTop:body?.scrollTop,scrollHeight:body?.scrollHeight,clientHeight:body?.clientHeight,
     rowBottom:row?.bottom,navTop:bar?.top,scrollWidth:body?.scrollWidth,clientWidth:body?.clientWidth};
   });
   assert.ok(bottomRoster.scrollTop>0,`the project-team list scrolls inside the fixed mobile shell: ${JSON.stringify(bottomRoster)}`);
   assert.ok(bottomRoster.rowBottom<=bottomRoster.navTop,`the final member row is fully reachable above bottom navigation: ${JSON.stringify(bottomRoster)}`);
   assert.equal(bottomRoster.scrollWidth,bottomRoster.clientWidth,`the roster does not introduce horizontal scrolling: ${JSON.stringify(bottomRoster)}`);
   await page.screenshot({path:`${OUT}/${width}-${theme}-team-groups-bottom.png`,animations:'disabled'});
   await mobileGroups.first().click();const detail=page.locator('.bu-modal[role="dialog"],.bu-dialog[role="dialog"]');
   await detail.first().waitFor({state:'visible'});
   await mkdir(OUT,{recursive:true});await page.screenshot({path:`${OUT}/${width}-${theme}-team-detail.png`,animations:'disabled'});
  }else{
   assert.equal(await page.locator('.ao-mobile-team-preview').count(),0,'desktop uses the grouped floor roster');
   assert.equal(await page.locator('[data-floor-agent-group="'+group.id+'"]').locator('[data-occupant]').count(),expectedIds.length,
     'desktop renders each selected-floor team occupant inside that group');
   await mkdir(OUT,{recursive:true});await page.screenshot({path:`${OUT}/${width}-${theme}-team-groups.png`,animations:'disabled'});
  }
  assert.deepEqual(errors,[],`Bureau renders team groups without browser errors`);
  assert.deepEqual(badResponses.sort((a,b)=>a.url.localeCompare(b.url)),width===390?[]:[{status:404,url:'/backend/api/v3/orchestrators'}],`only the unavailable optional orchestrator source may return 404 on the v3 desktop path`);
 }finally{await b?.close();await h?.close();}
});

for(const width of [1440,390])for(const floorId of ['1','3'])test(`Bureau floor ${floorId} renders the whole office roster, its own groups first ${width} dark`,{skip:browserSkipReason(),timeout:120000},async()=>{
 let h,b;
 try{
  b=await openLayoutBrowser({theme:'dark',touch:width===390,apiVersion:width===390?2:3,apiProxy:async publicUrl=>{
   h=await projectTeamFixture({publicUrl,theme:'night',twoTeams:true,memberCount:5,memberNames:['Atlas','Domaine worker','VCE worker','Review agent','Unassigned worker'],primaryFloorId:'3'});return h.base;
  }});
  const {page}=b;await page.setViewportSize({width,height:width===390?844:900});
  const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  const office=(await h.get('/api/v3/views/office')).json.data;
  const floor=office.rosterFloors.find(row=>row.id===floorId);assert.ok(floor,`OfficeVM supplies floor ${floorId}`);
  assert.ok(Array.isArray(floor.agentGroups),'OfficeVM supplies the selected floor groups');
  if(floorId==='1'){
   const expectedTeams=office.teamGroups.filter(group=>group.floorId==='1').map(group=>group.id);
   assert.ok(expectedTeams.length>0,'synthetic project teams are seated on floor 1');
   assert.deepEqual(floor.agentGroups.filter(group=>group.kind==='team').slice(0,expectedTeams.length).map(group=>group.id),expectedTeams,
     'floor 1 lists its own project teams first, in server order');
  }else{
   const primary=office.occupants.find(row=>row.role==='primary');assert.ok(primary,'fixture has a primary agent');
   const unassigned=floor.agentGroups.find(group=>group.kind==='unassigned');assert.ok(unassigned,'floor 3 has an explicit unassigned group');
   assert.ok(unassigned.occupantIds.includes(primary.id),'the unassigned primary is listed');
   assert.ok(floor.agentGroups.some(group=>group.kind==='team'),'floor 3 also lists the teams seated elsewhere');
  }
  const officeAgents=office.rosterFloors.reduce((sum,row)=>sum+row.count,0);
  assert.equal(floor.agentGroups.reduce((sum,group)=>sum+group.count,0),officeAgents,
    'group counts add up to every agent in the office, including shared leads exactly once');
  assert.equal(new Set(floor.agentGroups.flatMap(group=>group.occupantIds)).size,officeAgents,
    'the office roster does not duplicate a lead shared by two teams');
  assert.equal(floor.agentGroups.filter(group=>group.kind==='team'&&group.id==='team:atelier-projets').length,1,
    'Domaine Kildare appears once in the roster');
  const url=new URL('/bureau',b.origin);url.searchParams.set('etage',floorId);
  await page.goto(url.href,{waitUntil:'domcontentloaded'});await page.locator('.ao-bureau__stage').waitFor({state:'visible'});
  const groupSelector=width===390?'.ao-mobile-team-preview[data-floor-agent-group]':`[data-roster-floor="${floorId}"] .ao-floor-roster__agent-group[data-floor-agent-group]`;
  const expectedGroups=floor.agentGroups;
  await page.locator(groupSelector).first().waitFor({state:'visible'});
  assert.deepEqual(await page.locator(groupSelector).evaluateAll(nodes=>nodes.map(node=>node.dataset.floorAgentGroup)),expectedGroups.map(group=>group.id),
    'desktop and phone render the selected floor groups in the VM-provided order');
  assert.deepEqual(await page.locator(groupSelector).evaluateAll(nodes=>nodes.map(node=>node.dataset.floorAgentGroupKind)),expectedGroups.map(group=>group.kind));
  if(width!==390)assert.equal(await page.locator('.ao-floor-roster__agent-group[data-floor-agent-group]').count(),expectedGroups.length,
    'the desktop rail renders the office roster once, under the selected floor only');
  assert.equal(await page.locator('[data-testid="team-herdr-opt-in-hint"]').count(),0,
    'the global opt-in hint is suppressed when the OfficeVM already supplies team groups');
  const teamOffice=page.locator('[data-testid="team-office"]');
  if(!floor.teamGroups.length&&await teamOffice.count()){
   assert.equal(await teamOffice.locator('[data-testid^="team-panel-"]').count(),0,
     'a group-free floor may show source health only, never the global team contents');
   assert.ok(await teamOffice.getByRole('status').count(),
     'any retained panel on a group-free floor is an explicit failed or stale source warning');
  }
  assert.equal(await teamOffice.locator('[data-testid="team-panel-members"], [data-testid="team-panel-board"]').count(),width===390?0:(floor.teamGroups.length?2:0),
    'healthy team contents remain hidden when the backend says this floor has no membership panel');
  if(width===390){
   for(const card of await page.locator(groupSelector).all()){
    const avatar=await card.locator('.ao-mobile-team-preview__avatars').boundingBox();
    const copy=await card.locator('.ao-mobile-team-preview__copy').boundingBox();
    assert.ok(avatar&&copy&&copy.x>=avatar.x+avatar.width,`group title and count start after the avatar stack: ${JSON.stringify({avatar,copy})}`);
    const groupId=await card.getAttribute('data-floor-agent-group');
    const group=expectedGroups.find(row=>row.id===groupId);
    const countText=await card.locator('.ao-mobile-team-preview__copy > span').innerText();
    assert.equal(countText,group.count===1?'1 agent':`${group.count} agents`,
      'mobile count uses the correct backend-computed singular/plural label');
   }
  }else{
   for(const card of await page.locator(groupSelector).all()){
    const groupId=await card.getAttribute('data-floor-agent-group');
    const group=expectedGroups.find(row=>row.id===groupId);
    assert.equal(await card.locator('[data-floor-agent-group-label] span').innerText(),group.count===1?'1 agent':`${group.count} agents`,
      'desktop count uses the correct backend-computed singular/plural label');
   }
  }
  assert.deepEqual(await page.evaluate(()=>[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight]),
    [width,width===390?844:900],'the selected floor view remains within its viewport');
  for(const node of await page.locator(groupSelector).all()){
   const box=await node.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width,`floor group is not clipped: ${JSON.stringify(box)}`);
  }
  if(width===390&&floorId==='1'){
   await page.locator(groupSelector).first().scrollIntoViewIfNeeded();
   const viewport=await page.evaluate(()=>({height:innerHeight,bottomNavTop:document.querySelector('.bu-bottombar')?.getBoundingClientRect().top||innerHeight}));
   const boxes=await Promise.all((await page.locator(`${groupSelector}[data-floor-agent-group-kind="team"]`).all()).map(node=>node.boundingBox()));
   assert.ok(boxes.every(box=>box&&box.y>=0&&box.y+box.height<=viewport.bottomNavTop),
     `all project-team cards fit together in the scrolled phone viewport: ${JSON.stringify({boxes,viewport})}`);
   await mkdir(OUT,{recursive:true});
   await page.screenshot({path:`${OUT}/390-dark-floor-1-groups-scrolled.png`,animations:'disabled'});
  }
  const finalGroup=page.locator(groupSelector).last();await finalGroup.scrollIntoViewIfNeeded();
  const finalBox=await finalGroup.boundingBox();assert.ok(finalBox&&finalBox.y>=0&&finalBox.y+finalBox.height<= (width===390?await page.evaluate(()=>innerHeight-(document.querySelector('.bu-bottombar')?.getBoundingClientRect().height||0)):900),
    `the final selected-floor group is reachable above the fixed navigation: ${JSON.stringify(finalBox)}`);
  await mkdir(OUT,{recursive:true});
  await page.screenshot({path:`${OUT}/${width}-dark-floor-${floorId}.png`,animations:'disabled'});
 }finally{await b?.close();await h?.close();}
});

for(const theme of ['light','dark'])test(`Bureau keeps the team legend below the room at 360px ${theme}`,{skip:browserSkipReason(),timeout:120000},async()=>{
 let h,b;
 try{
  b=await openLayoutBrowser({theme,touch:true,apiVersion:2,apiProxy:async publicUrl=>{
   h=await projectTeamFixture({publicUrl,theme:theme==='light'?'day':'night',twoTeams:true,memberCount:5,memberNames:['Mira','Scribe','Nox','Beacon','Lumen']});return h.base;
  }});
  const {page}=b,errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:360,height:800});
  const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  const response=await h.get('/api/v2/views/office');assert.equal(response.status,200,`v2 OfficeVM is available: ${response.text.slice(0,1600)}`);
  const office=response.json.data,groups=office.teamGroups;
  assert.ok(Array.isArray(groups)&&groups.length===2,'the 360px fixture contains two backend team groups');
  const floorId=groups[0].floorId,url=new URL('/bureau',b.origin);url.searchParams.set('agent','Atlas');url.searchParams.set('etage',floorId);
  await page.goto(url.href,{waitUntil:'domcontentloaded'});await page.locator('.ao-bureau__stage').waitFor({state:'visible'});
  await page.locator('.ao-mobile-team-preview').first().waitFor({state:'visible'});
  const stageBox=await page.locator('.ao-bureau__stage').boundingBox(),legend=page.locator('.ao-team-legend'),items=legend.locator('[data-team-legend]');
  await legend.waitFor({state:'visible'});
  assert.deepEqual(await items.evaluateAll(nodes=>nodes.map(node=>[node.dataset.teamLegend,node.dataset.teamAccent])),office.teamLegend.map(row=>[row.teamId,row.accentToken]),'360px legend chips match the backend teamLegend order and accents');
  const legendBox=await legend.boundingBox();
  assert.ok(legendBox.y>=stageBox.y+stageBox.height-1,'the 360px legend remains below the room artwork');
  assert.ok(legendBox.x>=0&&legendBox.x+legendBox.width<=360,'the wrapped 360px legend remains in the viewport');
  const expectedZones=groups.filter(row=>row.floorId===floorId&&row.pod?.zone?.polygon?.length>=3).length;
  assert.ok(expectedZones>0,'the 360px fixture includes projected team pod zones');
  assert.equal(await page.locator('.ao-team-pod-zone').count(),expectedZones,'colored pod zones remain visible without map labels');
  assert.ok(await page.locator('.ao-mobile-team-preview').count()>=1,'the mobile floor group list remains available');
  assert.deepEqual(await page.evaluate(()=>[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight]),[360,800],'the narrower mobile layout stays inside its fixed viewport');
  await mkdir(OUT,{recursive:true});await page.screenshot({path:`${OUT}/360-${theme}-team-groups-legend.png`,animations:'disabled'});
  assert.deepEqual(errors,[],'the 360px legend state renders without browser errors');
 }finally{await b?.close();await h?.close();}
});

for(const width of [1440,390])test(`Bureau fails closed when team groups are absent ${width}`,{skip:browserSkipReason(),timeout:120000},async()=>{
 let h,b;
 try{
  const apiVersion=width===390?2:3;
  b=await openLayoutBrowser({theme:'light',touch:width===390,apiVersion,apiProxy:async publicUrl=>{
   h=await officeSceneFixture({publicUrl,occupantCount:6,namedAgents:true,primaryName:'Atlas'});return h.base;
  }});
  const {page}=b,errors=[],badResponses=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&!message.text().startsWith('Failed to load resource:'))errors.push(message.text());});page.on('response',response=>{if(response.status()>=400)badResponses.push({status:response.status(),url:new URL(response.url()).pathname});});await page.setViewportSize({width,height:width===390?844:900});
  const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  const legacyOffice=await h.get('/api/v2/views/office');assert.equal(legacyOffice.status,200,`ordinary v2 Office projection is healthy: ${legacyOffice.text.slice(0,2400)}`);const layoutResponse=await h.get('/api/v2/office/layout');assert.equal(layoutResponse.status,200,`ordinary v2 Office layout endpoint is healthy: ${layoutResponse.text.slice(0,2400)}`);
  const url=new URL('/bureau',b.origin);url.searchParams.set('agent','Atlas');
  const sourceResponses=waitForTeamEndpoints(page,width);
  await page.goto(url.href,{waitUntil:'domcontentloaded'});await page.locator('.ao-bureau--ready').waitFor({state:'visible'});
  await Promise.all(sourceResponses);
  const stage=page.locator('.ao-bureau__stage');
  const stageState=await stage.evaluate(node=>({hidden:node.hidden,html:node.innerHTML.slice(0,600),label:node.getAttribute('aria-label')}));
  assert.equal(stageState.hidden,false,`ordinary Office stage remains available without team groups: ${JSON.stringify({stageState,errors,badResponses,body:(await page.locator('body').innerText()).slice(-800)})}`);
  assert.deepEqual(errors,[],`Bureau modules load when team groups are absent; failed HTTP responses=${JSON.stringify(badResponses)}`);
  assert.deepEqual(badResponses.sort((a,b)=>a.url.localeCompare(b.url)),width===390?[]:[
   {status:404,url:'/backend/api/v3/orchestrators'},{status:404,url:'/backend/api/v3/teams'},
  ].sort((a,b)=>a.url.localeCompare(b.url)),'absent team sources return explicit not-found responses without breaking the ordinary Office');
  try{await page.waitForFunction(()=>document.querySelector('.ao-bureau__side .ao-bureau__roster')||document.querySelector('.ao-mobile-roster'));}catch{
   const debug=await page.evaluate(()=>({url:location.href,bodyText:document.body.innerText.slice(-1000),bureau:document.querySelector('.ao-bureau')?.outerHTML.slice(0,4000),classes:[...document.querySelectorAll('.ao-bureau *')].map(node=>String(node.className?.baseVal??node.className??'')).filter(Boolean).slice(-80)}));
   assert.fail(`ordinary roster did not render; browser errors=${JSON.stringify(errors)}; bad responses=${JSON.stringify(badResponses)}; page=${JSON.stringify(debug)}`);
  }
  assert.equal(await page.locator('[data-floor-agent-group-kind="team"],.ao-team-legend,.ao-team-pod-zone').count(),0,'no project-team membership is inferred when the server omits teamGroups');
  assert.ok(await page.locator('[data-floor-agent-group-kind="unassigned"]').count(),'ordinary agents remain grouped as unassigned by the backend');
  assert.ok(await page.locator('[data-occupant], [data-mobile-agent]').count(),'ordinary canonical occupants remain visible');
 }finally{await b?.close();await h?.close();}
});
