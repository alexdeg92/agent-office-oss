'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launch, findChrome } = require('./helpers/browser');
let browser;
before(async () => { if (findChrome()) browser = await launch(); });
after(async () => { await browser?.close(); });

test('pack portraits cover primary, floor roster and drawer without avatar metadata loads', { skip: !findChrome(), timeout: 120000 }, async () => {
  const p = await browser.page('/public/v2/office/bureau-dev.html?tick=600000&nom=Atlas&scenario=foule');
  try {
    await p.waitFor('window.officeBench && document.querySelectorAll(".ao-roster").length === 30');
    // Hold scene character updates to isolate avatar requests; floor planning and
    // the actual page, roster, selection and drawer continue to run normally.
    await p.eval(`const { OfficeScene } = await import('/public/v2/office/scene.js');
      OfficeScene.prototype.setOccupants = () => Promise.resolve();
      const B = officeBench, original = B.om.officeVM.bind(B.om);
      window.avatarLook = { character: 'fen', variant: 'moss', accessories: [] };
      B.om.officeVM = async () => { const vm = await original();
        vm.occupants[0].look = avatarLook;
        // Backend roster contract owns home-floor membership; make this fixture's off-floor target explicit.
        const remote = vm.occupants.find(o => o.id !== 'main');
        const floor = vm.rosterFloors.find(f => f.id === 'gym');
        if (!remote || !floor) throw new Error('missing fixture occupant or gym floor');
        remote.floorId = floor.id;
        for (const home of vm.rosterFloors) {
          home.occupantIds = home.occupantIds.filter(id => id !== remote.id);
          if (home === floor) home.occupantIds.push(remote.id);
          const members = home.occupantIds.map(id => vm.occupants.find(o => o.id === id)).filter(Boolean);
          home.count = members.length;
          home.countLabel = { key: 'office.floor.count', params: { n: members.length } };
          home.activeCount = members.some(o => o.state === 'unknown') ? null : members.filter(o => !['idle', 'offline'].includes(o.state)).length;
          home.idleCount = members.filter(o => ['idle', 'offline'].includes(o.state)).length;
          home.statusLabel = home.activeCount == null ? { key: 'office.floor.activityUnknown' }
            : { key: 'office.floor.status', params: { active: home.activeCount, idle: home.idleCount } };
        }
        const floorIds = vm.rosterFloors.flatMap(home => home.occupantIds);
        if (new Set(floorIds).size !== floorIds.length) throw new Error('fixture occupant appears on multiple floors');
        window.remoteAgent = remote.id;
        remote.look = { character: 'orbit', variant: 'teal', accessories: [] };
        return vm;
      };
      performance.clearResourceTimings(); await B.publish('office');`);
    await p.waitFor(`document.querySelector('.ao-roster .bu-avatar img[src*="fen/moss/t.webp"]')?.naturalWidth > 0`);
    const packs = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../design/office/manifest.example.json'))).characterPacks.packs;
    for (const pack of packs) for (const variant of pack.variants) {
      await p.eval(`avatarLook = { character: ${JSON.stringify(pack.id)}, variant: ${JSON.stringify(variant.id)}, accessories: [] }; await officeBench.publish('office');`);
      const source = variant.thumbnail;
      await p.waitFor(`document.querySelector('.ao-roster .bu-avatar img[src*=${JSON.stringify(source)}]')?.naturalWidth > 0`);
      await p.eval(`officeBench.services.router.setQuery({ agent: 'main' });`);
      await p.waitFor(`document.querySelector('.bu-drawer .bu-avatar img[src*=${JSON.stringify(source)}]')?.naturalWidth > 0`);
      await p.waitFor(`document.querySelector('.bu-drawer .bu-avatar')?.dataset.avatarReady === 'true'`);
      assert.ok(await p.eval(`const img = document.querySelector('.bu-drawer .bu-avatar img'), a = img.parentElement.getBoundingClientRect(), i = img.getBoundingClientRect();
        return getComputedStyle(img).visibility === 'visible' && i.left < a.left+a.width/2 && i.right > a.left+a.width/2 && i.top < a.top+a.height/2 && i.bottom > a.top+a.height/2;`), 'decoded thumbnail covers the avatar centre');
      await p.eval(`officeBench.services.router.setQuery({ agent: null });`);
    }
    await p.eval(`avatarLook = { character: 'fen', variant: 'moss', accessories: [] }; await officeBench.publish('office');
      document.querySelector('.ao-roster[data-occupant='+CSS.escape(remoteAgent)+']').click();`);
    await p.waitFor(`document.querySelector('.bu-drawer .bu-avatar img[src*="orbit/teal/t.webp"]')?.naturalWidth > 0`);
    assert.ok(await p.eval(`const floor=document.querySelector('.ao-bureau__stage')?.dataset.floor;
      return floor && floor !== '1' && new URLSearchParams(location.search).get('etage') === floor;`), 'selecting an off-floor agent opens its home floor');
    const urls = await p.eval(`return performance.getEntriesByType('resource').map(r => new URL(r.name).pathname).filter(p => ${JSON.stringify(packs.map(p => p.id))}.some(id => p.includes('/Characters/' + id + '/')));`);
    assert.ok(urls.some(u => u.endsWith('/fen/moss/t.webp')));
    assert.ok(urls.every(u => /\/(t\.webp|thumbnails\/[^/]+\.webp)$/.test(u)), 'avatars only request Store thumbnails');
    assert.deepEqual(p.logs, []);
    if (process.env.AO_AVATAR_SCREENSHOTS === '1') {
      const out = path.resolve(__dirname, '../../design/reports/roster-avatar-1'); fs.mkdirSync(out, { recursive: true });
      for (const [width, height] of [[1440, 900], [390, 844]]) {
        await p.viewport(width, height);
        fs.writeFileSync(path.join(out, `floor-drawer-${width}.png`), await p.screenshot());
        await p.eval(`officeBench.services.router.setQuery({ agent: 'main' });`);
        await p.waitFor(`document.querySelector('.bu-drawer .bu-avatar img[src*="fen/moss/t.webp"]')?.naturalWidth > 0`);
        fs.writeFileSync(path.join(out, `primary-drawer-${width}.png`), await p.screenshot());
        await p.eval(`officeBench.services.router.setQuery({ agent: null });`);
        await p.waitFor(`!document.querySelector('.bu-drawer')`);
        fs.writeFileSync(path.join(out, `roster-${width}.png`), await p.screenshot());
        await p.eval(`officeBench.services.router.setQuery({ agent: remoteAgent });`);
      }
    }
  } finally { await p.close(); }
});
