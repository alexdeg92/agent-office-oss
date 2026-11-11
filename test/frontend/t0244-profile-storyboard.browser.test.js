import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { browserPath } from './helpers/layout-browser.js';

const require = createRequire(import.meta.url);
const { settingsFixture } = require('../helpers/settings-fixture');
const { createFrontendServer } = require('../../scripts/serve-frontend');
const sharp = require('sharp');
const skip = !browserPath();
const OUT = 'design/reports/t0244-profile-avatar/captures';
const WIDTHS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
const THEMES = ['light', 'dark'];

async function openApp() {
  let frontend, browser, fixture, avatarMode = 'full', selectableCharacterIds = [], manifestRequests = 0;
  const server = createServer((req, res) => frontend ? frontend.emit('request', req, res) : (res.writeHead(503), res.end()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    await browser?.close(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await fixture?.close();
  };
  try {
    fixture = await settingsFixture({ publicUrl: origin });
    const owner = fixture.store.users.owner();
    fixture.store.avatars.setCharacter(owner.id, 'fen', { character: 'fen', variant: 'sage', accessories: [] });
    frontend = createFrontendServer({ root: resolve('public/v2'), apiBase: '/backend', apiVersion: 2, apiProxy: fixture.base });
    browser = await chromium.launch({ executablePath: browserPath(), headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
    const context = await browser.newContext({ bypassCSP: true });
    const sep = fixture.cookie.indexOf('=');
    await context.addCookies([{ name: fixture.cookie.slice(0, sep), value: fixture.cookie.slice(sep + 1), url: origin, httpOnly: true, sameSite: 'Lax' }]);
    await context.addInitScript(() => { localStorage.setItem('ao.locale', 'fr'); localStorage.setItem('ao.uiTheme', 'light'); });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort());
    await context.route('**/backend/api/v2/me', async route => {
      const response = await route.fetch();
      const body = await response.json();
      if (body?.data) body.data.roleName = 'Propriétaire';
      const avatar = body?.data?.avatar;
      selectableCharacterIds = Array.isArray(avatar?.characterChoices) ? avatar.characterChoices.map(choice => choice.id) : [];
      if (avatarMode === 'missing-capabilities' && body?.data?.avatar) delete body.data.avatar.capabilities;
      if (avatarMode === 'missing-upload-policy' && body?.data?.avatar) {
        body.data.avatar.uploadLimits = { acceptedTypes: [], maxBytes: 0, maxPixels: 0 };
      }
      await route.fulfill({ response, body: JSON.stringify(body) });
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('request', request => { if (request.url().includes('office/manifest.example.json')) manifestRequests++; });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/parametres?onglet=compte', { waitUntil: 'domcontentloaded' });
    await page.locator('#settings-section-form').waitFor();
    await page.locator('.bu-usercard__role').filter({ hasText: 'Propriétaire' }).waitFor();
    return { page, selectableCharacterIds: () => [...selectableCharacterIds], manifestRequests: () => manifestRequests, resetManifestRequests() { manifestRequests = 0; }, setAvatarMode(value) { avatarMode = value; },
      close: async () => { await close(); assert.deepEqual(errors, []); } };
  } catch (error) { await close(); throw error; }
}

const portraitSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><rect width="240" height="240" fill="#ead7c6"/><path d="M24 240c9-58 45-84 96-84s87 26 96 84" fill="#49677d"/><ellipse cx="120" cy="96" rx="53" ry="65" fill="#c98f73"/><path d="M66 88c1-51 23-75 58-75 43 0 65 31 61 79-17-20-41-30-65-28-20 2-37 12-54 24" fill="#49352f"/><circle cx="101" cy="99" r="5" fill="#252a31"/><circle cx="140" cy="99" r="5" fill="#252a31"/><path d="M106 126q14 12 29 0" fill="none" stroke="#87594e" stroke-width="5" stroke-linecap="round"/></svg>');

async function waitForPaint(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test('T-0244 approved profile avatar flow: 28 mounted full-shell frames', { skip, timeout: 420000 }, async t => {
  const app = await openApp(); t.after(() => app.close());
  const { page } = app;
  await page.locator('#settings-tab-compte').click();
  await page.locator('#settings-section-form').waitFor();
  await page.getByRole('heading', { name: 'Photo de profil' }).waitFor();
  await mkdir(OUT, { recursive: true });
  let count = 0;
  const captureState = async state => {
    for (const { width, height } of WIDTHS) for (const theme of THEMES) {
      await page.setViewportSize({ width, height });
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      if (state === 'uses') {
        const body = page.locator('.ao-frame__body[aria-label="Compte"]');
        const heading = page.locator('.ao-account-avatar-uses__heading');
        await heading.evaluate(element => element.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' }));
        const bodyBox = await body.boundingBox();
        const usesBox = await heading.boundingBox();
        assert.ok(usesBox.y >= bodyBox.y && usesBox.y < bodyBox.y + bodyBox.height,
          'the profile usage previews are visible in each viewport');
      }
      if (state === 'characters') {
        const geometry = await page.getByRole('dialog').evaluate(dialog => {
          const body = dialog.querySelector('.ao-frame__body');
          const footer = dialog.querySelector('.bu-modal__footer');
          const preview = dialog.querySelector('.ao-account-character-picker__preview');
          const colour = dialog.querySelector('.ao-account-character-picker__colour');
          const accessories = dialog.querySelector('.ao-account-character-picker__accessories');
          const list = accessories?.querySelector(':scope > div');
          if (body) body.scrollTop = 0;
          const rect = element => {
            const box = element?.getBoundingClientRect();
            return box && { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height };
          };
          return { body: rect(body), footer: rect(footer), preview: rect(preview), colour: rect(colour), accessories: rect(accessories), list: rect(list),
            listScrollHeight: list?.scrollHeight ?? 0, listClientHeight: list?.clientHeight ?? 0, listOverflowY: list ? getComputedStyle(list).overflowY : '',
            maxListHeight: list ? getComputedStyle(list).maxHeight : '' };
        });
        assert.ok(geometry.body && geometry.footer && geometry.preview && geometry.colour && geometry.accessories && geometry.list,
          'the customization preview, colour controls, accessories and modal frame are present');
        for (const region of [geometry.preview, geometry.colour, geometry.accessories, geometry.list]) {
          assert.ok(region.top >= geometry.body.top - 1 && region.bottom <= geometry.body.bottom + 1,
            'customization controls remain inside the modal body above the fixed footer: ' + JSON.stringify(geometry));
        }
        assert.ok(geometry.listScrollHeight > geometry.listClientHeight + 1,
          'the long accessory set has its own reachable scroll area');
        assert.ok(geometry.listOverflowY === 'auto' || geometry.listOverflowY === 'scroll',
          'the bounded accessory area remains independently scrollable');
        assert.ok(geometry.list.height <= (width <= 820 ? 62 : 73),
          'accessory rows stay bounded so the preview and colour swatches remain visible');
        const reachesLastAccessory = await page.getByRole('dialog').evaluate(dialog => {
          const list = dialog.querySelector('.ao-account-character-picker__accessories > div');
          const last = list?.querySelector('button:last-child');
          if (!list || !last) return false;
          list.scrollTop = list.scrollHeight;
          const clip = list.getBoundingClientRect(), item = last.getBoundingClientRect();
          const reachable = item.top >= clip.top - 1 && item.bottom <= clip.bottom + 1;
          list.scrollTop = 0;
          return reachable;
        });
        assert.ok(reachesLastAccessory, 'the final accessory remains reachable inside its bounded scroll area');
      }
      await page.evaluate(() => document.fonts.ready);
      await waitForPaint(page);
      const screenshot = `${OUT}/${state}-${theme}-${width}.png`;
      await page.screenshot({ path: screenshot, animations: 'disabled' });
      count++;
    }
  };

  // Stage the reset on a synthetic saved character so the real reset action is visible and exercised.
  const resetButton = page.getByRole('button', { name: 'Retirer', exact: true });
  await resetButton.waitFor();
  await resetButton.click();
  await resetButton.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.ao-account-avatar__row .ao-profile-avatar img').count(), 0,
    'reset returns the staged avatar to initials');
  await captureState('initials');
  assert.equal(await page.locator('.ao-account-avatar__row .ao-profile-avatar').evaluate(el => el.getBoundingClientRect().width), 80,
    'profile avatar keeps the approved 80px size on phone');
  await page.locator('#settings-owner-displayName').fill('Camille Exemple');
  await captureState('editing');
  assert.deepEqual(await page.locator('.ao-settings__dirty-text').evaluate(el => {
    const style = getComputedStyle(el); return { text: el.textContent, whiteSpace: style.whiteSpace, clipped: el.scrollWidth > el.clientWidth };
  }), { text: 'Modifications non enregistrées : Compte', whiteSpace: 'normal', clipped: false }, 'phone save status is fully readable');
  assert.ok(await page.locator('.ao-settings__footer .bu-btn-group').evaluate(el => {
    const box = el.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth;
  }), 'phone save actions remain inside the viewport');
  await page.locator('#settings-owner-displayName').fill('Camille');

  app.resetManifestRequests();
  await page.getByRole('button', { name: 'Choisir un personnage', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('listbox').waitFor();
  const tiles = dialog.getByRole('option');
  assert.equal(await tiles.count(), 11, 'the picker shows each installed character pack exactly once');
  assert.equal(app.manifestRequests(), 0, 'the profile picker uses the authoritative VM and does not fetch the office pack manifest');
  const shownIds = await tiles.evaluateAll(elements => elements.map(element => element.dataset.characterId).sort());
  assert.deepEqual(shownIds, app.selectableCharacterIds().slice().sort(), 'the picker renders exactly the selectable character IDs provided by the server');
  assert.equal(await dialog.locator('[aria-selected="true"]').count(), 0, 'an initials avatar does not cause the client to select a default character');
  assert.equal(await dialog.getByText('Robot principal').count(), 0);
  assert.equal(await dialog.getByText('Sous-agent').count(), 0);
  assert.equal(await dialog.getByText('Pose de l’aperçu').count(), 0);
  await dialog.getByRole('option', { name: /Renard/ }).click();
  await dialog.getByRole('button', { name: 'Choisir Renard', exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Annuler', exact: true }).waitFor();
  const preview = dialog.locator('[data-account-avatar-preview="true"]');
  const decodePreview = () => preview.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await decodePreview();
  const previewLayers = async () => preview.locator('img').evaluateAll(images => images.map(image => ({
    accessory: image.dataset.previewAccessory || null, layer: image.dataset.previewLayer, src: new URL(image.src).pathname,
  })));
  const initialPreview = await previewLayers();
  assert.ok(initialPreview.some(layer => layer.layer === 'body'), 'the preview renders the VM-selected colour sprite');
  const previewAccessory = dialog.locator('.ao-account-character-picker__chip[data-preview-available="true"][aria-pressed="false"]').first();
  await previewAccessory.waitFor();
  const previewAccessoryId = await previewAccessory.getAttribute('data-accessory-id');
  const previewAccessoryIndex = await previewAccessory.evaluate(element => [...element.parentElement.children].indexOf(element));
  await previewAccessory.click();
  await page.waitForFunction(previous => {
    const node = document.querySelector('[data-account-avatar-preview="true"]');
    const current = [...(node?.querySelectorAll('img') || [])].map(image => ({ accessory: image.dataset.previewAccessory || null,
      layer: image.dataset.previewLayer, src: new URL(image.src).pathname }));
    return JSON.stringify(current) !== JSON.stringify(previous);
  }, initialPreview);
  await decodePreview();
  const customizedPreview = await previewLayers();
  assert.ok(customizedPreview.some(layer => layer.accessory === previewAccessoryId),
    'toggling an accessory adds its VM-provided composed layer to the character preview');
  await dialog.locator('.ao-account-character-picker__chip').nth(previewAccessoryIndex).click();
  await page.waitForFunction(accessoryId => {
    const node = document.querySelector('[data-account-avatar-preview="true"]');
    const current = [...(node?.querySelectorAll('img') || [])].map(image => ({ accessory: image.dataset.previewAccessory || null,
      layer: image.dataset.previewLayer, src: new URL(image.src).pathname }));
    return !current.some(layer => layer.accessory === accessoryId);
  }, previewAccessoryId);
  assert.ok(!(await previewLayers()).some(layer => layer.accessory === previewAccessoryId),
    'removing an accessory removes its composed layer from the preview');
  const footerButtons = dialog.locator('.bu-modal__footer .bu-button');
  assert.equal(await footerButtons.count(), 2);
  const mobileDialog = await dialog.boundingBox();
  const mobileViewport = page.viewportSize();
  assert.equal(mobileDialog.x, 0, 'phone picker reaches the left viewport edge');
  assert.equal(mobileDialog.width, mobileViewport.width, 'phone picker fills the viewport width');
  const buttonBoxes = await footerButtons.evaluateAll(buttons => buttons.map(button => {
    const { x, width } = button.getBoundingClientRect(); return { x, width };
  }));
  assert.ok(Math.abs(buttonBoxes[0].width - buttonBoxes[1].width) <= 1, 'stacked phone actions have equal widths');
  await page.setViewportSize({ width: 1440, height: 900 });
  const desktopDialog = await dialog.boundingBox();
  const closeBox = await dialog.getByRole('button', { name: 'Fermer' }).boundingBox();
  assert.ok(Math.abs((desktopDialog.x + desktopDialog.width) - (closeBox.x + closeBox.width) - 20) <= 3,
    'desktop character-picker close button aligns with the dialog right inset');
  await captureState('characters');
  await dialog.getByRole('button', { name: 'Choisir Renard', exact: true }).click();
  await page.locator('.ao-account-avatar__row .ao-profile-avatar').waitFor();
  await page.locator('.ao-account-avatar__row .ao-character-avatar[data-avatar-ready="true"]').waitFor();
  await captureState('account');

  await page.getByRole('button', { name: 'Importer une photo', exact: true }).click();
  await page.getByRole('dialog').getByRole('heading', { name: 'Importer une photo' }).waitFor();
  const photo = await sharp(portraitSvg).png().toBuffer();
  const fileInput = page.locator('.ao-account-avatar input[type=file]');
  await fileInput.setInputFiles({ name: 'portrait-synthetic.png', mimeType: 'image/png', buffer: photo });
  await page.locator('.ao-avatar-crop__frame img').evaluate(image => image.decode());
  await captureState('upload');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Importer une photo', exact: true }).click();
  await fileInput.setInputFiles({ name: 'oversized-photo.png', mimeType: 'image/png', buffer: Buffer.alloc(6 * 1024 * 1024) });
  await page.getByRole('dialog').getByRole('alert').waitFor();
  assert.equal(await page.locator('.ao-account-avatar > [role=alert]').count(), 0,
    'the upload error appears once inside the open dialog, not behind its scrim');
  const errorDialog = page.getByRole('dialog');
  const errorFooterButtons = errorDialog.locator('.bu-modal__footer .bu-button');
  assert.equal(await errorFooterButtons.count(), 1);
  const errorButtonBox = await errorFooterButtons.first().boundingBox();
  const errorFooterBox = await errorDialog.locator('.bu-modal__footer').boundingBox();
  assert.ok(errorButtonBox.width >= errorFooterBox.width - 48, 'single phone action fills the available footer row');
  await captureState('upload-error');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Importer une photo', exact: true }).click();
  await fileInput.setInputFiles({ name: 'portrait-synthetic.png', mimeType: 'image/png', buffer: photo });
  await page.locator('.ao-avatar-crop__frame img').evaluate(image => image.decode());
  await page.getByRole('dialog').getByRole('button', { name: 'Utiliser cette photo', exact: true }).click();
  await page.locator('.ao-account-avatar-uses').getByRole('heading', { name: 'Où votre profil apparaît' }).waitFor();
  await page.locator('.ao-account-avatar-uses .ao-profile-avatar img').first().evaluate(image => image.decode());
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await captureState('uses');

  app.setAvatarMode('missing-capabilities');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#settings-section-form').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Choisir un personnage', exact: true }).count(), 0,
    'missing capability flags fail closed for character selection');
  assert.equal(await page.getByRole('button', { name: 'Importer une photo', exact: true }).count(), 0,
    'missing capability flags fail closed for uploads');
  assert.equal(await page.locator('.ao-account-avatar input[type=file]').count(), 0,
    'missing capability flags do not leave an undisplayed upload input');

  app.setAvatarMode('missing-upload-policy');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#settings-section-form').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Choisir un personnage', exact: true }).count(), 1,
    'the server-provided character capability and list remain usable');
  assert.equal(await page.getByRole('button', { name: 'Importer une photo', exact: true }).count(), 0,
    'an upload capability without server MIME and byte limits fails closed');
  assert.equal(await page.locator('.ao-account-avatar input[type=file]').count(), 0);

  assert.equal(count, 28);
});
