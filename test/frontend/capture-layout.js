// Synthetic review evidence stays local, per the repository's reports policy.
import { mkdirSync, writeFileSync } from 'node:fs';
import { openLayoutBrowser, visit, routes } from './helpers/layout-browser.js';
import scratchHome from '../helpers/scratch-home.cjs';
scratchHome.requireScratchHome(import.meta.url);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)

const phase = process.env.LAYOUT_PHASE || 'after';
if (!['before', 'after'].includes(phase)) throw new Error('LAYOUT_PHASE must be before or after');
const revision2 = process.env.LAYOUT_REVISION === '2';
const directory = 'design/reports/layout-scroll-1' + (revision2 ? '/revision-2' : '');
mkdirSync(directory, { recursive: true });
const themes = revision2 ? ['light', 'dark'] : ['light'];
const cases = revision2 ? [
  ['store-long', '/boutique?onglet=personnages', '.ao-shop__savebar'],
  ['store-short', '/boutique?onglet=themes', '.ao-shop__savebar'],
  ...routes.filter(r => ['chat', 'setup'].includes(r[0])),
] : routes;
const results = [];
for (const theme of themes) {
  const h = await openLayoutBrowser({ root: process.env.LAYOUT_UI_ROOT, theme });
  try {
    for (const width of (revision2 ? [1440, 390, 375] : [1440, 390])) {
      await h.page.setViewportSize({ width, height: width === 1440 ? 900 : width === 375 ? 667 : 844 });
      for (const [name, path, ready] of cases) {
        await visit(h.page, h.origin, path, ready);
        const stats = await h.page.evaluate(() => ({
          height: innerHeight, documentHeight: document.scrollingElement.scrollHeight,
          width: innerWidth, documentWidth: document.scrollingElement.scrollWidth,
          scrollers: [...document.querySelectorAll('*')]
            .filter(e => e.scrollHeight > e.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(e).overflowY))
            .map(e => ({ class: e.className, height: e.clientHeight, scrollHeight: e.scrollHeight })),
          foot: [...document.querySelectorAll('.ao-shop__savebar,.ao-chat__composer,.ao-setup__nav,.bu-bottombar')]
            .filter(e => e.getBoundingClientRect().height)
            .map(e => ({ class: e.className, box: e.getBoundingClientRect().toJSON(), position: getComputedStyle(e).position })),
          frameFooters: [...document.querySelectorAll('.ao-frame__foot')]
            .filter(e => e.children.length && e.getBoundingClientRect().height)
            .map(e => ({ class: e.parentElement.className, frameBottom: e.parentElement.getBoundingClientRect().bottom,
              footerBottom: e.getBoundingClientRect().bottom,
              gap: e.parentElement.getBoundingClientRect().bottom - parseFloat(getComputedStyle(e.parentElement).borderBottomWidth || 0) - e.getBoundingClientRect().bottom })),
        }));
        results.push({ phase, name, theme, width, path, ...stats });
        console.log(name, width, stats.documentHeight, stats.scrollers.map(e => e.class).join(','));
        if (!revision2 && !['store', 'chat', 'setup'].includes(name)) continue;
        const shot = `${phase}-${name}-${revision2 ? theme + '-' : ''}${width}`;
        await h.page.evaluate(() => { for (const e of document.querySelectorAll('.ao-frame__body')) e.scrollTop = 0; });
        await h.page.screenshot({ path: `${directory}/${shot}-top.png` });
        await h.page.evaluate(() => {
          const body = [...document.querySelectorAll('.ao-frame__body')]
            .filter(e => e.scrollHeight > e.clientHeight + 1 && getComputedStyle(e).overflowY === 'auto').at(-1);
          if (body) body.scrollTop = body.scrollHeight;
          else window.scrollTo(0, document.scrollingElement.scrollHeight);
        });
        await h.page.screenshot({ path: `${directory}/${shot}-bottom.png` });
      }
    }
  } finally { await h.close(); }
}
writeFileSync(`${directory}/${phase}-audit.json`, JSON.stringify(results, null, 2));
