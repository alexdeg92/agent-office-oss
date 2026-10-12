import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { browserSkipReason, openLayoutBrowser, visit } from './helpers/layout-browser.js';

const skip = browserSkipReason();
const capture = process.env.CONNECTOR_MARK_SCREENSHOTS === '1';
const files = {
  openclaw: '/v2/assets/connectors/openclaw.svg',
  claude: '/v2/assets/connectors/claude-code.svg',
  codex: '/v2/assets/connectors/codex.svg',
};

test('connector marks use adapter assets and preserve fallback identity in Logs and Settings', { skip, timeout: 60000 }, async () => {
  const h = await openLayoutBrowser();
  try {
    const p = h.page;
    await p.goto(new URL('/journaux?mock=1', h.origin).href, { waitUntil: 'networkidle' });
    await p.locator('.ao-logs').waitFor({ state: 'visible' });
    await p.waitForFunction(() => ['openclaw.svg', 'claude-code.svg', 'codex.svg'].every(name =>
      [...document.querySelectorAll('.ao-connector img')].some(image => image.src.endsWith('/assets/connectors/' + name) && image.naturalWidth > 0)));
    assert.equal(await p.locator('.ao-connector__name').filter({ hasText: /^OpenClaw$/ }).count() > 0, true);
    assert.equal(await p.locator('.ao-connector__name').filter({ hasText: /^Claude Code$/ }).count() > 0, true);
    assert.equal(await p.locator('.ao-connector__name').filter({ hasText: /^Codex$/ }).count() > 0, true);
    const codexText = await p.evaluate(() => {
      const mark = [...document.querySelectorAll('.ao-connector')].find(node => node.textContent.includes('Codex'));
      return mark?.closest('.bu-table__row, .ao-logs__card')?.textContent || '';
    });
    assert.match(codexText, /—/, 'cumulative Codex usage is hidden as unknown');
    const kinds = await p.locator('.ao-kind').allTextContents().then(rows => rows.join(' '));
    assert.doesNotMatch(kinds, /Other\s*\(conversation\)/);
    assert.match(kinds, /Conversation/);
    if (capture) {
      await mkdir('design/reports/logos-t0063', { recursive: true });
      await p.setViewportSize({ width: 1440, height: 900 });
      await p.screenshot({ path: 'design/reports/logos-t0063/logs-1440.png', animations: 'disabled' });
    }
    for (const width of [390, 375]) {
      await p.setViewportSize({ width, height: 844 });
      if (capture) await p.screenshot({ path: `design/reports/logos-t0063/logs-${width}.png`, animations: 'disabled' });
    }

    await visit(p, h.origin, '/parametres?onglet=agents&mock=settings-fixall', '#settings-section-form');
    await p.waitForFunction(() => document.querySelector('#settings-section-form')?.getAttribute('aria-busy') === 'false');
    for (const [agent, asset] of [['openclaw-atlas', files.openclaw], ['claude-local-helper', files.claude], ['codex-agent-office', files.codex]]) {
      const badge = p.locator(`[data-testid="settings-agent-all-${agent}"] .ao-settings__connector-mark`);
      assert.ok((await badge.locator('.ao-brand-mark__image--light').getAttribute('src')).endsWith(asset.replace('/v2', '')));
    }
    assert.equal(await p.locator('[data-testid="settings-agent-all-claude-local-helper"] .ao-settings__connector-name').innerText(), 'Claude Code');
    if (capture) {
      await p.setViewportSize({ width: 1440, height: 900 });
      await p.screenshot({ path: 'design/reports/logos-t0063/settings-1440.png', animations: 'disabled' });
    }
    for (const width of [390, 375]) {
      await p.setViewportSize({ width, height: 844 });
      if (capture) await p.screenshot({ path: `design/reports/logos-t0063/settings-${width}.png`, animations: 'disabled' });
    }
  } finally { await h.close(); }
});

test('connector marks remain legible in dark mode', { skip, timeout: 60000 }, async () => {
  const h = await openLayoutBrowser({ theme: 'dark' });
  try {
    const p = h.page;
    await p.goto(new URL('/journaux?mock=1', h.origin).href, { waitUntil: 'networkidle' });
    await p.locator('.ao-logs').waitFor({ state: 'visible' });
    await p.waitForFunction(() => ['openclaw.svg', 'claude-code.svg', 'codex.svg'].every(name =>
      [...document.querySelectorAll('.ao-connector img')].some(image => image.src.endsWith('/assets/connectors/' + name) && image.naturalWidth > 0)));
    assert.ok(await p.locator('.ao-connector img').evaluateAll(images => images.some(image => image.currentSrc.endsWith('/assets/connectors/codex-dark.svg'))), 'Codex selects its white vendor mark in dark mode');
    if (capture) {
      await mkdir('design/reports/logos-t0063', { recursive: true });
      await p.setViewportSize({ width: 1440, height: 900 });
      await p.screenshot({ path: 'design/reports/logos-t0063/logs-dark-1440.png', animations: 'disabled' });
    }
    await visit(p, h.origin, '/parametres?onglet=agents&mock=settings-fixall', '#settings-section-form');
    await p.waitForFunction(() => document.querySelector('#settings-section-form')?.getAttribute('aria-busy') === 'false');
    await p.waitForFunction(() => document.querySelector('[data-testid="settings-agent-all-codex-agent-office"] .ao-settings__connector-mark')?.classList.contains('ao-brand-mark--ready'));
    assert.ok(await p.locator('[data-testid="settings-agent-all-codex-agent-office"] .ao-settings__connector-mark .ao-brand-mark__image--dark').evaluate(image => image.currentSrc.endsWith('/assets/connectors/codex-dark.svg')));
    if (capture) {
      await p.screenshot({ path: 'design/reports/logos-t0063/settings-dark-1440.png', animations: 'disabled' });
      for (const width of [390, 375]) {
        await p.setViewportSize({ width, height: 844 });
        await p.screenshot({ path: `design/reports/logos-t0063/settings-dark-${width}.png`, animations: 'disabled' });
      }
    }
  } finally { await h.close(); }
});
