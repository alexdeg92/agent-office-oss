import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { openLayoutBrowser, visit, browserSkipReason } from './helpers/layout-browser.js';
const skip = browserSkipReason();
const require = createRequire(import.meta.url);
const { buildOfficeVM, createStateTracker } = require('../../src/api/v2/vm/office');
const FIXTURE_NOW = Date.UTC(2026,9,12,0,0);

// Exercise the production projection from canonical sessions, never hand-write VM parentId.
function projectedOffice({scoutParent='atlas-session',scribeParent='scout-session',scoutFromChildKeys=false,includeChildren=true,includeCodingSession=false}={}) {
  const now=FIXTURE_NOW;
  const session=(key,kind,agentId,name,parentKey=null)=>({
    key,displayName:name,summarySource:'runtime',label:null,parentKey,childKeys:[],updatedAt:now,
    interactive:!['primary','explicit'].includes(kind),usage:{total:0},
    class:{kind,agentId,heartbeatOf:null,channel:null,interlocutorId:kind==='conversation-direct'?'person-demo':null},
    // These canonical fixtures assert live occupants, so they must provide
    // verified run evidence instead of relying on a bare status string.
    run:{status:'running',evidence:'status-field',evidenceLevel:'verified',observedAt:now,expiresAt:null,startedAt:now-1000,endedAt:null},
  });
  const sessions=[session('atlas-session','primary','main','Atlas'),
    session('claude-session','explicit','claude','Claude'),
    session('dm-session','conversation-direct','main','Camille')];
  if(includeCodingSession) {
    const coding=session('coding-session','conversation','claude','Fix the conversation title');
    coding.projectLabel='agent-office-redesign';coding.cwd='/workspace/agent-office-redesign';
    sessions.push(coding);
  }
  if(includeChildren) sessions.push(
    session('scout-session','subagent','main','Scout',scoutFromChildKeys?null:scoutParent),
    session('scribe-session','subagent','main','Scribe',scribeParent),
    session('tests-session','subagent','claude','Tests','claude-session'));
  if(scoutFromChildKeys) sessions[0].childKeys=['scout-session'];
  const agents=[{id:'main',name:'Atlas',isPrimary:true,mainSessionKey:'atlas-session'},
    {id:'claude',name:'Claude',isPrimary:false}];
  const engine={sessions:()=>sessions,session:key=>sessions.find(s=>s.key===key)||null,
    agents:()=>agents,primaryAgent:()=>agents[0],gateway:()=>({connected:true,since:1}),
    runtimeFor:()=>({name:'Claude Code',connected:true}),cronJobs:()=>[],host:()=>null,liveEvents:()=>[]};
  return buildOfficeVM({engine,now,tracker:createStateTracker(),canReadSessions:true,
    configuredAgents:{claude:'Claude'},names:{interlocutorName:id=>id==='person-demo'?'Camille':null},
    actorOf:()=>({kind:'system',name:'Système'})});
}

test('production OfficeVM projects parentKey and childKeys into stacked occupants without SessionVM cues',()=>{
  for(const scoutFromChildKeys of [false,true]) {
    const vm=projectedOffice({scoutFromChildKeys}),byName=new Map(vm.occupants.map(o=>[o.name,o]));
    assert.equal(byName.get('Scout').parentId,byName.get('Atlas').id);
    assert.equal(byName.get('Scribe').parentId,byName.get('Scout').id);
    assert.equal(byName.get('Tests').parentId,byName.get('Claude').id);
    assert.equal(byName.get('Camille').parentId,byName.get('Atlas').id,'conversation ownership is not delegation');
    const byId=new Map(vm.occupants.map(o=>[o.id,o]));
    assert.deepEqual(vm.rosterItems.map(item=>[byId.get(item.rootId).name,item.occupantIds.slice(1).map(id=>byId.get(id).name)]),
      [['Atlas',['Scout','Scribe']],['Claude',['Tests']]]);
    assert.deepEqual(vm.conversationIds.map(id=>byId.get(id).name),['Camille']);
  }
});

test('a child spawned from a DM reaches its agent stack while the DM remains conversation activity',()=>{
  const vm=projectedOffice({scoutParent:'dm-session'}),byName=new Map(vm.occupants.map(o=>[o.name,o]));
  assert.equal(byName.get('Scout').parentId,byName.get('Camille').id,'the immediate canonical parent is the DM');
  const byId=new Map(vm.occupants.map(o=>[o.id,o]));
  assert.deepEqual(vm.rosterItems.map(item=>[byId.get(item.rootId).name,item.occupantIds.slice(1).map(id=>byId.get(id).name)]),
    [['Atlas',['Scout','Scribe']],['Claude',['Tests']]]);
  assert.deepEqual(vm.conversationIds.map(id=>byId.get(id).name),['Camille']);
});

test('production projection with missing or cyclic parentage keeps the delegates visible',()=>{
  for(const scoutParent of ['absent-session','scribe-session']) {
    const vm=projectedOffice({scoutParent});
    const visible=vm.rosterItems.flatMap(item=>item.occupantIds);
    assert.equal(visible.length,new Set(visible).size,'no identity appears twice');
    assert.deepEqual(new Set(visible),new Set(vm.occupants.filter(o=>!vm.conversationIds.includes(o.id)).map(o=>o.id)),
      'every non-conversation identity remains visible exactly once');
  }
});

test('OfficeVM returns the canonical tree for nested, orphaned, cyclic and conversation rows', () => {
  const { projectOfficeRoster } = require('../../src/api/v2/vm/office-roster.js');
  const vm=projectOfficeRoster({ occupants: [
    {id:'primary',role:'primary',name:'Atlas'},
    {id:'agent:other',role:'agent',name:'Atlas'},
    {id:'docs',role:'agent',parentId:'primary'},
    {id:'nested',role:'agent',parentId:'docs'},
    {id:'dm',role:'dm',parentId:'primary'},
    {id:'group',role:'group'},
    {id:'conversation',role:'conversation',parentId:'docs'},
    {id:'tests',role:'subagent',parentId:'agent:other'},
    {id:'unknown',role:'subagent',parentId:null,sessionKey:'opaque-child'},
    {id:'missing',role:'subagent',parentId:'absent'},
    {id:'cycle-a',role:'subagent',parentId:'cycle-b'},
    {id:'cycle-b',role:'agent',parentId:'cycle-a'},
  ] });
  const byId=new Map(vm.occupants.map(o=>[o.id,o]));
  assert.deepEqual(vm.rosterItems.map(item=>[item.rootId,item.occupantIds]),[
    ['primary',['primary','docs','nested']],['agent:other',['agent:other','tests']],['unknown',['unknown']],
    ['missing',['missing']],['cycle-a',['cycle-a','cycle-b']],
  ]);
  assert.deepEqual(vm.conversationIds,['dm','group','conversation']);
  assert.equal(new Set(vm.rosterItems.flatMap(item=>item.occupantIds)).size,9);
  assert.equal(byId.get('nested').rosterDepth,2);
});

async function fixture(page, canonical = false, includeCodingSession = false) {
  const fixture = await page.evaluate(async projected => {
    const { services } = await import('/services.js');
    const api = await import('/api.js');
    const mock = await api.mock();
    const base = (await mock.handle('GET','/api/v2/views/sessions/agent:main:main')).body;
    const stream=services.stream;
    stream.stop();stream.status.set({conn:'open'});
    const vm=projected || structuredClone(stream._topics.get('office').state.data);
    const fixtureFloorLayout=vm.rosterFloors?.[0]?.layout;
    const names=['Atlas','Scout','Scribe','Claude','Tests'];
    const keys=['atlas-session','scout-session','scribe-session','claude-session','tests-session'];
    if(!projected) {
      vm.occupants=vm.occupants.slice(0,5).map((o,index)=>({...o,id:index===3?'agent:claude':o.id,role:index===3?'agent':o.role,name:names[index],title:null,sessionKey:keys[index],runtime:index===3||index===4?'Claude Code':'OpenClaw',summary:index===4?'Vérifie le formulaire mobile':'Prépare la synthèse',state:'working'}));
      const byName=new Map(vm.occupants.map(o=>[o.name,o]));
      const parents={Scout:'Atlas',Scribe:'Scout',Tests:'Claude'};
      vm.occupants=vm.occupants.map((o,index)=>({ ...o, parentId:parents[o.name]?byName.get(parents[o.name]).id:null,
        parentName:parents[o.name]||null, rosterDepth:o.name==='Scribe'?2:parents[o.name]?1:0,
        teamId:null,groupId:parents[o.name]?(parents[o.name]==='Scout'?'Atlas':parents[o.name]):o.id,rosterOrder:index,
        floorId:'1',standingPoint:null,stateLabel:{key:`agentState.${o.state}`} }));
      vm.rosterItems=[['Atlas',['Atlas','Scout','Scribe']],['Claude',['Claude','Tests']]].map(([rootName,names])=>{
      const ids=names.map(name=>byName.get(name).id);return {id:ids[0],kind:'group',isGroup:true,rootId:ids[0],occupantIds:ids,childIds:ids.slice(1),previewOccupantIds:ids.slice(0,3),overflowCount:0,openLabel:{key:'office.mobile.openTeam',params:{name:rootName,n:ids.length-1}},delegatesLabel:{key:'office.mobile.delegates',params:{n:ids.length-1}},overflowLabel:null,order:vm.occupants.find(o=>o.id===ids[0]).rosterOrder,count:ids.length-1,label:{key:'sessionTitle.named',params:{name:rootName}}};
      });
      vm.rosterPreviewItems=vm.rosterItems;vm.rosterOverflowCount=0;
      vm.conversationIds=[];vm.rosterSummary={count:5,activeCount:5};
      vm.rosterFloors=[{id:'1',order:1,label:{key:'office.floor.first'},kind:'office',occupantIds:vm.occupants.map(o=>o.id),mobileLabelIds:vm.occupants.slice(0,3).map(o=>o.id),items:vm.occupants.map(o=>({kind:'occupant',id:`occupant:${o.id}`,occupantId:o.id})),count:5,activeCount:5,idleCount:0,layout:fixtureFloorLayout,capacity:null}];
      vm.unseatedTeams=[];
      vm.kpis.find(k=>k.id==='active').value=5;
    }
    const lay=structuredClone(stream._topics.get('layout').state.data);lay.agentsSeen=[];
    return {vm,lay,base,meta:services.meta};
  },canonical?projectedOffice({includeCodingSession}):null);
  await page.route('**/backend/api/v2/meta?*',route=>route.fulfill({json:{data:{...fixture.meta,env:'dev'}}}));
  await page.route('**/backend/api/v2/views/sessions/*',route=>{
    const key=decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1));
    const children=key==='atlas-session'?['scout-session','scribe-session']:key==='claude-session'?['tests-session']:[];
    return route.fulfill({json:{...fixture.base,data:{...fixture.base.data,key,subagents:children.map(key=>({kind:'agent',id:key,name:'Delegate',runtime:'demo',channel:null,avatarHint:null,delegation:{sessionKey:key,label:null}}))}}});
  });
  await page.evaluate(async fixture=>{
    const api=await import('/api.js');await api.init({search:'',hostname:'127.0.0.1'});
    const {services}=await import('/services.js');
    // Late initial GETs must not replace the isolated synthetic scenario.
    for(const topic of ['layout','office']) {
      const entry=services.stream._topics.get(topic);entry.state={...entry.state,rev:(entry.state.rev||0)+100};
    }
    services.stream.applyVM('layout',fixture.lay);services.stream.applyVM('office',fixture.vm);
  },fixture);
  await page.waitForFunction(()=>document.querySelectorAll('.ao-mobile-group').length===2);
}

test('compact options and separate parent stacks lead to full detail and return to the right team', {skip,timeout:90000}, async()=>{
  for(const width of [360,390]) for(const theme of ['light','dark']) {
    const h=await openLayoutBrowser({theme,touch:true}),p=h.page,errors=[];
    p.on('pageerror',e=>errors.push(e.message));
    const capture=async name=>{if(process.env.BUREAU_SCREENSHOTS==='1'){
      await mkdir('design/reports/mobile-office-options/product',{recursive:true});
      await p.evaluate(()=>document.fonts.ready);
      await p.screenshot({path:`design/reports/mobile-office-options/product/${name}-${width}-${theme}.png`,animations:'disabled'});
    }};
    try {
      await p.setViewportSize({width,height:844});await visit(p,h.origin,'/bureau?mock=foule','.ao-mobile-options');
      await p.getByRole('button',{name:'Options du bureau',exact:true}).click();
      const dialog=p.getByRole('dialog',{name:'Options du bureau',exact:true});
      const sheetHeight=(await dialog.boundingBox()).height;
      assert.ok(sheetHeight<=298,`entire sheet takes less than half the old 597px height (${sheetHeight}px)`);
      assert.equal(await dialog.getByRole('button',{name:'Fermer',exact:true}).count(),1);
      assert.equal(await dialog.getByRole('button',{name:/Zoom/}).count(),0);
      assert.equal(await dialog.getByText(/Connexion active depuis/).count(),0);
      assert.equal(await dialog.getByText('Préférences d’apparence',{exact:true}).count(),0);
      assert.ok(await dialog.locator('button').evaluateAll(buttons=>buttons.every(b=>b.getBoundingClientRect().height>=44&&b.getBoundingClientRect().width>=44)));
      await dialog.getByRole('button',{name:'Nuit',exact:true}).click();
      await p.waitForFunction(()=>document.querySelector('.ao-office-options [aria-pressed=true]')?.textContent.trim()==='Nuit');
      await dialog.getByRole('button',{name:'Recentrer',exact:true}).click();
      await capture('options');await p.keyboard.press('Escape');
      await fixture(p);await capture('teams');
      await p.evaluate(async()=>{
        const {services}=await import('/services.js');
        const office=services.stream._topics.get('office').state.data;
        const layout=services.stream._topics.get('layout').state.data;
        const primary=office.occupants.find(row=>row.role==='primary'||row.role==='main');
        services.officeApi={get:async()=>layout,getRevision:async()=>null,put:async()=>({vm:layout}),putTheme:async()=>({vm:layout})};
        // The endpoint fixture returns its complete server-owned groups and rows, not a client-built roster.
        const byId=new Map(office.occupants.map(person=>[person.id,person]));
        const shape=(person,order)=>({id:person.id,role:person.role,name:person.name,runtime:person.runtime,
          runtimeBrand:person.runtimeBrand||null,state:person.state,stateLabel:person.stateLabel,roleLabel:person.roleLabel,
          primary:person.id===primary.id,look:person.look,groupId:person.groupId,order:person.rosterOrder??order,
          inOffice:true,lastSeenAt:null});
        const groups=(office.rosterItems||[]).map(group=>({id:group.id,label:group.label,count:group.occupantIds.length,
          countLabel:{key:group.occupantIds.length===1?'office.characters.count.one':'office.characters.count.other',params:{n:group.occupantIds.length}},
          rows:group.occupantIds.map((id,index)=>byId.get(id)).filter(Boolean).map(shape)}));
        const count=groups.reduce((sum,group)=>sum+group.rows.length,0);
        services.officeCharacterVM=async({scope,search})=>({scope,search,count,countLabel:{key:count===1?'office.characters.count.one':'office.characters.count.other',params:{n:count}},
          groups,emptyLabel:{key:'office.characters.emptyOffice'}});
      });
      const group=p.locator('.ao-mobile-group');assert.equal(await group.count(),2);
      assert.ok(await group.evaluateAll(groups=>groups.every(g=>g.scrollWidth<=g.clientWidth)));
      await group.first().getByRole('button',{name:/Voir l’équipe de Atlas/}).click();
      await p.getByRole('dialog',{name:'Équipe de Atlas',exact:true}).waitFor();await capture('atlas-team');
      assert.equal(await p.locator('[role=dialog] [data-occupant]').count(),3);
      assert.equal(await p.getByRole('dialog').getByText('Tests',{exact:true}).count(),0);
      await p.locator('[role=dialog] [data-occupant]').filter({has:p.getByText('Scribe',{exact:true})}).click();
      await p.locator('#ao-drawer-title').waitFor();assert.equal(await p.locator('#ao-drawer-title').innerText(),'Scribe');await capture('scribe-detail');
      await p.getByRole('button',{name:'Retour à l’équipe',exact:true}).click();
      await p.getByRole('dialog',{name:'Équipe de Atlas',exact:true}).waitFor();await p.keyboard.press('Escape');
      await group.first().locator('[data-mobile-agent]').click();
      await p.locator('#ao-drawer-title').waitFor();assert.equal(await p.locator('#ao-drawer-title').innerText(),'Atlas');await capture('atlas-detail');
      await p.getByRole('button',{name:'Équipe de Atlas',exact:true}).click();await p.getByRole('dialog',{name:'Équipe de Atlas',exact:true}).waitFor();await p.keyboard.press('Escape');
      await group.nth(1).getByRole('button',{name:/Voir l’équipe de Claude/}).click();
      await p.getByRole('dialog',{name:'Équipe de Claude',exact:true}).waitFor();await capture('claude-team');
      assert.equal(await p.locator('[role=dialog] [data-occupant]').count(),2);
      assert.equal(await p.getByRole('dialog').getByText('Scribe',{exact:true}).count(),0);
      await p.locator('[role=dialog] [data-occupant]').filter({has:p.getByText('Tests',{exact:true})}).click();
      await p.locator('#ao-drawer-title').waitFor();assert.equal(await p.locator('#ao-drawer-title').innerText(),'Tests');await capture('tests-detail');
      await p.getByRole('button',{name:'Retour à l’équipe',exact:true}).click();await p.getByRole('dialog',{name:'Équipe de Claude',exact:true}).waitFor();
      await p.keyboard.press('Escape');
      await p.locator('.ao-mobile-group').nth(1).locator('[data-mobile-agent]').click();
      await p.locator('.bu-drawer #ao-drawer-title').waitFor();
      await p.locator('.bu-drawer').getByRole('button',{name:'Personnaliser',exact:true}).click();
      await p.locator('.ao-editpanel .ao-characters__detail').waitFor();
      assert.equal(await p.locator('.ao-editpanel .ao-characters__list').isVisible(),false,'drawer customization opens the selected agent directly');
      assert.equal(await p.locator('.ao-editpanel .ao-characters__detail').isVisible(),true);
      await p.locator('.ao-characters__actions').getByRole('button',{name:'Annuler',exact:true}).click();
      await p.locator('.bu-drawer').getByRole('button',{name:'Fermer',exact:true}).click();
      await p.locator('.ao-mobile-options').waitFor();
      await p.getByRole('button',{name:'Options du bureau',exact:true}).click();
      await p.getByRole('dialog').getByRole('button',{name:'Personnaliser',exact:true}).click();
      await p.locator('.ao-editpanel .ao-character-row').first().waitFor();
      assert.equal(await p.locator('.ao-editpanel').getAttribute('data-mode'),'characters');
      assert.ok(await p.locator('.ao-editpanel .ao-characters__list .ao-character-row').count()>=3,'server-projected roster provides multiple readable rows');
      assert.equal(await p.locator('.ao-editpanel .ao-characters__detail').isVisible(),false,'customize opens the mobile roster list first');
      assert.ok(await p.locator('.ao-editpanel .ao-characters__list').evaluate(node=>node.clientHeight>0));
      const frameMetrics=await p.evaluate(()=>{
        const box=selector=>{const r=document.querySelector(selector)?.getBoundingClientRect();return r&&{top:r.top,bottom:r.bottom,height:r.height,width:r.width};};
        const list=document.querySelector('.ao-editpanel .ao-characters__list');
        return {scrollHeight:document.scrollingElement.scrollHeight,viewport:innerHeight,stage:box('.ao-bureau__stagewrap'),bar:box('.ao-bureau__editbar'),panel:box('.ao-editpanel'),actions:box('.ao-characters__actions'),listScrolls:list.scrollHeight>list.clientHeight+1};
      });
      assert.ok(frameMetrics.scrollHeight<=frameMetrics.viewport+1,`mobile editor fits the viewport: ${JSON.stringify(frameMetrics)}`);
      assert.ok(frameMetrics.bar.height<=56,`mode bar stays compact: ${JSON.stringify(frameMetrics)}`);
      assert.ok(frameMetrics.stage.bottom<=frameMetrics.bar.top+2,`office preview stays above the mode bar: ${JSON.stringify(frameMetrics)}`);
      assert.ok(frameMetrics.listScrolls,'only the character list owns the roster scrolling region');
      assert.ok(frameMetrics.actions.bottom<=frameMetrics.panel.bottom+1,'save/cancel stay inside the editor frame');
      const visibleLabels=await p.locator('.ao-office .ao-plate').evaluateAll(labels=>labels.filter(label=>getComputedStyle(label).display!=='none').map(label=>label.querySelector('.ao-plate__name')?.textContent.trim()));
      assert.ok(visibleLabels.length<=4,`only the backend shortlist and current selection stay labelled on the mobile map: ${visibleLabels.join(', ')}`);
      if(process.env.BUREAU_SCREENSHOTS==='1') {
        await mkdir('design/reports/office-dev-105',{recursive:true});
        await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelectorAll('.ao-office img')].map(img=>img.decode().catch(()=>{})));});
        await p.waitForTimeout(450);
        await p.screenshot({path:`design/reports/office-dev-105/production-characters-${width}-${theme}.png`,animations:'disabled'});
      }
      await p.locator('.ao-editpanel .ao-character-row').first().click();
      await p.locator('.ao-editpanel .ao-characters__detail').waitFor();
      assert.equal(await p.locator('.ao-editpanel .ao-characters__list').isVisible(),false,'the selected character opens in its own mobile detail screen');
      assert.equal(await p.locator('.ao-sc__subtitle').innerText(),'Apparence d’Atlas');
      const characterTiles=await p.locator('.ao-sc__card').evaluateAll(cards=>cards.map(card=>{
        const label=card.lastElementChild.getBoundingClientRect(),box=card.getBoundingClientRect();
        return {text:card.lastElementChild.textContent.trim(),labelFits:label.left>=box.left&&label.right<=box.right&&label.bottom<=box.bottom};
      }));
      assert.ok(characterTiles.length>=2&&characterTiles.every(tile=>tile.labelFits),`character choice labels fit their tiles: ${JSON.stringify(characterTiles)}`);
      assert.equal(await p.locator('.ao-characters__back .bu-icon').evaluate(icon=>getComputedStyle(icon).transform),'none','back control icon points left');
      if(process.env.BUREAU_SCREENSHOTS==='1') {
        await p.evaluate(()=>document.fonts.ready);
        await p.screenshot({path:`design/reports/office-dev-105/production-characters-detail-${width}-${theme}.png`,animations:'disabled'});
      }
      const detailMetrics=await p.evaluate(()=>{
        const detail=document.querySelector('.ao-editpanel .ao-characters__detail');
        const rect=selector=>{const r=document.querySelector(selector)?.getBoundingClientRect();return r&&{x:r.x,width:r.width,height:r.height};};
        return {page:document.scrollingElement.scrollHeight,viewport:innerHeight,detailScrolls:detail.scrollHeight>detail.clientHeight+1,actionsBottom:document.querySelector('.ao-characters__actions').getBoundingClientRect().bottom,frame:rect('.ao-bureau'),body:rect('.ao-bureau__main'),stage:rect('.ao-bureau__stagecol'),aside:rect('.ao-bureau__side'),host:rect('#ao-bureau-editaside'),panel:rect('.ao-editpanel'),characters:rect('.ao-characters'),detail:rect('.ao-characters__detail')};
      });
      assert.ok(detailMetrics.page<=detailMetrics.viewport+1,'detail remains inside the fixed mobile frame');
      assert.ok(detailMetrics.detailScrolls,'long accessory/name controls scroll inside the detail region');
      assert.ok(detailMetrics.panel.width>=width-48,`detail panel fills the phone content width: ${JSON.stringify(detailMetrics)}`);
      assert.deepEqual(errors,[]);
    } finally {await h.close();}
  }
});

test('canonical children stack, own conversations stay reachable as activity, and reparenting follows snapshots without transcripts', {skip,timeout:90000}, async()=>{
  for(const width of [360,390]) for(const theme of ['light','dark']) {
    const h=await openLayoutBrowser({theme,touch:true}),p=h.page,errors=[];
    p.on('pageerror',e=>errors.push(e.message));
    try {
      await p.setViewportSize({width,height:844});await visit(p,h.origin,'/bureau?mock=foule','.ao-mobile-roster');
      const requests=[];p.on('request',r=>{if(r.url().includes('/backend/api/v2/views/sessions/'))requests.push(r.url());});
      await fixture(p,true);
      assert.equal(await p.locator('.ao-mobile-roster [data-mobile-agent]').count(),2);
      assert.equal(await p.locator('.ao-mobile-roster').getByText('Camille',{exact:true}).count(),0);
      const summaryText=await p.locator('.ao-mobile-summary summary').innerText();
      assert.equal(summaryText.includes('6 en activité · 6 au bureau'),true,summaryText);
      if(process.env.BUREAU_SCREENSHOTS==='1'){
        await mkdir('design/reports/mobile-office-options/product',{recursive:true});
        await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(img=>img.decode().catch(()=>{})));});
        await p.screenshot({path:`design/reports/mobile-office-options/product/canonical-teams-${width}-${theme}.png`,animations:'disabled'});
      }
      await p.locator('.ao-mobile-group').first().getByRole('button',{name:/Voir l’équipe de Atlas/}).click();
      const dialog=p.getByRole('dialog',{name:'Équipe de Atlas',exact:true});await dialog.waitFor();
      assert.equal(await dialog.locator('[data-occupant]').count(),3,'parent and two descendants');
      assert.equal(await dialog.getByText('Camille',{exact:true}).count(),0,'a conversation is not a delegated agent');
      await dialog.locator('[data-occupant]').filter({has:p.getByText('Scribe',{exact:true})}).click();
      await p.locator('#ao-drawer-title').waitFor();assert.equal(await p.locator('#ao-drawer-title').innerText(),'Scribe');
      await p.getByRole('button',{name:'Retour à l’équipe',exact:true}).click();await dialog.waitFor();await p.keyboard.press('Escape');
      await p.locator('.ao-mobile-roster').getByRole('button',{name:'Conversations · 1',exact:true}).click();
      const conversations=p.getByRole('dialog',{name:'Conversations',exact:true});await conversations.waitFor();
      assert.equal(await conversations.locator('[data-occupant]').count(),1);
      await conversations.locator('[data-occupant]').click();await p.locator('#ao-drawer-title').waitFor();
      assert.equal(await p.locator('#ao-drawer-title').innerText(),'Camille');
      await p.getByRole('button',{name:'Retour aux conversations',exact:true}).click();await conversations.waitFor();await p.keyboard.press('Escape');
      await p.evaluate(async vm=>{
        const {services}=await import('/services.js');services.stream.applyVM('office',vm);
      },projectedOffice({scribeParent:'claude-session'}));
      await p.locator('.ao-mobile-group').nth(1).getByRole('button',{name:/Voir l’équipe de Claude.*2 sous-agents/}).waitFor();
      await p.locator('.ao-mobile-group').nth(1).getByRole('button',{name:/Voir l’équipe de Claude/}).click();
      const other=p.getByRole('dialog',{name:'Équipe de Claude',exact:true});await other.waitFor();
      assert.equal(await other.getByText('Scribe',{exact:true}).count(),1);await p.keyboard.press('Escape');
      await p.evaluate(async vm=>{
        const {services}=await import('/services.js');services.stream.applyVM('office',vm);
      },projectedOffice({includeChildren:false}));
      await p.locator('.ao-mobile-group').waitFor({state:'detached'});
      assert.equal(await p.locator('.ao-mobile-roster [data-mobile-agent]').count(),2);
      const finalSummary=await p.locator('.ao-mobile-summary summary').innerText();assert.equal(finalSummary.includes('3 en activité · 3 au bureau'),true,finalSummary);
      assert.deepEqual(requests,[],'canonical grouping never requests transcripts');assert.deepEqual(errors,[]);
    } finally {await h.close();}
  }
});

test('mobile Conversations distinguishes coding sessions from chat channels and shows task plus project', {skip,timeout:60000}, async()=>{
  const h=await openLayoutBrowser({theme:'light',touch:true}),p=h.page;
  try {
    await p.setViewportSize({width:390,height:844});await visit(p,h.origin,'/bureau?mock=foule','.ao-mobile-roster');
    await fixture(p,true,true);
    const list=p.locator('.ao-mobile-roster');
    await list.getByRole('button',{name:'Conversations · 2',exact:true}).click();
    const dialog=p.getByRole('dialog',{name:'Conversations',exact:true});await dialog.waitFor();
    const session=dialog.locator('[data-occupant]').filter({has:p.getByText('Fix the conversation title',{exact:true})});
    await session.waitFor();
    assert.match(await session.innerText(),/dans agent-office-redesign/);
    assert.equal(await session.getByText('En attente',{exact:true}).count(),0,'visit phase does not fabricate a waiting state');
    assert.equal(await dialog.getByText('Channel',{exact:true}).count(),0,'coding sessions never inherit a chat role');
    if(process.env.BUREAU_SCREENSHOTS==='1'){
      await mkdir('design/reports/office-dev-81/captures',{recursive:true});
      await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(img=>img.decode().catch(()=>{})));});
      await p.screenshot({path:'design/reports/office-dev-81/captures/mobile-conversations-390-fr-light.png',animations:'disabled'});
    }
    await session.click();await p.locator('#ao-drawer-title').waitFor();
    assert.equal(await p.locator('#ao-drawer-title').innerText(),'Fix the conversation title');
    assert.match(await p.locator('#ao-drawer-desc').innerText(),/Session · Claude Code/);
    assert.deepEqual(await p.locator('.bu-drawer .bu-kv time').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('datetime'))),
      [new Date(FIXTURE_NOW).toISOString(),new Date(FIXTURE_NOW-1000).toISOString()]);
    if(process.env.BUREAU_SCREENSHOTS==='1') await p.screenshot({path:'design/reports/office-dev-81/captures/mobile-session-drawer-390-fr-light.png',animations:'disabled'});
  } finally {await h.close();}
});
