import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openLayoutBrowser, visit, browserSkipReason } from './helpers/layout-browser.js';

const skip = browserSkipReason();
async function capture(page, name) {
  if (process.env.FLOORS_SCREENSHOTS !== '1') return;
  const dir = 'design/reports/floors-05';
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png`, animations: 'disabled' });
}

test('floors replace annex scenes and navigate through the desktop elevator panel', { skip, timeout: 60000 }, async () => {
  const h = await openLayoutBrowser(), p = h.page;
  try {
    await p.setViewportSize({ width: 1440, height: 900 });
    await visit(p, h.origin, '/bureau?mock=foule', '.ao-bureau__stage');
    assert.equal(await p.locator('.ao-bureau__stage').count(), 1, 'only one floor scene is mounted');
    assert.equal(await p.locator('.ao-bureau__annexstage').count(), 0);
    assert.ok(await p.locator('.ao-floor-picker [data-floor="2"]').count());
    const floorTwo = p.locator('.ao-floor-picker [data-floor="2"]');
    assert.match(await floorTwo.innerText(), /Étage 2/);
    assert.match(await floorTwo.innerText(), /agents/);
    await floorTwo.click();
    await p.waitForFunction(() => new URL(location.href).searchParams.get('etage') === '2');
    await p.waitForFunction(() => document.querySelector('.ao-bureau__stage')?.dataset.floor === '2');
    assert.equal(await p.locator('.ao-bureau__stage').count(), 1);
    assert.ok(await p.locator('[data-roster-floor="2"]').count());
  } finally { await h.close(); }
});

test('closing an off-floor agent drawer preserves the selected floor by button and Escape', { skip, timeout: 60000 }, async () => {
  const h = await openLayoutBrowser(), p = h.page;
  try {
    await p.setViewportSize({ width: 1440, height: 900 });
    await visit(p, h.origin, '/bureau?mock=foule&etage=2', '.ao-bureau__stage');
    const firstFloorTwoAgent = p.locator('[data-roster-floor="2"] .ao-roster').first();
    await firstFloorTwoAgent.click();
    await p.locator('.bu-drawer #ao-drawer-title').waitFor();
    assert.equal(new URL(p.url()).searchParams.get('etage'), '2');
    await p.getByRole('button', { name: 'Fermer', exact: true }).click();
    await p.locator('.bu-drawer').waitFor({ state: 'detached' });
    assert.equal(new URL(p.url()).searchParams.get('etage'), '2', 'close button preserves the selected floor');
    assert.equal(await p.locator('.ao-bureau__stage').getAttribute('data-floor'), '2');

    await firstFloorTwoAgent.click();
    await p.locator('.bu-drawer #ao-drawer-title').waitFor();
    await p.waitForFunction(() => document.activeElement.getAttribute('aria-label') === 'Fermer');
    await p.keyboard.press('Escape');
    await p.locator('.bu-drawer').waitFor({ state: 'detached' });
    assert.equal(new URL(p.url()).searchParams.get('etage'), '2', 'Escape preserves the selected floor');
    assert.equal(await p.locator('.ao-bureau__stage').getAttribute('data-floor'), '2');

    await firstFloorTwoAgent.click();
    await p.locator('.bu-drawer #ao-drawer-title').waitFor();
    await p.locator('.ao-bureau__scrim').click({ position: { x: 1, y: 1 } });
    await p.locator('.bu-drawer').waitFor({ state: 'detached' });
    assert.equal(new URL(p.url()).searchParams.get('etage'), '2', 'scrim preserves the selected floor');
    assert.equal(await p.locator('.ao-bureau__stage').getAttribute('data-floor'), '2');
  } finally { await h.close(); }
});

test('the registered lobby and gym pack furniture loads in their destination floors', { skip, timeout: 60000 }, async () => {
  const h = await openLayoutBrowser(), p = h.page;
  try {
    await p.setViewportSize({ width: 1440, height: 900 });
    await visit(p, h.origin, '/bureau?mock=foule', '.ao-bureau__stage');
    for (const [floorId, items] of [
      ['rdc', ['floor-ash-receptacle']],
      ['gym', ['floor-weight-rack', 'floor-exercise-bench', 'floor-exercise-mat', 'floor-treadmill']],
    ]) {
      await p.locator(`.ao-floor-picker [data-floor="${floorId}"]`).click();
      await p.waitForFunction(id => document.querySelector('.ao-bureau__stage')?.dataset.floor === id, floorId);
      await p.waitForFunction(ids => ids.every(uid => {
        const img = document.querySelector(`[data-item="${uid}"]`);
        return img && img.complete && img.naturalWidth > 0;
      }), items);
      if (floorId === 'gym') {
        const shell = p.locator('.ao-shell');
        await p.waitForFunction(() => {
          const image = document.querySelector('.ao-shell');
          return image?.complete && image.naturalWidth > 0 && /Office\/floors\/gym\/(day|night)\.webp$/.test(new URL(image.src).pathname);
        });
        assert.match(await shell.getAttribute('src'), /Office\/floors\/gym\/(day|night)\.webp$/);
        await capture(p, 'gym-desktop');
      }
    }
  } finally { await h.close(); }
});

test('editing a non-default floor opens, saves and loads a projected revision without leaving that floor', { skip, timeout: 60000 }, async () => {
  const h = await openLayoutBrowser(), p = h.page;
  try {
    await p.setViewportSize({ width: 1440, height: 900 });
    await visit(p, h.origin, '/bureau?mock=foule&etage=2', '.ao-bureau__stage');
    await p.getByRole('button', { name: 'Personnaliser', exact: true }).click();
    const bar = p.locator('.ao-editbar');
    await bar.waitFor();
    await bar.getByRole('button', { name: 'Thème', exact: true }).click();
    await p.locator('.ao-editpanel section[aria-labelledby="ao-theme-title"] .bu-segmented__opt').nth(2).click();
    await bar.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await bar.waitFor({ state: 'detached' });
    assert.equal(await p.locator('.ao-bureau__stage').getAttribute('data-floor'), '2');

    await p.getByRole('button', { name: 'Personnaliser', exact: true }).click();
    await bar.waitFor();
    await bar.getByRole('button', { name: 'Plus d’actions', exact: true }).click();
    await p.getByRole('menuitem', { name: 'Versions', exact: true }).click();
    const versions = p.getByRole('dialog', { name: 'Versions enregistrées' });
    await versions.waitFor();
    await versions.getByRole('button', { name: 'Charger', exact: true }).nth(1).click();
    await versions.waitFor({ state: 'detached' });
    await bar.getByRole('button', { name: 'Thème', exact: true }).click();
    assert.equal(await p.locator('.ao-editpanel section[aria-labelledby="ao-theme-title"] .bu-segmented__opt[aria-pressed="true"]').innerText(), 'Automatique');
    await bar.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await bar.waitFor({ state: 'detached' });
    assert.equal(await p.locator('.ao-bureau__stage').getAttribute('data-floor'), '2');
  } finally { await h.close(); }
});

test('mobile elevator sheet deep-links to its floor; reduced motion skips the transition', { skip, timeout: 60000 }, async () => {
  const h = await openLayoutBrowser({ touch: true }), p = h.page;
  try {
    await p.setViewportSize({ width: 390, height: 844 });
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await visit(p, h.origin, '/bureau?mock=foule', '.ao-bureau__stage');
    const trigger = p.getByRole('button', { name: /Étages/ });
    await trigger.click();
    const dialog = p.getByRole('dialog', { name: 'Étages' });
    await dialog.waitFor();
    await dialog.locator('[data-floor="2"]').click();
    await p.waitForFunction(() => new URL(location.href).searchParams.get('etage') === '2');
    await p.waitForFunction(() => document.querySelector('.ao-bureau__stage')?.dataset.floor === '2');
    assert.equal(await p.locator('.ao-bureau__stage').count(), 1);
    assert.equal(await p.locator('html').evaluate(el => el.classList.contains('ao-floor-transition')), false);
    await trigger.click();
    const reopened = p.getByRole('dialog', { name: 'Étages' });
    await reopened.waitFor();
    await reopened.locator('[data-floor="gym"]').click();
    await p.waitForFunction(() => document.querySelector('.ao-bureau__stage')?.dataset.floor === 'gym');
    await p.waitForFunction(() => {
      const image = document.querySelector('.ao-shell');
      return image?.complete && image.naturalWidth > 0 && /Office\/floors\/gym\/(day|night)\.webp$/.test(new URL(image.src).pathname);
    });
    assert.match(await p.locator('.ao-shell').getAttribute('src'), /Office\/floors\/gym\/(day|night)\.webp$/);
    await capture(p, 'gym-mobile');
  } finally { await h.close(); }
});

test('the Store keeps the selected floor in its editor adapter and return path', { skip, timeout: 60000 }, async () => {
  const h = await openLayoutBrowser(), p = h.page;
  try {
    await p.setViewportSize({ width: 1440, height: 900 });
    await visit(p, h.origin, '/boutique?etage=2&onglet=mobilier&mock=foule', '.ao-shop__floor-context');
    assert.equal(await p.locator('.ao-shop__floor-context').getAttribute('data-floor-context'), '2');
    assert.match(await p.locator('.ao-shop__floor-context').innerText(), /Étage 2/);
    await p.locator('.ao-shop__back').click();
    await p.waitForFunction(() => new URL(location.href).searchParams.get('etage') === '2');
    await p.waitForFunction(() => document.querySelector('.ao-bureau__stage')?.dataset.floor === '2');
  } finally { await h.close(); }
});
