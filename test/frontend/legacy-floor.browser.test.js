import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url);
const {startServer}=require('../helpers/harness');
const {loadScenario}=require('../helpers/scenario');
const {officeDefaults}=require('../../src/api/v2/vm/office');
const {floorLayout}=require('../../src/engine/office/floors');
for(const width of [1440,390])for(const theme of ['day','night'])
test(`normal Bureau retains 11 historical Floor 2 desks without red overlays: ${theme} ${width}`,{skip:browserSkipReason(),timeout:60000},async()=>{
  const api=await startServer(loadScenario('synthetic-basic'));let h;
  try{
    await api.get('/api/v3/office/layout/revisions/1');
    api.withStore(db=>{
      const row=db.prepare('SELECT id,data_json FROM office_layouts WHERE active=1').get();
      const data=JSON.parse(row.data_json),{index}=officeDefaults(),floor=floorLayout(data,index,'2');
      const desk=floor.items.find(i=>i.asset==='desk');
      floor.items.push({...desk,uid:'historical-extra-desk',x:0,y:7});
      floor.theme={mode:'fixed',fixed:theme};
      data.floors=[{id:'2',kind:'office',layout:{room:floor.room,theme:floor.theme,items:floor.items}}];
      db.prepare('UPDATE office_layouts SET data_json=? WHERE id=?').run(JSON.stringify(data),row.id);
    });
    h=await openLayoutBrowser({theme:theme==='day'?'light':'dark',touch:width===390});const p=h.page;
    await p.setViewportSize({width,height:width===390?844:900});
    await p.route('**/backend/**',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.pathname==='/backend/api/v2/stream')return route.abort();
      const response=await api.request(request.method(),url.pathname.replace(/^\/backend/,'')+url.search,request.postData()?JSON.parse(request.postData()):undefined);
      return route.fulfill({status:response.status,contentType:'application/json',body:response.text});
    });
    await p.goto(h.origin+'/bureau?etage=2',{waitUntil:'domcontentloaded'});
    await p.waitForFunction(()=>!!document.querySelector('.ao-bureau__stage')?.aoScene);
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
    await mkdir('design/reports/lobbygym-regression',{recursive:true});
    await p.screenshot({path:`design/reports/lobbygym-regression/floor-2-${theme}-${width}.png`,animations:'disabled'});
  }finally{await h?.close();await api.stop();}
});
