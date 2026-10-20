import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openLayoutBrowser, visit, browserSkipReason } from './helpers/layout-browser.js';

const skip=browserSkipReason();
const groups=['forms','rows','actions','states'];
const captureBase='design/reports/bureau-components-1-gallery';
// Golden PNGs in baselineBase are captured in ao-test:24 (PC container, Playwright chromium build); see its README.
const baselineBase='test/golden/bureau-gallery/synthetic-ui';
const file=(group,width,theme)=>`${captureBase}/${group}-${width}-${theme}.png`;
const baseline=(group,width,theme)=>`${baselineBase}/${group}-${width}-${theme}.png`;
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

test('owner design-system gallery covers every group at desktop/mobile in both themes', {skip,timeout:120000}, async()=>{
  const capture=process.env.BUREAU_GALLERY_CAPTURE==='1';
  const deadline=Date.now()+120000;
  if(capture)await mkdir(captureBase,{recursive:true});
  for(const theme of ['light','dark']) {
    const h=await openLayoutBrowser({theme,testTimeoutMs:Math.max(1000,deadline-Date.now())}),p=h.page;
    try {
      await p.emulateMedia({reducedMotion:'reduce'});
      for(const width of [1440,390,375]) {
        await p.setViewportSize({width,height:width===1440?900:width===390?844:667});
        await visit(p,h.origin,'/design-system?mock=1','[data-design-system-gallery]');
        await p.locator('[data-design-system-gallery]').waitFor({state:'visible'});
        assert.equal(await p.locator('[role="tab"]').count(),4);
        assert.equal(await p.locator('.ao-topbar__title, .bu-topbar__title').first().innerText(),'Bureau');
        const frame=p.locator('.ao-frame__body').first();
        const geometry=await frame.evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth,root:document.documentElement.scrollWidth,viewport:innerWidth}));
        assert.ok(geometry.scroll<=geometry.client,`gallery body has horizontal overflow: ${JSON.stringify(geometry)}`);
        assert.ok(geometry.root<=geometry.viewport,`document has horizontal overflow: ${JSON.stringify(geometry)}`);
        // The shell's seconds clock is live; remove it so pixels stay deterministic.
        await p.locator('.bu-topbar__clock').evaluate(el=>el.remove());

        for(const group of groups) {
          const tab=p.getByRole('tab',{name:group==='forms'?'Formulaires':group==='rows'?'Lignes':group==='actions'?'Actions':'États',exact:true});
          await tab.click();
          const panel=p.locator(`#ds-panel-${group}`);
          await panel.waitFor({state:'visible'});
          const image=await p.screenshot({fullPage:true,animations:'disabled'});
          assert.ok(image.length>10_000,`${group} ${width}px ${theme} should render a substantial component panel`);
          if(capture)await writeFile(file(group,width,theme),image);
          else assert.equal(sha256(image),sha256(await readFile(baseline(group,width,theme))),`${group} ${width}px ${theme} differs from its designer-approved pixel baseline`);
        }
      }
    } finally { await h.close(); }
  }
});

test('gallery follows the interface language in English', {skip,timeout:30000},async()=>{
  const h=await openLayoutBrowser({testTimeoutMs:30000}),p=h.page;
  try {
    await p.addInitScript(()=>localStorage.setItem('ao.locale','en'));
    await p.setViewportSize({width:390,height:844});
    await visit(p,h.origin,'/design-system?mock=1','[data-design-system-gallery]');
    assert.equal(await p.locator('.ds-intro h2').innerText(),'Components in context');
    assert.equal(await p.getByRole('tab',{name:'Forms',exact:true}).count(),1);
    assert.equal(await p.getByLabel('Workspace URL').count(),1);
  } finally {await h.close();}
});

test('gallery interactions exercise menu, inline edit and named confirmation', {skip,timeout:60000},async()=>{
  const h=await openLayoutBrowser({testTimeoutMs:60000}),p=h.page;
  try {
    await p.setViewportSize({width:390,height:844});
    await visit(p,h.origin,'/design-system?mock=1','[data-design-system-gallery]');
    await p.getByRole('tab',{name:'Actions',exact:true}).click();
    await p.getByRole('button',{name:'Autres actions',exact:true}).click();
    await p.getByRole('menuitem',{name:'Définir comme principal',exact:true}).click();
    await p.getByRole('status').filter({hasText:'Dernière action'}).waitFor();
    await p.getByRole('button',{name:'Ouvrir la confirmation',exact:true}).click();
    const dialog=p.getByRole('dialog',{name:'Retirer cet espace ?'});
    await dialog.waitFor();
    await dialog.getByRole('button',{name:'Annuler',exact:true}).click();
    await dialog.waitFor({state:'detached'});
    await p.getByRole('tab',{name:'Lignes',exact:true}).click();
    await p.getByRole('button',{name:/Modifier le nom de Espace de travail/}).click();
    await p.locator('.bu-inline-edit input').fill('New local name');
    await p.getByRole('button',{name:'Valider',exact:true}).click();
    await p.locator('.bu-inline-edit__view').filter({hasText:'New local name'}).waitFor();
  } finally { await h.close(); }
});
