import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url);
const {startServer,waitFor}=require('../helpers/harness');
const {loadScenario}=require('../helpers/scenario');
const {officeDefaults}=require('../../src/api/v2/vm/office');
const {floorLayout}=require('../../src/engine/office/floors');
for(const version of [2,3])for(const width of [1440,390])for(const theme of ['day','night'])
test(`normal v${version} Bureau renders 11 active Floor 2 desk occupants without red overlays: ${theme} ${width}`,{skip:browserSkipReason(),timeout:60000},async()=>{
  const sc=loadScenario('synthetic-basic');
  const workers=Array.from({length:10},(_,n)=>{
    const id='ffffffff-0000-4000-8000-'+String(n+1).padStart(12,'0');
    return {key:'agent:main:subagent:'+id,sessionId:id,kind:'direct',isBackground:true,agentId:'main',subagentRole:'worker',spawnedBy:'agent:main:main',updatedAt:sc.now,status:'active',hasActiveRun:true,totalTokens:100};
  });
  const sessions=[{key:'agent:main:main',sessionId:'ffffffff-5e55-4000-8000-000000000000',kind:'direct',isBackground:false,agentId:'main',isMain:true,updatedAt:sc.now,status:'active',hasActiveRun:true,totalTokens:100},...workers];
  const api=await startServer(sc,{handlers:{
    'agents.list':()=>({defaultId:'main',agents:[{id:'main',name:'Synthetic lead',workspace:'/srv/fake/main',model:'fake-model'}]}),
    'sessions.list':()=>({sessions,totalCount:sessions.length,count:sessions.length,hasMore:false,nextOffset:null,limitApplied:300}),
    'cron.list':()=>({jobs:[]}),
  }});let h;
  try{
    await api.get('/api/v3/office/layout/revisions/1');
    api.withStore(db=>{
      const row=db.prepare('SELECT id,data_json FROM office_layouts WHERE active=1').get();
      const data=JSON.parse(row.data_json),{index}=officeDefaults(),floor=floorLayout(data,index,'2');
      const desk=floor.items.find(i=>i.asset==='desk');
      floor.items.push({...desk,uid:'historical-extra-desk',x:0,y:7});
      floor.theme={mode:'fixed',fixed:theme};
      data.floors=[{id:'2',kind:'office',layout:{room:floor.room,theme:floor.theme,items:floor.items}}];
      const lead=data.agents.find(a=>['primary','main'].includes(a.agentId));lead.homeFloor='2';lead.station='auto';
      db.prepare('UPDATE office_layouts SET data_json=? WHERE id=?').run(JSON.stringify(data),row.id);
    });
    const officeResponse=await waitFor(async()=>{const r=await api.get('/api/v'+version+'/views/office');assert.equal(r.status,200,r.text);return r.json.data.rosterFloors.find(f=>f.id==='2')?.count===11?r:null;},{timeoutMs:20000,what:'all eleven source sessions projected on Floor 2'});
    const office=officeResponse.json.data,floor=office.rosterFloors.find(f=>f.id==='2');
    const people=office.occupants.filter(o=>floor.occupantIds.includes(o.id));
    assert.equal(floor.count,11,JSON.stringify(office.occupants.map(o=>({id:o.id,parentId:o.parentId,state:o.state,floorId:o.floorId,stationUid:o.stationUid}))));assert.equal(floor.activeCount,11);assert.equal(people.length,11);
    assert.ok(people.every(o=>o.state==='working'&&o.floorId==='2'&&o.stationUid&&o.homeTarget.floorId==='2'&&o.sceneTarget.floorId==='2'&&o.activity===null));
    assert.equal(new Set(people.map(o=>o.stationUid)).size,11);
    assert.ok(people.every(o=>floor.layout.items.find(i=>i.uid===o.stationUid)?.asset==='desk'));
    h=await openLayoutBrowser({theme:theme==='day'?'light':'dark',touch:width===390,apiVersion:version});const p=h.page;
    await p.setViewportSize({width,height:width===390?844:900});
    await p.emulateMedia({reducedMotion:'reduce'});
    await p.route('**/backend/**',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(/^\/backend\/api\/v[23]\/stream$/.test(url.pathname))return route.abort();
      const response=await api.request(request.method(),url.pathname.replace(/^\/backend/,'')+url.search,request.postData()?JSON.parse(request.postData()):undefined);
      return route.fulfill({status:response.status,contentType:'application/json',body:response.text});
    });
    await p.goto(h.origin+'/bureau?etage=2',{waitUntil:'domcontentloaded'});
    await p.waitForFunction(()=>!!document.querySelector('.ao-bureau__stage')?.aoScene);
    await p.waitForFunction(()=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene;return s?.chars.size===11&&[...s.chars.values()].every(c=>c.displayed&&c.seatMode==='desk'&&!c.walking);});
    const rendered=await p.evaluate(()=>{const s=document.querySelector('.ao-bureau__stage').aoScene;return [...s.chars.values()].map(c=>({id:c.id,stationUid:c.occ.stationUid,floorId:c.occ.floorId,mode:c.seatMode}));});
    assert.deepEqual(rendered.map(o=>o.id).sort(),floor.occupantIds.slice().sort());
    assert.ok(rendered.every(o=>o.floorId==='2'&&o.mode==='desk'));
    const result=await p.evaluate(()=>{
      const scene=document.querySelector('.ao-bureau__stage').aoScene;
      scene.setLayout(scene.layout);scene.setLayout(scene.layout);
      return {desks:scene.layout.items.filter(i=>i.asset==='desk').length,
        red:[...scene.stage.querySelectorAll('.ao-tint')].filter(n=>!n.hidden&&getComputedStyle(n).display!=='none').length,
        invalid:scene.stage.querySelectorAll('.ghost.bad').length,editing:scene.stage.hasAttribute('data-editing')};
    });
    assert.deepEqual(result,{desks:11,red:0,invalid:0,editing:false});
    await p.waitForFunction(()=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene;return [...s.stage.querySelectorAll('img[src]')].filter(i=>i.getAttribute('src')).every(i=>i.complete&&i.naturalWidth);});
    await p.evaluate(async()=>{
      const images=[...document.querySelector('.ao-bureau__stage').querySelectorAll('img[src]')].filter(i=>i.getAttribute('src'));
      await Promise.all(images.map(i=>i.decode()));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    });
    const visible=await p.evaluate(()=>{
      const s=document.querySelector('.ao-bureau__stage').aoScene,stage=s.stage.getBoundingClientRect();
      return [...s.chars.values()].filter(c=>{const r=c.displayed.getBoundingClientRect();return getComputedStyle(c.displayed).opacity==='1'&&r.width>0&&r.height>0&&r.right>stage.left&&r.left<stage.right&&r.bottom>stage.top&&r.top<stage.bottom&&Number(c.el.style.zIndex)>0;}).length;
    });
    assert.equal(visible,11,'all eleven decoded seated sprites are visible in the stage stacking order');
    await mkdir('design/reports/lobbygym-regression',{recursive:true});
    await p.screenshot({path:`design/reports/lobbygym-regression/floor-2-v${version}-${theme}-${width}.png`,animations:'disabled'});
  }finally{await h?.close();await api.stop();}
});
