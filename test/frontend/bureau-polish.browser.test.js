import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { openLayoutBrowser, visit, browserSkipReason } from './helpers/layout-browser.js';
const require = createRequire(import.meta.url);
const { officeDefaults } = require('../../src/api/v2/vm/office');
const { projectOfficeRoster, projectOfficePlacement } = require('../../src/api/v2/vm/office-roster');
const skip = browserSkipReason();
const captureDir = 'design/reports/bureau-polish-01';

// The backend builds this fixture's hierarchy, preview, overflow, ordering and room placement.
async function officeFixture() {
  const vm = JSON.parse(await readFile('docs/architecture/examples/office-vm.json', 'utf8')).data;
  const source = vm.occupants[0], now = Date.now();
  const row = (id, name, runtime, parentId, look, state = 'working') => ({ ...source, id,
    role: id === 'main' ? 'main' : 'agent', name, title: { key: 'sessionTitle.named', params: { name } },
    roleLabel: { key: 'custom', params: { text: 'Agent' } }, runtime, parentId, state, stateSince: now - 1000,
    look, stationUid: null, destination: null, sessionKey: null, summary: '',
  });
  vm.occupants = [
    row('main', 'Atlas', 'OpenClaw', null, { character: 'timmy', accessories: [] }, 'idle'),
    row('agent:pm-t98', 'Project Manager', 'Claude Code', null, { character: 'subagent', variant: 'ochre', accessories: [] }),
    ...Array.from({ length: 7 }, (_, i) => row('agent:member-t98-' + i,
      i === 0 ? 'Responsable de la vérification des intégrations et de la documentation' : 'Agent de vérification ' + (i + 1),
      i % 2 ? 'Codex' : 'Claude Code', 'agent:pm-t98', { character: 'subagent', variant: i % 2 ? 'teal' : 'sage', accessories: [] })),
    ...Array.from({ length: 4 }, (_, i) => row('agent:solo-t98-' + i, 'Un autre agent indépendant ' + (i + 1), 'Codex', null, { character: 'family-b', variant: 'moss', accessories: [] }, 'idle')),
  ];
  vm.journal = []; vm.queue = [];
  const { layout, index } = officeDefaults();
  const projected = projectOfficePlacement(projectOfficeRoster(vm, { now }), { layout, index });
  projected.kpis = projected.kpis.map(kpi => kpi.id === 'active' ? { ...kpi, value: projected.rosterSummary.activeCount,
    sub: { key: 'kpi.onStage', params: { n: projected.rosterSummary.count } } } : kpi);
  return projected;
}

async function feed(page, vm) {
  await page.evaluate(async vm => {
    const { services } = await import('/services.js');
    services.stream.stop(); services.stream.status.set({ conn: 'open' });
    services.stream._topics.get('office').meta = null;
    services.stream.applyVM('office', vm);
  }, vm);
}
async function capture(page, name) {
  if (process.env.BUREAU_POLISH_CAPTURES !== '1') return;
  await mkdir(captureDir, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: captureDir + '/' + name + '.png', animations: 'disabled' });
}

for (const theme of ['light','dark']) test(`Bureau mobile cards, labelled map and sheet close remain coherent at 390px (${theme})`, { skip, timeout: 90000 }, async () => {
  const h = await openLayoutBrowser({ theme, touch: true }), p = h.page;
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  try {
    await p.setViewportSize({ width: 390, height: 844 });
    await visit(p, h.origin, '/bureau?mock=lignee', '.ao-bureau__stage');
    const vm = await officeFixture(); await feed(p, vm);
    const group = p.locator('.ao-mobile-group').filter({ has: p.locator('[data-mobile-agent="agent:pm-t98"]') });
    await group.waitFor(); await group.locator('.bu-avatar[data-avatar-ready=true]').first().waitFor();
    const item = vm.rosterItems.find(item => item.rootId === 'agent:pm-t98');
    assert.equal(await group.locator('.bu-avatar').count(), item.previewOccupantIds.length);
    assert.equal((await group.locator('.ao-mobile-stack__count').innerText()).trim(), '+5');
    assert.match(await group.innerText(), /Sous-agents · 7/);
    const geometry = await group.evaluate(el => {
      const stack = el.querySelector('.ao-mobile-stack').getBoundingClientRect(), label = el.querySelector('.ao-mobile-parent').getBoundingClientRect();
      const avatar = el.querySelector('.bu-avatar'), style = getComputedStyle(avatar);
      return { stackWidth: stack.width, labelGap: label.x - stack.right, shadow: style.boxShadow, stateColor: style.getPropertyValue('--_st').trim() };
    });
    assert.ok(Math.abs(geometry.labelGap - 8) <= 1, JSON.stringify(geometry));
    assert.ok(geometry.shadow.includes('4px'), 'lead keeps the same outer state ring as an individual avatar');
    const standalone = p.locator('[data-mobile-agent=main] .bu-avatar');
    assert.ok(Math.abs((await standalone.boundingBox()).x - (await group.locator('.bu-avatar').first().boundingBox()).x) <= 2, 'avatars share the same left alignment');
    assert.equal(await group.locator('.ao-agentcard__name').getAttribute('title'), 'Project Manager');
    assert.equal(await group.locator('.ao-mobile-parent .bu-cell-sub').first().innerText(), 'Claude Code');
    await capture(p, 'mobile-' + theme + '-390');

    // Follow the backend's team's floor so all group name pills are exercised.
    const floor = vm.occupants.find(row => row.id === 'agent:pm-t98').floorId;
    await p.locator('.ao-floor-mobile-trigger').click();
    await p.locator('[role=dialog] [data-floor="' + floor + '"]').click();
    await p.waitForFunction(id => document.querySelector('.ao-bureau__stage')?.dataset.floor === id, floor);
    const plates = p.locator('.ao-bureau__stage .ao-plate:not([hidden])'); await plates.first().waitFor();
    assert.ok(await p.locator('.ao-bureau__stage .ao-plate').count() >= 7);
    assert.ok(await plates.count() <= 3, 'mobile shows only the bounded backend shortlist');
    const supplied = vm.rosterFloors.find(row => row.id === floor).mobileLabelIds;
    assert.equal(await p.locator('.ao-bureau__stage').evaluate((el, ids) => [...el.aoScene.chars.values()].every(c => c.plate.hidden || ids.includes(c.id)), supplied), true);
    for (const plate of await plates.all()) {
      assert.equal(await plate.locator('.ao-plate__name').isVisible(), true, 'each shown map pill displays the supplied VM name');
      assert.ok((await plate.locator('.ao-plate__name').innerText()).trim());
      assert.ok(await plate.getAttribute('title'), 'full identity is available when a map name is truncated');
    }
    const contained = await plates.evaluateAll(nodes => {
      const view = document.querySelector('.ao-bureau__stage .ao-viewport').getBoundingClientRect();
      return nodes.every(node => { const box = node.getBoundingClientRect(); return box.left >= view.left && box.right <= view.right && box.top >= view.top && box.bottom <= view.bottom; });
    });
    assert.equal(contained, true, 'crowded labels remain inside the map viewport');
    assert.equal(await plates.evaluateAll(nodes => nodes.every(node => {
      const box = node.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('.ao-plate') === node;
    })), true, 'every visible name pill has an unobstructed tap centre');
    await capture(p, 'mobile-team-map-' + theme + '-390');
    const first = plates.first(), selectedName = await first.locator('.ao-plate__name').innerText();
    await first.click();
    await p.locator('#ao-drawer-title').waitFor();
    assert.equal(await p.locator('#ao-drawer-title').innerText(), selectedName, 'visible label hit area opens the matching agent');
    await p.locator('.bu-drawer [aria-label="Fermer"]').click();
    await p.locator('#ao-drawer-title').waitFor({ state: 'detached' });
    await p.locator('[data-overflow-count]').click();
    const sheet = p.getByRole('dialog', { name: 'Agents au bureau', exact: true }); await sheet.waitFor();
    await p.evaluate(() => Promise.all(document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
    const bounds = await sheet.evaluate(el => {
      const head = el.querySelector('.bu-modal__header').getBoundingClientRect(), close = el.querySelector('.bu-modal__header > button').getBoundingClientRect();
      const style = getComputedStyle(el.querySelector('.bu-modal__header'));
      return { rightGap: head.right - parseFloat(style.paddingRight) - close.right, width: close.width, height: close.height };
    });
    assert.ok(Math.abs(bounds.rightGap) <= 1, JSON.stringify(bounds));
    assert.ok(bounds.width >= 44 && bounds.height >= 44);
    await capture(p, 'mobile-roster-' + theme + '-390');
    await sheet.locator('.bu-modal__header > button').click(); await sheet.waitFor({ state: 'detached' });
    await p.setViewportSize({ width: 320, height: 700 });
    assert.equal(await p.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { await h.close(); }
});

for (const theme of ['light','dark']) test(`desktop roster exposes full two-line identities (${theme})`, { skip, timeout: 60000 }, async () => {
  const h = await openLayoutBrowser({ theme }), p = h.page;
  try {
    await p.setViewportSize({ width: 1440, height: 900 });
    await visit(p, h.origin, '/bureau?mock=lignee', '.ao-bureau__stage');
    const vm = await officeFixture(); await feed(p, vm);
    const card = p.locator('.ao-bureau__side [data-occupant="agent:member-t98-0"]'); await card.waitFor();
    const name = card.locator('.ao-roster__name');
    assert.equal(await name.getAttribute('title'), vm.occupants.find(row => row.id === 'agent:member-t98-0').name);
    const lines = await name.evaluate(el => ({ height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight), clamp: getComputedStyle(el).webkitLineClamp, whiteSpace: getComputedStyle(el).whiteSpace }));
    assert.equal(lines.clamp, '2'); assert.equal(lines.whiteSpace, 'normal');
    assert.ok(lines.height > lines.line && lines.height <= lines.line * 2 + 1, JSON.stringify(lines));
    await capture(p, 'desktop-' + theme + '-1440');
  } finally { await h.close(); }
});
