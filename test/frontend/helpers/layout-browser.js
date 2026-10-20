import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import scratchHome from '../../helpers/scratch-home.cjs';
import { cleanupAfterTest } from './test-cleanup.js';
scratchHome.refuseEntry(import.meta.url);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)
const require = createRequire(import.meta.url);
const { findChrome } = require('../../office/helpers/browser');
export const browserPath = () => process.env.AO_SKIP_BROWSER === '1' ? null : findChrome();
export function browserSkipReason() {
  if (process.env.AO_SKIP_BROWSER === '1') return 'AO_SKIP_BROWSER=1';
  try { require.resolve('playwright-core'); }
  catch { return 'no playwright-core (install devDependencies to run the layout checks)'; }
  return !browserPath() && 'no Chrome (set CHROME_BIN to run the layout checks)';
}
export async function openLayoutBrowser({ root = resolve('public/v2'), theme = 'light', touch = false, apiVersion, apiProxy, testTimeoutMs } = {}) {
  const skip = browserSkipReason();
  if (skip) throw new Error(`Layout browser unavailable: ${skip}`);
  const { chromium } = await import('playwright-core');
  const { createFrontendServer } = require('../../../scripts/serve-frontend');
  const options = { root, allowDesignSystem:true, ...(apiVersion ? { apiVersion } : {}) };
  const server = createFrontendServer({ ...options, ...(typeof apiProxy === 'string' ? { apiProxy } : {}) });
  await new Promise((resolve, reject) => {
    const onError = error => { server.removeListener('listening', onListening); reject(error); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, browserServer;
  // Only callers that pass their owning node:test timeout get a test-deadline
  // watchdog. A global default here can kill unrelated long-running browser
  // tests well before their own timeout.
  const watchdog = Number.isFinite(testTimeoutMs)
    ? setTimeout(() => browserServer?.process()?.kill('SIGKILL'), Math.max(1000, testTimeoutMs - 1000))
    : null;
  watchdog?.unref?.();
  const stopBrowser = async () => {
    const child = browserServer?.process();
    const killTimer = setTimeout(() => child?.kill('SIGKILL'), 5000);
    killTimer.unref?.();
    let failure;
    try {
      try { await browser?.close(); } catch (error) { if (!child?.killed) failure = error; }
      try { if (browserServer) await browserServer.close(); } catch (error) { if (!child?.killed) failure ||= error; }
      if (failure) {
        // A browser protocol call can remain pending after the test timeout. The
        // server handle gives teardown a direct way to end that child process.
        child?.kill('SIGKILL');
        throw failure;
      }
    } finally {
      if (watchdog) clearTimeout(watchdog);
      clearTimeout(killTimer);
    }
  };
  try {
    // A mounted API fixture can configure its allowed public origin only once
    // this existing frontend server has its actual ephemeral listen address.
    if (typeof apiProxy === 'function') {
      const proxy = createFrontendServer({ ...options, apiProxy: await apiProxy(origin) });
      server.removeAllListeners('request');
      for (const listener of proxy.listeners('request')) server.on('request', listener);
    }
    // launch() creates a fresh temporary user-data directory per browser. Keep its
    // startup bound so a saturated parallel run fails the owning test instead of
    // leaving a worker waiting on a browser process indefinitely.
    const startupTimeoutMs = Number.isFinite(testTimeoutMs) ? Math.max(1000, testTimeoutMs - 1000) : 15000;
    browserServer = await chromium.launchServer({ executablePath: browserPath(), headless: true, timeout: Math.min(10000, startupTimeoutMs), args: ['--no-sandbox', '--disable-background-networking'] });
    browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: Math.min(5000, startupTimeoutMs) });
    const context = await browser.newContext({ hasTouch: touch, locale: 'fr-FR' });
    await context.addInitScript(({ theme }) => {
      localStorage.setItem('ao.locale', 'fr'); localStorage.setItem('ao.uiTheme', theme);
      if (location.pathname.endsWith('/connexion')) sessionStorage.setItem('ao.mock.loggedOut', '1');
      else sessionStorage.removeItem('ao.mock.loggedOut');
    }, { theme });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(10000);
    const closeServer = () => new Promise((resolve, reject) => {
      // Stop accepting first, then terminate keep-alive/SSE sockets. Otherwise
      // server.close() can wait forever after a browser test has timed out.
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections?.();
    });
    return {
      page,
      origin,
      close: async () => cleanupAfterTest(undefined, [
        stopBrowser,
        closeServer,
      ], 'layout browser close'),
    };
  } catch (error) {
    await cleanupAfterTest({ error }, [
      stopBrowser,
      () => new Promise((resolve, reject) => {
        server.close(closeError => closeError ? reject(closeError) : resolve());
        server.closeAllConnections?.();
      }),
    ], 'layout browser setup');
    throw error;
  }
}
export const routes = [
  ['bureau', '/bureau', '.ao-bureau__stage'],
  ['store', '/boutique?onglet=personnages', '.ao-shop__savebar'],
  ['chat', '/discuter?chat-plein=1', '.ao-messenger__workspace'],
  ['flows', '/flux', '.ao-flows'],
  ['flow', '/flux/ffffffff-0c01-4000-8000-000000000001', '.ao-flow'],
  ['project', '/projets/prj_portail', '.ao-project'],
  ['interlocutor', '/habilitations/discord-user%3A100000000000000001', '.ao-interlocutor'],
  ['skill', '/competences/meteo', '.ao-skill'],
  ['about', '/a-propos', '.ao-about'],
  ['more', '/plus', '.bu-morelist'],
  ['not-found', '/page-inconnue', '.bu-empty'],
  ['access', '/habilitations', '.ao-access'],
  ['logs', '/journaux', '.ao-logs'],
  ['session', '/journaux/agent%3Amain%3Adiscord%3Achannel%3Aprojets', '.ao-session'],
  ['skills', '/competences', '.ao-skills'],
  ['health', '/sante', '.ao-health__cards'],
  ['settings', '/parametres', '#settings-section-form'],
  ['projects', '/projets', '[data-card]'],
  ['import', '/projets/importer', '.ao-import'],
  ['setup', '/?mock=installation', '#setup-code'],
  ['animations', '/bureau/test-animations?agents=4', '.ao-animations-stage'],
  ['login', '/connexion', '#login-email'],
];
export async function visit(page, origin, path, ready) {
  const url = new URL(path, origin); if (!url.searchParams.has('mock')) url.searchParams.set('mock', '1'); url.searchParams.set('agent', 'Atlas');
  await page.goto(url.href, { waitUntil: 'networkidle' });
  if(url.pathname.endsWith('/discuter')&&ready!=='.ao-messenger__workspace')await chooseChatConversation(page);
  await page.locator(ready).first().waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
}

/** Explicit synthetic test-user navigation through the v3 target and session panes. */
export async function chooseChatConversation(page){
 const target=page.locator('[data-chat-agent]').first();await target.waitFor();await target.click();
 const session=page.locator('[data-chat-session]').first();await session.waitFor();await session.click();
 await page.locator('#chat-texte').waitFor();
}
