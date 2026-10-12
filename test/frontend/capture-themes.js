// Synthetic Store theme review evidence; PNGs remain local per repository policy.
import { mkdirSync, writeFileSync } from 'node:fs';
import { openLayoutBrowser, visit } from './helpers/layout-browser.js';
import scratchHome from '../helpers/scratch-home.cjs';
scratchHome.requireScratchHome(import.meta.url);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)
const phase = process.env.THEMES_PHASE || 'after';
if (!['before', 'after'].includes(phase)) throw new Error('THEMES_PHASE must be before or after');
const directory = 'design/reports/themes-ux-1';
mkdirSync(directory, { recursive: true });
const results = [], visuals = [];
for (const theme of ['light', 'dark']) {
  const h = await openLayoutBrowser({ root: process.env.THEMES_UI_ROOT, theme });
  const capture = async file => {
    await h.page.screenshot({ path: `${directory}/${file}` });
    visuals.push(await h.page.evaluate(file => {
      const frame=document.querySelector('.ao-shop'), host=document.querySelector('.ao-theme-preview > .ao-theme-scene');
      return {file, width:innerWidth, height:innerHeight, documentWidth:document.scrollingElement.scrollWidth, documentHeight:document.scrollingElement.scrollHeight,
        frameBottom:frame.getBoundingClientRect().bottom, footerBottom:frame.querySelector('.ao-shop__savebar').getBoundingClientRect().bottom,
        previewTheme:host?.dataset.officeTheme, season:host?.dataset.officeSeason,
        filter:host && getComputedStyle(host.querySelector('.ao-world')).filter, background:host && getComputedStyle(host).backgroundColor,
        decorations:host ? [...host.querySelectorAll('[data-season]')].map(e=>e.getAttribute('src')) : [] };
    }, file));
  };
  try {
    for (const [width, height] of [[1440, 900], [390, 844], [375, 667]]) {
      await h.page.setViewportSize({ width, height });
      for (const [mode, name] of [['auto', 'Automatique'], ['day', 'Jour'], ['night', 'Nuit']]) {
        await visit(h.page, h.origin, '/boutique?onglet=themes', '.ao-shop__savebar');
        const choice = phase === 'before' ? h.page.locator('.ao-shop__grid--themes button').filter({ hasText: name }) : h.page.locator(`[data-theme-mode="${mode}"]`);
        await choice.click(); await h.page.mouse.move(0, 0);
        if(phase==='after') await h.page.locator('.ao-theme-preview__time input').evaluate((e,m)=>{ e.value=m; e.dispatchEvent(new Event('input',{bubbles:true})); }, mode==='auto'?300:mode==='night'?1200:720);
        await h.page.waitForTimeout(400);
        await h.page.evaluate(async () => { await Promise.all([...document.images].map(i => i.decode().catch(() => {}))); });
        const stats = await h.page.evaluate(() => ({ height: innerHeight, documentHeight: document.scrollingElement.scrollHeight, width: innerWidth, documentWidth: document.scrollingElement.scrollWidth,
          frameBottom: document.querySelector('.ao-shop').getBoundingClientRect().bottom, footerBottom: document.querySelector('.ao-shop__savebar').getBoundingClientRect().bottom }));
        results.push({ phase, theme, width, mode, ...stats });
        await capture(`${phase}-${theme}-${width}-${mode}.png`);
        if (width < 800 && mode === 'auto') {
          await h.page.locator('.ao-shop__catalogue').evaluate(e => { e.scrollTop = e.scrollHeight; });
          await capture(`${phase}-${theme}-${width}-${mode}-seasons.png`);
        }
        if(phase==='after' && mode==='auto') {
          await h.page.locator('.ao-shop__catalogue').evaluate(e=>{ e.scrollTop=0; });
          await h.page.locator('.ao-theme-preview__time input').evaluate(e=>{ e.value=720; e.dispatchEvent(new Event('input',{bubbles:true})); });
          await h.page.waitForTimeout(100);
          await capture(`${phase}-${theme}-${width}-auto-day.png`);
        }
        if(phase==='after' && mode==='night') {
          const ids=await h.page.locator('[data-theme-season]').evaluateAll(es=>es.map(e=>e.dataset.themeSeason).filter(Boolean));
          for(const id of ids) {
            await h.page.locator(`[data-theme-season="${id}"]`).click(); await h.page.mouse.move(0,0);
            await h.page.waitForTimeout(100);
            await h.page.evaluate(async()=>{await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));});
            await capture(`${phase}-${theme}-${width}-night-season-${id}.png`);
          }
        }
        console.log(phase, theme, width, mode);
      }
    }
  } finally { await h.close(); }
}
writeFileSync(`${directory}/${phase}-audit.json`, JSON.stringify(results, null, 2));

writeFileSync(`${directory}/${phase}-visual-audit.json`, JSON.stringify(visuals, null, 2));
