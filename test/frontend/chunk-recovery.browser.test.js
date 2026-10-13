import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openLayoutBrowser, visit, browserSkipReason } from './helpers/layout-browser.js';
const skip = browserSkipReason();
const root = process.env.AO_FREEZE_ROOT || resolve('public/v2');
const captureDir = 'design/reports/ui-freeze-01';
async function navigate(p, path) {
  await p.evaluate(async path => { const { services } = await import('/services.js'); void services.router.navigate(path); }, path);
}
async function frame(p) {
  assert.equal(await p.evaluate(() => document.scrollingElement.scrollHeight === innerHeight && document.scrollingElement.scrollWidth <= innerWidth), true);
}
async function capture(p, name) {
  if (process.env.UI_FREEZE_CAPTURES !== '1') return;
  await mkdir(captureDir, { recursive: true });
  await p.screenshot({ path: `${captureDir}/${name}.png`, animations: 'disabled' });
}

for (const width of [1440,390]) test(`dirty Bureau draft survives a failed accessory chunk and canceled recovery (${width}px)`, {skip,timeout:45000}, async()=>{
  const h=await openLayoutBrowser({root,theme:width===390?'dark':'light'}),p=h.page;
  let documents=0,failed=0,release;const held=new Promise(resolve=>{release=resolve;});
  p.on('request',r=>{if(r.resourceType()==='document')documents++;});
  await p.route('**/office/accessory-pack-loader.js*',async route=>{
    if(route.request().resourceType()==='script'&&failed===0){await held;failed++;return route.abort('internetdisconnected');}
    return route.continue();
  });
  try{
    await p.setViewportSize({width:1440,height:900});
    await visit(p,h.origin,'/bureau?mock=1','.ao-bureau__stage');
    await p.getByRole('button',{name:'Personnaliser',exact:true}).first().click();
    await p.locator('.ao-editbar button').filter({hasText:'Personnages'}).click();
    if(width===390)await p.setViewportSize({width,height:844});
    const name=p.locator('.ao-agentcard input').first(),hat=p.locator('.ao-sc__acc').filter({hasText:'Bonnet'}).first();
    await name.fill('Unsaved synthetic name');await name.dispatchEvent('change');await hat.click();
    release();
    const reload=p.locator('.bu-toasts').getByRole('button',{name:'Recharger',exact:true});
    await reload.waitFor();
    assert.equal(documents,1);assert.equal(await name.inputValue(),'Unsaved synthetic name');assert.equal(await hat.getAttribute('aria-pressed'),'true');
    assert.equal(await p.evaluate(()=>sessionStorage.getItem('ao.chunk-reload')),null,'blocked recovery consumes no reload guard');
    await reload.click();const dialog=p.getByRole('dialog',{name:'Quitter sans enregistrer ?'});await dialog.waitFor();
    await dialog.getByRole('button',{name:'Rester',exact:true}).click();
    await reload.waitFor();assert.equal(documents,1);assert.equal(await name.inputValue(),'Unsaved synthetic name');
    assert.equal(await hat.getAttribute('aria-pressed'),'true');
    assert.equal(await p.evaluate(()=>sessionStorage.getItem('ao.chunk-reload')),null);
    await p.evaluate(async()=>{const {loadModule}=await import('/build-update.js');await loadModule(()=>Promise.reject(Error('concurrent failed chunk'))).catch(()=>{});});
    assert.equal(documents,1,'another failed import cannot bypass a canceled discard');
    await capture(p,`dirty-draft-${width}`);
    await reload.click();await dialog.waitFor();
    await dialog.getByRole('button',{name:'Quitter',exact:true}).click();
    await p.waitForFunction(()=>performance.getEntriesByType('navigation')[0]?.type==='reload');
    await p.waitForFunction(()=>!!document.querySelector('.ao-bureau__stage')?.aoScene);
    assert.equal(documents,2,'only explicit discard consent reloads');assert.equal(failed,1);
    assert.equal(await p.locator('.ao-editbar').count(),0);
  }finally{release();await h.close();}
});

test('Store dirty draft blocks automatic recovery and confirms explicit discard', {skip,timeout:30000},async()=>{
  const h=await openLayoutBrowser({root,theme:'light',touch:true}),p=h.page;let documents=0;
  p.on('request',r=>{if(r.resourceType()==='document')documents++;});
  try{
    await p.setViewportSize({width:390,height:844});
    await visit(p,h.origin,'/boutique?mock=1&onglet=personnages','.ao-shop__grid--looks');
    await p.locator('.ao-shop__grid--looks button[aria-pressed]').filter({hasText:'Cosmo'}).first().click();
    await p.locator('.ao-shop__previewtext .bu-btn--primary').click();
    await p.locator('.ao-shop__savebar.is-dirty').waitFor();
    await p.evaluate(async()=>{const {loadModule}=await import('/build-update.js');await loadModule(()=>Promise.reject(Error('synthetic chunk failure'))).catch(()=>{});});
    const reload=p.locator('.bu-toasts').getByRole('button',{name:'Recharger',exact:true});await reload.waitFor();
    assert.equal(documents,1);
    p.once('dialog',d=>d.dismiss());await reload.click();await reload.waitFor();
    assert.equal(documents,1);await p.locator('.ao-shop__savebar.is-dirty').waitFor();
    p.once('dialog',d=>d.accept());await reload.click();
    await p.waitForFunction(()=>performance.getEntriesByType('navigation')[0]?.type==='reload');
    await p.locator('.ao-shop__savebar:not(.is-dirty)').waitFor();assert.equal(documents,2);
  }finally{await h.close();}
});

test('Settings dirty draft uses its existing discard dialog for chunk recovery', {skip,timeout:30000},async()=>{
  const h=await openLayoutBrowser({root,theme:'dark',touch:true}),p=h.page;let documents=0;
  p.on('request',r=>{if(r.resourceType()==='document')documents++;});
  try{
    await p.setViewportSize({width:390,height:844});
    await visit(p,h.origin,'/parametres?mock=1&onglet=compte','#settings-owner-displayName');
    const name=p.locator('#settings-owner-displayName');await name.fill('Unsaved synthetic account');
    await p.evaluate(async()=>{const {loadModule}=await import('/build-update.js');await loadModule(()=>Promise.reject(Error('synthetic chunk failure'))).catch(()=>{});});
    const reload=p.locator('.bu-toasts').getByRole('button',{name:'Recharger',exact:true});await reload.click();
    const dialog=p.getByRole('dialog',{name:'Quitter sans enregistrer ?'});await dialog.waitFor();
    await dialog.getByRole('button',{name:'Rester ici',exact:true}).click();
    await reload.waitFor();assert.equal(documents,1);assert.equal(await name.inputValue(),'Unsaved synthetic account');
    await reload.click();await dialog.waitFor();await dialog.getByRole('button',{name:'Quitter',exact:true}).click();
    await p.waitForFunction(()=>performance.getEntriesByType('navigation')[0]?.type==='reload');
    await p.locator('#settings-owner-displayName').waitFor();assert.equal(documents,2);
  }finally{await h.close();}
});

for (const width of [1440, 390]) for (const scenario of ['B', 'C', 'D', 'E'])
test(`chunk recovery ${scenario} restores navigation (${width}px)`, { skip, timeout: 45000 }, async () => {
  const h = await openLayoutBrowser({ root, theme: width === 390 ? 'dark' : 'light', touch: width === 390 }), p = h.page;
  let documents = 0, failed = 0, deployed = false, slowReads = 0, oldScriptsDuringCheck = 0;
  const types = [], errors = [];
  p.on('request', r => { if (r.resourceType() === 'document') documents++; });
  p.on('pageerror', e => errors.push(e.message));
  const html = await readFile(resolve(root, 'index.html'), 'utf8');
  const original = /name="ao-build" content="([^"]+)"/.exec(html)[1], updated = 'syntheticnextbuild';
  const target = scenario === 'E' ? '/board.js' : '/pages/health.js';
  await p.route('**/*', async route => {
    const r = route.request(), u = new URL(r.url());
    if (scenario === 'C' && deployed) {
      if (u.pathname === '/build.json') {
        slowReads++;
        await new Promise(resolve => setTimeout(resolve, 3000));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ buildId: updated }) });
      }
      if (r.resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: html.replaceAll(original, updated) });
      if (u.searchParams.get('v') === original) {
        if (r.resourceType() === 'script' && u.pathname === target) oldScriptsDuringCheck++;
        return route.fulfill({ status: 410, headers: { 'cache-control': 'no-store' }, body: 'release replaced' });
      }
      if (u.searchParams.get('v') === updated) {
        u.searchParams.delete('v');
        return route.fulfill({ response: await route.fetch({ url: u.href }) });
      }
    }
    if (deployed && u.pathname === target) {
      types.push(r.resourceType());
      const shouldFail = scenario === 'D' ? r.resourceType() === 'fetch' : r.resourceType() === 'script';
      if (shouldFail && failed === 0) { failed++; return route.abort('internetdisconnected'); }
    }
    return route.continue();
  });
  try {
    await p.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await visit(p, h.origin, scenario === 'E' ? '/sante?mock=1' : '/bureau?mock=1', scenario === 'E' ? '.ao-health__cards' : '.ao-bureau__stage');
    deployed = true;
    if (scenario === 'D') {
      await p.evaluate(() => globalThis.AO_ROUTES.preload('sante'));
      await new Promise((resolve, reject) => {
        const until = Date.now() + 5000;
        const poll = () => failed ? resolve() : Date.now() >= until ? reject(Error('preload did not run')) : setTimeout(poll, 20);
        poll();
      });
      assert.equal(await p.locator('link[rel=modulepreload][href*="pages/health.js"]').count(), 0);
    }
    await navigate(p, scenario === 'E' ? '/discuter' : '/sante');
    if (scenario === 'C') await p.evaluate(async () => {
      // A background import can fail while navigation is waiting for build.json.
      const {loadModule}=await import('/build-update.js');
      void loadModule(()=>Promise.reject(Error('synthetic concurrent chunk failure'))).catch(()=>{});
    });
    await p.locator(scenario === 'E' ? '#chat-texte' : '.ao-health__cards').waitFor({ timeout: 20000 });
    if (scenario === 'C') {
      assert.ok(slowReads > 0); assert.equal(oldScriptsDuringCheck, 0, 'slow stale-build check completes before old chunks are imported');
      assert.equal(await p.locator('meta[name=ao-build]').getAttribute('content'), updated);
    } else assert.equal(failed, 1);
    assert.equal(documents, scenario === 'D' ? 1 : 2, 'a failed fetch prewarm needs no reload; a poisoned module recovers with one reload');
    if (scenario === 'D') assert.equal(types[0], 'fetch');
    await frame(p); await capture(p, `${scenario}-${width}`);
    // Shared dependencies must also work on a second route after recovery.
    await navigate(p, '/projets'); await p.locator('[data-card]').first().waitFor();
    assert.deepEqual(errors, []);
  } finally { await h.close(); }
});

test('permanent chunk failure stops after one reload; manual retry waits offline then recovers', { skip, timeout: 45000 }, async () => {
  const h = await openLayoutBrowser({ root, theme: 'dark', touch: true }), p = h.page;
  let documents = 0, fail = false;
  p.on('request', r => { if (r.resourceType() === 'document') documents++; });
  await p.route('**/pages/health.js*', route => fail && route.request().resourceType() === 'script' ? route.abort('internetdisconnected') : route.continue());
  try {
    await p.setViewportSize({ width: 390, height: 844 });
    await visit(p, h.origin, '/bureau?mock=1', '.ao-bureau__stage'); fail = true;
    await navigate(p, '/sante');
    const retry = p.getByRole('button', { name: 'Réessayer', exact: true }); await retry.waitFor();
    assert.equal(documents, 2, 'loop guard stops permanent failure after one automatic reload');
    await p.context().setOffline(true); await retry.click();
    await p.waitForTimeout(100); assert.equal(documents, 2, 'offline retry does not reload');
    fail = false; await p.context().setOffline(false);
    await p.locator('.ao-health__cards').waitFor(); assert.equal(documents, 3);
    await frame(p);
  } finally { await h.close(); }
});

test('a lazy route stylesheet failure reloads once and recovers the route', { skip, timeout: 30000 }, async () => {
  const h = await openLayoutBrowser({ root }), p = h.page;
  let failed = 0, documents = 0;
  p.on('request', r => { if (r.resourceType() === 'document') documents++; });
  await p.route('**/workspace-mobile.css*', route => {
    if (failed++ === 0) return route.abort('internetdisconnected');
    return route.continue();
  });
  try {
    await visit(p, h.origin, '/bureau?mock=1', '.ao-bureau__stage');
    await navigate(p, '/discuter'); await p.locator('#chat-texte').waitFor();
    assert.equal(documents, 2); assert.ok(failed >= 2);
    await frame(p);
  } finally { await h.close(); }
});

test('late editor import recovers through the same helper and the control works again', { skip, timeout: 30000 }, async () => {
  const h = await openLayoutBrowser({ root }), p = h.page;
  let failed = 0, documents = 0;
  p.on('request', r => { if (r.resourceType() === 'document') documents++; });
  await p.route('**/office/editor.js*', route => {
    if (route.request().resourceType() === 'script' && failed++ === 0) return route.abort('internetdisconnected');
    return route.continue();
  });
  try {
    await p.setViewportSize({ width: 1280, height: 720 });
    await visit(p, h.origin, '/bureau?mock=1', '.ao-bureau__stage');
    await p.getByRole('button', { name: 'Personnaliser', exact: true }).first().click();
    await p.waitForFunction(() => sessionStorage.getItem('ao.chunk-reload') !== null);
    await p.waitForFunction(() => document.querySelector('.ao-bureau__stage')?.aoScene && !document.querySelector('.ao-bureau--editing'));
    assert.equal(documents, 2);
    await p.getByRole('button', { name: 'Personnaliser', exact: true }).first().click();
    await p.locator('.ao-bureau--editing').waitFor();
  } finally { await h.close(); }
});

for (const [width,height] of [[1440,900],[1280,720],[390,844]]) for (const theme of ['light','dark'])
test(`page render boundary keeps shell navigation responsive (${width}px ${theme})`, { skip, timeout: 30000 }, async () => {
  const h = await openLayoutBrowser({ root,theme,touch:width===390 }), p = h.page;
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  await p.route('**/pages/health.js*', route => route.fulfill({ contentType: 'text/javascript', body: `
    import {html,useState} from '/lib.js';
    export function HealthPage(){const [n,set]=useState(0);window.failSyntheticPage=()=>set(1);
      if(n)throw Error('synthetic render failure');return html\`<p id="healthy-page">Ready</p>\`;}` }));
  try {
    await p.setViewportSize({ width, height });
    await visit(p, h.origin, '/sante?mock=1', '#healthy-page');
    await p.evaluate(() => window.failSyntheticPage());
    await p.getByRole('button', { name: 'Réessayer', exact: true }).waitFor();
    await frame(p); await capture(p, `page-boundary-${width}-${theme}`);
    await navigate(p, '/projets'); await p.locator('[data-card]').first().waitFor();
    await frame(p); await capture(p, `recovered-${width}-${theme}`);
    assert.deepEqual(errors, [], 'render error is contained before it can poison the render queue');
  } finally { await h.close(); }
});

test('Bureau skips trip initialization until the latest layout contains its manifest', { skip, timeout: 30000 }, async () => {
  const h = await openLayoutBrowser({ root, theme: 'dark', touch: true }), p = h.page;
  let trips = 0;
  p.on('request', r => { if (new URL(r.url()).pathname === '/office/floor-trips.js') trips++; });
  const source = await readFile(resolve(root, 'office/page.js'), 'utf8');
  await p.route('**/office/page.js*', route => route.fulfill({ contentType: 'text/javascript', body: source.replace('const layout = useLayout();', `
    const realLayout=useLayout();const [hold,setHold]=useState(true);
    useEffect(()=>{window.releaseSyntheticLayout=()=>setHold(false);},[]);
    const layout=hold?{...realLayout,data:undefined}:realLayout;`) }));
  try {
    await p.setViewportSize({ width: 390, height: 844 });
    await p.goto(h.origin + '/bureau?mock=foule');
    await p.waitForFunction(() => !!window.releaseSyntheticLayout);
    await p.evaluate(async () => {
      const {services}=await import('/services.js'); window.syntheticServices = services;
    });
    const snapshot = await p.waitForFunction(() => {
      const vm = window.syntheticServices.stream._topics.get('office')?.state.data;
      return vm?.occupants?.length ? vm : false;
    });
    const vm = await snapshot.jsonValue();
    assert.ok(Array.isArray(vm?.occupants), JSON.stringify({ type: typeof vm, keys: vm && Object.keys(vm) }));
    await p.evaluate(async vm => {
      const {services}=await import('/services.js');
      services.stream.stop();
      services.stream.applyVM('office',{...vm,occupants:vm.occupants.map(o=>({...o,state:'idle',presence:null,destination:null}))});
    }, vm);
    assert.equal(trips, 0, 'an absent manifest cannot start the loader with a stale closure');
    await p.evaluate(() => window.releaseSyntheticLayout());
    await p.locator('.ao-bureau__stage.ao-office').waitFor();
    await p.waitForFunction(() => document.querySelector('.ao-bureau__stage').aoScene?.chars.size > 0);
    await frame(p);
  } finally { await h.close(); }
});
