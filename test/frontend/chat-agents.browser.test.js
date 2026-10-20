import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{chatV3UiFixture}=require('../helpers/chat-v3-ui-fixture.cjs');
const OUT='design/reports/t0197-chat-agents';
function targetInventory(){
 const {scopedId,parseId}=require('../../src/runtime-ids');
 const ids={primary:scopedId('openclaw','agent','main'),pm:scopedId('claude-code','agent','pm-session-agent'),builder:scopedId('codex','agent','backend-codex'),child:scopedId('claude-code','agent','pm-child')};
 const agents=[
  {id:ids.primary,name:'Atlas',isPrimary:true,mainSessionKey:scopedId('openclaw','session','main-thread')},
  {id:ids.pm,name:'PM',isPrimary:false,mainSessionKey:scopedId('claude-code','session','pm-thread')},
  {id:ids.builder,name:'backend-codex',isPrimary:false,mainSessionKey:scopedId('codex','session','builder-thread')},
  {id:ids.child,name:'Review helper',isPrimary:false,spawnedBy:{agentId:ids.pm,sessionKey:'pm-thread',via:'subagent-tool',label:'Review helper'},mainSessionKey:scopedId('claude-code','session','child-thread')},
  ...['agent-office-redesign','dev','agent-office-connect-ux','Project 8a5edab28263'].map((name,n)=>({id:scopedId(n%2?'codex':'openclaw','agent','noise-'+n),name,isPrimary:false}))
 ];
 const session=(key,agentId,kind='conversation')=>({key,class:{kind,agentId},updatedAt:Date.now()});
 const sessions=[session('main',ids.primary),session('pm-thread',ids.pm),session('builder-thread',ids.builder),session('child-thread',ids.child,'subagent'),
  ...agents.filter(row=>row.name.startsWith('agent-office')||row.name==='dev'||row.name.startsWith('Project ')).map(row=>session(scopedId(parseId(row.id,'agent').runtime,'session','noise-'+row.id.slice(-1)),row.id,'project'))];
 const adapters=['openclaw','claude-code','codex'];
 const connectors=Object.fromEntries(adapters.map(adapter=>{const definition=require('../../src/adapters/'+adapter).definition;return [adapter,{id:'fixture-'+adapter,adapter,name:definition.name,mark:definition.mark}];}));
 const runtimes=Object.fromEntries(adapters.map(adapter=>[adapter,{adapterId:adapter,name:connectors[adapter].name,gatewayLabel:'Synthetic gateway',connected:true,capabilities:adapter==='openclaw'?{chat:true,chatSessionScope:'principal'}:{chat:false}}]));
 const members=[{id:'member:pm',name:'PM',teamId:'team:pm',roleKind:'lead',parentMemberId:null,sessionStatus:'known'},
  {id:'member:builder',name:'backend-codex',teamId:'team:pm',roleKind:'member',parentMemberId:'member:pm',sessionStatus:'known'}];
 const orchestratorTeams={getSnapshot:()=>({team:{id:'team:pm',label:'PM team'},members,privateMemberSessionRefs:{
  'member:pm':{agentId:ids.pm,runtimeKind:'claude-code',sessionRef:'pm-session-ref',sessionKey:'pm-thread'},
  'member:builder':{agentId:ids.builder,runtimeKind:'codex',sessionRef:'builder-session-ref',sessionKey:'builder-thread'}
 }})};
 return {agents,sessions,primary:agents[0],connectors,runtimes,orchestratorTeams,expectedTargetCount:5};
}
for(const [width,name] of [[1440,'desktop'],[390,'mobile']])test(`T-0197 fixed real-agent list ${name}`,{skip:browserSkipReason(),timeout:60000},async()=>{
 let browser,fixture;
 try{
  browser=await openLayoutBrowser({theme:'day',touch:width===390,apiVersion:3,apiProxy:async publicUrl=>{fixture=await chatV3UiFixture({publicUrl,historyCount:0,targetInventory:targetInventory()});return fixture.base;}});
  const page=browser.page,height=width===390?844:900;await page.setViewportSize({width,height});
  const split=fixture.cookie.indexOf('=');await page.context().addCookies([{name:fixture.cookie.slice(0,split),value:fixture.cookie.slice(split+1),url:browser.origin,httpOnly:true,sameSite:'Lax'}]);
  await page.goto(browser.origin+'/discuter',{waitUntil:'domcontentloaded'});await page.locator('[data-chat-agent]').first().waitFor();await page.evaluate(()=>document.fonts.ready);
  const apiRows=fixture.targets,agentRows=apiRows.filter(row=>row.kind==='agent');
  assert.deepEqual(agentRows.map(row=>row.name).sort(),['PM','Review helper','Atlas','backend-codex'].sort());
  assert.deepEqual(Object.fromEntries(agentRows.map(row=>[row.name,row.provider.id])),{Atlas:'openclaw',PM:'claude-code','backend-codex':'codex','Review helper':'claude-code'});
  assert.deepEqual(await page.locator('[data-chat-agent]').evaluateAll(rows=>rows.map(row=>row.innerText.trim().split('\n')[0]).sort()),['PM','PM team','Review helper','Atlas','backend-codex'].sort());
  assert.equal(await page.locator('[data-chat-agent]').count(),5);
  for(const noise of ['agent-office-redesign','dev','agent-office-connect-ux','Project 8a5edab28263'])assert.equal(await page.getByText(noise,{exact:true}).count(),0);
  const labels=await page.locator('[data-chat-agent]').evaluateAll(rows=>rows.map(row=>row.innerText));
  assert.ok(labels.some(text=>text.includes('OpenClaw')));assert.ok(labels.some(text=>text.includes('Claude Code')));assert.ok(labels.some(text=>text.includes('Codex')));
  await mkdir(OUT,{recursive:true});const shot=`${OUT}/${name}.png`;await page.screenshot({path:shot,animations:'disabled'});
  await writeFile(`${OUT}/${name}.json`,JSON.stringify({source:process.env.AO_SOURCE_SHA,targets:agentRows.map(({name,provider,capabilities})=>({name,providerId:provider.id,providerLabel:provider.label,sendMessage:capabilities.sendMessage})),grouping:apiRows.filter(row=>row.kind==='team').map(row=>row.name),screenshot:shot},null,2)+'\n');
  await page.goto(browser.origin+'/discuter?vue=sessions',{waitUntil:'domcontentloaded'});
  const sessionsPane=page.locator('[data-chat-pane="sessions"]');await sessionsPane.locator('.ao-messenger__notice').waitFor();
  assert.match(await sessionsPane.locator('.ao-messenger__notice').innerText(),/select an agent|sélectionnez un agent/i);
  assert.ok(await page.getByText('Choisissez un agent',{exact:true}).count()<=1,'the Discussions column must not duplicate the conversation pane empty state');
 }finally{await browser?.close();await fixture?.close();}
});
