import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import scratchHome from '../../helpers/scratch-home.cjs';
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
export async function openLayoutBrowser({ root = resolve('public/v2'), theme = 'light', touch = false, apiVersion } = {}) {
  const skip = browserSkipReason();
  if (skip) throw new Error(`Layout browser unavailable: ${skip}`);
  const { chromium } = await import('playwright-core');
  const { createFrontendServer } = require('../../../scripts/serve-frontend');
  const server = createFrontendServer({ root, allowDesignSystem:true, ...(apiVersion ? { apiVersion } : {}) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: browserPath(), headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
    const context = await browser.newContext({ hasTouch: touch, locale: 'fr-FR' });
    await context.addInitScript(({ theme }) => {
      localStorage.setItem('ao.locale', 'fr'); localStorage.setItem('ao.uiTheme', theme);
      if (location.pathname.endsWith('/connexion')) sessionStorage.setItem('ao.mock.loggedOut', '1');
      else sessionStorage.removeItem('ao.mock.loggedOut');
    }, { theme });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    return { page, origin, close: async () => { await browser.close(); await new Promise(r => server.close(r)); } };
  } catch (e) { await browser?.close(); await new Promise(r => server.close(r)); throw e; }
}
export const routes = [
  ['bureau', '/bureau', '.ao-bureau__stage'],
  ['store', '/boutique?onglet=personnages', '.ao-shop__savebar'],
  ['chat', '/discuter?chat-plein=1', '#chat-texte'],
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
  await page.locator(ready).first().waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
}
