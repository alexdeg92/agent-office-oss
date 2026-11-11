import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { browserSkipReason, openLayoutBrowser, visit } from './helpers/layout-browser.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skip = browserSkipReason() || false;
const shots=join(process.env.AO_TEST_SHOTS_DIR||tmpdir(),'settings-pending-details');

test('Details lists pending field changes and jumps to the field', { skip, timeout: 45000 }, async () => {
  const h = await openLayoutBrowser(), p = h.page;
  try {
    await visit(p, h.origin, '/parametres?onglet=connexion&connecteur=openclaw&mock=settings-fixall', '#settings-label-openclaw');
    await p.locator('#settings-label-openclaw').fill('Pending connector draft');
    await p.locator('.ao-settings__footer').waitFor();
    await p.getByRole('button', { name: /Détails|Details/i }).click();
    const sheet = p.getByTestId('settings-pending-details');
    await sheet.waitFor();
    assert.match(await sheet.innerText(), /Pending connector draft/);
    assert.match(await sheet.innerText(), /Nom de cette instance|Instance name/i);
    mkdirSync(shots, { recursive: true });
    await p.setViewportSize({ width: 1440, height: 900 });
    await p.locator('[role=dialog]').screenshot({ path: `${shots}/desktop-pending-details.png`, animations: 'disabled' });
    await p.setViewportSize({ width: 390, height: 844 });
    assert.equal(await sheet.isVisible(), true);
    assert.match(await p.locator('#modal-title').innerText(), /Modifications en attente|Pending changes/);
    assert.match(await sheet.innerText(), /Pending connector draft/);
    // Framed settings height collapses under 820px in this Chromium harness; keep DOM proof for phone.
    writeFileSync(`${shots}/phone-pending-states.json`, JSON.stringify({
      viewport: { width: 390, height: 844 },
      visible: await sheet.isVisible(),
      text: await sheet.innerText(),
      title: await p.locator('#modal-title').innerText(),
    }, null, 2));
    await p.setViewportSize({ width: 1440, height: 900 });
    await sheet.getByRole('button', { name: /Voir|View/i }).first().click();
    await p.waitForFunction(() => {
      const el = document.getElementById('settings-label-openclaw');
      return !!el && !document.querySelector('[data-testid=settings-pending-details]')
        && (document.activeElement === el || el.contains(document.activeElement));
    });
    assert.equal(await p.locator('#settings-label-openclaw').inputValue(), 'Pending connector draft');
  } finally {
    await h.close();
  }
});

test('Details shows secrets as changed and never as values', { skip, timeout: 45000 }, async () => {
  const h = await openLayoutBrowser(), p = h.page;
  try {
    await visit(p, h.origin, '/parametres?onglet=connexion&connecteur=openclaw&mock=settings-fixall', '#settings-label-openclaw');
    await p.getByRole('button', { name: /Remplacer|Replace/i }).click();
    await p.locator('#settings-runtime-openclaw-token').waitFor();
    await p.locator('#settings-runtime-openclaw-token').fill('never-show-this-secret');
    await p.locator('.ao-settings__footer').waitFor();
    await p.getByRole('button', { name: /Détails|Details/i }).click();
    const sheet = p.getByTestId('settings-pending-details');
    await sheet.waitFor();
    const text = await sheet.innerText();
    assert.ok(!text.includes('never-show-this-secret'));
    assert.match(text, /modifié|changed/i);
    mkdirSync(shots, { recursive: true });
    await p.locator('[role=dialog]').screenshot({ path: `${shots}/desktop-pending-secret.png`, animations: 'disabled' });
  } finally {
    await h.close();
  }
});
