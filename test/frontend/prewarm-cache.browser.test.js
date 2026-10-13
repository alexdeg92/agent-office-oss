// T-0106: a failed route prewarm must stay retryable through the browser's HTTP cache. A 404 for a current-release
// URL that the browser kept would replay to every retry (the freeze class this task fixes). Real Chrome, real
// serve-frontend, synthetic root; no request interception (Playwright routing disables the HTTP cache).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserPath, browserSkipReason } from './helpers/layout-browser.js';

const require = createRequire(import.meta.url);
const skip = browserSkipReason();
const UI = new URL('../../public/v2/', import.meta.url);

test('a route prewarm that met a 404 fetches again after the file appears (no cached failure)', { skip, timeout: 60_000 }, async () => {
  const { chromium } = await import('playwright-core');
  const { createFrontendServer } = require('../../scripts/serve-frontend');
  const root = mkdtempSync(join(tmpdir(), 'ao-prewarm-'));
  for (const f of ['index.html', 'route-preload.js']) writeFileSync(join(root, f), readFileSync(new URL(f, UI)));
  mkdirSync(join(root, 'pages')); mkdirSync(join(root, 'messages'));
  // The transport is api.js's own prewarm, verbatim.
  const prewarm = /export (async function prewarm\(url\) \{[\s\S]*?\n\})/.exec(readFileSync(new URL('api.js', UI), 'utf8'))[1];
  const seen = [];
  const server = createFrontendServer({ root, basePath: '/', apiBase: '/backend' });
  server.on('request', (req) => { if (/health\.js/.test(req.url)) seen.push(req.url); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: browserPath(), headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
  try {
    const page = await browser.newPage();
    const statuses = [];
    page.on('response', (r) => { if (/pages\/health\.js/.test(r.url())) statuses.push(r.status()); });
    await page.goto(origin + '/a-propos');
    await page.evaluate(`globalThis.AO_ROUTES.attach(${prewarm}); true`);
    const settle = async (n) => { for (const until = Date.now() + 10_000; statuses.length < n && Date.now() < until;) await page.waitForTimeout(50); };
    await page.evaluate(() => globalThis.AO_ROUTES.preload('sante'));
    await settle(1);
    writeFileSync(join(root, 'pages', 'health.js'), 'export const ok = 1;');
    writeFileSync(join(root, 'messages', 'health.js'), 'export const ok = 1;');
    await page.evaluate(() => globalThis.AO_ROUTES.preload('sante'));
    await settle(2);
    assert.deepEqual(statuses, [404, 200], 'the retry reached the server and got the file');
    assert.equal(seen.filter((u) => u.startsWith('/pages/health.js')).length, 2, 'the 404 was not replayed from the HTTP cache');
    await page.evaluate(() => globalThis.AO_ROUTES.preload('sante'));   // warmed: no further request
    await page.waitForTimeout(300);
    assert.equal(seen.filter((u) => u.startsWith('/pages/health.js')).length, 2);
  } finally {
    await browser.close(); await new Promise((r) => server.close(r)); rmSync(root, { recursive: true, force: true });
  }
});
