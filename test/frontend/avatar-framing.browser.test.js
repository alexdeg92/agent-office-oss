import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openLayoutBrowser, visit, browserSkipReason } from './helpers/layout-browser.js';

const options = { skip: browserSkipReason(), timeout: 90000 };
const evidence = new URL('../../design/reports/avatar-01/', import.meta.url);

test('avatar keeps its sized icon while the image renderer chunk loads', options, async () => {
  const h = await openLayoutBrowser(), p = h.page;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await p.route('**/office/avatar-framing.js*', async route => { await held; await route.continue(); });
  try {
    await visit(p, h.origin, '/parametres?mock=1', '#settings-section-form');
    await p.locator('#settings-tab-agents').click();
    // The Agents tab opens on the all-connectors overview; the per-connector rows (settings-agent-row-N) are one connector's view
    await p.locator('#settings-agent-runtime').selectOption('openclaw');
    const avatar = p.locator('[data-testid=settings-agent-row-0] .ao-character-avatar');
    await avatar.locator('svg').waitFor({ state: 'visible' });
    assert.equal(await avatar.getAttribute('data-avatar-ready'), 'false');
    assert.equal(await avatar.locator('img').count(), 0, 'image lifecycle belongs to the deferred renderer');
    const box = await avatar.boundingBox();
    assert.ok(box.width >= 32 && box.height >= 32, 'fallback retains the avatar frame');
    release();
    await p.waitForFunction(() => document.querySelector('[data-testid=settings-agent-row-0] [data-avatar-ready="true"] img')?.naturalWidth > 0);
    const [result] = await pixels(p, '[data-testid=settings-agent-row-0] .ao-character-avatar');
    assert.ok(result.coverage > .15 && result.dx < .13 && result.dy < .13, 'decoded sprite replaces the lazy-loading fallback');
  } finally { release(); await h.close(); }
});

// Draw the displayed image using its actual DOM rectangle, including circular clipping.
// NaturalWidth alone accepted the old empty/sliver failure.
async function pixels(page, selector) {
  return page.locator(selector).evaluateAll(avatars => avatars.map(a => {
    const img = a.querySelector('img'), rect = a.getBoundingClientRect(), box = img.getBoundingClientRect();
    const size = Math.round(rect.width), canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(img, box.x - rect.x, box.y - rect.y, box.width, box.height);
    const rgba = ctx.getImageData(0, 0, size, size).data;
    let count = 0, left = size, top = size, right = 0, bottom = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (rgba[(y * size + x) * 4 + 3] < 32) continue;
      count++; left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    }
    return { id: a.parentElement.dataset.case, size, ready: a.dataset.avatarReady,
      visible: getComputedStyle(img).visibility, coverage: count / (size * size),
      dx: Math.abs((left + right) / 2 - size / 2) / size, dy: Math.abs((top + bottom) / 2 - size / 2) / size };
  }));
}

test('Settings and roster avatars centre every installed model/variant at 32, 40 and 56px after either CSS order', options, async () => {
  const h = await openLayoutBrowser(), p = h.page, metadata = [];
  p.on('request', r => { if (/\/Characters\/[^/]+\/manifest\.json/.test(r.url())) metadata.push(r.url()); });
  try {
    // The Agents tab opens on the all-connectors overview; the per-connector rows (settings-agent-row-N) are one connector's view
    await visit(p, h.origin, '/parametres?onglet=agents&connecteur=openclaw&mock=1', '#settings-section-form');
    await p.waitForFunction(() => document.querySelector('.ao-settings__portrait img')?.naturalWidth > 0);
    await p.evaluate(async () => {
      const api = await import('/api.js'), { services } = await import('/services.js');
      const { data: vm } = await api.get('/api/v2/office/layout');
      vm.layout.data.agents[0] = { ...vm.layout.data.agents[0], character: 'subagent', variant: 'sage', accessories: [] };
      await api.put('/api/v2/office/layout', { expectedRevision: vm.layout.revision, data: vm.layout.data });
      services.stream.retry('layout');
      const sheet = document.createElement('link'); sheet.rel = 'stylesheet'; sheet.href = '/office/page.css';
      await new Promise((resolve, reject) => { sheet.onload = resolve; sheet.onerror = reject; document.head.append(sheet); });
    });
    await p.waitForFunction(() => document.querySelector('[data-testid=settings-agent-row-0] [data-avatar-ready="true"] img')?.src.includes('/subagent/sage/idle.png'));
    const settings = await pixels(p, '[data-testid=settings-agent-row-0] .ao-character-avatar');
    assert.ok(settings[0].coverage > .15 && settings[0].dx < .13 && settings[0].dy < .13, 'actual Settings remains framed after loading office CSS');
    if (process.env.AO_AVATAR_SCREENSHOTS === '1') {
      await mkdir(evidence, { recursive: true });
      for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
        await p.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await p.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
        await writeFile(new URL(`settings-${theme}-${width}.png`, evidence), await p.screenshot());
      }
      await p.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      await p.setViewportSize({ width: 1440, height: 900 });
    }
    await p.evaluate(async () => {
      const { html, render } = await import('/lib.js');
      const { services } = await import('/services.js');
      const { indexManifest } = await import('/office/assets.js');
      const { avatarSource, CharacterAvatar } = await import('/office/avatar.js');
      const { SettingsPortrait } = await import('/pages/settings-portraits.js');
      const index = indexManifest(services.stream._topics.get('layout').state.data.manifest);
      const host = document.createElement('section'); host.id = 'avatar-matrix';
      host.style.cssText = 'position:absolute;top:0;left:0;z-index:10000;width:1440px;box-sizing:border-box;padding:24px;background:var(--bu-bg);display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px';
      document.body.append(host);
      const cases = [];
      for (const c of index.characters.values()) for (const v of c.variants?.length ? c.variants : [{ id: null }]) {
        const source = avatarSource(index, { character: c.id, variant: v.id }, '/bureau/');
        for (const size of [32, 40, 56]) for (const surface of ['settings', 'roster']) cases.push({ id: `${c.id}/${v.id ?? 'base'}/${size}/${surface}`, source, size, surface });
      }
      render(html`${cases.map(c => html`<div data-case=${c.id}><small>${c.id}</small><br />
        ${c.surface === 'settings' ? html`<${SettingsPortrait} look=${c.source} size=${c.size} />`
          : html`<${CharacterAvatar} source=${c.source} size=${c.size} state="idle" />`}</div>`)}`, host);
      window.avatarCases = cases.length;
    });
    await p.waitForFunction(() => document.querySelectorAll('#avatar-matrix [data-avatar-ready="true"]').length === window.avatarCases);
    for (const order of ['office-last', 'settings-last']) {
      await p.evaluate(async order => {
        for (const path of order === 'office-last' ? ['/pages/settings.css', '/office/page.css'] : ['/office/page.css', '/pages/settings.css']) {
          const sheet = document.createElement('link'); sheet.rel = 'stylesheet'; sheet.href = path;
          await new Promise((resolve, reject) => { sheet.onload = resolve; sheet.onerror = reject; document.head.append(sheet); });
        }
      }, order);
      const results = await pixels(p, '#avatar-matrix .ao-character-avatar');
      assert.ok(results.length >= 14 * 3 * 2);
      for (const r of results) {
        assert.equal(r.ready, 'true', JSON.stringify(r)); assert.equal(r.visible, 'visible', JSON.stringify(r));
        assert.ok(r.coverage > .15, `visible sprite: ${JSON.stringify(r)}`);
        assert.ok(r.dx < .13 && r.dy < .13, `centred sprite: ${JSON.stringify(r)}`);
      }
      if (process.env.AO_AVATAR_SCREENSHOTS === '1') {
        await mkdir(evidence, { recursive: true });
        const height = await p.locator('#avatar-matrix').evaluate(el => Math.ceil(el.getBoundingClientRect().height));
        await p.setViewportSize({ width: 1440, height: height + 32 });
        await writeFile(new URL(`matrix-${order}.json`, evidence), JSON.stringify(results, null, 2));
        await writeFile(new URL(`matrix-${order}.png`, evidence), await p.locator('#avatar-matrix').screenshot());
      }
    }
    assert.deepEqual(metadata, [], 'including lazy packs, avatars need only registry thumbnails');
  } finally { await h.close(); }
});

test('avatar fallback survives delayed/error/transparent images and an obsolete decode after a look change', options, async () => {
  const h = await openLayoutBrowser(), p = h.page;
  try {
    await visit(p, h.origin, '/parametres?mock=1', '#settings-section-form');
    await p.evaluate(async () => {
      const { html, render } = await import('/lib.js');
      const { CharacterAvatar } = await import('/office/avatar.js');
      const host = document.createElement('div'); host.id = 'avatar-race'; document.body.append(host);
      window.paintAvatar = source => render(html`<${CharacterAvatar} source=${source} size=${40} />`, host);
      window.avatarDecode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = function () {
        if (this.src.includes('decode-held')) return new Promise(resolve => { window.releaseAvatarDecode = resolve; });
        return window.avatarDecode.call(this);
      };
      const first = new URL('/bureau/assets/Characters/subagent/sage/idle.png?decode-held=1', location.href).href;
      paintAvatar({ url: first, box: { x: 51.8, y: 115.35, w: 92.65, h: 73.1 }, canvas: { w: 192, h: 288 } });
    });
    await p.waitForFunction(() => typeof window.releaseAvatarDecode === 'function');
    assert.ok(await p.locator('#avatar-race .bu-icon').count(), 'agent fallback while decoding');
    assert.equal(await p.locator('#avatar-race img').evaluate(i => getComputedStyle(i).visibility), 'hidden');
    await p.evaluate(() => paintAvatar({ url: '/bureau/assets/Characters/fen/moss/t.webp' }));
    await p.waitForFunction(() => document.querySelector('#avatar-race [data-avatar-ready="true"]'));
    const before = await p.locator('#avatar-race img').getAttribute('style');
    await p.evaluate(() => window.releaseAvatarDecode());
    assert.equal(await p.locator('#avatar-race img').getAttribute('style'), before, 'stale decode cannot reframe the new look');
    await p.evaluate(() => paintAvatar({ url: '/missing-avatar.webp' }));
    await p.waitForFunction(() => document.querySelector('#avatar-race img')?.complete);
    assert.equal(await p.locator('#avatar-race [data-avatar-ready]').getAttribute('data-avatar-ready'), 'false');
    assert.ok(await p.locator('#avatar-race .bu-icon').count(), 'agent fallback on download failure');
    await p.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 8; paintAvatar({ url: c.toDataURL() }); });
    await p.waitForFunction(() => document.querySelector('#avatar-race img')?.naturalWidth === 8);
    assert.equal(await p.locator('#avatar-race [data-avatar-ready]').getAttribute('data-avatar-ready'), 'false');
    assert.ok(await p.locator('#avatar-race .bu-icon').count(), 'agent fallback for an empty transparent sprite');
  } finally { await h.close(); }
});
