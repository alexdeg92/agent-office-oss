import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
import {assertOverlayLayout} from './helpers/overlay-layout.js';

const require=createRequire(import.meta.url),{projectTeamFixture}=require('../helpers/project-team-fixture.cjs');

for(const width of [390,1440])for(const theme of ['light','dark'])test(`T-0191 seven-person rows ${width}px ${theme}`,{skip:browserSkipReason(),timeout:120000},async()=>{
  let browser,fixture;
  try{
    browser=await openLayoutBrowser({theme,touch:width===390,apiVersion:3,apiProxy:async publicUrl=>{fixture=await projectTeamFixture({publicUrl,memberCount:7});return fixture.base;}});
    const page=browser.page,height=width===390?844:900;
    await page.setViewportSize({width,height});
    const split=fixture.cookie.indexOf('=');
    await page.context().addCookies([{name:fixture.cookie.slice(0,split),value:fixture.cookie.slice(split+1),url:browser.origin,httpOnly:true,sameSite:'Lax'}]);
    await page.goto(`${browser.origin}/projets/${encodeURIComponent(fixture.projectId)}`,{waitUntil:'domcontentloaded'});
    await page.locator('.ao-team-project').waitFor({state:'visible'});
    await page.getByRole('button',{name:/Personnes/}).click();
    const dialog=page.getByRole('dialog',{name:'Personnes impliquées',exact:true});
    await dialog.waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelectorAll('[data-member-id] [data-avatar-ready="true"]').length===7);
    await page.waitForFunction(()=>[...document.querySelectorAll('[data-member-id] .ao-brand-mark')].every(mark=>mark.classList.contains('ao-brand-mark--ready')));
    await assertOverlayLayout(page,`T-0191 people rows ${width}px ${theme}`,['dialog']);
    const result=await dialog.evaluate(el=>{
      const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      const rows=[...el.querySelectorAll('[data-member-id]')].map(row=>({
        id:row.dataset.memberId,depth:Number(row.dataset.memberDepth),row:rect(row),portrait:rect(row.querySelector('.ao-project-member__portrait')),
        name:rect(row.querySelector('.ao-project-member__copy > strong')),detail:rect(row.querySelector('.ao-project-member__detail')),
        runtime:rect(row.querySelector('.ao-project-member__runtime')),runtimeLabelDisplay:getComputedStyle(row.querySelector('.ao-project-member__runtime-label')).display,
        status:rect(row.querySelector('.ao-project-member__status')),hasMark:!!row.querySelector('.ao-brand-mark'),text:row.innerText,
        overflow:row.scrollWidth>row.clientWidth+1,
      }));
      return {dialog:rect(el),body:rect(el.querySelector(':scope > .ao-frame__body')),rows,viewport:{width:innerWidth,height:innerHeight},pageWidth:document.scrollingElement.scrollWidth};
    });
    assert.equal(result.rows.length,7,'the capture includes the full seven-member hierarchy');
    assert.equal(result.pageWidth,width,'no page-level horizontal overflow');
    assert.ok(result.rows.some(row=>row.depth>0),'fixture includes indented sub-members');
    assert.ok(result.rows.every(row=>row.hasMark),'each member carries its adapter-provided runtime mark');
    assert.ok(result.rows.every(row=>!row.overflow),'member content fits without horizontal clipping');
    if(width===1440){
      assert.ok(result.dialog.width>=710&&result.dialog.width<=730,`desktop people dialog should be about 720px, got ${result.dialog.width}`);
      assert.ok(result.rows.every(row=>Math.abs(row.status.right-result.rows[0].status.right)<2),'desktop status chips share a flush right edge');
      assert.ok(result.rows.every(row=>row.runtimeLabelDisplay!=='none'),'desktop runtime chips include their provider label');
    }else{
      assert.ok(Math.abs(result.dialog.left)<1&&Math.abs(result.dialog.right-width)<1,'phone sheet reaches both viewport edges');
      assert.ok(result.rows.every(row=>row.runtime.width<=26&&row.runtimeLabelDisplay==='none'),'phone runtime chip is logo-only');
      assert.ok(result.rows.every(row=>Math.abs(row.status.right-result.rows[0].status.right)<2),'phone status chips share a flush right edge');
      assert.ok(result.rows.every(row=>Math.abs((row.status.top+row.status.bottom-row.row.top-row.row.bottom)/2)<3),'phone status stays vertically aligned in the member row beside the runtime mark');
    }
    await mkdir('design/reports/t0191-people-rows',{recursive:true});
    await page.screenshot({path:`design/reports/t0191-people-rows/${width}-${theme}.png`,animations:'disabled'});
    assert.deepEqual(await page.evaluate(()=>window.__AO_VM_ISSUES||[]),[]);
  }finally{
    await browser?.close();
    await fixture?.close();
  }
});
