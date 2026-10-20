import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{projectTeamFixture}=require('../helpers/project-team-fixture.cjs');
async function ordinary(t){let h,b;
 try{
  b=await openLayoutBrowser({apiVersion:2,apiProxy:async publicUrl=>{h=await projectTeamFixture({publicUrl});return h.base;}});
  t.after(async()=>{await b.close();await h.close();});
  const created=await h.post('/api/v3/projects',{name:'Synthetic ordinary project',summary:'Original summary'});assert.equal(created.status,200,created.text);const vm=created.json.data.vm;
  const page=b.page;await page.setViewportSize({width:1440,height:900});
  const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  await page.route('**/*api/v3/stream*',route=>route.abort());
  await page.goto(b.origin+'/projets/'+vm.id,{waitUntil:'domcontentloaded'});
  const summary=page.locator('section[aria-labelledby="resume"]');await summary.getByText('Original summary',{exact:true}).waitFor();
  return {h,b,page,vm,summary};
 }catch(error){if(!b){await h?.close();}throw error;}
}
test('ordinary project applies successful command VM without waiting for SSE',{skip:browserSkipReason(),timeout:45000},async t=>{
 const {page,vm,summary}=await ordinary(t);
 await summary.getByRole('button',{name:'Modifier',exact:true}).click();await page.locator('#summary-input').fill('Saved authoritative summary');
 const response=page.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname.endsWith('/projects/'+vm.id));
 await summary.getByRole('button',{name:'Enregistrer',exact:true}).click();const saved=await response;assert.equal(saved.status(),200);assert.ok(new URL(saved.url()).pathname.endsWith('/api/v3/projects/'+vm.id),'command version follows the pinned detail');
 await page.locator('#summary-input').waitFor({state:'detached'});
 assert.deepEqual(await summary.locator('.bu-summary__text').allTextContents(),['Saved authoritative summary'],'command response must reach the same detail subscription');
});
test('ordinary project applies conflict current VM without waiting for SSE',{skip:browserSkipReason(),timeout:45000},async t=>{
 const {h,page,vm,summary}=await ordinary(t);
 const changed=await h.request('PATCH','/api/v3/projects/'+vm.id,{expectedRevision:vm.revision,summary:'Server authoritative summary'});assert.equal(changed.status,200,changed.text);
 await summary.getByRole('button',{name:'Modifier',exact:true}).click();await page.locator('#summary-input').fill('Stale draft summary');
 const response=page.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname.endsWith('/projects/'+vm.id));
 await summary.getByRole('button',{name:'Enregistrer',exact:true}).click();const conflicted=await response;assert.equal(conflicted.status(),409);assert.ok(new URL(conflicted.url()).pathname.endsWith('/api/v3/projects/'+vm.id),'conflict command version follows the pinned detail');
 await summary.getByRole('button',{name:'Annuler',exact:true}).click();await page.locator('#summary-input').waitFor({state:'detached'});
 assert.deepEqual(await summary.locator('.bu-summary__text').allTextContents(),['Server authoritative summary'],'409 current must update the actual detail stream');
});
