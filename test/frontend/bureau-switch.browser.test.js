import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { openLayoutBrowser, browserSkipReason } from './helpers/layout-browser.js';

const require=createRequire(import.meta.url);
const { ROOT, buildId }=require('../../scripts/first-load.js');

const skip = browserSkipReason();
async function fixture(page, origin, transform = body => body) {
  const body = transform(await readFile(new URL('./fixtures/bureau-switch.html', import.meta.url), 'utf8'));
  await page.route('**/__bureau-switch.html', route => route.fulfill({ contentType:'text/html', body }));
  await page.goto(`${origin}/__bureau-switch.html`, { waitUntil:'networkidle' });
  await page.getByRole('switch', { name:'Animations surprises', exact:true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
}

test('shared Bureau: runtime imports and lazy stylesheet use the document release stamp', { skip, timeout:15000 }, async () => {
  const b=await openLayoutBrowser(); const requests=[], errors=[];
  try {
    const version=buildId(), html=await readFile(`${ROOT}/index.html`,'utf8');
    const map=/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1];
    b.page.on('request',request=>{
      const url=new URL(request.url());
      if(/\.(?:js|mjs)$/.test(url.pathname)||url.pathname.endsWith('/components/bureau/bureau.css'))requests.push(url);
    });
    b.page.on('pageerror',error=>errors.push(error.message));
    await fixture(b.page,b.origin,body=>body
      .replace('<title>',`<meta name="ao-build" content="${version}"><title>`)
      .replace(/<script type="importmap">[\s\S]*?<\/script>/,`<script type="importmap">${map}</script>`)
      .replace("import {Switch,loadStyles} from '/components/bureau/index.js';",`const {Switch,loadStyles}=await import('/components/bureau/index.js?v=${version}');`));
    assert.deepEqual(errors,[]);
    for(const name of ['index.js','switch.js','styles.js','control-id.js','bureau.css'])
      assert.ok(requests.some(url=>url.pathname===`/components/bureau/${name}`),name+' was requested');
    assert.ok(requests.length>=8,'Bureau dependencies are also imported');
    for(const url of requests)assert.equal(url.search,`?v=${version}`,url.pathname+' is pinned to the document');
    assert.equal(await b.page.locator('link[data-bureau-controls-css]').count(),1);
  } finally {await b.close();}
});

test('shared Switch: immediate keyboard change, committed pending state, failure recovery and stable label IDs', { skip, timeout:30000 }, async () => {
  const b = await openLayoutBrowser();
  try {
    const p=b.page; await fixture(p,b.origin);
    assert.equal(await p.locator('link[data-bureau-controls-css]').count(),1,'shared stylesheet is loaded once');
    const toggle=p.getByRole('switch',{name:'Animations surprises',exact:true});
    assert.equal(await toggle.isChecked(),true);
    await toggle.focus(); await p.keyboard.press('Space');
    assert.equal(await toggle.isChecked(),false);
    await p.evaluate(()=>window.bureauFixture.state.hold=true);
    await p.keyboard.press('Space');
    assert.equal(await toggle.isChecked(),false,'pending request keeps committed off state');
    assert.equal(await toggle.getAttribute('aria-busy'),'true');
    assert.equal(await toggle.evaluate(e=>e===document.activeElement),true,'busy preserves focus');
    await p.keyboard.press('Space');
    assert.deepEqual(await p.evaluate(()=>window.bureauFixture.state.calls),[false,true],'busy blocks repeat request');
    await p.evaluate(()=>window.bureauFixture.settle(false));
    assert.equal(await toggle.isChecked(),false);
    assert.equal(await toggle.getAttribute('aria-describedby'),'surprises-help surprises-error');
    assert.equal(await p.getByRole('alert').textContent(),'La modification a échoué. Réessayez.');
    await p.keyboard.press('Space'); await p.evaluate(()=>window.bureauFixture.settle(true));
    assert.equal(await toggle.isChecked(),true); assert.equal(await p.getByRole('alert').count(),0);
    assert.equal(await toggle.getAttribute('aria-describedby'),'surprises-help');
    const ids=await p.getByRole('switch').evaluateAll(es=>es.map(e=>({id:e.id,labels:[...e.labels].map(l=>l.textContent.trim())})));
    assert.equal(new Set(ids.map(e=>e.id)).size,3); assert.ok(ids.every(e=>e.labels.length===1));
    await p.evaluate(()=>window.bureauFixture.draw());
    assert.deepEqual(await p.getByRole('switch').evaluateAll(es=>es.map(e=>e.id)),ids.map(e=>e.id));
    assert.equal(await p.getByRole('switch',{name:'Préférence indisponible'}).isDisabled(),true);
    const long=p.getByRole('switch').nth(1); await long.click();
    assert.equal(await long.isChecked(),false,'parent that declines a change keeps its value');
  } finally { await b.close(); }
});

test('shared styles: failed loading removes the link and allows a real retry', { skip, timeout:15000 }, async () => {
  const b=await openLayoutBrowser();let requests=0;
  try {
    await b.page.route('**/components/bureau/bureau.css',route=>++requests===1?route.abort():route.continue());
    await fixture(b.page,b.origin,body=>body.replace('await Promise.all([loadStyles(),loadStyles()]);',"try { await loadStyles(); } catch(error) { window.styleFailure=error.message; await loadStyles(); }"));
    assert.equal(requests,2);
    assert.equal(await b.page.evaluate(()=>window.styleFailure),'Bureau controls stylesheet unavailable');
    assert.equal(await b.page.locator('link[data-bureau-controls-css]').count(),1);
    assert.equal(await b.page.locator('.bu-control-switch__track').first().evaluate(e=>e.getBoundingClientRect().width),40);
  } finally { await b.close(); }
});

test('shared Switch: current Bureau light/dark desktop/mobile geometry, focus and screenshot evidence', { skip, timeout:45000 }, async () => {
  const b=await openLayoutBrowser({touch:true}); const records=[];
  const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  try {
    await b.page.emulateMedia({reducedMotion:'reduce'});
    await fixture(b.page,b.origin);
    for(const [width,height] of [[1440,900],[390,844],[375,667]])for(const theme of ['light','dark'])for(const state of ['on','off','focus','pending','error']) {
      await b.page.setViewportSize({width,height});
      await b.page.evaluate(({theme,state})=>{
        document.documentElement.dataset.theme=theme;
        Object.assign(window.bureauFixture.state,{checked:state!=='off',busy:state==='pending',error:state==='error'?'La modification a échoué. Réessayez.':null});
        window.bureauFixture.draw();
      },{theme,state});
      const toggle=b.page.getByRole('switch',{name:'Animations surprises',exact:true});
      if(state==='focus'){await toggle.focus();await b.page.keyboard.press('Tab');await b.page.keyboard.press('Shift+Tab');}
      else await toggle.evaluate(e=>e.blur());
      await b.page.waitForFunction(()=>document.getAnimations().every(a=>a.playState!=='running'||a.effect.getComputedTiming().iterations===Infinity));
      const geometry=await b.page.evaluate(()=>{
        const track=document.querySelector('.bu-control-switch__track'),probe=document.createElement('span');probe.style.color='var(--bu-bg-sunken)';document.body.append(probe);
        const offColor=getComputedStyle(probe).color;probe.remove();
        return {width:document.documentElement.scrollWidth,viewport:innerWidth,controls:[...document.querySelectorAll('input')].map(e=>({id:e.id,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})),track:track.getBoundingClientRect().toJSON(),focus:getComputedStyle(track).outlineStyle,checked:document.querySelector('#surprises').checked,trackColor:getComputedStyle(track).backgroundColor,offColor,thumbX:new DOMMatrix(getComputedStyle(track,'::after').transform).m41,progress:document.querySelectorAll('.bu-control-switch__progress').length};
      });
      assert.ok(geometry.width<=width,'long label contained');
      assert.ok(geometry.controls.every(c=>c.height>=(width<821?44:40)),'full label is native hit target');
      assert.equal(geometry.track.width,40); assert.equal(geometry.track.height,24);
      if(state==='focus')assert.equal(geometry.focus,'solid');
      assert.equal(geometry.checked,state!=='off');
      assert.equal(geometry.progress,state==='pending'?1:0,'pending has visible progress');
      if(state==='off'){assert.equal(geometry.trackColor,geometry.offColor);assert.equal(geometry.thumbX,0,'off thumb settled at left');}
      if(process.env.BUREAU_SCREENSHOTS==='1'){
        const filename=`switch-${width}-${theme}-${state}.png`;await mkdir('design/reports/bureau-components-checkpoint-1',{recursive:true});
        await b.page.screenshot({path:`design/reports/bureau-components-checkpoint-1/${filename}`});records.push({filename,revision,width,height,theme,state,geometry});
      }
    }
    if(records.length)await writeFile('design/reports/bureau-components-checkpoint-1/captures.json',JSON.stringify(records,null,2)+'\n');
  } finally { await b.close(); }
});
