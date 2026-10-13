import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { browserSkipReason, openLayoutBrowser } from './helpers/layout-browser.js';

const skip = browserSkipReason();
const options = { skip, timeout: 90000 };
async function capture(p, name) {
  if (process.env.MOBILE_PWA_CAPTURES !== '1') return;
  const folder = 'design/reports/mobile-pwa-t0077';
  await mkdir(folder, { recursive: true });
  await p.screenshot({ path: `${folder}/fixed-${name}.png`, animations: 'disabled' });
}
async function mobile(width, run) {
  const h = await openLayoutBrowser({ touch: true }), p = h.page, errors = [];
  p.on('pageerror', e => errors.push(e.message));
  try {
    await p.setViewportSize({ width, height: width === 390 ? 844 : 640 });
    const cdp = await p.context().newCDPSession(p);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await run(p, h.origin, cdp);
    assert.deepEqual(errors, [], 'faults are contained; navigation produces no uncaught errors');
  } finally { await h.close(); }
}
async function open(p, origin) {
  await p.goto(origin + '/bureau?mock=1&agent=Atlas', { waitUntil: 'domcontentloaded' });
  await ready(p);
}
async function ready(p) {
  await p.waitForFunction(() => !!document.querySelector('.ao-bureau__stage')?.aoScene);
}
async function navigate(p, path) {
  await p.evaluate(async path => {
    const build = document.querySelector('meta[name="ao-build"]').content;
    const { services } = await import('/services.js?v=' + build);
    await services.router.navigate(path);
  }, path);
}
async function countListeners(p) {
  await p.addInitScript(() => {
    const owned = new WeakSet(), remove = window.removeEventListener;
    window.__sceneListeners = 0;
    window.addEventListener = function(type, fn, ...args) {
      if (type === 'office-surprises-setting' && !owned.has(fn)) { owned.add(fn); __sceneListeners++; }
      return EventTarget.prototype.addEventListener.call(this, type, fn, ...args);
    };
    window.removeEventListener = function(type, fn, ...args) {
      if (type === 'office-surprises-setting' && owned.delete(fn)) __sceneListeners--;
      return remove.call(this, type, fn, ...args);
    };
    const addTarget = EventTarget.prototype.addEventListener;
    window.__sceneGlobalListeners = 0;
    EventTarget.prototype.addEventListener = function(type, fn, options) {
      if ((this === window || this === document) && options?.signal && !options.signal.aborted) {
        __sceneGlobalListeners++;
        addTarget.call(options.signal, 'abort', () => { __sceneGlobalListeners--; }, { once: true });
      }
      return addTarget.call(this, type, fn, options);
    };
  });
}
async function visibleMap(p) {
  await p.waitForFunction(() => {
    const stage = document.querySelector('.ao-bureau__stage'), box = stage?.getBoundingClientRect();
    return [...(stage?.querySelectorAll('img') ?? [])].some(img => {
      const r = img.getBoundingClientRect();
      return img.naturalWidth && !img.hidden && r.width && r.height && r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom;
    });
  });
  assert.equal(await p.locator('.ao-viewport').first().evaluate(e => getComputedStyle(e).position), 'absolute');
}

for (const width of [390, 360]) {
  test(`PWA ${width}: leaving Bureau releases the scene, listeners and pending work`, options, () => mobile(width, async (p, origin) => {
    await countListeners(p); await open(p, origin);
    for (let i = 0; i < 3; i++) {
      await p.evaluate(() => { window.__oldStage = document.querySelector('.ao-bureau__stage'); window.__oldScene = __oldStage.aoScene; });
      await navigate(p, '/journaux');
      await p.locator('.ao-logs').waitFor();
      await p.waitForFunction(() => __oldScene.destroyed);
      assert.deepEqual(await p.evaluate(() => ({
        handle: !!__oldStage.aoScene, raf: __oldScene._raf, actors: __oldScene.chars.size,
        images: __oldScene._imgKeep.size, nodes: __oldStage.childElementCount, listeners: __sceneListeners,
      })), { handle: false, raf: 0, actors: 0, images: 0, nodes: 0, listeners: 0 });
      await p.evaluate(() => { delete window.__oldStage; delete window.__oldScene; });
      await navigate(p, '/bureau'); await ready(p);
      assert.equal(await p.evaluate(() => __sceneListeners), 1);
    }
  }));

  test(`PWA ${width}: hidden, frozen and offscreen walking pauses without a resume jump`, options, () => mobile(width, async (p, origin) => {
    await open(p, origin);
    await p.evaluate(() => {
      const s = document.querySelector('.ao-bureau__stage').aoScene;
      s.lifeConfig.enabled = false; s.setFrozen(false);
      const c = [...s.chars.values()][0];
      c.path = [{ x: c.pos.x + 20, y: c.pos.y }]; c.walking = true;
      window.__walk = c; window.__scene = s; s._kick();
    });
    for (const mode of ['frozen', 'hidden', 'offscreen', 'pagehide', 'freeze']) {
      await p.evaluate(mode => {
        const s = __scene;
        s._nextFrame(__walk, () => { window.__finishedFrame = true; });
        if (mode === 'frozen') s.setFrozen(true);
        if (mode === 'offscreen') { s._offscreen = true; s._syncHidden(); }
        if (mode === 'hidden') { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }
        if (mode === 'pagehide') window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        if (mode === 'freeze') document.dispatchEvent(new Event('freeze'));
        window.__pausedPosition = { ...__walk.pos };
        s._kick(); s._frame(performance.now() + 5000);
      }, mode);
      await p.waitForTimeout(200);
      assert.equal(await p.evaluate(() => __scene._raf), 0, mode + ': no pending walking frame');
      assert.equal(await p.evaluate(() => __walk.rafs.size), 0, mode + ': no pending decorative frame');
      assert.equal(await p.evaluate(() => __finishedFrame), true, mode + ': enter/crossfade changes finish immediately');
      assert.deepEqual(await p.evaluate(() => __walk.pos), await p.evaluate(() => __pausedPosition), mode + ': no movement');
      const resumed = await p.evaluate(mode => {
        const s = __scene;
        if (mode === 'frozen') s.setFrozen(false);
        if (mode === 'offscreen') { s._offscreen = false; s._syncHidden(); }
        if (mode === 'hidden') { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); }
        if (mode === 'pagehide') window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        if (mode === 'freeze') document.dispatchEvent(new Event('resume'));
        // First resumed frame must reset elapsed time, even after a long suspension.
        cancelAnimationFrame(s._raf); s._frame(performance.now() + 30000);
        return { position: { ...__walk.pos }, paused: { ...__pausedPosition } };
      }, mode);
      assert.deepEqual(resumed.position, resumed.paused, mode + ': no catch-up step');
      await p.waitForFunction(() => __walk.pos.x > __pausedPosition.x);
    }
  }));

  test(`PWA ${width}: critical CSS is awaited before a scene can mount`, options, () => mobile(width, async (p, origin) => {
    let release;
    const held = new Promise(r => { release = r; });
    await p.route('**/office/office.css?*', async route => { await held; await route.continue(); });
    await p.goto(origin + '/bureau?mock=1&agent=Atlas', { waitUntil: 'domcontentloaded' });
    await p.getByText('La carte du bureau est en cours de chargement.', { exact: true }).waitFor();
    assert.equal(await p.locator('.ao-bureau__stage').count(), 0);
    await capture(p, `css-${width}-loading`);
    release(); await ready(p); await visibleMap(p);
  }));

  for (const failure of ['abort', '410']) test(`PWA ${width}: failed CSS (${failure}) is removed and retried after online/navigation`, options, () => mobile(width, async (p, origin) => {
    let broken = true, requests = 0, documents = 0;
    p.on('request',r=>{if(r.resourceType()==='document')documents++;});
    await p.route('**/office/office.css?*', route => {
      requests++;
      return broken ? failure === 'abort' ? route.abort() : route.fulfill({ status: 410, body: 'Synthetic obsolete asset', contentType: 'text/plain' }) : route.continue();
    });
    await p.goto(origin + '/bureau?mock=1&agent=Atlas', { waitUntil: 'domcontentloaded' });
    const retry = p.getByRole('button', { name: 'Réessayer', exact: true });
    await retry.waitFor();
    await p.waitForFunction(()=>sessionStorage.getItem('ao.chunk-reload')!==null);
    await p.waitForFunction(()=>performance.getEntriesByType('navigation')[0]?.type==='reload');
    await retry.waitFor();
    assert.equal(documents,2,'one automatic reload resets the failed document');
    assert.equal(requests,2,'the guarded fresh document makes one more stylesheet request');
    assert.equal(await p.locator('link[data-office*="/office.css"]').count(), 0, 'failed link removed');
    assert.equal(await p.locator('.ao-bureau__stage').count(), 0);
    await capture(p, `css-${failure}-${width}-retry`);
    await Promise.all([p.waitForEvent('framenavigated',f=>f===p.mainFrame()),retry.click()]);
    await p.waitForFunction(() => document.querySelector('[role="alert"]'));
    await p.waitForFunction(() => !document.querySelector('link[data-office*="/office.css"]'));
    assert.equal(requests, 3, 'explicit retry reloads the document and makes a fresh request');
    assert.equal(documents,3);
    broken = false;
    await p.evaluate(() => window.dispatchEvent(new Event('online')));
    await ready(p); await visibleMap(p);
    await capture(p, `css-${failure}-${width}-recovered`);
    assert.equal(requests, 4);
    // A fresh document fails once, then route navigation recovers without reloading the app.
    broken = true; await p.reload({ waitUntil: 'domcontentloaded' }); await retry.waitFor();
    await navigate(p, '/journaux'); await p.locator('.ao-logs').waitFor();
    broken = false; await navigate(p, '/bureau'); await ready(p); await visibleMap(p);
    assert.equal(requests, 6);
    assert.equal(await p.locator('link[data-office*="/office.css"]').count(), 1);
  }));

  test(`PWA ${width}: failed scene initialization is contained and retries keep one scene`, options, () => mobile(width, async (p, origin) => {
    await countListeners(p);
    await p.addInitScript(() => { window.__failScene = 'early'; });
    await p.route('**/office/scene.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: await response.text() + `
        for (const [method, phase] of [['setLayout','early'],['_syncReduced','late'],['setPrimaryLabels','page'],['setOccupants','occupants'],['setSignals','signals']]) {
          const original=OfficeScene.prototype[method];
          OfficeScene.prototype[method]=function(...args){
            if(method==='setLayout'){this.__layoutCalls=(this.__layoutCalls??0)+1;if(this.__layoutCalls>=2 && globalThis.__failScene==='replay')throw Error('Synthetic replay failure');}
            if(globalThis.__failScene===phase)throw Error('Synthetic init failure');
            return original.apply(this,args);
          };
        }` });
    });
    await p.goto(origin + '/bureau?mock=1&agent=Atlas', { waitUntil: 'domcontentloaded' });
    const retry = p.getByRole('button', { name: 'Réessayer', exact: true });
    const phases = ['early', 'late', 'page', 'occupants', 'signals', 'replay'];
    for (let i = 0; i < phases.length; i++) {
      await retry.waitFor();
      assert.equal(await p.locator('.ao-bureau__stage').count(), 1);
      assert.equal(await p.locator('.ao-mobile-options').count(), 1);
      assert.equal(await p.evaluate(() => __sceneListeners), 0, 'partly initialized constructor releases its window listener');
      assert.equal(await p.evaluate(() => __sceneGlobalListeners), 0, 'all scene-owned window/document listeners released');
      assert.equal(await p.locator('.ao-bureau__stage > *').count(), 0);
      assert.equal(await p.evaluate(async () => {
        const build = document.querySelector('meta[name="ao-build"]').content;
        const { services } = await import('/services.js?v=' + build);
        return services.cueListeners?.size ?? 0;
      }), 0, 'failed replay releases its cue subscription');
      await p.evaluate(phase => { __failScene = phase; }, phases[(i + 1) % phases.length]);
      await retry.click();
    }
    await retry.waitFor();
    await capture(p, `init-${width}-retry`);
    await p.evaluate(() => { __failScene = false; }); await retry.click();
    await ready(p); await visibleMap(p);
    await capture(p, `init-${width}-recovered`);
    assert.equal(await p.evaluate(() => __sceneListeners), 1);
    assert.ok(await p.evaluate(() => __sceneGlobalListeners > 0));
    assert.equal(await p.locator('.ao-bureau__stage .ao-viewport').count(), 1);
    await p.waitForFunction(() => document.querySelector('.ao-bureau__stage').aoScene.chars.size > 0);
    for (const phase of ['occupants', 'signals']) {
      await p.evaluate(async phase => {
        window.__failedScene = document.querySelector('.ao-bureau__stage').aoScene;
        __failScene = phase;
        const build = document.querySelector('meta[name="ao-build"]').content;
        const { services } = await import('/services.js?v=' + build);
        const stream = services.stream, vm = structuredClone(stream._topics.get('office').state.data);
        stream.stop(); stream.status.set({ conn: 'open' });
        stream._topics.get('office').meta = null;
        vm.occupants[0].state = 'waiting'; vm.occupants[0].stateSince = Date.now();
        vm.journal = [];
        stream.applyVM('office', vm);
      }, phase);
      await retry.waitFor();
      assert.equal(await p.evaluate(() => __failedScene.destroyed), true, 'later state faults destroy the live scene');
      assert.equal(await p.evaluate(() => __sceneGlobalListeners), 0);
      assert.equal(await p.evaluate(() => !!document.querySelector('.ao-bureau__stage').aoScene), false);
      await p.evaluate(() => { __failScene = false; }); await retry.click(); await ready(p);
      await p.waitForFunction(() => [...document.querySelector('.ao-bureau__stage').aoScene.chars.values()].some(c => c.occ.state === 'waiting'));
      await p.evaluate(() => { delete window.__failedScene; });
    }
    await navigate(p, '/journaux'); await p.locator('.ao-logs').waitFor();
    await p.waitForFunction(() => __sceneListeners === 0);
    assert.equal(await p.evaluate(() => __sceneGlobalListeners), 0);
    await navigate(p, '/bureau'); await ready(p);
    assert.equal(await p.locator('.ao-mobile-options').count(), 1);
    assert.equal(await p.evaluate(() => __sceneListeners), 1);
  }));

  test(`PWA ${width}: a slow complete build check gates new chunks while existing controls remain responsive`, options, () => mobile(width, async (p, origin) => {
    await open(p, origin);
    let reads = 0, release;
    const held=new Promise(resolve=>{release=resolve;});
    await p.route('**/build.json', async route => { reads++;await held;await route.continue(); });
    await p.evaluate(async () => {
      const build = document.querySelector('meta[name="ao-build"]').content;
      const { services } = await import('/services.js?v=' + build);
      void services.router.navigate('/journaux');
    });
    await p.waitForTimeout(1100);
    assert.equal(new URL(p.url()).pathname,'/bureau','no old chunk is imported on an elapsed deadline');
    await p.locator('.ao-mobile-options').click();await p.getByRole('dialog').waitFor();
    await p.getByRole('dialog').getByRole('button',{name:'Fermer',exact:true}).click();
    assert.equal(reads, 1, 'concurrent checks share the held navigation request');
    release();
    await p.locator('.ao-logs:not([aria-busy="true"])').waitFor({ timeout: 5000 });
    assert.equal(new URL(p.url()).pathname, '/journaux');
    await navigate(p, '/bureau'); await ready(p);
    await p.locator('.ao-mobile-options').click();
    await p.getByRole('dialog').waitFor();
    await p.getByRole('dialog').getByRole('button', { name: 'Fermer', exact: true }).click();
    await p.getByRole('dialog').waitFor({ state: 'hidden' });
  }));
}
