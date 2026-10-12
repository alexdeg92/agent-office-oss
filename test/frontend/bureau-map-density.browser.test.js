import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { openLayoutBrowser, visit, browserSkipReason } from './helpers/layout-browser.js';
const require = createRequire(import.meta.url);
const { officeDefaults } = require('../../src/api/v2/vm/office');
const { projectOfficeRoster, projectOfficePlacement } = require('../../src/api/v2/vm/office-roster');
const skip = browserSkipReason();

async function fixture() {
  const vm = JSON.parse(await readFile('docs/architecture/examples/office-vm.json', 'utf8')).data;
  const source = vm.occupants[0], now = Date.now();
  const row = (id, name, parentId, state = 'working') => ({ ...source, id, name, parentId,
    title: { key: 'sessionTitle.named', params: { name } }, role: 'agent',
    roleLabel: { key: 'custom', params: { text: 'Agent' } }, runtime: 'Canonical fixture',
    state, stateSince: now - 1000, look: { character: 'subagent', variant: 'teal', accessories: [] },
    stationUid: null, destination: null, sessionKey: null, summary: '',
  });
  vm.occupants = [row('agent:density-lead', 'Project Manager', null), ...Array.from({ length: 12 }, (_, i) =>
    row('agent:density-' + i, 'Responsable des intégrations ' + (i + 1), 'agent:density-lead'))];
  vm.journal = []; vm.queue = [];
  const { layout, index } = officeDefaults();
  return projectOfficePlacement(projectOfficeRoster(vm, { now }), { layout, index });
}
async function feed(page, vm) {
  await page.evaluate(async vm => {
    const { services } = await import('/services.js');
    services.stream.stop(); services.stream.status.set({ conn: 'open' });
    services.stream._topics.get('office').meta = null; services.stream.applyVM('office', vm);
  }, vm);
}
async function capture(page, name) {
  if (!process.env.MAP_DENSITY_CAPTURES) return;
  const dir = 'design/reports/map-density-01'; await mkdir(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${process.env.MAP_DENSITY_BEFORE ? 'before' : 'after'}-${name}.png`, animations: 'disabled' });
}
for (const theme of ['light', 'dark']) for (const width of [390, 1440, 1280])
test(`bounded mobile map labels keep all 13 floor occupants reachable (${theme}, ${width}px)`, { skip, timeout: 60000 }, async () => {
  const h = await openLayoutBrowser({ theme, touch: width === 390 }), p = h.page;
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  try {
    await p.setViewportSize({ width, height: width === 390 ? 844 : width === 1280 ? 720 : 900 });
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await visit(p, h.origin, '/bureau?mock=lignee', '.ao-bureau__stage');
    const vm = await fixture(), floor = vm.rosterFloors.find(f => f.occupantIds.length === 13);
    assert.ok(floor, 'backend keeps the oversized team on one floor');
    await feed(p, vm);
    if (width === 390) {
      await p.locator('.ao-floor-mobile-trigger').click();
      await p.locator(`[role=dialog] [data-floor="${floor.id}"]`).click();
    } else await p.locator(`.ao-floor-picker [data-floor="${floor.id}"]`).click();
    await p.waitForFunction(id => {
      const stage = document.querySelector('.ao-bureau__stage');
      return stage?.dataset.floor === id && stage.aoScene?.chars.size === 13;
    }, floor.id);
    await p.evaluate(() => document.fonts.ready);
    await p.waitForFunction(() => [...document.querySelector('.ao-bureau__stage').aoScene.chars.values()].every(c => c.head && c.el.querySelector('img')?.complete));
    await capture(p, `${theme}-${width}`);
    if (process.env.MAP_DENSITY_BEFORE) return;
    assert.equal(await p.evaluate(() => document.scrollingElement.scrollHeight === innerHeight && document.scrollingElement.scrollWidth <= innerWidth), true, 'viewport frame never scrolls');
    const result = await p.evaluate(() => {
      const s = document.querySelector('.ao-bureau__stage').aoScene, view = s.viewport.getBoundingClientRect();
      return [...s.chars.values()].filter(c => !c.plate.hidden).map(c => {
        const b = c.plate.getBoundingClientRect(), headX = (c.head.sx + s.origin.x) * s.cam.zoom + s.cam.x, headY = (c.head.sy + s.origin.y) * s.cam.zoom + s.cam.y;
        return { id: c.id, x: b.x - view.x, y: b.y - view.y, w: b.width, h: b.height, headX, headY, viewW: view.width, viewH: view.height };
      });
    });
    if (width === 390) {
      assert.ok(result.length > 0 && result.length <= 3, JSON.stringify(result));
      assert.ok(result.every(r => floor.mobileLabelIds.includes(r.id)), 'only backend IDs get persistent pills');
      for (const r of result) {
        assert.ok(Math.abs(r.x + r.w / 2 - r.headX) <= 1, 'pill is centred on its character, never parked on an edge');
        assert.ok(Math.min(Math.abs(r.y + r.h - r.headY), Math.abs(r.y - r.headY)) <= 40);
        assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= r.viewW && r.y + r.h <= r.viewH);
      }
      for (let i = 0; i < result.length; i++) for (let j = i + 1; j < result.length; j++) {
        const a = result[i], b = result[j];
        assert.ok(Math.abs(a.x + a.w / 2 - b.x - b.w / 2) >= (Math.max(44, a.w) + Math.max(44, b.w)) / 2 || Math.abs(a.y + a.h / 2 - b.y - b.h / 2) >= 44, 'tap targets do not overlap');
      }
      // The renderer must not invent extra labels after selecting an unlisted sprite.
      const target = await p.evaluate(ids => {
        const s = document.querySelector('.ao-bureau__stage').aoScene, view = s.viewport.getBoundingClientRect();
        for (const c of s.chars.values()) if (!ids.includes(c.id)) {
          const b = c.el.getBoundingClientRect(), x = b.x + b.width / 2, y = b.y + b.height * .65;
          if (x > view.left && x < view.right && y > view.top && y < view.bottom && s._occupantAt(x, y) === c.id) return { id: c.id, x, y };
        }
        return null;
      }, floor.mobileLabelIds);
      assert.ok(target, 'an unlabelled sprite remains hit-testable');
      await p.evaluate(id => document.querySelector('.ao-bureau__stage').aoScene.select(id), target.id);
      const selectedLabel = await p.evaluate(id => {
        const s = document.querySelector('.ao-bureau__stage').aoScene, c = s.chars.get(id);
        return { visible: !c.plate.hidden, name: c.plate.querySelector('.ao-plate__name').textContent,
          shownIds: [...s.chars.values()].filter(c => !c.plate.hidden).map(c => c.id) };
      }, target.id);
      assert.equal(selectedLabel.visible, true, 'selection always shows its name in addition to the backend shortlist');
      assert.equal(selectedLabel.name, vm.occupants.find(o => o.id === target.id).name);
      assert.ok(selectedLabel.shownIds.length <= 4 && selectedLabel.shownIds.every(id => id === target.id || floor.mobileLabelIds.includes(id)));
      await capture(p, `selected-${theme}-${width}`);
      await p.evaluate(() => document.querySelector('.ao-bureau__stage').aoScene.select(null));
      await p.touchscreen.tap(target.x, target.y); await p.locator('#ao-drawer-title').waitFor();
      assert.equal(await p.locator('#ao-drawer-title').innerText(), vm.occupants.find(o => o.id === target.id).name);
      assert.equal(await p.locator('.ao-bureau__stage').evaluate((el,id) => !el.aoScene.chars.get(id).plate.hidden, target.id), true);
      await p.locator('.bu-drawer [aria-label="Fermer"]').click(); await p.locator('#ao-drawer-title').waitFor({ state: 'detached' });
      await p.waitForFunction(() => document.querySelector('.ao-bureau__stage').aoScene.selected === null);
      await p.locator('.ao-mobile-stack').click();
      assert.equal(await p.locator('[role=dialog] [data-occupant]').count(), 13, 'roster still lists every occupant');
      await p.locator('[role=dialog] .bu-modal__header > button').click();
      // Replays retain the same shortlist, and resizing restores all desktop labels.
      await feed(p, vm);
      assert.ok(await p.locator('.ao-bureau__stage .ao-plate:not([hidden])').count() <= 3);
      // Projected head collisions cannot create a distant edge column or substitute names.
      const suppressed = await p.evaluate(ids => {
        const s = document.querySelector('.ao-bureau__stage').aoScene;
        for (const id of ids) s.chars.get(id).head = { sx: (s.viewport.clientWidth / 2 - s.cam.x) / s.cam.zoom - s.origin.x,
          sy: (s.viewport.clientHeight / 2 - s.cam.y) / s.cam.zoom - s.origin.y };
        s._positionLabels();
        const colliding = [...s.chars.values()].filter(c => !c.plate.hidden).length;
        for (const id of ids) s.chars.get(id).head = { sx: -10000, sy: -10000 };
        s._positionLabels();
        return { colliding, offscreen: [...s.chars.values()].filter(c => !c.plate.hidden).length };
      }, floor.mobileLabelIds);
      assert.ok(suppressed.colliding <= 2, 'overlapping heads show at most the above/below pair');
      assert.equal(suppressed.offscreen, 0, 'offscreen labels are suppressed instead of clamped to an edge');
      await p.setViewportSize({ width: 1280, height: 720 });
      await p.waitForFunction(() => !document.querySelector('.ao-bureau__stage').hasAttribute('data-plates-primary'));
      assert.equal(await p.locator('.ao-bureau__stage .ao-plate:not([hidden])').count(), 13);
    } else assert.equal(result.length, 13, 'desktop label presentation stays intact');
    assert.deepEqual(errors, []);
  } finally { await h.close(); }
});
