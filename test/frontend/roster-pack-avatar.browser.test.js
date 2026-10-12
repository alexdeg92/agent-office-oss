import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openLayoutBrowser, visit, browserSkipReason } from './helpers/layout-browser.js';

test('actual app shell renders pack avatars across floors with one metadata load per used pack', { skip: browserSkipReason(), timeout: 120000 }, async () => {
  const h = await openLayoutBrowser(); const p = h.page;
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  const meta = []; p.on('request', r => { if (/\/(fen|orbit)\/manifest\.json/.test(r.url())) meta.push(new URL(r.url()).pathname); });
  try {
    await visit(p, h.origin, '/bureau?mock=foule', '.ao-bureau__stage');
    await p.evaluate(async () => {
      const api = await import('/api.js'), { services } = await import('/services.js');
      const { data: vm } = await api.get('/api/v2/office/layout');
      vm.layout.data.agents[0] = { ...vm.layout.data.agents[0], name: 'Atlas · Documentation', character: 'fen', variant: 'moss', accessories: [] };
      vm.layout.data.agents[1] = { ...vm.layout.data.agents[1], character: 'orbit', variant: 'teal', accessories: [] };
      await api.put('/api/v2/office/layout', { expectedRevision: vm.layout.revision, data: vm.layout.data });
      services.stream.retry('layout'); services.stream.retry('office');
    });
    await p.waitForFunction(() => document.querySelector('.ao-roster img[src*="fen/moss/t.webp"]')?.naturalWidth > 0);
    await p.waitForFunction(() => [...document.querySelectorAll('.ao-bureau__stage img[src*="fen/moss/"]')].some(i => i.naturalWidth === 192));
    await p.waitForFunction(() => document.querySelector('.ao-bureau__stage')?.aoScene?.chars.get('main')?.displayed?.querySelector('img[src*="fen/moss/"]')?.naturalWidth === 192);
    assert.equal(meta.filter(u => u.includes('/fen/')).length, 1);
    const overflow=await p.evaluate(async()=>{
      const {services}=await import('/services.js');
      const vm=services.stream._topics.get('office').state.data;
      const occupant=vm.occupants.find(o=>o.look.character==='orbit');
      const floor=vm.rosterFloors.find(f=>f.occupantIds.includes(occupant.id));
      return {id:floor.id,occupant:occupant.id};
    });
    if (overflow.id !== '1') {
      await p.locator('.ao-floor-picker [data-floor="'+overflow.id+'"]').click();
      await p.waitForFunction(id=>document.querySelector('.ao-bureau__stage')?.dataset.floor===id,overflow.id);
      await p.waitForFunction(()=>[...document.querySelectorAll('.ao-bureau__stage img[src*="orbit/teal/"]')].some(i=>i.naturalWidth===192));
    }
    assert.equal(meta.filter(u => u.includes('/orbit/')).length, 1, 'second floor reuses the pack metadata request');
    const out = new URL('../../design/reports/roster-avatar-1/', import.meta.url);
    if (process.env.AO_AVATAR_SCREENSHOTS === '1') await mkdir(out, { recursive: true });
    for (const theme of ['light', 'dark']) for (const width of [1440, 390, 375]) {
      await p.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await p.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      const mobile=width<600;
      if(mobile) {
        await p.locator('.ao-mobile-roster').waitFor();
        assert.equal(await p.locator('.ao-bureau__stage').evaluate(el=>el.classList.contains('ao-office')&&el.hasAttribute('data-plates-primary')),true);
        await p.waitForFunction(async () => {
          const stage = document.querySelector('.ao-bureau__stage'), {services} = await import('/services.js');
          const floor = services.stream._topics.get('office').state.data.rosterFloors.find(f=>f.id===stage.dataset.floor);
          const chars = [...stage.aoScene.chars.values()];
          return chars.length > 0 && chars.every(c=>c.plate.hidden || floor.mobileLabelIds.includes(c.id));
        });
      }
      const primary=p.locator(mobile?'.ao-mobile-roster [data-mobile-agent="main"]':'.ao-bureau__side .ao-roster[data-occupant="main"]');
      assert.equal(await primary.locator('img[src*="fen/moss/t.webp"]').count(),1);
      await primary.click();
      await p.waitForFunction(() => document.querySelector('.bu-drawer img[src*="fen/moss/t.webp"]')?.naturalWidth > 0);
      await p.locator('.bu-drawer').evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
      assert.ok(await p.locator('.bu-drawer').evaluate(el => {
        const style = getComputedStyle(el), box = el.getBoundingClientRect();
        const top = document.elementFromPoint(box.right - 16, box.top + 16);
        return style.opacity === '1' && !style.backgroundColor.startsWith('rgba') && el.contains(top);
      }), 'drawer has an opaque surface above the roster and shell');
      if (process.env.AO_AVATAR_SCREENSHOTS === '1') await writeFile(new URL(`app-primary-${theme}-${width}.png`, out), await p.screenshot());
      await p.keyboard.press('Escape');
      await p.locator('.bu-drawer').waitFor({ state: 'hidden' });
      await p.locator('.ao-bureau > .ao-frame__body').evaluate(el => { el.scrollTop = 0; });
      if (process.env.AO_AVATAR_SCREENSHOTS === '1') await writeFile(new URL(`app-office-${theme}-${width}.png`, out), await p.screenshot());
      if(mobile) {
        await p.locator('.ao-floor-mobile-trigger').click();
        await p.locator('[role=dialog] [data-floor="'+overflow.id+'"]').click();
      } else await p.locator('.ao-floor-picker [data-floor="'+overflow.id+'"]').click();
      await p.waitForFunction(id=>document.querySelector('.ao-bureau__stage')?.dataset.floor===id,overflow.id);
      await p.waitForFunction(()=>[...document.querySelectorAll('.ao-bureau__stage img[src*="orbit/teal/"]')].some(i=>i.naturalWidth===192));
      if(mobile) { await p.locator('[data-overflow-count]').click(); await p.locator('[role=dialog] [data-occupant="'+overflow.occupant+'"]').waitFor(); }
      await p.locator(mobile?'[role=dialog] [data-occupant="main"]':'.ao-bureau__side [data-occupant="main"]').scrollIntoViewIfNeeded();
      if (process.env.AO_AVATAR_SCREENSHOTS === '1') await writeFile(new URL(`app-roster-${theme}-${width}.png`, out), await p.screenshot());
      const annexCard=p.locator(`${mobile?'[role=dialog]':'.ao-bureau__side'} [data-occupant="${overflow.occupant}"]`);
      assert.equal(await annexCard.locator('img[src*="orbit/teal/t.webp"]').count(),1);
      await annexCard.click();
      await p.locator('.bu-drawer img[src*="orbit/teal/t.webp"]').waitFor();
      await p.locator('.bu-drawer').evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
      if (process.env.AO_AVATAR_SCREENSHOTS === '1') await writeFile(new URL(`app-floor-${theme}-${width}.png`, out), await p.screenshot());
      await p.keyboard.press('Escape'); await p.locator('.bu-drawer').waitFor({ state: 'hidden' });
    }
    assert.equal(meta.filter(u=>u.includes('/fen/')).length,1);assert.equal(meta.filter(u=>u.includes('/orbit/')).length,1,'all avatar surfaces and reopened rooms share one metadata load');
    assert.deepEqual(errors, []);
  } finally { await h.close(); }
});
